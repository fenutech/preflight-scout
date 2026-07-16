import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenericDemoRepo } from "./demo.js";
import { checkLlmProvider, renderDoctorReport, runDoctor } from "./doctor.js";

const execFileAsync = promisify(execFile);

describe("doctor", () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-doctor-"));
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it("reports setup checks for a generic repo", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";

    const report = await runDoctor({
      root: demo.root,
      base: demo.base,
      head: demo.head,
      url: demo.appUrl,
      timeoutMs: 100
    });
    const text = renderDoctorReport(report);

    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["git_repo", "git_refs", "local_env_file", "contract", "llm_provider", "storage_state_ignore", "target_url", "playwright"]));
    expect(report.checks.find((check) => check.id === "git_refs")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "llm_provider")?.status).toBe("pass");
    expect(["pass", "warn"]).toContain(report.checks.find((check) => check.id === "target_url")?.status);
    expect(report.checks.find((check) => check.id === "storage_state_ignore")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "local_env_file")?.status).toBe("pass");
    expect(text).toContain("Preflight Scout Doctor");
  });

  it("gives a valid initialization command when the QA contract is missing", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    await rm(path.join(demo.root, ".preflight-scout", "config.yml"));
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";

    const report = await runDoctor({
      root: demo.root,
      base: demo.base,
      head: demo.head,
      timeoutMs: 100,
      checkBrowser: async () => undefined
    });
    const contractCheck = report.checks.find((check) => check.id === "contract");

    expect(contractCheck).toMatchObject({ status: "warn" });
    expect(contractCheck?.message).toContain("Run preflight-scout init.");
    expect(contractCheck?.message).not.toContain("--write");
  });

  it("does not interpret an option-shaped base revision as a Git diff option", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    const marker = path.join(dir, "doctor-git-output.txt");

    const report = await runDoctor({
      root: demo.root,
      base: `--output=${marker}`,
      head: demo.head,
      timeoutMs: 100,
      checkBrowser: async () => undefined
    });

    expect(report.checks.find((check) => check.id === "git_refs")?.status).toBe("fail");
    await expect(access(marker)).rejects.toThrow();
  });

  it.each([
    ["file URL", "file:///tmp/preflight-scout-secret", "must use http: or https:"],
    ["data URL", "data:text/plain,preflight-scout-secret", "must use http: or https:"],
    ["embedded credentials", "https://doctor-user:doctor-pass@example.invalid/private", "must not contain embedded credentials"]
  ])("refuses a %s before making a target request", async (_label, unsafeUrl, expectedDetail) => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const report = await runDoctor({
      root: demo.root,
      url: unsafeUrl,
      timeoutMs: 100,
      checkBrowser: async () => undefined
    });

    const targetCheck = report.checks.find((check) => check.id === "target_url");
    expect(targetCheck).toMatchObject({ status: "fail", message: "Refused unsafe target URL." });
    expect(targetCheck?.detail).toContain(expectedDetail);
    expect(fetchMock).not.toHaveBeenCalled();
    const rendered = renderDoctorReport(report);
    expect(rendered).not.toContain("doctor-user");
    expect(rendered).not.toContain("doctor-pass");
  });

  it("redacts and caps target request failures", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    const marker = "doctor-fetch-marker-e81b34";
    vi.stubEnv("PRIVATE_API_TOKEN", marker);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(`${marker}${"x".repeat(5000)}`);
    }));

    const report = await runDoctor({
      root: demo.root,
      url: "https://example.invalid/health",
      timeoutMs: 100,
      checkBrowser: async () => undefined
    });

    const targetCheck = report.checks.find((check) => check.id === "target_url");
    expect(targetCheck?.status).toBe("warn");
    expect(targetCheck?.detail).toContain("[REDACTED_ENV_SECRET]");
    expect(targetCheck?.detail).toContain("diagnostic truncated");
    expect(targetCheck?.detail).not.toContain(marker);
    expect(targetCheck?.detail?.length).toBeLessThanOrEqual(1000);
  });

  it("does not follow or expose an off-origin target redirect", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://outside.example/private" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const report = await runDoctor({
      root: demo.root,
      url: "https://example.invalid/health",
      timeoutMs: 100,
      checkBrowser: async () => undefined
    });

    expect(report.checks.find((check) => check.id === "target_url")).toMatchObject({
      status: "fail",
      message: "Refused an off-origin redirect during the connectivity check."
    });
    expect(fetchMock).toHaveBeenCalledWith("https://example.invalid/health", expect.objectContaining({ redirect: "manual" }));
  });

  it("fails when no LLM provider is configured", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    delete process.env.PREFLIGHT_SCOUT_LLM_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const report = await runDoctor({ root: demo.root, timeoutMs: 100 });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "llm_provider")?.status).toBe("fail");
  });

  it.each([
    ["openai", { ANTHROPIC_API_KEY: "wrong-key" }, "fail", "OPENAI_API_KEY"],
    ["anthropic", { OPENAI_API_KEY: "wrong-key" }, "fail", "ANTHROPIC_API_KEY"],
    ["gemini", { ANTHROPIC_API_KEY: "wrong-key" }, "fail", "GEMINI_API_KEY"],
    ["codex-exec", {}, "pass", "Configured provider codex-exec"],
    ["unknown-provider", { OPENAI_API_KEY: "wrong-key" }, "fail", "Unsupported"],
    ["none", { OPENAI_API_KEY: "wrong-key" }, "fail", "explicitly disabled"]
  ] as const)("validates exact provider/key pairing for %s", (provider, keys, status, message) => {
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "PREFLIGHT_SCOUT_MODEL"]) {
      delete process.env[key];
    }
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = provider;
    Object.assign(process.env, keys);

    expect(checkLlmProvider()).toMatchObject({ status, message: expect.stringContaining(message) });
  });

  it("reports and does not load a tracked local environment file", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    await writeFile(path.join(demo.root, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_APP_URL=https://mutated.example",
      "PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec",
      "PREFLIGHT_SCOUT_EXEC_COMMAND=./repo-script",
      "PREFLIGHT_SCOUT_OPENAI_BASE_URL=https://attacker.example"
    ].join("\n"));
    await execFileAsync("git", ["add", "--force", ".env.preflight-scout.local"], { cwd: demo.root });
    delete process.env.PREFLIGHT_SCOUT_APP_URL;
    delete process.env.PREFLIGHT_SCOUT_LLM_PROVIDER;
    delete process.env.PREFLIGHT_SCOUT_EXEC_COMMAND;
    delete process.env.PREFLIGHT_SCOUT_OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "trusted-existing-key";

    const report = await runDoctor({ root: demo.root, timeoutMs: 100, checkBrowser: async () => undefined });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "local_env_file")).toMatchObject({
      status: "fail",
      message: "Refused to load the configured environment file."
    });
    expect(process.env.PREFLIGHT_SCOUT_APP_URL).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_LLM_PROVIDER).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_EXEC_COMMAND).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe("trusted-existing-key");
  });

  it("fails when an OpenAI-compatible gateway has no explicit model", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "openai-compatible";
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.PREFLIGHT_SCOUT_MODEL;

    const report = await runDoctor({ root: demo.root, timeoutMs: 100, checkBrowser: async () => undefined });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "llm_provider")).toMatchObject({
      status: "fail",
      message: "OpenAI-compatible gateway is missing PREFLIGHT_SCOUT_MODEL."
    });
  });

  it("fails an auth role that maps provider secrets as browser credentials", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop"), scenario: "auth-dashboard" });
    const configPath = path.join(demo.root, ".preflight-scout", "config.yml");
    const config = (await readFile(configPath, "utf8"))
      .replace("PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL", "OPENAI_API_KEY")
      .replace("PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD", "AWS_SECRET_ACCESS_KEY");
    await writeFile(configPath, config);
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    process.env.OPENAI_API_KEY = "provider-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "cloud-secret";

    const report = await runDoctor({ root: demo.root, timeoutMs: 100, checkBrowser: async () => undefined });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "credentials:qa_user")).toMatchObject({
      status: "fail"
    });
    expect(report.checks.find((check) => check.id === "credentials:qa_user")?.message).toContain("invalid browser credential environment mappings");
  });

  it("can check delegated agent runtime when requested", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    process.env.OPENAI_API_KEY = "openai-probe-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-probe-secret";
    process.env.GEMINI_API_KEY = "gemini-probe-secret";
    process.env.GOOGLE_API_KEY = "google-probe-secret";
    const progress: string[] = [];
    const capturePath = path.join(dir, "delegated-probe-capture.json");

    const report = await runDoctor({
      root: demo.root,
      timeoutMs: 100,
      agent: "custom",
      agentCommand: process.execPath,
      agentArgs: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), env: process.env })); console.log('PREFLIGHT_SCOUT_AGENT_RUNTIME=ready')",
        capturePath
      ],
      agentTimeoutMs: 1000,
      checkBrowser: async () => undefined,
      onProgress: (message) => progress.push(message)
    });

    const runtimeCheck = report.checks.find((check) => check.id === "delegated_agent_runtime");
    expect(runtimeCheck?.status).toBe("pass");
    expect(runtimeCheck?.message).toContain("isolated temporary directory");
    expect(runtimeCheck?.message).toContain("agent execution only");
    expect(runtimeCheck?.message).toContain("delegated browser QA was not run");
    expect(runtimeCheck?.message).not.toContain("can reach");
    expect(progress.some((message) => message.includes("Started custom agent command"))).toBe(true);
    expect(progress.some((message) => message.includes("agent command exited with 0"))).toBe(true);

    const capture = JSON.parse(await readFile(capturePath, "utf8")) as { cwd: string; env: Record<string, string> };
    const relativeFromRoot = path.relative(demo.root, capture.cwd);
    const relativeFromProbe = path.relative(capture.cwd, demo.root);
    expect(relativeFromRoot === "" || (!relativeFromRoot.startsWith(`..${path.sep}`) && relativeFromRoot !== "..")).toBe(false);
    expect(relativeFromProbe === "" || (!relativeFromProbe.startsWith(`..${path.sep}`) && relativeFromProbe !== "..")).toBe(false);
    await expect(access(capture.cwd)).rejects.toThrow();
    expect(capture.env.PREFLIGHT_SCOUT_DELEGATED_SANDBOX).toBe("1");
    expect(capture.env.OPENAI_API_KEY).toBeUndefined();
    expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capture.env.GEMINI_API_KEY).toBeUndefined();
    expect(capture.env.GOOGLE_API_KEY).toBeUndefined();
    const unexpectedEnv = Object.keys(capture.env).filter((key) => !/^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|COLORTERM|LANG|LC_.+|TZ|CI|NO_COLOR|FORCE_COLOR|__CF_USER_TEXT_ENCODING|CODEX_HOME|CLAUDE_CONFIG_DIR|GEMINI_CLI_HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_STATE_HOME|PLAYWRIGHT_BROWSERS_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PREFLIGHT_SCOUT_DELEGATED_SANDBOX)$/i.test(key));
    expect(unexpectedEnv).toEqual([]);
  });

  it("passes only the selected built-in agent authentication to the isolated doctor probe", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    process.env.OPENAI_API_KEY = "openai-selected-probe-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-unrelated-probe-secret";
    process.env.GEMINI_API_KEY = "gemini-unrelated-probe-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "cloud-unrelated-probe-secret";
    const capturePath = path.join(dir, "codex-probe-env.json");

    const report = await runDoctor({
      root: demo.root,
      timeoutMs: 100,
      agent: "codex",
      agentCommand: process.execPath,
      agentArgs: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env)); console.log('PREFLIGHT_SCOUT_AGENT_RUNTIME=ready')",
        capturePath
      ],
      agentTimeoutMs: 1000,
      checkBrowser: async () => undefined
    });

    expect(report.checks.find((check) => check.id === "delegated_agent_runtime")?.status).toBe("pass");
    const capturedEnv = JSON.parse(await readFile(capturePath, "utf8")) as Record<string, string>;
    expect(capturedEnv.OPENAI_API_KEY).toBe("openai-selected-probe-secret");
    expect(capturedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedEnv.GEMINI_API_KEY).toBeUndefined();
    expect(capturedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("reports redacted captured diagnostics and a primary cause on delegated timeout", async () => {
    const demo = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    process.env.PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec";
    process.env.OPENAI_API_KEY = "doctor-super-secret-value";
    const progress: string[] = [];
    const outputSecret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

    const report = await runDoctor({
      root: demo.root,
      timeoutMs: 100,
      agent: "custom",
      agentCommand: process.execPath,
      agentArgs: [
        "-e",
        `console.log('Primary cause: simulated delegated stall'); console.error('${outputSecret}'); setInterval(() => {}, 1000)`
      ],
      agentTimeoutMs: 750,
      checkBrowser: async () => undefined,
      onProgress: (message) => progress.push(message)
    });

    const runtimeCheck = report.checks.find((check) => check.id === "delegated_agent_runtime");
    expect(runtimeCheck?.status).toBe("fail");
    expect(runtimeCheck?.message).toContain("bounded runtime probe");
    expect(runtimeCheck?.detail).toContain("Primary cause: simulated delegated stall");
    expect(runtimeCheck?.detail).toContain("Captured stdout");
    expect(runtimeCheck?.detail).toContain("Captured stderr");
    expect(runtimeCheck?.detail).toContain("[REDACTED_SECRET]");
    expect(runtimeCheck?.detail).not.toContain(outputSecret);
    expect(runtimeCheck?.detail).not.toContain("doctor-super-secret-value");
    expect(progress.some((message) => message.includes("terminating it"))).toBe(true);
    expect(progress.some((message) => message.includes("captured"))).toBe(true);
  });
});
