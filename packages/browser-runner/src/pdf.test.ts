// @preflight-scout-requires-browser
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printHtmlReportToPdf } from "./pdf.js";

describe("printHtmlReportToPdf", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-pdf-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prints a report HTML file to PDF", async () => {
    const htmlPath = path.join(dir, "report.html");
    const pdfPath = path.join(dir, "report.pdf");
    await writeFile(htmlPath, "<!doctype html><html><body><h1>Preflight Scout Report</h1></body></html>");

    await printHtmlReportToPdf({ htmlPath, pdfPath });
    const pdf = await readFile(pdfPath);

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("blocks network requests while rendering an arbitrary report", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "image/png" });
      response.end("not an image");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind a port.");
      const htmlPath = path.join(dir, "network-report.html");
      const pdfPath = path.join(dir, "network-report.pdf");
      await writeFile(htmlPath, `<!doctype html><html><body><img src="http://127.0.0.1:${address.port}/probe.png" /></body></html>`);

      await printHtmlReportToPdf({ htmlPath, pdfPath });
      const pdf = await readFile(pdfPath);

      expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a symlink as the report source", async () => {
    const target = path.join(dir, "target.html");
    const htmlPath = path.join(dir, "report-link.html");
    const pdfPath = path.join(dir, "report-link.pdf");
    await writeFile(target, "<!doctype html><html><body>target</body></html>");
    await symlink(target, htmlPath);

    await expect(printHtmlReportToPdf({ htmlPath, pdfPath })).rejects.toThrow("regular HTML file");
  });

  it.skipIf(process.platform === "win32")("rejects a hard link as the report source", async () => {
    const target = path.join(dir, "hardlink-target.html");
    const htmlPath = path.join(dir, "hardlink-report.html");
    const pdfPath = path.join(dir, "hardlink-report.pdf");
    await writeFile(target, "<!doctype html><html><body>target</body></html>");
    await link(target, htmlPath);

    await expect(printHtmlReportToPdf({ htmlPath, pdfPath })).rejects.toThrow("hard link");
  });

  it.skipIf(process.platform === "win32")("rejects a symlink output parent", async () => {
    const htmlPath = path.join(dir, "output-parent-report.html");
    const redirectedParent = path.join(dir, "redirected-output");
    const outputParent = path.join(dir, "output-link");
    await writeFile(htmlPath, "<!doctype html><html><body>report</body></html>");
    await mkdir(redirectedParent);
    await symlink(redirectedParent, outputParent, "dir");

    await expect(printHtmlReportToPdf({ htmlPath, pdfPath: path.join(outputParent, "report.pdf") })).rejects.toThrow("output parent");
  });
});
