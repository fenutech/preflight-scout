import { inspect } from "node:util";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as processTree from "@preflight-scout/core";
import {
  AGENT_OUTPUT_LIMIT_CHARS,
  AgentExecError,
  buildAgentEnvironment,
  renderAgentCapabilityProbePrompt,
  renderAgentPrompt,
  renderAuthLoginPrompt,
  resolveAgentCommand,
  runAgentCapabilityProbe,
  runAgentExecution
} from "./index.js";

const contract = {
  app: { name: "Example" },
  criticalFlows: [],
  sensitiveAreas: [],
  dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
  testData: {},
  unknowns: []
};

const mission = {
  id: "mission-1",
  title: "Validate checkout",
  risk: "high" as const,
  summary: "Checkout changed.",
  affectedAreas: [],
  manualChecklist: [],
  edgeCases: [],
  automationCandidates: [],
  unknowns: []
};

describe("renderAgentPrompt", () => {
  it("includes the target URL, contract, and mission", () => {
    const prompt = renderAgentPrompt({
      kind: "codex",
      appUrl: "https://preview.example.com",
      contract: { ...contract, criticalFlows: ["checkout"], sensitiveAreas: ["payments"] },
      mission
    });

    expect(prompt).toContain("https://preview.example.com");
    expect(prompt).toContain("Validate checkout");
    expect(prompt).toContain("Do not use hardcoded heuristics");
    expect(prompt).toContain("MUST execute browser work");
    expect(prompt).toContain("Do not create or modify GitHub/GitLab issues");
    expect(prompt).toContain("Do not push, publish, deploy");
  });

  it("includes storage-state output instructions for delegated auth", () => {
    const prompt = renderAgentPrompt({
      kind: "codex",
      appUrl: "https://preview.example.com",
      storageStateOutput: ".preflight-scout/auth/qa_user.json",
      evidenceDir: ".preflight-scout/runs/auth/qa_user",
      contract: { ...contract, criticalFlows: ["login"], sensitiveAreas: ["auth"] },
      mission: { ...mission, id: "auth", title: "Authenticate", risk: "medium", summary: "Login." }
    });

    expect(prompt).toContain("save Playwright storageState JSON to: .preflight-scout/auth/qa_user.json");
    expect(prompt).toContain("Write screenshots, traces, notes, or other evidence under this directory");
    expect(prompt).toContain(".preflight-scout/runs/auth/qa_user");
    expect(prompt).toContain("current URL");
  });

  it("redacts embedded contract and mission secrets before prompt transport", () => {
    const embeddedSecret = ["sk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const prompt = renderAgentPrompt({
      kind: "codex",
      appUrl: "https://preview.example.com",
      contract: { ...contract, testData: { unsafe_fixture: embeddedSecret } },
      mission: { ...mission, summary: `Never transport ${embeddedSecret}` }
    });

    expect(prompt).not.toContain(embeddedSecret);
    expect(prompt).toContain("[REDACTED_SECRET]");
  });
});

describe("renderAuthLoginPrompt", () => {
  it("renders a minimal login-only prompt without QA contract noise", () => {
    const prompt = renderAuthLoginPrompt({
      kind: "codex",
      appUrl: "http://127.0.0.1:5173",
      role: "qa_user",
      usernameEnv: "PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL",
      passwordEnv: "PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD",
      signedInTarget: "testid=user-menu",
      storageStateOutput: ".preflight-scout/auth/qa_user.json",
      evidenceDir: ".preflight-scout/runs/auth/qa_user",
      startPath: "/"
    });

    expect(prompt).toContain("You are tasked with logging into this app");
    expect(prompt).toContain("http://127.0.0.1:5173");
    expect(prompt).toContain("PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL");
    expect(prompt).toContain("PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD");
    expect(prompt).toContain("Do not create a new user");
    expect(prompt).toContain("save Playwright storageState JSON exactly");
    expect(prompt).toContain("testid=user-menu");
    expect(prompt).toContain("PREFLIGHT_SCOUT_AUTH_VERIFIED=1");
    expect(prompt).toContain("Open only the reviewed app URL and reviewed login start path");
    expect(prompt).toContain("Primary cause:");
    expect(prompt).not.toContain("QA Contract");
    expect(prompt).not.toContain("criticalFlows");
  });
});

