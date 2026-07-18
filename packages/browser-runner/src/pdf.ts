import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

export async function printHtmlReportToPdf(input: {
  htmlPath?: string;
  htmlContent?: string;
  /**
   * Validated local root used to resolve relative assets in verified
   * htmlContent without rereading a mutable HTML file.
   */
  reportRoot?: string;
  pdfPath: string;
}): Promise<string> {
  if ((input.htmlPath !== undefined) === (input.htmlContent !== undefined)) {
    throw new Error("PDF rendering requires exactly one HTML source.");
  }
  if (input.htmlPath && input.reportRoot) {
    throw new Error("PDF reportRoot is only valid with verified HTML content.");
  }
  let canonicalHtmlPath: string | undefined;
  let reportRoot: string | undefined;
  let contentBaseUrl: string | undefined;
  if (input.htmlPath) {
    const htmlPath = path.resolve(input.htmlPath);
    const htmlStat = await lstat(htmlPath);
    if (!htmlStat.isFile() || htmlStat.isSymbolicLink() || htmlStat.nlink !== 1) {
      throw new Error("PDF source must be a uniquely linked regular HTML file, not a symlink or hard link.");
    }
    canonicalHtmlPath = await realpath(htmlPath);
    reportRoot = await realpath(path.dirname(htmlPath));
  } else if (input.reportRoot) {
    const requestedReportRoot = path.resolve(input.reportRoot);
    const reportRootStat = await lstat(requestedReportRoot);
    if (!reportRootStat.isDirectory() || reportRootStat.isSymbolicLink()) {
      throw new Error("PDF report root must be a regular directory, not a symlink.");
    }
    reportRoot = await realpath(requestedReportRoot);
    contentBaseUrl = pathToFileURL(path.join(reportRoot, `.preflight-scout-pdf-${randomUUID()}.html`)).toString();
  }
  const requestedPdfPath = path.resolve(input.pdfPath);
  const requestedPdfParent = path.dirname(requestedPdfPath);
  await mkdir(requestedPdfParent, { recursive: true });
  const parentStat = await lstat(requestedPdfParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("PDF output parent must be a regular directory, not a symlink.");
  }
  const pdfPath = path.join(await realpath(requestedPdfParent), path.basename(requestedPdfPath));
  try {
    const existingOutput = await lstat(pdfPath);
    if (!existingOutput.isFile() || existingOutput.isSymbolicLink()) {
      throw new Error("PDF output must be a regular file, not a symlink or directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(pdfPath, { force: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ javaScriptEnabled: false, serviceWorkers: "block" });
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (contentBaseUrl && requestUrl === contentBaseUrl) {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Preflight Scout PDF base</title>" });
      } else if (reportRoot && await isAllowedReportRequest(requestUrl, reportRoot)) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    if (input.htmlContent !== undefined) {
      if (contentBaseUrl) {
        await page.goto(contentBaseUrl, { waitUntil: "domcontentloaded" });
      }
      await page.setContent(input.htmlContent, { waitUntil: "networkidle" });
    } else {
      await page.goto(pathToFileURL(canonicalHtmlPath!).toString(), { waitUntil: "networkidle" });
    }
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "12mm", bottom: "16mm", left: "12mm" }
    });
    return pdfPath;
  } finally {
    await browser.close();
  }
}

async function isAllowedReportRequest(requestUrl: string, reportRoot: string): Promise<boolean> {
  let filePath: string;
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== "file:") return false;
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }

  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    const canonicalFile = await realpath(filePath);
    return isPathWithin(reportRoot, canonicalFile);
  } catch {
    return false;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
