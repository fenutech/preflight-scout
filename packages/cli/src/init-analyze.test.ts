import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract } from "@preflight-scout/core";
import { createGenericDemoRepo } from "./demo.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.ts");

describe("init followed by analyze", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("replaces an unsafe init-model output directory and completes analysis in the guarded default", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-init-analyze-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD~1"], { cwd: demo.root });
    const agentLog = path.join(parent, "agent-calls.log");
    const agentScript = path.join(parent, "deterministic-init-analyze-agent.mjs");
    await writeFile(agentScript, deterministicAgentSource(agentLog), { encoding: "utf8", mode: 0o600 });
    const env = deterministicAgentEnv(agentScript);

    await runCli([
      "init",
      "--root", demo.root,
      "--force",
      "--target", "frontend",
      "--local-url", "http://localhost:3004",
      "--base", "origin/main",
      "--target-env", "local"
    ], env);

    const generated = await loadContract(demo.root);
    expect(generated.defaults?.outputDir).toBe(".preflight-scout/runs/latest");
    expect(generated.app.targets?.frontend?.localUrl).toBe("http://localhost:3004");

    await runCli([
      "analyze",
      "--root", demo.root,
      "--base", "origin/main",
      "--head", "HEAD",
      "--target", "frontend",
      "--env", "local"
    ], env);

    const outputDir = path.join(demo.root, ".preflight-scout", "runs", "latest");
    for (const artifact of ["analysis-manifest.json", "impact-map.json", "mission.json", "report.md", "report.html"]) {
      await expect(readFile(path.join(outputDir, artifact), "utf8")).resolves.not.toHaveLength(0);
    }
    await expect(readFile(agentLog, "utf8")).resolves.toBe("qa_contract\nimpact_map\nqa_mission\n");

    const staleResultsPath = path.join(outputDir, "run-results.json");
    await writeFile(staleResultsPath, `${JSON.stringify([{
      missionId: "stale-browser-mission",
      status: "passed",
      results: [{ stepId: "stale", status: "passed", message: "Old result" }],
      artifacts: []
    }], null, 2)}\n`);
    await runCli(["report", "--root", demo.root, "--run-dir", outputDir], env);
    await expect(access(staleResultsPath)).rejects.toThrow();
    const reportSummary = JSON.parse(await readFile(path.join(outputDir, "report-summary.json"), "utf8")) as {
      verdict: string;
      counts: { browserMissions: number };
    };
    expect(reportSummary).toMatchObject({
      verdict: "no_browser_evidence",
      counts: { browserMissions: 0 }
    });

    await expect(runCli([
      "promote",
      "--root", demo.root,
      "--base", "origin/main",
      "--head", "HEAD",
      "--run-dir", outputDir,
      "--dry-run"
    ], env)).rejects.toMatchObject({
      stderr: expect.stringContaining("no declared browser results")
    });
    await expect(readFile(agentLog, "utf8")).resolves.toBe("qa_contract\nimpact_map\nqa_mission\n");

    const missionPath = path.join(outputDir, "mission.json");
    const mission = JSON.parse(await readFile(missionPath, "utf8")) as { title: string };
    await writeFile(missionPath, `${JSON.stringify({ ...mission, title: "Tampered replay mission" }, null, 2)}\n`);
    await expect(runCli([
      "replay",
      "--root", demo.root,
      "--mission", missionPath,
      "--base", "origin/main",
      "--head", "HEAD",
      "--url", "http://127.0.0.1:3004"
    ], env)).rejects.toMatchObject({
      stderr: expect.stringContaining("mission.json no longer matches its reviewed digest")
    });
    await expect(readFile(agentLog, "utf8")).resolves.toBe("qa_contract\nimpact_map\nqa_mission\n");
  }, 30_000);

  it("keeps an init --url staging default runnable for a named target", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-init-staging-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD~1"], { cwd: demo.root });
    const agentLog = path.join(parent, "agent-calls.log");
    const agentScript = path.join(parent, "deterministic-init-staging-agent.mjs");
    await writeFile(agentScript, deterministicAgentSource(agentLog), { encoding: "utf8", mode: 0o600 });
    const env = deterministicAgentEnv(agentScript);

    await runCli([
      "init",
      "--root", demo.root,
      "--force",
      "--no-llm",
      "--target", "frontend",
      "--url", "https://staging.example.com",
      "--base", "origin/main",
      "--target-env", "staging"
    ], env);

    const generated = await loadContract(demo.root);
    expect(generated.app.targets?.frontend?.stagingUrl).toBe("https://staging.example.com");
    expect(generated.app.targets?.frontend?.url).toBeUndefined();

    await runCli([
      "analyze",
      "--root", demo.root,
      "--base", "origin/main",
      "--head", "HEAD",
      "--target", "frontend",
      "--env", "staging"
    ], env);

    const outputDir = path.join(demo.root, ".preflight-scout", "runs", "latest");
    await expect(readFile(path.join(outputDir, "report.html"), "utf8")).resolves.toContain("Preflight Scout Report");
    await expect(readFile(agentLog, "utf8")).resolves.toBe("impact_map\nqa_mission\n");
  }, 30_000);

  it.each(["analyze", "run"] as const)("%s rejects a legacy boundary-level output directory before starting model calls", async (command) => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-output-fail-fast-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    const configPath = path.join(demo.root, ".preflight-scout", "config.yml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "outputDir: .preflight-scout/runs/latest",
        "outputDir: .preflight-scout/runs"
      )
    );
    const marker = path.join(parent, "agent-started");
    const agentScript = path.join(parent, "must-not-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      command,
      "--root", demo.root,
      "--base", "HEAD~1",
      "--head", "HEAD"
    ], deterministicAgentEnv(agentScript))).rejects.toMatchObject({
      stderr: expect.stringContaining("must resolve to a directory beneath")
    });
    await expect(access(marker)).rejects.toThrow();
  }, 30_000);

  it.each(["analyze", "run"] as const)("%s rejects an explicit unignored in-repository output before starting model calls", async (command) => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-explicit-output-fail-fast-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    const marker = path.join(parent, "agent-started");
    const agentScript = path.join(parent, "must-not-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      command,
      "--root", demo.root,
      "--base", "HEAD~1",
      "--head", "HEAD",
      "--output-dir", "preflight-output"
    ], deterministicAgentEnv(agentScript))).rejects.toMatchObject({
      stderr: expect.stringContaining("must be untracked and ignored by Git")
    });
    await expect(access(marker)).rejects.toThrow();
  }, 30_000);

  it.each(["analyze", "run"] as const)("%s rejects a contents-only ignored output with a re-included report before starting model calls", async (command) => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-negated-output-fail-fast-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    await writeFile(
      path.join(demo.root, ".gitignore"),
      "preflight-output/*\n!preflight-output/report.md\n"
    );
    const marker = path.join(parent, "agent-started");
    const agentScript = path.join(parent, "must-not-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      command,
      "--root", demo.root,
      "--base", "HEAD~1",
      "--head", "HEAD",
      "--output-dir", "preflight-output"
    ], deterministicAgentEnv(agentScript))).rejects.toMatchObject({
      stderr: expect.stringContaining("must be untracked and ignored by Git")
    });
    await expect(access(marker)).rejects.toThrow();
  }, 30_000);

  it("keeps an explicitly selected external analysis directory reusable", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-external-analysis-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD~1"], { cwd: demo.root });
    const externalOutput = path.join(parent, "external-artifacts", "reviewed-run");
    const agentLog = path.join(parent, "agent-calls.log");
    const agentScript = path.join(parent, "deterministic-external-agent.mjs");
    await writeFile(agentScript, deterministicAgentSource(agentLog), { encoding: "utf8", mode: 0o600 });
    const env = deterministicAgentEnv(agentScript);

    await runCli([
      "analyze",
      "--root", demo.root,
      "--base", "origin/main",
      "--head", "HEAD",
      "--output-dir", externalOutput
    ], env);
    await runCli(["report", "--root", demo.root, "--run-dir", externalOutput], env);

    await expect(readFile(path.join(externalOutput, "analysis-manifest.json"), "utf8")).resolves.toContain(
      '"kind": "preflight-scout-analysis"'
    );
    await expect(readFile(path.join(externalOutput, "report.md"), "utf8")).resolves.toContain(
      "# Preflight Scout Report"
    );
  }, 30_000);
});

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    timeout: 25_000,
    maxBuffer: 1024 * 1024 * 8
  });
}