describe("agent capability probe", () => {
  it("uses a minimal no-tools prompt that does not claim browser QA ran", () => {
    const prompt = renderAgentCapabilityProbePrompt();

    expect(prompt).toContain("PREFLIGHT_SCOUT_AGENT_");
    expect(prompt).toContain("RUNTIME=ready");
    expect(prompt).not.toContain("PREFLIGHT_SCOUT_AGENT_RUNTIME=ready");
    expect(prompt).toContain("Do not use browser, network, shell, MCP, filesystem, or any other tool");
    expect(prompt).toContain("does not run browser QA");
    expect(prompt).not.toContain("Target app URL");
    expect(prompt).not.toContain("QA Contract");
    expect(prompt).not.toContain("Mission:");
  });

  it("executes a bounded non-interactive readiness probe", async () => {
    const result = await runAgentCapabilityProbe({
      kind: "custom",
      cwd: process.cwd(),
      command: process.execPath,
      args: ["-e", "console.log('PREFLIGHT_SCOUT_AGENT_RUNTIME=ready')"],
      timeoutMs: 1000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PREFLIGHT_SCOUT_AGENT_RUNTIME=ready");
  });
});

describe("resolveAgentCommand", () => {
  it("passes built-in agent prompts over stdin by default", () => {
    const command = resolveAgentCommand({
      kind: "codex",
      appUrl: "https://preview.example.com",
      contract,
      mission
    }, "secret mission prompt");

    expect(command.args).toContain("exec");
    expect(command.args).toContain("--sandbox");
    expect(command.args).toContain("workspace-write");
    expect(command.args).toContain("--ephemeral");
    expect(command.args.at(-1)).toBe("-");
    expect(command.input).toBe("secret mission prompt");
    expect(command.promptTransport).toBe("stdin");
  });

  it("adds provider sandbox controls to built-in agent commands", () => {
    const claude = resolveAgentCommand({ kind: "claude", appUrl: "https://preview.example.com", contract, mission }, "prompt");
    const gemini = resolveAgentCommand({ kind: "gemini", appUrl: "https://preview.example.com", contract, mission }, "prompt");

    expect(claude.args).toContain("--disallowedTools");
    expect(claude.args.join(" ")).toContain("Bash(gh:*)");
    expect(gemini.args).toContain("--sandbox");
  });

  it("propagates configured model and reasoning flags to built-in agents", () => {
    const previousModel = process.env.PREFLIGHT_SCOUT_EXEC_MODEL;
    const previousEffort = process.env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT;
    process.env.PREFLIGHT_SCOUT_EXEC_MODEL = "test-model";
    process.env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT = "high";
    try {
      const codex = resolveAgentCommand({ kind: "codex", appUrl: "https://preview.example.com", contract, mission }, "prompt");
      const claude = resolveAgentCommand({ kind: "claude", appUrl: "https://preview.example.com", contract, mission }, "prompt");
      const boundedProbe = resolveAgentCommand({
        kind: "codex",
        reasoningEffort: "low",
        executionProfile: "capability-probe",
        promptTransport: "argv"
      }, "probe prompt");
      const claudeProbe = resolveAgentCommand({
        kind: "claude",
        reasoningEffort: "low",
        executionProfile: "capability-probe",
        promptTransport: "argv"
      }, "probe prompt");
      const geminiProbe = resolveAgentCommand({
        kind: "gemini",
        executionProfile: "capability-probe",
        promptTransport: "argv",
        toolDenyPolicyPath: "/tmp/preflight-scout-deny-tools.toml"
      }, "probe prompt");

      expect(codex.args).toEqual(expect.arrayContaining(["-m", "test-model", "-c", "model_reasoning_effort=\"high\""]));
      expect(claude.args).toEqual(expect.arrayContaining(["--model", "test-model", "--effort", "high"]));
      expect(boundedProbe.args).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=\"low\""]));
      expect(boundedProbe.args).not.toContain("model_reasoning_effort=\"high\"");
      expect(boundedProbe.args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "--disable", "plugins", "--sandbox", "read-only"]));
      expect(boundedProbe.args).not.toContain("workspace-write");
      expect(boundedProbe.args).not.toContain("sandbox_policy.network_access=enabled");
      expect(boundedProbe.args.at(-1)).toBe("probe prompt");
      expect(boundedProbe.input).toBeUndefined();
      expect(claudeProbe.args).toEqual(expect.arrayContaining([
        "--safe-mode", "--no-chrome", "--strict-mcp-config", "--tools", "", "--disable-slash-commands", "--permission-mode", "plan"
      ]));
      expect(claudeProbe.args).not.toContain("--disallowedTools");
      expect(geminiProbe.args).toEqual(expect.arrayContaining([
        "--sandbox", "--approval-mode", "plan", "--allowed-mcp-server-names", "__preflight_scout_no_mcp__", "--admin-policy", "/tmp/preflight-scout-deny-tools.toml"
      ]));
    } finally {
      if (previousModel === undefined) delete process.env.PREFLIGHT_SCOUT_EXEC_MODEL;
      else process.env.PREFLIGHT_SCOUT_EXEC_MODEL = previousModel;
      if (previousEffort === undefined) delete process.env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT;
      else process.env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT = previousEffort;
    }
  });
});

