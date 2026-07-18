import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, ".preflight-scout", "package-check");
const workspacePackagesDir = path.join(root, "packages");
const packageEntries = await readdir(workspacePackagesDir, { withFileTypes: true });
const manifests = await Promise.all(packageEntries
  .filter((entry) => entry.isDirectory())
  .map(async (entry) => JSON.parse(await readFile(path.join(workspacePackagesDir, entry.name, "package.json"), "utf8"))));
const tarballs = Object.fromEntries(manifests.map((manifest) => [
  manifest.name,
  `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`
]));
const archiveSpecifiers = Object.fromEntries(Object.entries(tarballs).map(([name, file]) => [
  name,
  fileDependencySpecifier(file)
]));
const cliManifest = manifests.find((manifest) => manifest.name === "@preflight-scout/cli");
if (!cliManifest) throw new Error("Could not locate the @preflight-scout/cli source manifest.");
const pnpm = packageManagerInvocation();
const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-clean-install-"));
let server;

try {
  await writeFile(path.join(tempRoot, "package.json"), `${JSON.stringify({
    name: "preflight-scout-clean-install-smoke",
    private: true,
    type: "module",
    dependencies: archiveSpecifiers
  }, null, 2)}\n`);
  const overrides = Object.entries(archiveSpecifiers)
    .map(([name, specifier]) => `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`)
    .join("\n");
  await writeFile(path.join(tempRoot, "pnpm-workspace.yaml"), `overrides:\n${overrides}\n`);
  await execFileAsync(pnpm.command, [...pnpm.args, "install", "--prefer-offline"], commandOptions(tempRoot, 1024 * 1024 * 8, 180000));
  await assertInstalledPackages(manifests);

  const resolutionProbe = `
    import path from "node:path";
    import { fileURLToPath } from "node:url";
    import { verifyPackageDistBuildIdentity } from "@preflight-scout/core";
    for (const name of ${JSON.stringify(Object.keys(tarballs))}) {
      const resolved = import.meta.resolve(name);
      if (!resolved.startsWith("file:")) throw new Error(\`Could not resolve \${name}\`);
      const modulePath = fileURLToPath(resolved);
      const packageRoot = path.resolve(path.dirname(modulePath), "..");
      verifyPackageDistBuildIdentity(packageRoot, modulePath, name, ${JSON.stringify(cliManifest.version)});
    }
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", resolutionProbe], commandOptions(tempRoot));
  const version = await runPreflightScout(["--version"]);
  if (version.stdout.trim() !== cliManifest.version) throw new Error(`Installed preflight-scout reported unexpected version ${version.stdout.trim()}.`);
  const help = await runPreflightScout(["--help"]);
  if (!help.stdout.includes("Release QA for pull requests")) throw new Error("Installed preflight-scout CLI did not print the expected help text.");

  const demoRoot = path.join(tempRoot, "generic-shop");
  await runPreflightScout(["demo", "--output", demoRoot, "--force"]);
  for (const required of [".git", ".preflight-scout/config.yml", "index.html", "src/checkout.js"]) {
    await readFile(path.join(demoRoot, required === ".git" ? ".git/HEAD" : required));
  }

  const fakeAgent = path.join(tempRoot, "deterministic-agent.mjs");
  const fakeState = path.join(tempRoot, "browser-agent-state.json");
  await writeFile(fakeAgent, deterministicAgentSource(), { encoding: "utf8", mode: 0o600 });
  const agentEnv = {
    ...process.env,
    PREFLIGHT_SCOUT_LLM_PROVIDER: "codex-exec",
    PREFLIGHT_SCOUT_EXEC_COMMAND: process.execPath,
    PREFLIGHT_SCOUT_EXEC_ARGS: JSON.stringify([fakeAgent]),
    PREFLIGHT_SCOUT_EXEC_TIMEOUT_MS: "30000",
    PREFLIGHT_SCOUT_FAKE_STATE: fakeState,
    PREFLIGHT_SCOUT_PROGRESS: "0"
  };

  const analysisDir = path.join(demoRoot, ".preflight-scout", "runs", "packed-analysis");
  await runPreflightScout([
    "analyze", "--root", demoRoot, "--base", "HEAD~1", "--head", "HEAD",
    "--title", "Packed install smoke", "--output-dir", analysisDir
  ], agentEnv, 180000);
  await assertReportArtifacts(analysisDir, false);
  await runPreflightScout(["report", "--run-dir", analysisDir]);
  await assertReportArtifacts(analysisDir, false);

  server = createStaticServer(demoRoot);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Clean-install smoke server did not bind a TCP port.");
  const appUrl = `http://127.0.0.1:${address.port}`;

  if (process.env.PREFLIGHT_SCOUT_SMOKE_INSTALL_BROWSER === "1") {
    await runPreflightScout(["install-browser"], process.env, 600000);
  }
  const doctor = await runPreflightScoutAllowFailure([
    "doctor", "--root", demoRoot, "--base", "HEAD~1", "--head", "HEAD", "--url", appUrl, "--json"
  ], agentEnv, 60000);
  const doctorReport = JSON.parse(doctor.stdout);
  assertDoctorReport(doctorReport, process.env.PREFLIGHT_SCOUT_SMOKE_INSTALL_BROWSER === "1", doctor.exitCode);

  if (process.env.PREFLIGHT_SCOUT_SMOKE_INSTALL_BROWSER === "1") {
    await writeFile(fakeState, "0\n", "utf8");
    const runDir = path.join(demoRoot, ".preflight-scout", "runs", "packed-browser");
    await runPreflightScout([
      "run", "--root", demoRoot, "--analysis-dir", analysisDir, "--url", appUrl,
      "--output-dir", runDir, "--max-turns", "6"
    ], agentEnv, 300000);
    await assertReportArtifacts(runDir, true);
    const runResults = JSON.parse(await readFile(path.join(runDir, "run-results.json"), "utf8"));
    if (runResults.length !== 1 || runResults[0]?.status !== "passed" || !runResults[0]?.evidence?.tracePath) {
      throw new Error(`Packed CLI browser smoke did not produce one passed mission with trace evidence. Result: ${formatRunResultDiagnostic(runResults)}`);
    }
    const trace = await readFile(resolveRunArtifact(runDir, runResults[0].evidence.tracePath));
    if (!trace.length) throw new Error("Packed CLI browser smoke produced an empty trace artifact.");
    await runPreflightScout(["report", "--run-dir", runDir]);
    await assertReportArtifacts(runDir, true);
  }

  console.log(`Clean install smoke passed package resolution, CLI/version, generic demo, live analysis/report, doctor${process.env.PREFLIGHT_SCOUT_SMOKE_INSTALL_BROWSER === "1" ? ", and browser execution" : ""}.`);
} finally {
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function commandOptions(cwd, maxBuffer = 1024 * 1024 * 4, timeout = 60000, env = process.env) {
  return { cwd, maxBuffer, timeout, env };
}

async function runPreflightScout(args, env = process.env, timeout = 60000) {
  return execFileAsync(pnpm.command, [...pnpm.args, "exec", "preflight-scout", ...args], commandOptions(tempRoot, 1024 * 1024 * 16, timeout, env));
}

async function runPreflightScoutAllowFailure(args, env, timeout) {
  try {
    const result = await runPreflightScout(args, env, timeout);
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (typeof error?.stdout !== "string") throw error;
    return { stdout: error.stdout, stderr: typeof error.stderr === "string" ? error.stderr : "", exitCode: error.code ?? 1 };
  }
}

async function assertReportArtifacts(directory, expectResults) {
  for (const name of ["analysis-manifest.json", "impact-map.json", "mission.json", "report.md", "report.html"]) {
    const content = await readFile(path.join(directory, name), "utf8");
    if (!content.includes("Generic checkout") && (name === "report.md" || name === "report.html")) {
      throw new Error(`${name} from packed CLI smoke did not contain mission-specific report content.`);
    }
  }
  if (expectResults) await readFile(path.join(directory, "run-results.json"), "utf8");
}

async function assertInstalledPackages(expectedManifests) {
  for (const expected of expectedManifests) {
    const installedRoot = path.join(tempRoot, "node_modules", ...expected.name.split("/"));
    const installed = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
    if (installed.name !== expected.name || installed.version !== expected.version) {
      throw new Error(`Clean install resolved ${installed.name}@${installed.version} instead of ${expected.name}@${expected.version}.`);
    }
    for (const required of ["dist/index.js", "dist/index.d.ts"]) {
      await readFile(path.join(installedRoot, required));
    }
    const stamp = JSON.parse(await readFile(path.join(installedRoot, "dist", ".preflight-scout-build.json"), "utf8"));
    if (stamp.schemaVersion !== 3 || stamp.packageName !== expected.name || stamp.packageVersion !== expected.version || !/^sha256:[0-9a-f]{64}$/.test(stamp.packageRuntimeHash) || !/^sha256:[0-9a-f]{64}$/.test(stamp.sourceHash)) {
      throw new Error(`Clean install found an invalid build-integrity stamp for ${expected.name}.`);
    }
  }
}

function assertDoctorReport(report, browserRequired, exitCode) {
  if (!Array.isArray(report?.checks)) throw new Error("Packed CLI doctor did not return its machine-readable check list.");
  for (const id of ["git_repo", "git_refs", "contract", "llm_provider", "target_url", "storage_state_ignore"]) {
    const check = report.checks.find((candidate) => candidate.id === id);
    if (!check || check.status !== "pass") throw new Error(`Packed CLI doctor did not pass required check ${id}.`);
  }
  const playwrightCheck = report.checks.find((check) => check.id === "playwright");
  if (!playwrightCheck || !new Set(["pass", "fail"]).has(playwrightCheck.status)) {
    throw new Error("Packed CLI doctor did not report a definitive Playwright check.");
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (report.ok !== (failures.length === 0)) {
    throw new Error("Packed CLI doctor JSON did not reconcile its ok flag with failed checks.");
  }
  if ((failures.length === 0 && exitCode !== 0) || (failures.length > 0 && exitCode === 0)) {
    throw new Error(`Packed CLI doctor exit code ${exitCode} did not match its failed checks.`);
  }
  if (browserRequired) {
    if (!report.ok || failures.length || playwrightCheck.status !== "pass") {
      throw new Error("Packed CLI doctor did not validate the installed Chromium runtime.");
    }
  } else if (failures.some((check) => check.id !== "playwright")) {
    throw new Error(`Packed CLI doctor had an unexpected failure: ${failures.map((check) => check.id).join(", ")}.`);
  }
}

function resolveRunArtifact(runDir, artifactPath) {
  if (
    typeof artifactPath !== "string"
    || !artifactPath
    || path.posix.isAbsolute(artifactPath)
    || artifactPath.includes("\\")
    || artifactPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Packed CLI browser smoke returned an unsafe trace artifact path.");
  }
  const root = path.resolve(runDir);
  const candidate = path.resolve(root, ...artifactPath.split("/"));
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Packed CLI browser smoke returned a trace artifact outside its run directory.");
  }
  return candidate;
}

function fileDependencySpecifier(file) {
  const archivePath = path.resolve(packageDir, file).split(path.sep).join("/");
  return `file:${archivePath}`;
}

function packageManagerInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && path.isAbsolute(npmExecPath) && /pnpm/i.test(path.basename(npmExecPath))) {
    return { command: process.execPath, args: [npmExecPath] };
  }
  if (process.platform === "win32") {
    throw new Error("On Windows, run the clean-install smoke through `pnpm smoke:install` so pnpm can be invoked without a command shell.");
  }
  return { command: "pnpm", args: [] };
}

