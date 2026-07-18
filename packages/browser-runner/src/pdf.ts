import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

export async function printHtmlReportToPdf(input: {
  htmlPath?: string;
  htmlContent?: string;
  pdfPath: string;
}): Promise<string> {
  if ((input.htmlPath !== undefined) === (input.htmlContent !== undefined)) {
    throw new Error("PDF rendering requires exactly one HTML source.");
  }
  let canonicalHtmlPath: string | undefined;
  let reportRoot: string | undefined;
  if (input.htmlPath) {
    const htmlPath = path.resolve(input.htmlPath);
    const htmlStat = await lstat(htmlPath);
    if (!htmlStat.isFile() || htmlStat.isSymbolicLink() || htmlStat.nlink !== 1) {
      throw new Error("PDF source must be a uniquely linked regular HTML file, not a symlink or hard link.");
    }
    canonicalHtmlPath = await realpath(htmlPath);
    reportRoot = await realpath(path.dirname(htmlPath));
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
      if (reportRoot && await isAllowedReportRequest(route.request().url(), reportRoot)) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    if (input.htmlContent !== undefined) {
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
