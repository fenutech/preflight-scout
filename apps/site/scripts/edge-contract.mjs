import assert from "node:assert/strict";

export const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate, no-transform";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable, no-transform";
const transformationMarkers = /__cf_email__|data-cfemail|\/cdn-cgi\/l\/email-protection|email-decode(?:\.min)?\.js|\[email(?:\s|&(?:#160|nbsp);)+protected\]/i;

export function verifyCacheHeaderSource(source) {
  const globalRule = source.match(/^\/\*\n((?:[ \t]+[^\n]*\n|\n)*)/m)?.[1] ?? "";
  const assetRule = source.match(/^\/_next\/static\/\*\n((?:[ \t]+[^\n]*\n|\n)*)/m)?.[1] ?? "";
  assert.ok(globalRule.includes(`  Cache-Control: ${DEFAULT_CACHE_CONTROL}\n`), "All site responses must preserve page revalidation and disable edge transformations");
  assert.ok(assetRule.includes(`  ! Cache-Control\n  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}\n`), "Fingerprinted assets must reset the global cache rule before retaining their immutable lifetime and no-transform");
}

export function verifyResponseHeaders(headers, mime, { immutable = false } = {}) {
  assert.equal(headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase(), mime, `Expected response Content-Type ${mime}`);
  const actual = (headers.get("cache-control") ?? "").toLowerCase().split(",").map((value) => value.trim()).sort();
  const expected = (immutable ? IMMUTABLE_CACHE_CONTROL : DEFAULT_CACHE_CONTROL).split(",").map((value) => value.trim()).sort();
  assert.deepEqual(actual, expected, "Cache-Control must disable transformations without changing cache lifetime or emitting conflicting directives");
}

export function verifyRawHtml(html, expectedHtml, version, route) {
  verifyNoTransformation(html, route);
  const expectedInstall = `npm install --global @preflight-scout/cli@${version} --registry=https://registry.npmjs.org/`;
  const commandLines = (source) => [...source.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)]
    .flatMap((match) => decodeHtmlText(match[1]).split("\n"))
    .filter((line) => line.startsWith("npm install --global "));
  const expectedCommands = commandLines(expectedHtml);
  assert.ok(expectedCommands.length > 0 && expectedCommands.every((line) => line === expectedInstall), `${route}: the reviewed export must display only canonical pinned npm install commands`);
  assert.deepEqual(commandLines(html), expectedCommands, `${route}: visible npm commands must match the reviewed export without JavaScript decoding`);
  const copyValues = (source) => [...source.matchAll(/\bdata-copy-command="([^"]*)"/g)].map((match) => decodeHtmlText(match[1]));
  assert.ok(copyValues(expectedHtml).length > 1, `${route}: the reviewed export must include onboarding and manual command copy controls`);
  assert.deepEqual(copyValues(html), copyValues(expectedHtml), `${route}: all raw copy values must match the reviewed export`);
  const setupRequest = "Fetch and follow the appropriate instructions to install and set up Preflight Scout for my coding agent from https://preflightscout.com/agent-setup/prompt.md";
  assert.ok(copyValues(html).includes(setupRequest), `${route}: the onboarding copy control must retain the exact setup URL`);
  assert.ok(html.includes('data-copy-success-label="Setup prompt copied"'), `${route}: onboarding copy feedback is missing`);
  assert.ok(html.includes('aria-label="Setup prompt to copy"'), `${route}: selectable onboarding fallback is missing`);
  const textareas = (source) => [...source.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g)].map((match) => decodeHtmlText(match[1]));
  assert.deepEqual(textareas(html), textareas(expectedHtml), `${route}: the raw manual copy fallback must match the reviewed export`);
  assert.ok(textareas(html).includes(setupRequest), `${route}: the manual copy fallback must retain the exact setup request`);
  assert.ok(html.includes('href="/llms.txt"'), `${route}: visible agent discovery is missing`);
}

export function verifyRawGuide(body, expectedBody, route) {
  verifyNoTransformation(body, route);
  assert.ok(/^# [^\n]*Preflight Scout/.test(body), `${route}: expected a readable agent guide`);
  assert.ok(!/<(?:html|script)\b/i.test(body), `${route}: expected plain text, not an HTML page`);
  assert.equal(body, expectedBody, `${route}: raw guide must match the reviewed export exactly`);
}

function verifyNoTransformation(body, route) {
  assert.ok(!transformationMarkers.test(body), `${route}: edge email obfuscation corrupted agent-readable content`);
}

// Decode ordinary HTML character references only. Never execute page scripts
// or Cloudflare's email decoder: agents must receive valid raw instructions.
function decodeHtmlText(value) {
  return value.replace(/&(?:#(\d+)|#x([a-f0-9]+)|(amp|quot|apos|lt|gt|nbsp));/gi, (entity, decimal, hex, named) => {
    if (decimal || hex) {
      const point = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: "\u00a0" }[named.toLowerCase()];
  });
}
