import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const suite = process.argv[2];
const browserTests = [
  "packages/browser-runner/src/auth-verification.test.ts",
  "packages/browser-runner/src/index.test.ts",
  "packages/browser-runner/src/pdf.test.ts",
  "packages/cli/src/generic-repo-smoke.test.ts"
];
const browserTestSet = new Set(browserTests);
const browserSignatures = [
  /@preflight-scout-requires-browser/,
  /\b(?:chromium|firefox|webkit)\s*\.\s*(?:launch|launchPersistentContext)\s*\(/,
  /\b(?:runBrowserMission|printHtmlReportToPdf|verifyStoredAuthentication)\s*\(/
];

if (suite !== "unit" && suite !== "browser") {
  throw new Error("Usage: node scripts/run-test-suite.mjs <unit|browser>");
}

await verifyBrowserTestClassification();

const require = createRequire(import.meta.url);
const vitestPackage = require.resolve("vitest/package.json");
const vitestCli = path.join(path.dirname(vitestPackage), "vitest.mjs");
const args = ["run"];
let emptyBrowserCache;

if (suite === "browser") {
  args.push(...browserTests);
  console.log(`Browser suite (${browserTests.length} files): ${browserTests.join(", ")}`);
} else {
  for (const file of browserTests) args.push("--exclude", file);
  // This makes the unit-suite boundary executable: a browser test that is not
  // classified above cannot accidentally pass by using a developer's cache.
  emptyBrowserCache = await mkdtemp(path.join(tmpdir(), "preflight-scout-no-browser-cache-"));
  console.log(`Unit suite: isolated browser cache; excluded ${browserTests.length} classified browser test files.`);
}

try {
  const exitCode = await run(process.execPath, [vitestCli, ...args], {
    ...process.env,
    ...(emptyBrowserCache ? { PLAYWRIGHT_BROWSERS_PATH: emptyBrowserCache } : {})
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  if (emptyBrowserCache) await rm(emptyBrowserCache, { recursive: true, force: true });
}

async function verifyBrowserTestClassification() {
  const testFiles = await collectTests(path.join(root, "packages"));
  const detected = new Set();

  for (const absoluteFile of testFiles) {
    const file = path.relative(root, absoluteFile).split(path.sep).join("/");
    const source = await readFile(absoluteFile, "utf8");
    if (browserSignatures.some((pattern) => pattern.test(source))) detected.add(file);
  }

  const missing = [...detected].filter((file) => !browserTestSet.has(file));
  const stale = browserTests.filter((file) => !detected.has(file));
  if (missing.length || stale.length) {
    const details = [
      ...missing.map((file) => `${file} launches a browser but is not classified in browserTests`),
      ...stale.map((file) => `${file} is classified as a browser test but lacks the browser marker/signature`)
    ];
    throw new Error(`Browser test suite classification is out of date:\n- ${details.join("\n- ")}`);
  }
}

async function collectTests(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectTests(file));
    else if (entry.name.endsWith(".test.ts")) output.push(file);
  }
  return output;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      shell: false,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Vitest terminated by signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}