function deterministicAgentEnv(agentScript: string): NodeJS.ProcessEnv {
  return {
    PREFLIGHT_SCOUT_LLM_PROVIDER: "codex-exec",
    PREFLIGHT_SCOUT_EXEC_COMMAND: process.execPath,
    PREFLIGHT_SCOUT_EXEC_ARGS: JSON.stringify([agentScript]),
    PREFLIGHT_SCOUT_EXEC_TIMEOUT_MS: "10000",
    PREFLIGHT_SCOUT_PROGRESS: "0"
  };
}

function deterministicAgentSource(logPath: string): string {
  const contract = {
    app: { name: "Init analyze fixture", previewUrlSource: "manual" },
    defaults: { outputDir: ".preflight-scout/runs" },
    criticalFlows: ["checkout"],
    sensitiveAreas: ["pricing"],
    dangerousActions: { allowed: ["navigate"], requireApproval: [], forbidden: ["real_payment"] },
    testData: {},
    unknowns: []
  };
  const impactMap = {
    summary: "The change updates checkout promo validation.",
    risk: "medium",
    changedFiles: [{ path: "src/checkout.js", status: "modified" }],
    affectedRoutes: [{ path: "/", file: "index.html", kind: "page" }],
    affectedAreas: [{
      kind: "component",
      name: "Checkout promo form",
      evidence: ["src/checkout.js changes promo validation"],
      risk: "medium"
    }],
    suggestedRoles: ["guest"],
    unknowns: []
  };
  const mission = {
    id: "checkout-promo",
    title: "Check checkout promo validation",
    risk: "medium",
    summary: "Confirm the changed promo path still applies a valid coupon.",
    affectedAreas: impactMap.affectedAreas,
    manualChecklist: ["Apply SAVE10 and confirm the total changes."],
    edgeCases: ["Expired coupon"],
    automationCandidates: [{
      id: "valid-coupon",
      title: "Apply a valid coupon",
      role: "guest",
      startPath: "/",
      risk: "medium",
      reason: ["The diff changes promo validation."],
      steps: [{ id: "observe-checkout", instruction: "Observe the checkout form.", action: "observe" }]
    }],
    unknowns: []
  };
  return `import { appendFileSync } from "node:fs";\nlet input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => input += chunk);\nprocess.stdin.on("end", () => {\n  let schema;\n  let response;\n  if (input.includes('schema named "qa_contract"')) { schema = "qa_contract"; response = ${JSON.stringify(contract)}; }\n  else if (input.includes('schema named "impact_map"')) { schema = "impact_map"; response = ${JSON.stringify(impactMap)}; }\n  else if (input.includes('schema named "qa_mission"')) { schema = "qa_mission"; response = ${JSON.stringify(mission)}; }\n  else throw new Error("Unexpected Preflight Scout schema");\n  appendFileSync(${JSON.stringify(logPath)}, schema + "\\n");\n  process.stdout.write(JSON.stringify(response));\n});\n`;
}
