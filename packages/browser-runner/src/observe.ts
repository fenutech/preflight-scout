import path from "node:path";
import { lstat, rm } from "node:fs/promises";
import type { Page } from "playwright";
import { redactText } from "@preflight-scout/core";
import type { BrowserObservation } from "./types.js";

const MAX_BODY_TEXT_CHARS = 8_000;
const MAX_URL_CHARS = 2_048;
const MAX_TITLE_CHARS = 512;
const MAX_INTERACTIVE_ELEMENTS = 80;
const MAX_INTERACTIVE_VALUE_CHARS = 256;
const MAX_FULL_PAGE_DIMENSION = 10_000;
const MAX_FULL_PAGE_PIXELS = 25_000_000;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
const SCREENSHOT_RETRY_DELAY_MS = 100;

export interface ScreenshotOptions {
  beforeRetry?: () => boolean | Promise<boolean>;
}

interface ScreenshotRetryBudget {
  remaining: number;
}

export async function observe(page: Page, consoleErrors: string[], networkErrors: string[]): Promise<BrowserObservation> {
  const title = await page.evaluate((limit) => document.title.slice(0, limit), MAX_TITLE_CHARS).catch(() => "");
  // Slice in the page process before transferring hostile DOM text to Node.
  const text = await page.evaluate((limit) => (document.body?.innerText ?? "").slice(0, limit), MAX_BODY_TEXT_CHARS).catch(() => "");
  const scroll = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight
  }));
  const interactive = await page.evaluate(({ count, valueLimit }) => {
    const clip = (value: string | null | undefined, limit = valueLimit): string | undefined => {
      const trimmed = value?.trim();
      return trimmed ? trimmed.slice(0, limit) : undefined;
    };
    const nodes = [...document.querySelectorAll("a,button,input,textarea,select,[role],[data-testid]")].slice(0, count);
    return nodes.map((node) => {
      const element = node as HTMLElement;
      const input = node as HTMLInputElement;
      const label = clip(element.getAttribute("aria-label"));
      return {
        tag: element.tagName.toLowerCase().slice(0, 32),
        role: clip(element.getAttribute("role"), 64),
        text: clip(element.innerText, 120) ?? label,
        label,
        placeholder: clip(input.placeholder),
        testid: clip(element.getAttribute("data-testid"))
      };
    });
  }, { count: MAX_INTERACTIVE_ELEMENTS, valueLimit: MAX_INTERACTIVE_VALUE_CHARS });

  return {
    url: redactText(page.url().slice(0, MAX_URL_CHARS)),
    title: redactText(title).slice(0, MAX_TITLE_CHARS),
    text: redactText(text).slice(0, 4000),
    viewport: page.viewportSize(),
    scroll,
    consoleErrors: consoleErrors.slice(-20),
    networkErrors: networkErrors.slice(-20),
    interactive: interactive.map((item) => ({
      ...item,
      text: item.text ? redactText(item.text) : undefined,
      label: item.label ? redactText(item.label) : undefined,
      placeholder: item.placeholder ? redactText(item.placeholder) : undefined,
      testid: item.testid ? redactText(item.testid) : undefined
    }))
  };
}

export async function screenshot(page: Page, outputDir: string, name: string, options: ScreenshotOptions = {}): Promise<string> {
  const screenshotPath = path.join(outputDir, `${name}.png`);
  const retryBudget: ScreenshotRetryBudget = { remaining: 1 };
  const dimensions = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  })).catch(() => ({ width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }));
  const fullPage = Number.isFinite(dimensions.width)
    && Number.isFinite(dimensions.height)
    && dimensions.width > 0
    && dimensions.height > 0
    && dimensions.width <= MAX_FULL_PAGE_DIMENSION
    && dimensions.height <= MAX_FULL_PAGE_DIMENSION
    && dimensions.width * dimensions.height <= MAX_FULL_PAGE_PIXELS;
  await captureScreenshot(page, screenshotPath, fullPage, options, retryBudget);
  let stats = await lstat(screenshotPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    await rm(screenshotPath, { force: true });
    throw new Error("Browser screenshot did not produce a regular evidence file");
  }
  if (stats.size > MAX_SCREENSHOT_BYTES && fullPage) {
    await captureScreenshot(page, screenshotPath, false, options, retryBudget);
    stats = await lstat(screenshotPath);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SCREENSHOT_BYTES) {
    await rm(screenshotPath, { force: true });
    throw new Error(`Browser screenshot exceeded the ${MAX_SCREENSHOT_BYTES}-byte evidence limit`);
  }
  return screenshotPath;
}

async function captureScreenshot(
  page: Page,
  screenshotPath: string,
  fullPage: boolean,
  options: ScreenshotOptions,
  retryBudget: ScreenshotRetryBudget
): Promise<void> {
  let retryError: Error | undefined;
  while (true) {
    await rm(screenshotPath, { force: true });
    if (retryError && options.beforeRetry && !await options.beforeRetry()) throw retryError;
    try {
      await page.screenshot({ path: screenshotPath, fullPage });
      return;
    } catch (error) {
      // A failed CDP capture can leave a partial file. Never retain it as
      // evidence, whether the failure is retryable or final.
      await rm(screenshotPath, { force: true });
      if (retryBudget.remaining === 0 || !isTransientScreenshotCaptureError(error)) throw error;
      retryBudget.remaining -= 1;
      retryError = error;
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_RETRY_DELAY_MS));
    }
  }
}

function isTransientScreenshotCaptureError(error: unknown): error is Error {
  return error instanceof Error
    && /Protocol error \(Page\.captureScreenshot\): Unable to capture screenshot/.test(error.message);
}
