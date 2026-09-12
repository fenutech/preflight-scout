import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL, verifyCacheHeaderSource, verifyRawGuide, verifyRawHtml, verifyResponseHeaders } from "./edge-contract.mjs";

const version = "9.8.7";
const install = `npm install --global @preflight-scout/cli@${version} --registry=https://registry.npmjs.org/`;
const setup = "Fetch and follow the appropriate instructions to install and set up Preflight Scout for my coding agent from https://preflightscout.com/agent-setup/prompt.md";
const html = `<code>${install}</code><button data-copy-command="${install}"></button><button data-copy-command="${setup}" data-copy-success-label="Setup prompt copied"></button><textarea aria-label="Setup prompt to copy">${setup}</textarea><a href="/llms.txt">For agents</a>`;

test("the maintained header file opts out of transformation without losing either cache lifetime", async () => {
  const source = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  verifyCacheHeaderSource(source);
  assert.throws(() => verifyCacheHeaderSource(source.replaceAll(", no-transform", "")), /disable edge transformations/);
  assert.throws(() => verifyCacheHeaderSource(source.replace("  ! Cache-Control\n", "")), /reset the global cache rule/);
  assert.throws(() => verifyCacheHeaderSource(source.replace("max-age=31536000", "max-age=0")), /immutable lifetime/);
});

test("raw HTML preserves pinned visible instructions, copy values, and a selectable setup prompt", () => {
  verifyRawHtml(html, html, version, "/");
  assert.throws(() => verifyRawHtml(html.replace(`<code>${install}`, `<code>${install.replace("@preflight-scout/cli", "wrong-package")}`), html, version, "/"), /visible npm commands/);
  assert.throws(() => verifyRawHtml(html.replace(`data-copy-command="${install}"`, 'data-copy-command="npm install wrong-package"'), html, version, "/"), /raw copy values/);
  assert.throws(() => verifyRawHtml(html.replace(`>${setup}</textarea>`, ">Wrong setup prompt</textarea>"), html, version, "/"), /manual copy fallback/);
});

for (const marker of [
  '<a class="__cf_email__">hidden</a>',
  '<a data-cfemail="0000">hidden</a>',
  '<a href="/cdn-cgi/l/email-protection">hidden</a>',
  '<script src="/cdn-cgi/scripts/example/cloudflare-static/email-decode.min.js"></script>',
  "[email&#160;protected]"
]) {
  test(`raw HTML rejects edge transformation: ${marker}`, () => {
    assert.throws(() => verifyRawHtml(html + marker, html, version, "/install/"), /edge email obfuscation/);
  });
}

test("plain agent endpoints must retain the exact reviewed text and not return HTML", () => {
  const guide = `# Preflight Scout setup\n\n${install}\n`;
  verifyRawGuide(guide, guide, "/agent-setup/prompt.md");
  assert.throws(() => verifyRawGuide(guide.replace(version, "0.0.0"), guide, "/agent-setup/prompt.md"), /match the reviewed export exactly/);
  assert.throws(() => verifyRawGuide("<html>Not a guide</html>", guide, "/agent-setup/prompt.md"), /readable agent guide/);
  assert.throws(() => verifyRawGuide(guide + "data-cfemail", guide, "/agent-setup/prompt.md"), /edge email obfuscation/);
});

test("HTTP response contracts reject missing transformation protection and conflicting cache lifetimes", () => {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": DEFAULT_CACHE_CONTROL });
  verifyResponseHeaders(headers, "text/html");
  headers.set("Cache-Control", DEFAULT_CACHE_CONTROL.replace(", no-transform", ""));
  assert.throws(() => verifyResponseHeaders(headers, "text/html"), /Cache-Control/);
  headers.set("Cache-Control", `${DEFAULT_CACHE_CONTROL}, ${IMMUTABLE_CACHE_CONTROL}`);
  assert.throws(() => verifyResponseHeaders(headers, "text/html"), /conflicting directives/);
  headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  headers.set("Content-Type", "text/css; charset=utf-8");
  verifyResponseHeaders(headers, "text/css", { immutable: true });
  assert.throws(() => verifyResponseHeaders(headers, "text/markdown", { immutable: true }), /Content-Type/);
});
