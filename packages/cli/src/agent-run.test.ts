import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAnalysisProvenance,
  createTrustedGit,
  loadContract,
  resolveTrustedGitCommit,
  writeAnalysisArtifacts,
  type ImpactMap,
  type QAMission
} from "@preflight-scout/core";
import { createGenericDemoRepo } from "./demo.js";
import { CLI_ANALYSIS_RUNTIME } from "./analysis.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.ts");

describe("agent-run CLI", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("advertises reviewed analysis reuse in command help", async () => {
    const { stdout } = await runCli(["agent-run", "--help"]);

    expect(stdout).toContain("--analysis-dir <path>");
    expect(stdout).toContain("reuse a provenance-bound directory");
  });

  it("delegates the reviewed mission when ref aliases resolve to the exact bound commits", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-run-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    const analysisDir = path.join(demo.root, ".preflight-scout", "runs", "reviewed");
    await mkdir(analysisDir, { recursive: true });
    await writeReviewedAnalysis(demo.root, analysisDir, reviewedAnalysis());
    const promptCapture = path.join(parent, "reviewed-agent-prompt.txt");
    const agentScript = path.join(parent, "print-agent-prompt.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(promptCapture)}, process.argv.at(-1) ?? ""); console.log("reviewed prompt received");\n`);

    await runCli([
      "agent-run",
      "--root", demo.root,
      "--analysis-dir", ".preflight-scout/runs/reviewed",
      "--base", "HEAD~1",
      "--head", "HEAD",
      "--agent", "custom",
      "--command", process.execPath,
      "--arg", agentScript
    ]);

    const capturedPrompt = await readFile(promptCapture, "utf8");
    expect(capturedPrompt).toContain('"id": "reviewed-mission"');
    expect(capturedPrompt).toContain('"id": "reviewed-flow"');
  }, 15_000);

  it("rejects an unresolved reviewed ref before the delegated agent starts", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-run-ref-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo") });
    const analysisDir = path.join(demo.root, ".preflight-scout", "runs", "reviewed");
    await writeReviewedAnalysis(demo.root, analysisDir, reviewedAnalysis());
    const marker = path.join(parent, "agent-started");
    const agentScript = path.join(parent, "mark-agent-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      "agent-run",
      "--root", demo.root,
      "--analysis-dir", ".preflight-scout/runs/reviewed",
      "--base", "missing-ref-that-must-be-resolved",
      "--agent", "custom",
      "--command", process.execPath,
      "--arg", agentScript
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("missing-ref-that-must-be-resolved") });
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects an analysis directory copied from another repository before delegation", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-run-foreign-"));
    tempDirs.push(parent);
    const source = await createGenericDemoRepo({ output: path.join(parent, "source") });
    const target = await createGenericDemoRepo({ output: path.join(parent, "target") });
    const sourceAnalysis = path.join(source.root, ".preflight-scout", "runs", "reviewed");
    const targetAnalysis = path.join(target.root, ".preflight-scout", "runs", "reviewed");
    await writeReviewedAnalysis(source.root, sourceAnalysis, reviewedAnalysis());
    await cp(sourceAnalysis, targetAnalysis, { recursive: true });
    const marker = path.join(parent, "foreign-agent-started");
    const agentScript = path.join(parent, "mark-foreign-agent-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      "agent-run",
      "--root", target.root,
      "--analysis-dir", ".preflight-scout/runs/reviewed",
      "--base", "HEAD~1",
      "--agent", "custom",
      "--command", process.execPath,
      "--arg", agentScript
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("different repository") });
    await expect(access(marker)).rejects.toThrow();
  }, 15_000);

  it("forwards only selected role credentials and no unrelated host secrets to a custom agent", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-env-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo"), scenario: "auth-dashboard" });
    const analysisDir = path.join(demo.root, ".preflight-scout", "runs", "reviewed");
    await writeFile(path.join(demo.root, ".preflight-scout", "config.yml"), `app:
  name: Agent environment fixture
  localUrl: http://127.0.0.1:4173
auth:
  roles:
    qa_user:
      usernameEnv: PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL
      passwordEnv: PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD
    unselected_admin:
      usernameEnv: OPENAI_API_KEY
dangerousActions:
  allowed: []
  requireApproval: []
  forbidden: []
criticalFlows: []
sensitiveAreas: []
testData: {}
unknowns: []
`);
    await writeReviewedAnalysis(demo.root, analysisDir, reviewedAnalysis("qa_user"));
    const agentScript = path.join(parent, "inspect-agent-env.mjs");
    await writeFile(agentScript, `
const prompt = process.argv.at(-1) ?? "";
console.log(JSON.stringify({
  emailReady: process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL === "qa@example.com",
  passwordReady: process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD === "test-password",
  awsPresent: process.env.AWS_SECRET_ACCESS_KEY !== undefined,
  githubPresent: process.env.GH_TOKEN !== undefined,
  openaiPresent: process.env.OPENAI_API_KEY !== undefined,
  unselectedMappingPresent: prompt.includes("OPENAI_API_KEY")
}));
`);

    const { stdout } = await runCli([
      "agent-run",
      "--root", demo.root,
      "--analysis-dir", ".preflight-scout/runs/reviewed",
      "--base", "HEAD~1",
      "--agent", "custom",
      "--command", process.execPath,
      "--arg", agentScript
    ], {
      PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL: "qa@example.com",
      PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD: "test-password",
      AWS_SECRET_ACCESS_KEY: "unrelated-cloud-secret",
      GH_TOKEN: "unrelated-github-token",
      OPENAI_API_KEY: "unrelated-provider-key"
    });

    expect(stdout).toContain('"emailReady":true');
    expect(stdout).toContain('"passwordReady":true');
    expect(stdout).toContain('"awsPresent":false');
    expect(stdout).toContain('"githubPresent":false');
    expect(stdout).toContain('"openaiPresent":false');
    expect(stdout).toContain('"unselectedMappingPresent":false');
  }, 15_000);

  it("rejects a malicious selected-role credential mapping before agent-run starts", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-malicious-role-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo"), scenario: "auth-dashboard" });
    const analysisDir = path.join(demo.root, ".preflight-scout", "runs", "reviewed");
    await writeFile(path.join(demo.root, ".preflight-scout", "config.yml"), maliciousCredentialContract());
    await writeReviewedAnalysis(demo.root, analysisDir, reviewedAnalysis("qa_user"));
    const marker = path.join(parent, "agent-started");
    const agentScript = path.join(parent, "mark-agent-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      "agent-run",
      "--root", demo.root,
      "--analysis-dir", ".preflight-scout/runs/reviewed",
      "--base", "HEAD~1",
      "--agent", "custom",
      "--command", process.execPath,
      "--arg", agentScript
    ], { OPENAI_API_KEY: "must-not-become-browser-input" })).rejects.toMatchObject({
      stderr: expect.stringContaining("not an authorized dedicated browser credential")
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects an unsafe contract app URL before a delegated agent starts", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-url-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo"), scenario: "auth-dashboard" });
    const analysisDir = path.join(demo.root, ".preflight-scout", "runs", "reviewed");
    const configPath = path.join(demo.root, ".preflight-scout", "config.yml");
    await writeFile(configPath, (await readFile(configPath, "utf8")).replace(
      "localUrl: http://127.0.0.1:4173",
      "localUrl: data:text/plain,private"
    ));
    await writeReviewedAnalysis(demo.root, analysisDir, reviewedAnalysis("qa_user"));
    const marker = path.join(parent, "agent-started");
    const agentScript = path.join(parent, "mark-agent-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      "agent-run",
      "--root", demo.root,
      "--analysis-dir", ".preflight-scout/runs/reviewed",
      "--agent", "custom",
      "--command", process.execPath,
      "--arg", agentScript
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("App URL must use http: or https:") });
    await expect(access(marker)).rejects.toThrow();
  });

  it("filters delegated-auth environment and redacts credential values in output artifacts", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-auth-env-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo"), scenario: "auth-dashboard" });
    const agentScript = path.join(parent, "auth-agent.mjs");
    await writeFile(agentScript, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const prompt = process.argv.at(-1) ?? "";
const storage = prompt.match(/Storage state output:\\n([^\\n]+)/)?.[1]?.trim();
if (!storage) throw new Error("missing storage output");
mkdirSync(path.dirname(storage), { recursive: true });
writeFileSync(storage, JSON.stringify({ cookies: [], origins: [] }));
console.log(JSON.stringify({
  emailReady: process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL === "qa@example.com",
  awsPresent: process.env.AWS_SECRET_ACCESS_KEY !== undefined
}) + " " + process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL);
console.log("PREFLIGHT_SCOUT_AUTH_VERIFIED=1");
console.error(process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD);
`);

    await runCli([
      "auth", "login",
      "--root", demo.root,
      "--agent", "custom",
      "--role", "qa_user",
      "--allow-blocked",
      "--command", process.execPath,
      "--arg", agentScript
    ], {
      PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL: "qa@example.com",
      PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD: "test-password",
      AWS_SECRET_ACCESS_KEY: "unrelated-cloud-secret"
    });

    const stdoutArtifact = await readFile(path.join(demo.root, ".preflight-scout", "runs", "auth", "qa_user", "agent-stdout.md"), "utf8");
    const stderrArtifact = await readFile(path.join(demo.root, ".preflight-scout", "runs", "auth", "qa_user", "agent-stderr.log"), "utf8");
    expect(stdoutArtifact).toContain('"emailReady":true');
    expect(stdoutArtifact).toContain('"awsPresent":false');
    expect(stdoutArtifact).toContain("[REDACTED_ENV_SECRET]");
    expect(stdoutArtifact).not.toContain("qa@example.com");
    expect(stderrArtifact).toContain("[REDACTED_ENV_SECRET]");
    expect(stderrArtifact).not.toContain("test-password");
    const metadata = await readFile(path.join(demo.root, ".preflight-scout", "auth", "qa_user.json.preflight-scout.json"), "utf8");
    expect(metadata).toContain('"status": "invalid"');
    expect(metadata).toContain("Authenticated state verification failed");
  });

  it("rejects a malicious delegated-auth credential mapping before the custom agent starts", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-auth-malicious-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo"), scenario: "auth-dashboard" });
    await writeFile(path.join(demo.root, ".preflight-scout", "config.yml"), maliciousCredentialContract());
    const marker = path.join(parent, "auth-agent-started");
    const agentScript = path.join(parent, "mark-auth-agent-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    await expect(runCli([
      "auth", "login",
      "--root", demo.root,
      "--agent", "custom",
      "--role", "qa_user",
      "--command", process.execPath,
      "--arg", agentScript
    ], { OPENAI_API_KEY: "must-not-become-browser-input" })).rejects.toMatchObject({
      stderr: expect.stringContaining("not an authorized dedicated browser credential")
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects and does not disclose credential-bearing app URLs before delegated auth starts", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-auth-url-"));
    tempDirs.push(parent);
    const demo = await createGenericDemoRepo({ output: path.join(parent, "repo"), scenario: "auth-dashboard" });
    const configPath = path.join(demo.root, ".preflight-scout", "config.yml");
    await writeFile(configPath, (await readFile(configPath, "utf8")).replace(
      "localUrl: http://127.0.0.1:4173",
      "localUrl: https://delegated-user:delegated-pass@example.invalid/private"
    ));
    const marker = path.join(parent, "auth-agent-started");
    const agentScript = path.join(parent, "mark-auth-agent-start.mjs");
    await writeFile(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");\n`);

    let thrown: unknown;
    try {
      await runCli([
        "auth", "login",
        "--root", demo.root,
        "--agent", "custom",
        "--role", "qa_user",
        "--command", process.execPath,
        "--arg", agentScript
      ]);
    } catch (error) {
      thrown = error;
    }
    const stderr = String((thrown as { stderr?: unknown })?.stderr ?? thrown);
    expect(stderr).toContain("App URL must not contain embedded credentials");
    expect(stderr).not.toContain("delegated-user");
    expect(stderr).not.toContain("delegated-pass");
    await expect(access(marker)).rejects.toThrow();
  });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PREFLIGHT_SCOUT_LLM_PROVIDER: "none", ...env }
  });
}

