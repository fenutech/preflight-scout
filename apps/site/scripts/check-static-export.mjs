import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "out");
const sitePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const ogAlt = "Preflight Scout showing a failed browser check with its evidence";
const pages = [
  {
    relative: "index.html",
    heading: "Give your coding agent a real release check.",
    title: "Preflight Scout — Release QA for coding agents",
    description: "Preflight Scout turns a pull-request diff into a test plan, approved browser checks, and evidence you can review before shipping.",
    canonical: "https://preflightscout.com/",
    structuredData: true
  },
  {
    relative: "install/index.html",
    heading: "Install Preflight Scout for Codex or Claude Code.",
    title: "Install the CLI and Agent Skill — Preflight Scout",
    description: "Install the Preflight Scout CLI, Chromium browser, and agent skill for Codex or Claude Code with version-pinned commands.",
    canonical: "https://preflightscout.com/install/",
    structuredData: false
  },
  {
    relative: "example-report/index.html",
    heading: "See what passed, what failed, and the files behind each result.",
    title: "Example Release QA Report — Preflight Scout",
    description: "Inspect a Preflight Scout release QA report with a passing browser check, a failed check, and the evidence files behind each result.",
    canonical: "https://preflightscout.com/example-report/",
    structuredData: false
  },
  {
    relative: "security/index.html",
    heading: "What Preflight Scout reads, sends, stores, and blocks.",
    title: "Security and Data Boundaries — Preflight Scout",
    description: "Learn what Preflight Scout reads, sends to the selected model, stores locally, and blocks during browser checks.",
    canonical: "https://preflightscout.com/security/",
    structuredData: false
  }
];

for (const page of pages) {
  const html = await readFile(path.join(out, page.relative), "utf8");
  assertContains(html, `<title>${page.title}</title>`, `${page.relative} title`);
  assertContains(html, `<meta name="description" content="${page.description}"`, `${page.relative} description`);
  assertContains(html, `href="${page.canonical}"`, `${page.relative} canonical`);
  assertContains(html, `<h1>${page.heading}</h1>`, `${page.relative} primary heading`);
  assertContains(html, `property="og:image:alt" content="${ogAlt}"`, `${page.relative} Open Graph image alt`);
  assertContains(html, `name="twitter:image:alt" content="${ogAlt}"`, `${page.relative} Twitter image alt`);
  assertContains(html, "https://preflightscout.com/opengraph-image.png", `${page.relative} social image URL`);
  assertContains(html, '<html lang="en"', `${page.relative} language`);
  assertContains(html, '<script src="/site.js" defer=""></script>', `${page.relative} progressive-enhancement script`);

  if ((html.match(/<h1(?:\s|>)/g) ?? []).length !== 1) throw new Error(`${page.relative} must contain exactly one h1`);
  if (/<meta\s+name="keywords"/i.test(html)) throw new Error(`${page.relative} must not emit ignored meta keywords`);
  if (/<script\b[^>]*\bsrc="\/_next\/static\/chunks\/[^"]+\.js"/.test(html) || html.includes("self.__next_f")) {
    throw new Error(`${page.relative} contains the unused Next.js client runtime`);
  }
  if (/https:\/\/[^"']*\.pages\.dev/i.test(extractCanonical(html))) throw new Error(`${page.relative} canonical points to pages.dev`);

  const jsonLdScripts = html.match(/<script\s+type="application\/ld\+json"[^>]*>/g) ?? [];
  if (page.structuredData && jsonLdScripts.length !== 1) throw new Error(`${page.relative} must contain one JSON-LD script`);
  if (!page.structuredData && jsonLdScripts.length !== 0) throw new Error(`${page.relative} must not repeat homepage JSON-LD`);
  if (page.structuredData) {
    assertContains(html, '"@type":"WebSite"', "home WebSite structured data");
    assertContains(html, '"name":"Preflight Scout"', "home site name");
    assertContains(html, '"alternateName":"preflightscout.com"', "home alternate site name");
    assertContains(html, '"url":"https://preflightscout.com/"', "home structured-data URL");
    assertContains(html, "codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable", "home Codex stable-channel installation");
    assertContains(html, "claude plugin marketplace add fenutech/preflight-scout@plugin-stable", "home Claude Code stable-channel installation");
    assertContains(html, "preflight-scout install-browser", "home Chromium installation");
    assertContains(html, "1280×720", "home sample-report viewport");
    assertContains(html, `https://github.com/fenutech/preflight-scout/releases/tag/v${sitePackage.version}`, "home exact GitHub release gate");
    assertContains(html, `https://www.npmjs.com/package/@preflight-scout/cli/v/${sitePackage.version}`, "home exact npm release gate");
  }

  await verifyInternalLinks(html, page.relative);
  if (page.relative === "install/index.html") {
    assertContains(html, "preflight-scout init --no-llm --base origin/main", "install repository initialization");
    assertContains(html, "PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec", "install Codex first run");
    assertContains(html, "PREFLIGHT_SCOUT_LLM_PROVIDER=claude-exec", "install Claude Code first run");
    assertContains(html, "--agent codex", "install Codex runtime probe");
    assertContains(html, "--agent claude", "install Claude Code runtime probe");
    assertContains(html, "$env:PREFLIGHT_SCOUT_LLM_PROVIDER", "install PowerShell provider setup");
    assertContains(html, "restart the client and start a new task or session", "install plugin discovery restart");
    assertContains(html, `preflight-scout update-check --skill-version ${sitePackage.version}`, "install release compatibility check");
    assertContains(html, `@preflight-scout/cli@${sitePackage.version}`, "install exact current CLI version");
    assertContains(html, "codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable", "install Codex stable channel");
    assertContains(html, "claude plugin marketplace add fenutech/preflight-scout@plugin-stable", "install Claude Code stable channel");
    assertContains(html, "codex plugin marketplace upgrade preflight-scout", "install Codex update command");
    assertContains(html, "claude plugin update preflight-scout@preflight-scout", "install Claude Code update command");
    assertContains(html, `https://github.com/fenutech/preflight-scout/releases/tag/v${sitePackage.version}`, "install exact GitHub release gate");
    assertContains(html, "0.1.0", "install first-update bootstrap guidance");
    assertContains(html, "do not mix unreleased source with", "install source and stable-channel pairing guidance");
  }
  if (page.relative === "example-report/index.html") {
    assertContains(html, 'href="/example-report/report.html" target="_blank" rel="noopener noreferrer"', "sample report new-tab link");
  }
}

const robots = await readFile(path.join(out, "robots.txt"), "utf8");
assertContains(robots, "Allow: /", "robots.txt allow rule");
assertContains(robots, "Sitemap: https://preflightscout.com/sitemap.xml", "robots.txt sitemap");
if (/Disallow:\s*\/(?:example-report|licenses)/i.test(robots)) throw new Error("robots.txt must not hide noindex resources from crawlers");

const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort();
const expectedSitemapUrls = pages.map((page) => page.canonical).sort();
if (JSON.stringify(sitemapUrls) !== JSON.stringify(expectedSitemapUrls)) {
  throw new Error(`sitemap.xml URL set does not match the canonical page set: ${JSON.stringify(sitemapUrls)}`);
}
if (/<(?:changefreq|priority)>/i.test(sitemap)) throw new Error("sitemap.xml must not emit ignored changeFrequency or priority hints");

const sampleReport = await readFile(path.join(out, "example-report", "report.html"), "utf8");
const sourceSampleReport = await readFile(path.join(root, "..", "..", "examples", "sample-report", "report.html"), "utf8");
assertContains(sampleReport, "Preflight Scout Report", "full sample HTML report");
assertContains(sampleReport, '<meta name="robots" content="noindex, nofollow"', "sample report noindex");
if (sampleReport !== sourceSampleReport) throw new Error("The exported sample report must be byte-for-byte identical to the CLI-generated fixture");

const headers = await readFile(path.join(out, "_headers"), "utf8");
const home = await readFile(path.join(out, "index.html"), "utf8");
const jsonLd = home.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];
if (!jsonLd) throw new Error("Homepage JSON-LD is missing, so its Content Security Policy hash cannot be verified");
const jsonLdHash = `sha256-${createHash("sha256").update(jsonLd).digest("base64")}`;
for (const rule of [
  "/*",
  "Content-Security-Policy: default-src 'self'",
  "script-src 'self'",
  `'${jsonLdHash}'`,
  "frame-ancestors 'none'",
  "Permissions-Policy:",
  "Referrer-Policy: no-referrer",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "https://:project.pages.dev/*",
  "https://:version.:project.pages.dev/*",
  "/example-report/report.html",
  "/example-report/report\n  X-Robots-Tag: noindex, nofollow",
  "/example-report/auto-valid-promo/*",
  "/example-report/auto-expired-promo/*",
  "/licenses/*",
  "X-Robots-Tag: noindex"
]) assertContains(headers, rule, `_headers rule ${rule}`);