function createStaticServer(repoRoot) {
  return createServer(async (request, response) => {
    try {
      const requestPath = request.url === "/" ? "/index.html" : request.url ?? "/index.html";
      const candidate = path.resolve(repoRoot, requestPath.replace(/^\/+/, ""));
      if (candidate !== repoRoot && !candidate.startsWith(`${repoRoot}${path.sep}`)) throw new Error("unsafe path");
      const body = await readFile(candidate);
      response.writeHead(200, { "content-type": candidate.endsWith(".js") ? "text/javascript" : "text/html" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
}

function deterministicAgentSource() {
  const impactMap = {
    summary: "The PR changes generic checkout promo validation and expired coupon feedback.",
    risk: "medium",
    changedFiles: [
      { path: "index.html", status: "modified" },
      { path: "src/checkout.js", status: "modified" }
    ],
    affectedRoutes: [{ path: "/", file: "index.html", kind: "page" }],
    affectedAreas: [{
      kind: "component",
      name: "Generic checkout promo form",
      evidence: ["index.html and src/checkout.js change promo feedback"],
      risk: "medium"
    }],
    suggestedRoles: ["guest"],
    unknowns: []
  };
  const mission = {
    id: "generic-checkout-promo",
    title: "Validate generic checkout promo feedback",
    risk: "medium",
    summary: "Confirm the changed promo code behavior still discounts valid coupons.",
    affectedAreas: impactMap.affectedAreas,
    manualChecklist: ["Apply SAVE10 and verify the total changes to $90.00."],
    edgeCases: ["Expired coupon", "Empty coupon"],
    automationCandidates: [{
      id: "generic-valid-coupon",
      title: "Generic checkout valid coupon",
      role: "guest",
      startPath: "/",
      risk: "medium",
      reason: ["The changed checkout JavaScript controls promo discount behavior."],
      steps: [{
        id: "fill-valid-coupon",
        instruction: "Enter the reviewed valid coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "SAVE10"
      }, {
        id: "apply-valid-coupon",
        instruction: "Apply the reviewed coupon.",
        action: "click",
        policyLabel: "click",
        target: "testid=apply-promo"
      }, {
        id: "verify-discounted-total",
        instruction: "Verify the discounted total.",
        action: "assert_text",
        target: "text=Total: $90.00",
        expected: "Total: $90.00"
      }]
    }],
    unknowns: []
  };
  const browserDecisions = [
    { thought: "Enter the valid coupon.", action: "fill", missionStepId: "fill-valid-coupon", target: "testid=promo-code", value: "SAVE10", reason: "Use the configured demo coupon." },
    { thought: "Apply the coupon.", action: "click", missionStepId: "apply-valid-coupon", target: "testid=apply-promo", reason: "Trigger the changed promo logic." },
    { thought: "Verify the discounted total.", action: "assert", missionStepId: "verify-discounted-total", target: "text=Total: $90.00", reason: "The valid coupon should discount the cart." },
    { thought: "The evidence is sufficient.", action: "finish_pass", reason: "Generic checkout promo behavior passed." }
  ];
  return `import { readFileSync, writeFileSync } from "node:fs";\nlet input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => input += chunk);\nprocess.stdin.on("end", () => {\n  let response;\n  if (input.includes('schema named "impact_map"')) response = ${JSON.stringify(impactMap)};\n  else if (input.includes('schema named "qa_mission"')) response = ${JSON.stringify(mission)};\n  else if (input.includes('schema named "browser_decision"')) {\n    const statePath = process.env.PREFLIGHT_SCOUT_FAKE_STATE;\n    const turn = statePath ? Number.parseInt(readFileSync(statePath, "utf8").trim() || "0", 10) : 0;\n    response = ${JSON.stringify(browserDecisions)}[Math.min(turn, ${browserDecisions.length - 1})];\n    if (statePath) writeFileSync(statePath, String(turn + 1));\n  } else throw new Error("Unexpected Preflight Scout schema");\n  process.stdout.write(JSON.stringify(response));\n});\n`;
}

function formatRunResultDiagnostic(runResults) {
  const bounded = Array.isArray(runResults)
    ? runResults.slice(0, 3).map((result) => ({
        missionId: diagnosticText(result?.missionId),
        status: diagnosticText(result?.status),
        results: Array.isArray(result?.results)
          ? result.results.slice(0, 20).map((step) => ({
              stepId: diagnosticText(step?.stepId),
              status: diagnosticText(step?.status),
              message: diagnosticText(step?.message)
            }))
          : [],
        evidence: {
          trace: typeof result?.evidence?.tracePath === "string",
          console: typeof result?.evidence?.consolePath === "string",
          network: typeof result?.evidence?.networkPath === "string",
          finalObservation: typeof result?.evidence?.finalObservationPath === "string"
        }
      }))
    : { kind: typeof runResults };
  return JSON.stringify(bounded).slice(0, 12_000);
}

function diagnosticText(value) {
  if (typeof value !== "string") return undefined;
  let safe = value;
  const secrets = Object.entries(process.env)
    .filter(([key, secret]) => secret && (/(TOKEN|KEY|SECRET|PASSWORD|PASS|API|AUTH|CREDENTIAL|COOKIE|SESSION|HEADER|PROXY)/i.test(key) && secret.length >= 8
      || /^PREFLIGHT_SCOUT_BROWSER_[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:EMAIL|USERNAME|PASSWORD)$/.test(key)))
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED_ENV_SECRET]");
  return safe
    .replace(/(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]+/g, "[REDACTED_SECRET]")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_SECRET]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_SECRET]")
    .replace(/npm_[A-Za-z0-9]{30,}/g, "[REDACTED_SECRET]")
    .replace(/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_SECRET]")
    .replaceAll("\0", "�")
    .slice(0, 2_000);
}
