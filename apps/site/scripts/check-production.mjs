import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRawGuide, verifyRawHtml, verifyResponseHeaders } from "./edge-contract.mjs";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(siteRoot, "out");
const { version } = JSON.parse(await readFile(path.join(siteRoot, "package.json"), "utf8"));
assert.ok(process.argv.length <= 3, "Usage: node apps/site/scripts/check-production.mjs [https://deployment-origin]");
const origin = new URL(process.argv[2] ?? "https://preflightscout.com");
assert.ok(origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)), "Use HTTPS or a local loopback HTTP fixture");
assert.ok(!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "Provide an origin without credentials, a path, a query, or a fragment");

// Read raw HTTP bytes as text. Browser rendering or a successful clipboard
// action can conceal edge rewrites that break a terminal-based coding agent.
for (const [route, relative] of [["/", "index.html"], ["/install/", "install/index.html"]]) {
  const expected = await readFile(path.join(out, relative), "utf8");
  const { response, body } = await fetchText(route);
  verifyRawHtml(body, expected, version, route);
  verifyResponseHeaders(response.headers, "text/html");
  console.log(`Verified raw HTML instructions and copy controls: ${route}`);
}

for (const [route, mime] of [["/llms.txt", "text/plain"], ["/agent-guide.md", "text/markdown"], ["/agent-setup/prompt.md", "text/markdown"]]) {
  const expected = await readFile(path.join(out, route.slice(1)), "utf8");
  const { response, body } = await fetchText(route);
  verifyRawGuide(body, expected, route);
  verifyResponseHeaders(response.headers, mime);
  console.log(`Verified raw agent guide and response type: ${route}`);
}

const home = await readFile(path.join(out, "index.html"), "utf8");
const stylesheet = home.match(/href="(\/_next\/static\/[^"?#]+\.css)"/)?.[1];
assert.ok(stylesheet, "The reviewed export must include a fingerprinted stylesheet to verify immutable caching");
const { response, body } = await fetchText(stylesheet);
verifyResponseHeaders(response.headers, "text/css", { immutable: true });
assert.equal(body, await readFile(path.join(out, stylesheet.slice(1)), "utf8"), "The deployed fingerprinted stylesheet must match the reviewed export");
console.log(`Verified raw deployment content and no-transform caching at ${origin.origin}; no page JavaScript was executed.`);

async function fetchText(route) {
  const response = await fetch(new URL(route, origin), {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "text/html, text/markdown, text/plain, text/css", "User-Agent": "Preflight-Scout-deployment-check" }
  });
  assert.equal(response.status, 200, `${route}: expected HTTP 200 without a redirect`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= 2 * 1024 * 1024, `${route}: response exceeds the deployment check's 2 MiB limit`);
    chunks.push(chunk);
  }
  return { response, body: Buffer.concat(chunks).toString("utf8") };
}