const scriptPolicy = headers.match(/Content-Security-Policy:[^\n]*script-src\s+([^;\n]+)/)?.[1] ?? "";
if (!scriptPolicy || /'unsafe-(?:inline|eval)'/.test(scriptPolicy)) {
  throw new Error("The public site script policy must remain self-only without unsafe-inline or unsafe-eval");
}

for (const relative of [
  "brand/instrument-frame.webp",
  "brand/instrument-texture.webp",
  "brand/preflight-scout-mark.png",
  "favicon.ico",
  "licenses/fonts-OFL.txt",
  "licenses/phosphor-MIT.txt",
  "manifest.webmanifest",
  "opengraph-image.png",
  "site.js"
]) {
  const content = await readFile(path.join(out, relative));
  if (!content.length) throw new Error(`Static website asset is empty: ${relative}`);
}

const socialImage = await readFile(path.join(out, "opengraph-image.png"));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (!socialImage.subarray(0, 8).equals(pngSignature)) throw new Error("opengraph-image.png is not a PNG");
if (socialImage.readUInt32BE(16) !== 1200 || socialImage.readUInt32BE(20) !== 630) {
  throw new Error("opengraph-image.png must be exactly 1200x630");
}

for (const relative of [
  "example-report/auto-expired-promo/console-errors.json",
  "example-report/auto-expired-promo/final-observation.json",
  "example-report/auto-expired-promo/network-errors.json",
  "example-report/auto-valid-promo/console-errors.json",
  "example-report/auto-valid-promo/final-observation.json",
  "example-report/auto-valid-promo/network-errors.json"
]) {
  const content = await readFile(path.join(out, relative), "utf8");
  JSON.parse(content);
}

console.log(`Verified ${pages.length} static pages, exact SEO metadata, local assets, and the noindex sample report boundary.`);

function assertContains(content, expected, label) {
  if (!content.includes(expected)) throw new Error(`${label} is missing ${expected}`);
}

function extractCanonical(html) {
  return html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/)?.[1] ?? "";
}

async function verifyInternalLinks(html, source) {
  const hrefs = [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((match) => match[1]);
  for (const href of hrefs) {
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const localPath = href.split("#", 1)[0].split("?", 1)[0] || "/";
    const relative = localPath === "/"
      ? "index.html"
      : localPath.endsWith("/")
        ? path.join(localPath.slice(1), "index.html")
        : localPath.slice(1);
    try {
      await readFile(path.join(out, relative));
    } catch {
      throw new Error(`${source} links to missing local target ${href}`);
    }
  }
}
