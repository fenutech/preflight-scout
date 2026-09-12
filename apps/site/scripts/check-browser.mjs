import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(siteRoot, "../..");
const out = path.join(siteRoot, "out");
const { chromium } = createRequire(path.join(repositoryRoot, "packages/browser-runner/package.json"))("playwright");
const { version } = JSON.parse(await readFile(path.join(siteRoot, "package.json"), "utf8"));
const setupRequest = "Fetch and follow the appropriate instructions to install and set up Preflight Scout for my coding agent from https://preflightscout.com/agent-setup/prompt.md";
const edgeHeaders = parseHeaders(await readFile(path.join(out, "_headers"), "utf8"));
await readFile(path.join(out, "index.html"));

// Serve only the reviewed export, on an ephemeral local port, with its static
// response/security headers. No external credentials or target app are used.
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relative = pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
    const file = path.resolve(out, relative);
    if (!file.startsWith(`${out}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const content = await readFile(file);
    response.setHeader("Content-Type", contentType(file));
    const setHeaders = new Set();
    for (const [pattern, headers] of edgeHeaders) {
      if (pattern.startsWith("https:")) continue;
      if (pattern === pathname || (pattern.endsWith("*") && pathname.startsWith(pattern.slice(0, -1)))) {
        for (const [name, value] of headers) {
          if (value === null) response.removeHeader(name);
          else {
            const existing = setHeaders.has(name.toLowerCase()) ? response.getHeader(name) : undefined;
            response.setHeader(name, existing ? `${existing}, ${value}` : value);
            setHeaders.add(name.toLowerCase());
          }
        }
      }
    }
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  const rawCheck = await promisify(execFile)(process.execPath, [path.join(siteRoot, "scripts/check-production.mjs"), origin]);
  process.stdout.write(rawCheck.stdout);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Capture the browser's actual copy-handler calls without replacing the
  // operator's system clipboard. Exercise both fallback branches separately.
  await context.addInitScript(() => {
    window.scoutCopyTest = { mode: "api", text: "", legacyCalls: 0 };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (window.scoutCopyTest.mode !== "api") throw new Error("Test clipboard denial");
          window.scoutCopyTest.text = text;
        }
      }
    });
    document.execCommand = (command) => {
      window.scoutCopyTest.legacyCalls += 1;
      if (window.scoutCopyTest.mode === "throw") throw new Error("Test legacy clipboard denial");
      if (window.scoutCopyTest.mode !== "legacy" || command !== "copy") return false;
      window.scoutCopyTest.text = document.activeElement.value;
      return true;
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", (request) => errors.push(`Failed request: ${request.url()}`));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });

  for (const route of ["/", "/install/"]) {
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await assertLayout(page, route);
      await assertSetupCopy(page);
    }
    const command = page.getByRole("button", { name: "Copy command", exact: true }).first();
    const expectedCommand = await command.getAttribute("data-copy-command");
    await command.click();
    await page.getByRole("button", { name: "Command copied", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.scoutCopyTest.text), expectedCommand, "Existing command copy must retain its exact text");
    await page.getByRole("button", { name: "Command copied", exact: true }).waitFor({ state: "hidden" });

    await page.evaluate(() => { window.scoutCopyTest.mode = "legacy"; });
    await assertSetupCopy(page);
    assert.ok(await page.evaluate(() => window.scoutCopyTest.legacyCalls > 0), "Legacy copy path must be exercised");
    for (const mode of ["denied", "throw"]) {
      await page.evaluate((value) => { window.scoutCopyTest.mode = value; }, mode);
      await page.getByRole("button", { name: "Onboard your agent", exact: true }).click();
      const fallback = page.getByRole("textbox", { name: "Setup prompt to copy" });
      await fallback.waitFor({ state: "visible" });
      assert.equal(await fallback.inputValue(), setupRequest, `${route} ${mode}: fallback must contain the exact setup request`);
      assert.deepEqual(await fallback.evaluate((element) => ({
        selected: element.selectionStart === 0 && element.selectionEnd === element.value.length,
        focused: document.activeElement === element,
        textareas: document.querySelectorAll("textarea").length
      })), { selected: true, focused: true, textareas: 1 }, `${route} ${mode}: select the manual prompt and remove the temporary textarea`);
    }
    await page.evaluate(() => { window.scoutCopyTest.mode = "api"; });
    await assertSetupCopy(page);
    assert.equal(await page.getByRole("textbox", { name: "Setup prompt to copy" }).isVisible(), false, "Successful retry must hide the manual fallback");
    await page.getByRole("link", { name: "Install manually", exact: true }).click();
    assert.equal(new URL(page.url()).hash, "#manual-install");
    await page.locator("#manual-install").waitFor({ state: "visible" });
  }

  for (const [route, mime] of [["/llms.txt", "text/plain"], ["/agent-guide.md", "text/markdown"], ["/agent-setup/prompt.md", "text/markdown"]]) {
    const response = await page.goto(`${origin}${route}`);
    assert.equal(response.status(), 200, route);
    assert.ok(response.headers()["content-type"].startsWith(mime), `${route} must have ${mime} content type`);
    const content = await page.locator("body").innerText();
    assert.ok(content.includes("Preflight Scout"), `${route} must be readable without JavaScript`);
    if (route === "/agent-setup/prompt.md") assert.ok(content.includes(`preflight-scout update-check --skill-version ${version}`));
  }
  assert.deepEqual(errors, [], "The public site must have no page, console, request, or HTTP errors");
  await context.close();
  console.log("Verified onboarding copy, feedback/reset, legacy and denied/thrown clipboard fallbacks, manual install, desktop/mobile layout, and text guides without changing the system clipboard.");
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function assertSetupCopy(page) {
  await page.getByRole("button", { name: "Onboard your agent", exact: true }).click();
  const copied = page.getByRole("button", { name: "Setup prompt copied", exact: true });
  await copied.waitFor();
  assert.equal(await page.evaluate(() => window.scoutCopyTest.text), setupRequest, "The exact setup request must be copied");
  await copied.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Onboard your agent", exact: true }).waitFor();
}

async function assertLayout(page, route) {
  const state = await page.evaluate(() => ({
    viewport: innerWidth,
    contentWidth: document.documentElement.scrollWidth,
    brokenImages: Array.from(document.images).filter((image) => !image.complete || image.naturalWidth === 0).length
  }));
  assert.ok(state.contentWidth <= state.viewport, `${route} must not overflow at ${state.viewport}px`);
  assert.equal(state.brokenImages, 0, `${route} must have no broken images`);
}

function parseHeaders(source) {
  const rules = [];
  let current;
  for (const line of source.split(/\r?\n/)) {
    if (line && !line.startsWith(" ")) { current = [line, []]; rules.push(current); }
    else if (line.trim() && current) {
      if (line.trim().startsWith("! ")) {
        current[1].push([line.trim().slice(2), null]);
        continue;
      }
      const separator = line.indexOf(":");
      current[1].push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
    }
  }
  return rules;
}

function contentType(file) {
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown", ".txt": "text/plain", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" })[path.extname(file)] ?? "application/octet-stream";
}