async function writeReviewedAnalysis(
  root: string,
  analysisDir: string,
  artifacts: { impactMap: ImpactMap; mission: QAMission }
): Promise<void> {
  const contract = await loadContract(root);
  const git = await createTrustedGit({ targetRoot: root });
  const [baseCommit, headCommit] = await Promise.all([
    resolveTrustedGitCommit(git, root, "HEAD~1"),
    resolveTrustedGitCommit(git, root, "HEAD")
  ]);
  const provenance = await createAnalysisProvenance({
    root,
    baseCommit,
    headCommit,
    contract,
    analysisRuntime: CLI_ANALYSIS_RUNTIME
  });
  await writeAnalysisArtifacts(analysisDir, { boundary: root, ...artifacts, provenance });
}

function reviewedAnalysis(role?: string): { impactMap: ImpactMap; mission: QAMission } {
  const impactMap: ImpactMap = {
    summary: "Reviewed impact",
    risk: "high",
    changedFiles: [{ path: "src/reviewed.ts", status: "modified" }],
    affectedRoutes: [],
    affectedAreas: [{ kind: "component", name: "Reviewed flow", evidence: ["src/reviewed.ts"], risk: "high" }],
    suggestedRoles: [],
    unknowns: []
  };
  return {
    impactMap,
    mission: {
      id: "reviewed-mission",
      title: "Reviewed mission",
      risk: "high",
      summary: "Use the exact reviewed mission",
      affectedAreas: impactMap.affectedAreas,
      manualChecklist: [],
      edgeCases: [],
      automationCandidates: [{
        id: "reviewed-flow",
        title: "Reviewed flow",
        ...(role ? { role } : {}),
        risk: "high",
        reason: ["Approved during review"],
        steps: [{ id: "observe-reviewed", instruction: "Observe the reviewed flow", action: "observe" }]
      }],
      unknowns: []
    }
  };
}

function maliciousCredentialContract(): string {
  return `app:
  name: Malicious credential fixture
  localUrl: http://127.0.0.1:4173
auth:
  roles:
    qa_user:
      usernameEnv: OPENAI_API_KEY
      passwordEnv: PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD
      signedInTarget: testid=user-menu
dangerousActions:
  allowed: []
  requireApproval: []
  forbidden: []
criticalFlows: []
sensitiveAreas: []
testData: {}
unknowns: []
`;
}
