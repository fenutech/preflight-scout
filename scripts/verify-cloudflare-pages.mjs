import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "wrangler.json");
const headersPath = path.join(root, "apps", "site", "public", "_headers");

const config = JSON.parse(await readFile(configPath, "utf8"));
const expectedKeys = ["compatibility_date", "name", "pages_build_output_dir", "send_metrics"];
const actualKeys = Object.keys(config).sort();

if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  throw new Error(`wrangler.json must contain only ${expectedKeys.join(", ")}; found ${actualKeys.join(", ")}.`);
}
if (config.name !== "preflight-scout") throw new Error("wrangler.json must target the preflight-scout Pages project.");
if (config.pages_build_output_dir !== "./apps/site/out") {
  throw new Error("wrangler.json must deploy only the reviewed static export at apps/site/out.");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)) {
  throw new Error("wrangler.json must pin an explicit Cloudflare compatibility date.");
}
if (config.send_metrics !== false) throw new Error("Wrangler telemetry must remain disabled for the release project.");

const serializedConfig = JSON.stringify(config);
for (const forbidden of ["account_id", "zone_id", "api_token", "secret", "token"]) {
  if (serializedConfig.toLowerCase().includes(forbidden)) {
    throw new Error(`wrangler.json must not contain Cloudflare credentials or account wiring: ${forbidden}.`);
  }
}

const headers = await readFile(headersPath, "utf8");
for (const marker of [
  "/*",
  "Content-Security-Policy: default-src 'self'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "Permissions-Policy:",
  "Referrer-Policy: no-referrer",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "https://:project.pages.dev/*",
  "https://:version.:project.pages.dev/*",
  "/example-report/report\n  X-Robots-Tag: noindex, nofollow",
  "X-Robots-Tag: noindex"
]) {
  if (!headers.includes(marker)) throw new Error(`Cloudflare _headers is missing required marker: ${marker}`);
}

const scriptPolicy = headers.match(/Content-Security-Policy:[^\n]*script-src\s+([^;\n]+)/)?.[1] ?? "";
if (!scriptPolicy || /'unsafe-(?:inline|eval)'/.test(scriptPolicy)) {
  throw new Error("The public site script policy must remain self-only without unsafe-inline or unsafe-eval.");
}

console.log("Cloudflare Pages configuration is static-only, credential-free, and carries the required edge security headers.");