describe("runAgentExecution", () => {
  it("builds a kind-specific minimal environment with only selected role credentials", () => {
    const sourceEnv = {
      PATH: "/trusted/bin",
      HOME: "/trusted/home",
      OPENAI_API_KEY: "codex-auth-key",
      ANTHROPIC_API_KEY: "claude-auth-key",
      GEMINI_API_KEY: "gemini-auth-key",
      AWS_SECRET_ACCESS_KEY: "unrelated-cloud-secret",
      GH_TOKEN: "unrelated-github-token",
      PREFLIGHT_SCOUT_BROWSER_QA_EMAIL: "qa@example.com",
      PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "short"
    };

    expect(buildAgentEnvironment("codex", {
      sourceEnv,
      credentialEnvNames: ["PREFLIGHT_SCOUT_BROWSER_QA_EMAIL", "PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD"]
    })).toMatchObject({
      PATH: "/trusted/bin",
      HOME: "/trusted/home",
      OPENAI_API_KEY: "codex-auth-key",
      PREFLIGHT_SCOUT_BROWSER_QA_EMAIL: "qa@example.com",
      PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "short",
      PREFLIGHT_SCOUT_DELEGATED_SANDBOX: "1"
    });
    expect(buildAgentEnvironment("codex", { sourceEnv })).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(buildAgentEnvironment("codex", { sourceEnv })).not.toHaveProperty("GEMINI_API_KEY");
    expect(buildAgentEnvironment("codex", { sourceEnv })).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(buildAgentEnvironment("codex", { sourceEnv })).not.toHaveProperty("GH_TOKEN");
    expect(buildAgentEnvironment("custom", { sourceEnv })).not.toHaveProperty("OPENAI_API_KEY");
    expect(() => buildAgentEnvironment("custom", {
      sourceEnv,
      credentialEnvNames: ["OPENAI_API_KEY"]
    })).toThrow("not an authorized dedicated browser credential");
  });

  it("uses a minimal environment for custom agents and redacts selected credentials on success", async () => {
    const previousAws = process.env.AWS_SECRET_ACCESS_KEY;
    const previousEmail = process.env.PREFLIGHT_SCOUT_BROWSER_QA_EMAIL;
    const previousPassword = process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD;
    process.env.AWS_SECRET_ACCESS_KEY = "unrelated-cloud-secret";
    process.env.PREFLIGHT_SCOUT_BROWSER_QA_EMAIL = "qa@example.com";
    process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD = "short";
    try {
      const result = await runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: [
          "-e",
          "console.log(JSON.stringify({ aws: process.env.AWS_SECRET_ACCESS_KEY ?? null, email: process.env.PREFLIGHT_SCOUT_BROWSER_QA_EMAIL ?? null })); console.error(process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD ?? 'missing')"
        ],
        env: buildAgentEnvironment("custom", {
          credentialEnvNames: ["PREFLIGHT_SCOUT_BROWSER_QA_EMAIL", "PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD"]
        }),
        timeoutMs: 1000
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"aws":null');
      expect(result.stdout).toContain("[REDACTED_ENV_SECRET]");
      expect(result.stdout).not.toContain("qa@example.com");
      expect(result.stderr).toContain("[REDACTED_ENV_SECRET]");
      expect(result.stderr).not.toContain("short");
      expect(result.command).toBe("[command redacted]");
      expect(result.args.every((arg) => arg.includes("redacted"))).toBe(true);
    } finally {
      if (previousAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previousAws;
      if (previousEmail === undefined) delete process.env.PREFLIGHT_SCOUT_BROWSER_QA_EMAIL;
      else process.env.PREFLIGHT_SCOUT_BROWSER_QA_EMAIL = previousEmail;
      if (previousPassword === undefined) delete process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD;
      else process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD = previousPassword;
    }
  });

  it("does not inherit unrelated host secrets when a custom agent omits env", async () => {
    const previousAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "unrelated-cloud-secret";
    try {
      const result = await runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({ aws: process.env.AWS_SECRET_ACCESS_KEY ?? null }))"],
        timeoutMs: 1000
      });

      expect(result.stdout).toContain('"aws":null');
    } finally {
      if (previousAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = previousAws;
    }
  });

  it.skipIf(process.platform === "win32")("excludes the target repository from built-in agent lookup when execution cwd is elsewhere", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-path-"));
    const target = path.join(temp, "target");
    const executionDir = path.join(temp, "artifacts");
    const maliciousBin = path.join(target, "node_modules", ".bin");
    const trustedBin = path.join(temp, "trusted-bin");
    const maliciousMarker = path.join(temp, "malicious-ran");
    const capturedPath = path.join(temp, "trusted-path");
    const fakeAgent = path.join(trustedBin, "codex");
    const maliciousAgent = path.join(maliciousBin, "codex");
    const providerSecret = "trusted-provider-secret-7f12";
    const browserSecret = "selected-browser-secret-9a31";

    try {
      await mkdir(path.join(target, ".git"), { recursive: true });
      await mkdir(executionDir, { recursive: true });
      await mkdir(maliciousBin, { recursive: true });
      await mkdir(trustedBin, { recursive: true });
      await writeFile(
        maliciousAgent,
        `#!/bin/sh\nprintf malicious > ${JSON.stringify(maliciousMarker)}\nprintf malicious-agent\\n\n`
      );
      await writeFile(
        fakeAgent,
        [
          "#!/bin/sh",
          `printf '%s' \"$PATH\" > ${JSON.stringify(capturedPath)}`,
          `if [ \"$OPENAI_API_KEY\" = ${JSON.stringify(providerSecret)} ] && [ \"$PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD\" = ${JSON.stringify(browserSecret)} ]; then`,
          "  printf 'trusted-agent-auth-present\\n'",
          "else",
          "  printf 'trusted-agent-auth-missing\\n'",
          "fi",
          ""
        ].join("\n")
      );
      await chmod(maliciousAgent, 0o755);
      await chmod(fakeAgent, 0o755);

      const result = await runAgentExecution({
        kind: "codex",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        cwd: executionDir,
        targetRoot: target,
        args: [],
        env: {
          PATH: [maliciousBin, trustedBin, process.env.PATH ?? ""].join(path.delimiter),
          HOME: process.env.HOME,
          OPENAI_API_KEY: providerSecret,
          PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: browserSecret
        },
        timeoutMs: 1000
      });

      expect(result.stdout).toContain("trusted-agent-auth-present");
      await expect(access(maliciousMarker)).rejects.toThrow();
      expect(await readFile(capturedPath, "utf8")).not.toContain(target);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("redacts a delegated agent prompt when the child echoes stdin", async () => {
    const result = await runAgentExecution({
      kind: "custom",
      appUrl: "https://private-preview.example.com/customer-acme",
      contract,
      mission: { ...mission, title: "Private customer launch path" },
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      promptTransport: "stdin",
      timeoutMs: 1000
    });

    expect(result.stdout).toContain("[REDACTED_PROMPT_ECHO]");
    expect(result.stdout).not.toContain("private-preview.example.com");
    expect(result.stdout).not.toContain("Private customer launch path");
    expect(result.stdout).not.toContain("QA Contract:");
  });

  it("never transports an embedded token to a delegated child", async () => {
    const embeddedSecret = ["sk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const result = await runAgentExecution({
      kind: "custom",
      appUrl: "https://preview.example.com",
      contract: { ...contract, testData: { unsafe_fixture: embeddedSecret } },
      mission,
      command: process.execPath,
      args: [
        "-e",
        "let input=''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log('RAW_SECRET_RECEIVED=' + input.includes('sk_' + 'live_' + 'abcdefghijklmnopqrstuvwxyz' + '123456')))"
      ],
      promptTransport: "stdin",
      timeoutMs: 1000
    });

    expect(result.stdout).toContain("RAW_SECRET_RECEIVED=false");
    expect(result.stdout).not.toContain(embeddedSecret);
  });

  it("buffers streamed signal lines before redacting a secret split across chunks", async () => {
    const secret = "split-stream-secret-52a9";
    const messages: string[] = [];
    await runAgentExecution({
      kind: "custom",
      appUrl: "https://preview.example.com",
      contract,
      mission,
      command: process.execPath,
      args: [
        "-e",
        "const value=process.env.ONLY_STREAM_SECRET; process.stdout.write('PREFLIGHT_SCOUT_AGENT_PROGRESS=' + value.slice(0, 8)); setTimeout(() => process.stdout.write(value.slice(8) + '\\n'), 20)"
      ],
      env: { ...process.env, ONLY_STREAM_SECRET: secret },
      streamOutput: "signals",
      onProgress: (message) => messages.push(message),
      timeoutMs: 1000
    });

    expect(messages.join("\n")).toContain("[REDACTED_ENV_SECRET]");
    expect(messages.join("\n")).not.toContain(secret);
  });

  it("keeps success output bounded when redacting a very short credential", async () => {
    const credentialName = "PREFLIGHT_SCOUT_BROWSER_SHORT_PASSWORD";
    const result = await runAgentExecution({
      kind: "custom",
      appUrl: "https://preview.example.com",
      contract,
      mission,
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(100000))"],
      env: buildAgentEnvironment("custom", {
        sourceEnv: { [credentialName]: "x" },
        credentialEnvNames: [credentialName]
      }),
      timeoutMs: 1000
    });

    expect(result.stdout.length).toBeLessThanOrEqual(AGENT_OUTPUT_LIMIT_CHARS / 2);
    expect(result.stdout).toContain("[REDACTED_ENV_SECRET]");
    expect(result.stdout).not.toContain("x");
  });

  it("terminates the delegated process tree when combined output exceeds the capture bound", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-output-tree-"));
    const marker = path.join(temp, "grandchild-survived");
    const grandchildScript = `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 1200)`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" }); process.stdout.write("x".repeat(${AGENT_OUTPUT_LIMIT_CHARS + 10_000})); setInterval(() => {}, 1000)`;
    let thrown: unknown;
    try {
      try {
        await runAgentExecution({
          kind: "custom",
          appUrl: "https://preview.example.com",
          contract,
          mission,
          command: process.execPath,
          args: ["-e", parentScript],
          timeoutMs: 5000
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AgentExecError);
      const error = thrown as AgentExecError;
      expect(error.timedOut).toBe(false);
      expect(error.message).toContain("output limit");
      expect(error.result.stdout.length).toBeLessThan(2200);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("terminates the delegated process tree on timeout", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "preflight-scout-agent-group-"));
    const marker = path.join(temp, "grandchild-survived");
    const grandchildScript = `const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 800)`;
    const parentScript = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000)`;

    try {
      await expect(runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: ["-e", parentScript],
        timeoutMs: 200,
        heartbeatMs: 50
      })).rejects.toBeInstanceOf(AgentExecError);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("waits for bounded process-tree cleanup and returns only safe cleanup diagnostics", async () => {
    let releaseCleanup = () => undefined;
    let markCleanupStarted = () => undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const terminator = vi.spyOn(processTree, "terminateProcessTree").mockImplementation(async (child, signal) => {
      markCleanupStarted();
      (child as unknown as { emit(event: string, error: Error): boolean }).emit(
        "error",
        Object.assign(new Error("private cleanup detail must stay hidden"), { code: "ESRCH" })
      );
      await cleanupGate;
      child.kill(signal);
      return {
        confirmed: false,
        diagnostic: "Bounded process-tree cleanup could not be confirmed."
      };
    });

    try {
      let settled = false;
      const outcome = runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 50,
        heartbeatMs: 10
      }).then(
        () => undefined,
        (error: unknown) => error
      ).finally(() => {
        settled = true;
      });

      await cleanupStarted;
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      releaseCleanup();

      const error = await outcome;
      expect(error).toBeInstanceOf(AgentExecError);
      expect((error as AgentExecError).message).toContain("Bounded process-tree cleanup could not be confirmed.");
      expect((error as AgentExecError).message).toContain("subprocess emitted ESRCH during cleanup");
      expect((error as AgentExecError).message).not.toContain("private cleanup detail");
    } finally {
      releaseCleanup();
      terminator.mockRestore();
    }
  });

  it("emits heartbeats and rejects when delegated agents time out", async () => {
    const messages: string[] = [];

    await expect(runAgentExecution({
      kind: "custom",
      appUrl: "https://preview.example.com",
      contract,
      mission,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 500)"],
      timeoutMs: 50,
      heartbeatMs: 10,
      onProgress: (message) => messages.push(message)
    })).rejects.toThrow(/agent command timed out after .* \[agent command; 3 args\]/);

    expect(messages.some((message) => message.includes("Started custom agent command"))).toBe(true);
    expect(messages.some((message) => message.includes("Waiting for custom agent command"))).toBe(true);
    expect(messages.join("\n")).not.toContain("Target app URL");
  });

  it("preserves and redacts captured output when a delegated agent times out", async () => {
    const previousSecret = process.env.PREFLIGHT_SCOUT_TEST_PASSWORD;
    process.env.PREFLIGHT_SCOUT_TEST_PASSWORD = "super-secret-value";
    const messages: string[] = [];
    let thrown: unknown;
    try {
      await runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: [
          "-e",
          "console.log('Primary cause: simulated stalled runtime'); console.error('x'.repeat(6000) + process.env.PREFLIGHT_SCOUT_TEST_PASSWORD); setInterval(() => {}, 1000)",
          "argv-mission-secret"
        ],
        env: { ...process.env },
        timeoutMs: 1000,
        heartbeatMs: 50,
        onProgress: (message) => messages.push(message)
      });
    } catch (error) {
      thrown = error;
    } finally {
      if (previousSecret === undefined) delete process.env.PREFLIGHT_SCOUT_TEST_PASSWORD;
      else process.env.PREFLIGHT_SCOUT_TEST_PASSWORD = previousSecret;
    }

    expect(thrown).toBeInstanceOf(AgentExecError);
    const error = thrown as AgentExecError;
    expect(error.timedOut).toBe(true);
    expect(error.primaryCause).toBe("simulated stalled runtime");
    expect(error.result.stdout).toContain("Primary cause: simulated stalled runtime");
    expect(error.result.stderr).toContain("[REDACTED_ENV_SECRET]");
    expect(error.result.stderr).not.toContain("super-secret-value");
    expect(error.result.stderr.length).toBeLessThan(2200);
    expect(error.result.args.every((arg) => arg.includes("redacted"))).toBe(true);
    expect(error.message).toContain("Captured stdout");
    expect(error.message).toContain("Captured stderr");
    expect(error.message).toContain("[REDACTED_ENV_SECRET]");
    expect(error.message).not.toContain("super-secret-value");
    const publicRepresentations = [error.message, String(error), inspect(error, { depth: 10 }), JSON.stringify(error)].join("\n");
    expect(publicRepresentations).not.toContain("super-secret-value");
    expect(publicRepresentations).not.toContain("argv-mission-secret");
    expect(publicRepresentations).not.toContain("Target app URL:");
    expect(publicRepresentations).toContain("[REDACTED_ENV_SECRET]");
    expect(JSON.stringify(error).length).toBeLessThan(7000);
    expect(messages.some((message) => message.includes("terminating it"))).toBe(true);
    expect(messages.some((message) => message.includes("captured"))).toBe(true);
  });

  it("redacts secrets supplied only through the child-process environment", async () => {
    const key = "ONLY_CUSTOM_SECRET";
    const previous = process.env[key];
    const secret = "only-in-options-env-secret-7f2c";
    const messages: string[] = [];
    let thrown: unknown;
    delete process.env[key];
    try {
      await runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: [
          "-e",
          `console.log('Primary cause: ' + process.env.${key}); setInterval(() => {}, 1000)`
        ],
        env: { ...process.env, [key]: secret },
        timeoutMs: 1000,
        heartbeatMs: 50,
        streamOutput: "signals",
        onProgress: (message) => messages.push(message)
      });
    } catch (error) {
      thrown = error;
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }

    expect(thrown).toBeInstanceOf(AgentExecError);
    const error = thrown as AgentExecError;
    const publicRepresentations = [
      error.message,
      error.primaryCause,
      error.result.stdout,
      error.result.stderr,
      String(error),
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      ...messages
    ].join("\n");
    expect(publicRepresentations).not.toContain(secret);
    expect(publicRepresentations).toContain("[REDACTED_ENV_SECRET]");
  });

  it("does not retain raw argv or spawn metadata when a command cannot start", async () => {
    let thrown: unknown;
    try {
      await runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: "command-name-secret-not-installed-4f973f",
        args: ["raw-argv-secret"],
        timeoutMs: 1000
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentExecError);
    const error = thrown as AgentExecError;
    const publicRepresentations = [error.message, String(error), inspect(error, { depth: 10 }), JSON.stringify(error)].join("\n");
    expect(publicRepresentations).not.toContain("raw-argv-secret");
    expect(publicRepresentations).not.toContain("command-name-secret");
    expect(publicRepresentations).not.toContain("Target app URL:");
    expect(error.result.args.every((arg) => arg.includes("redacted"))).toBe(true);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("can stream redacted delegated agent output into progress", async () => {
    process.env.PREFLIGHT_SCOUT_TEST_PASSWORD = "super-secret-value";
    const messages: string[] = [];
    try {
      await runAgentExecution({
        kind: "custom",
        appUrl: "https://preview.example.com",
        contract,
        mission,
        command: process.execPath,
        args: ["-e", "console.log(process.env.PREFLIGHT_SCOUT_TEST_PASSWORD)"],
        env: { ...process.env },
        timeoutMs: 1000,
        heartbeatMs: 100,
        streamOutput: true,
        onProgress: (message) => messages.push(message)
      });
    } finally {
      delete process.env.PREFLIGHT_SCOUT_TEST_PASSWORD;
    }

    expect(messages.join("\n")).toContain("[REDACTED_ENV_SECRET]");
    expect(messages.join("\n")).not.toContain("super-secret-value");
  });
});
