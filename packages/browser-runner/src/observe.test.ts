import { access, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screenshot } from "./observe.js";

describe("screenshot", () => {
  const outputDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(outputDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("retries one transient Page.captureScreenshot failure after deleting partial evidence", async () => {
    const outputDir = await temporaryOutputDirectory();
    let attempt = 0;
    let partialEvidenceWasRemoved = false;
    const page = fakePage(async (options) => {
      attempt += 1;
      const outputPath = String(options.path);
      if (attempt === 1) {
        await writeFile(outputPath, "partial screenshot");
        throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
      }
      partialEvidenceWasRemoved = await access(outputPath).then(() => false, () => true);
      await writeFile(outputPath, "complete screenshot");
    });

    const outputPath = await screenshot(page, outputDir, "turn-1");

    expect(attempt).toBe(2);
    expect(partialEvidenceWasRemoved).toBe(true);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("complete screenshot");
  });

  it("does not retry other failures and deletes their partial evidence", async () => {
    const outputDir = await temporaryOutputDirectory();
    const capture = vi.fn(async (options: { path?: string | Buffer }) => {
      await writeFile(String(options.path), "partial screenshot");
      throw new Error("page.screenshot: Target page, context or browser has been closed");
    });
    const page = fakePage(capture);
    const outputPath = path.join(outputDir, "turn-1.png");

    await expect(screenshot(page, outputDir, "turn-1")).rejects.toThrow("Target page, context or browser has been closed");

    expect(capture).toHaveBeenCalledTimes(1);
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("checks the caller's safety boundary before retrying", async () => {
    const outputDir = await temporaryOutputDirectory();
    const capture = vi.fn(async () => {
      throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
    });
    const beforeRetry = vi.fn(() => false);

    await expect(screenshot(fakePage(capture), outputDir, "turn-1", { beforeRetry })).rejects.toThrow("Unable to capture screenshot");

    expect(capture).toHaveBeenCalledTimes(1);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
  });

  it("checks the safety boundary after cleanup with no cleanup between the guard and retry capture", async () => {
    const outputDir = await temporaryOutputDirectory();
    const outputPath = path.join(outputDir, "turn-1.png");
    let attempt = 0;
    let guardMarkerReachedCapture = false;
    const page = fakePage(async (options) => {
      attempt += 1;
      if (attempt === 1) {
        await writeFile(String(options.path), "partial screenshot");
        throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
      }
      guardMarkerReachedCapture = await readFile(String(options.path), "utf8").then(
        (contents) => contents === "guard completed",
        () => false
      );
      await writeFile(String(options.path), "complete screenshot");
    });
    const beforeRetry = vi.fn(async () => {
      await expect(access(outputPath)).rejects.toThrow();
      await writeFile(outputPath, "guard completed");
      return true;
    });

    await expect(screenshot(page, outputDir, "turn-1", { beforeRetry })).resolves.toBe(outputPath);

    expect(attempt).toBe(2);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(guardMarkerReachedCapture).toBe(true);
  });

  it("shares one retry budget across full-page capture and the oversized viewport fallback", async () => {
    const outputDir = await temporaryOutputDirectory();
    const outputPath = path.join(outputDir, "turn-1.png");
    let attempt = 0;
    const capture = vi.fn(async (options: { path?: string | Buffer; fullPage?: boolean }) => {
      attempt += 1;
      const capturePath = String(options.path);
      if (attempt === 1) {
        await writeFile(capturePath, "partial full-page screenshot");
        throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
      }
      if (attempt === 2) {
        expect(options.fullPage).toBe(true);
        await writeFile(capturePath, "");
        await truncate(capturePath, 20 * 1024 * 1024 + 1);
        return;
      }
      expect(options.fullPage).toBe(false);
      await writeFile(capturePath, "partial viewport screenshot");
      throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
    });
    const beforeRetry = vi.fn(() => true);

    await expect(screenshot(fakePage(capture), outputDir, "turn-1", { beforeRetry })).rejects.toThrow("Unable to capture screenshot");

    expect(capture).toHaveBeenCalledTimes(3);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    await expect(access(outputPath)).rejects.toThrow();
  });

  async function temporaryOutputDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "preflight-scout-observe-test-"));
    outputDirectories.push(directory);
    return directory;
  }
});

function fakePage(capture: (options: { path?: string | Buffer; fullPage?: boolean }) => Promise<void>): Page {
  return {
    evaluate: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
    screenshot: capture
  } as unknown as Page;
}
