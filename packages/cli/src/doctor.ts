import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppUrlValidationError, browserCredentialKindForEnvName, createTrustedGit, loadContract, redactText, resolveTargetUrl, resolveTrustedGitCommit, validateAppUrl, type QAContract, type TrustedGit } from "@preflight-scout/core";
import { AgentExecError, runAgentCapabilityProbe, type AgentExecKind, type AgentExecResult } from "@preflight-scout/agent-exec";
import { loadEnvFile } from "./local.js";

const execFileAsync = promisify(execFile);
const DELEGATED_DOCTOR_TIMEOUT_CAP_MS = 30000;
const MAX_DOCTOR_DIAGNOSTIC_CHARS = 1000;
const GEMINI_DENY_ALL_TOOLS_POLICY = `[[rule]]
toolName = "*"
decision = "deny"
priority = 999
denyMessage = "Preflight Scout doctor capability probes do not permit tool use."
`;

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  root: string;
  envFile?: string;
  base?: string;
  head?: string;
  url?: string;
  target?: string;
  env?: string;
  timeoutMs?: number;
  checkMcp?: boolean;
  checkBrowser?: () => Promise<void>;
  agent?: AgentExecKind;
  agentCommand?: string;
  agentArgs?: string[];
  agentTimeoutMs?: number;
  onProgress?: (message: string) => void;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const root = path.resolve(options.root);
  const checks: DoctorCheck[] = [];
  const envFile = options.envFile ?? ".env.preflight-scout.local";
  let loadedEnvPath: string | undefined;
  let envLoadError: unknown;
  try {
    loadedEnvPath = await loadEnvFile(root, envFile);
  } catch (error) {
    envLoadError = error;
  }
  const contract = await loadContract(root);
  const git = createTrustedGit({ targetRoot: root });

  checks.push(await checkGitRepo(root, git));
  checks.push(await checkLocalEnvFile(root, envFile, loadedEnvPath, envLoadError, git));
  if (options.base || options.head) checks.push(await checkGitRefs(root, options.base ?? "origin/main", options.head ?? "HEAD", git));
  checks.push(await checkContract(root, contract));
  checks.push(checkLlmProvider());
  checks.push(...checkCredentialEnv(contract));
  checks.push(await checkStorageStateIgnore(root, git));
  checks.push(await checkTargetUrl(contract, { url: options.url, target: options.target, env: options.env ?? "auto", timeoutMs: options.timeoutMs ?? 5000 }));
  checks.push(await checkPlaywright(options.checkBrowser));
  if (options.agent) checks.push(await checkDelegatedAgentRuntime(root, {
    agent: options.agent,
    command: options.agentCommand,
    args: options.agentArgs,
    timeoutMs: Math.min(options.agentTimeoutMs ?? DELEGATED_DOCTOR_TIMEOUT_CAP_MS, DELEGATED_DOCTOR_TIMEOUT_CAP_MS),
    onProgress: options.onProgress ?? defaultDoctorProgress
  }));
  if (options.checkMcp) checks.push(...await checkMcpServers(root));

  return {
    root,
    ok: checks.every((check) => check.status !== "fail"),
    checks
  };
}

async function checkDelegatedAgentRuntime(root: string, options: {
  agent: AgentExecKind;
  command?: string;
  args?: string[];
  timeoutMs: number;
  onProgress: (message: string) => void;
}): Promise<DoctorCheck> {
  let probeDirectory: string | undefined;
  let check: DoctorCheck;
  try {
    probeDirectory = await createIsolatedProbeDirectory(root);
    const toolDenyPolicyPath = await createProbeToolDenyPolicy(options.agent, probeDirectory);
    const result = await runAgentCapabilityProbe({
      kind: options.agent,
      cwd: probeDirectory,
      targetRoot: root,
      command: options.command,
      args: options.args,
      timeoutMs: options.timeoutMs,
      heartbeatMs: Math.min(5000, Math.max(250, Math.floor(options.timeoutMs / 3))),
      onProgress: options.onProgress,
      streamOutput: false,
      toolDenyPolicyPath
    });
    check = interpretDelegatedAgentResult(options.agent, result);
  } catch (error) {
    if (error instanceof AgentExecError) {
      const combined = [error.result.stdout, error.result.stderr].filter(Boolean).join("\n");
      const cause = error.primaryCause ?? extractPrimaryCause(combined) ?? (error.timedOut
        ? `agent command exceeded the ${Math.round(options.timeoutMs / 1000)}s doctor limit before returning the readiness marker`
        : firstErrorLine(error));
      check = fail(
        "delegated_agent_runtime",
        "Delegated agent runtime",
        error.timedOut
          ? `${options.agent} did not complete the bounded runtime probe within ${Math.round(options.timeoutMs / 1000)}s.`
          : `${options.agent} runtime probe failed to start.`,
        formatDelegatedDiagnostics(cause, error.result)
      );
    } else {
      check = fail("delegated_agent_runtime", "Delegated agent runtime", `${options.agent} runtime probe failed.`, redactText(errorMessage(error)));
    }
  }

  if (probeDirectory) {
    try {
      await rm(probeDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch (error) {
      return fail(
        "delegated_agent_runtime",
        "Delegated agent runtime",
        "Could not remove the isolated delegated-agent probe directory.",
        `Primary cause: ${redactText(errorMessage(error))}`
      );
    }
  }
  return check;
}

function interpretDelegatedAgentResult(agent: AgentExecKind, result: AgentExecResult): DoctorCheck {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const runtimeStatus = combined.match(/PREFLIGHT_SCOUT_AGENT_RUNTIME\s*=\s*(ready|blocked|fail)/i)?.[1]?.toLowerCase();
  const legacyStatus = combined.match(/PREFLIGHT_SCOUT_PROBE_STATUS\s*=\s*(pass|blocked|fail)/i)?.[1]?.toLowerCase();
  const status = runtimeStatus ?? legacyStatus;
  if (result.exitCode !== 0) {
    return fail(
      "delegated_agent_runtime",
      "Delegated agent runtime",
      `${agent} exited with ${result.exitCode}.`,
      formatDelegatedDiagnostics(extractPrimaryCause(combined) ?? `agent command exited with ${result.exitCode}`, result)
    );
  }
  if (status === "ready" || status === "pass") {
    return pass(
      "delegated_agent_runtime",
      "Delegated agent runtime",
      `${agent} completed a bounded non-interactive command probe in an isolated temporary directory. This confirms agent execution only; delegated browser QA was not run.`
    );
  }
  if (status === "blocked" || status === "fail") {
    return fail(
      "delegated_agent_runtime",
      "Delegated agent runtime",
      `${agent} reported that its non-interactive runtime is unavailable.`,
      formatDelegatedDiagnostics(extractPrimaryCause(combined) ?? "agent reported a blocked runtime without a primary cause", result)
    );
  }
  return warn(
    "delegated_agent_runtime",
    "Delegated agent runtime",
    `${agent} exited successfully but did not return PREFLIGHT_SCOUT_AGENT_RUNTIME=ready. Browser QA was not run.`,
    formatDelegatedDiagnostics("readiness marker missing from agent output", result)
  );
}

async function createIsolatedProbeDirectory(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidateBases = [...new Set([tmpdir(), homedir(), path.dirname(canonicalRoot)].map((candidate) => path.resolve(candidate)))];
  const failures: string[] = [];
  for (const base of candidateBases) {
    let canonicalBase: string;
    try {
      canonicalBase = await realpath(base);
    } catch (error) {
      failures.push(`${base}: ${errorMessage(error)}`);
      continue;
    }
    if (isPathWithin(canonicalRoot, canonicalBase)) continue;
    let candidate: string | undefined;
    try {
      candidate = await mkdtemp(path.join(canonicalBase, "preflight-scout-agent-probe-"));
      const canonicalCandidate = await realpath(candidate);
      if (pathsOverlap(canonicalRoot, canonicalCandidate)) {
        await rm(candidate, { recursive: true, force: true });
        continue;
      }
      return canonicalCandidate;
    } catch (error) {
      if (candidate) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      failures.push(`${canonicalBase}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`Could not create a temporary probe directory outside the target repository. ${failures.join("; ")}`.trim());
}

async function createProbeToolDenyPolicy(agent: AgentExecKind, probeDirectory: string): Promise<string | undefined> {
  if (agent !== "gemini") return undefined;
  const policyPath = path.join(probeDirectory, "deny-all-tools.toml");
  await writeFile(policyPath, GEMINI_DENY_ALL_TOOLS_POLICY, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return policyPath;
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function checkStorageStateIgnore(root: string, gitPromise: Promise<TrustedGit>): Promise<DoctorCheck> {
  try {
    const git = await gitPromise;
    await git.exec(["check-ignore", "--quiet", ".preflight-scout/auth/example.json"], { cwd: root });
    return pass("storage_state_ignore", "Storage-state gitignore", ".preflight-scout/auth files are ignored by git.");
  } catch {
    return warn(
      "storage_state_ignore",
      "Storage-state gitignore",
      ".preflight-scout/auth files may not be ignored.",
      "Add .preflight-scout/auth/ to .gitignore before saving authenticated browser sessions."
    );
  }
}

async function checkLocalEnvFile(
  root: string,
  envFile: string,
  loadedEnvPath: string | undefined,
  loadError: unknown,
  gitPromise: Promise<TrustedGit>
): Promise<DoctorCheck> {
  const envPath = path.resolve(root, envFile);
  if (loadError) {
    return fail(
      "local_env_file",
      "Local environment file",
      "Refused to load the configured environment file.",
      redactText(errorMessage(loadError))
    );
  }
  if (!isPathWithin(root, envPath)) {
    return pass(
      "local_env_file",
      "Local environment file",
      loadedEnvPath
        ? "Loaded an explicitly selected environment file outside the target repository."
        : "The explicitly selected environment file outside the target repository is not present."
    );
  }

  const relativePath = path.relative(root, envPath);
  try {
    const git = await gitPromise;
    if (await gitPredicate(git, root, ["ls-files", "--error-unmatch", "--", relativePath])) {
      return fail(
        "local_env_file",
        "Local environment file",
        `${relativePath} is tracked by Git.`,
        "Remove it from the index and keep repository-local environment files untracked and ignored."
      );
    }
    if (!await gitPredicate(git, root, ["check-ignore", "--quiet", "--", relativePath])) {
      return loadedEnvPath
        ? fail(
          "local_env_file",
          "Local environment file",
          `${relativePath} is not ignored by Git.`,
          "Add .env.preflight-scout.local to .gitignore before using repository-local environment values."
        )
        : warn(
          "local_env_file",
          "Local environment file",
          `${relativePath} is not ignored by Git.`,
          "Add .env.preflight-scout.local to .gitignore before creating the local environment file."
        );
    }
  } catch (error) {
    return warn(
      "local_env_file",
      "Local environment file",
      "Could not verify the configured repository-local environment file with Git.",
      redactText(errorMessage(error))
    );
  }

  return pass(
    "local_env_file",
    "Local environment file",
    loadedEnvPath
      ? `${relativePath} is untracked, ignored, and passed the environment-control policy.`
      : `${relativePath} is ignored and not present.`
  );
}

export function renderDoctorReport(report: DoctorReport): string {
  const hasWarnings = report.checks.some((check) => check.status === "warn");
  const status = report.ok ? (hasWarnings ? "passed with warnings" : "passed") : "needs attention";
  const lines = [
    `Preflight Scout Doctor ${status}`,
    `Root: ${report.root}`,
    ""
  ];
  for (const check of report.checks) {
    lines.push(`${symbol(check.status)} ${check.label}: ${check.message}`);
    if (check.detail) lines.push(`   ${check.detail}`);
  }
  return lines.join("\n");
}

async function checkGitRepo(root: string, gitPromise: Promise<TrustedGit>): Promise<DoctorCheck> {
  try {
    const git = await gitPromise;
    await git.exec(["rev-parse", "--show-toplevel"], { cwd: root });
    return pass("git_repo", "Git repository", "Found git repository.");
  } catch (error) {
    return fail("git_repo", "Git repository", "Not a git repository.", errorMessage(error));
  }
}

async function checkGitRefs(root: string, base: string, head: string, gitPromise: Promise<TrustedGit>): Promise<DoctorCheck> {
  try {
    const git = await gitPromise;
    const [baseCommit, headCommit] = await Promise.all([
      resolveTrustedGitCommit(git, root, base),
      resolveTrustedGitCommit(git, root, head)
    ]);
    await git.exec(
      ["diff", "--no-ext-diff", "--no-textconv", "--name-only", `${baseCommit}...${headCommit}`, "--"],
      { cwd: root, maxBuffer: 1024 * 1024 }
    );
    return pass("git_refs", "Git refs", `Can diff ${base}...${head}.`);
  } catch (error) {
    return fail("git_refs", "Git refs", `Cannot diff ${base}...${head}.`, errorMessage(error));
  }
}

async function checkContract(root: string, contract: QAContract): Promise<DoctorCheck> {
  const configPath = path.join(root, ".preflight-scout", "config.yml");
  if (!await exists(configPath)) {
    return warn("contract", "QA contract", "Missing .preflight-scout/config.yml. Run preflight-scout init.");
  }
  const roles = Object.keys(contract.auth?.roles ?? {});
  const rootUrls = [contract.app.localUrl, contract.app.stagingUrl, contract.app.url].filter(Boolean).length;
  const targetUrls = Object.values(contract.app.targets ?? {}).flatMap((target) => [target.localUrl, target.stagingUrl, target.url]).filter(Boolean).length;
  return pass("contract", "QA contract", `Loaded .preflight-scout/config.yml with ${roles.length} auth role(s), ${rootUrls + targetUrls} configured URL(s), and ${Object.keys(contract.app.targets ?? {}).length} named target(s).`);
}

export function checkLlmProvider(): DoctorCheck {
  const provider = process.env.PREFLIGHT_SCOUT_LLM_PROVIDER;
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  if (!provider) {
    return hasOpenAI || hasAnthropic || hasGemini
      ? pass("llm_provider", "LLM provider", "Provider can be inferred from available API key.")
      : fail("llm_provider", "LLM provider", "No LLM provider found.", "Set PREFLIGHT_SCOUT_LLM_PROVIDER plus the matching provider key, or use codex-exec/claude-exec.");
  }
  if (provider === "none") {
    return fail("llm_provider", "LLM provider", "LLM provider is explicitly disabled.");
  }
  if (provider === "codex-exec" || provider === "claude-exec" || provider === "gemini-exec") {
    return pass("llm_provider", "LLM provider", `Configured provider ${provider}.`);
  }
  if (provider === "openai") {
    return hasOpenAI
      ? pass("llm_provider", "LLM provider", "Configured provider openai.")
      : fail("llm_provider", "LLM provider", "OpenAI provider is missing OPENAI_API_KEY.");
  }
  if (provider === "anthropic") {
    return hasAnthropic
      ? pass("llm_provider", "LLM provider", "Configured provider anthropic.")
      : fail("llm_provider", "LLM provider", "Anthropic provider is missing ANTHROPIC_API_KEY.");
  }
  if (provider === "gemini") {
    return hasGemini
      ? pass("llm_provider", "LLM provider", "Configured provider gemini.")
      : fail("llm_provider", "LLM provider", "Gemini provider is missing GEMINI_API_KEY or GOOGLE_API_KEY.");
  }
  if (provider === "openai-compatible") {
    if (!hasOpenAI) return fail("llm_provider", "LLM provider", "OpenAI-compatible gateway is missing OPENAI_API_KEY.");
    if (!process.env.PREFLIGHT_SCOUT_MODEL?.trim()) {
      return fail("llm_provider", "LLM provider", "OpenAI-compatible gateway is missing PREFLIGHT_SCOUT_MODEL.", "Set the gateway's exact model identifier; Preflight Scout does not assume an OpenAI model slug.");
    }
    return pass("llm_provider", "LLM provider", `Configured provider ${provider}.`);
  }
  return fail("llm_provider", "LLM provider", "Unsupported PREFLIGHT_SCOUT_LLM_PROVIDER value.");
}

function checkCredentialEnv(contract: QAContract): DoctorCheck[] {
  const roles = Object.entries(contract.auth?.roles ?? {});
  if (!roles.length) return [warn("credentials", "Credential env vars", "No auth roles configured.")];

  return roles.map(([role, credentials]) => {
    const invalid = [
      ["username", credentials.usernameEnv],
      ["password", credentials.passwordEnv]
    ].flatMap(([kind, name]) => (
      name && browserCredentialKindForEnvName(name) !== kind ? [`${kind}=${name}`] : []
    ));
    if (invalid.length) {
      return fail(
        `credentials:${role}`,
        `Credential env vars for ${role}`,
        `Role uses invalid browser credential environment mappings: ${invalid.join(", ")}.`,
        "Use PREFLIGHT_SCOUT_BROWSER_<ROLE_OR_LABEL>_(EMAIL|USERNAME|PASSWORD), with an EMAIL/USERNAME name for username and a PASSWORD name for password."
      );
    }
    const required = [credentials.usernameEnv, credentials.passwordEnv].filter((item): item is string => Boolean(item));
    const missing = required.filter((name) => !process.env[name]);
    if (!required.length) return warn(`credentials:${role}`, `Credential env vars for ${role}`, "Role has no username/password env names configured.");
    if (missing.length) return warn(`credentials:${role}`, `Credential env vars for ${role}`, `Missing ${missing.join(", ")}.`);
    return pass(`credentials:${role}`, `Credential env vars for ${role}`, "All configured credential env vars are present.");
  });
}

async function checkTargetUrl(contract: QAContract, options: { url?: string; target?: string; env: string; timeoutMs: number }): Promise<DoctorCheck> {
  let resolvedTargetUrl: string;
  try {
    resolvedTargetUrl = resolveTargetUrl(contract, {
      url: options.url,
      target: options.target,
      env: options.env
    });
  } catch (error) {
    return error instanceof AppUrlValidationError
      ? fail("target_url", "Target URL", "Refused unsafe target URL.", safeDoctorDiagnostic(error))
      : warn("target_url", "Target URL", "No target URL resolved.", safeDoctorDiagnostic(error));
  }
  const targetUrl = resolvedTargetUrl;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(targetUrl, { method: "GET", signal: controller.signal, redirect: "manual" });
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400 && location) {
      let redirectTarget: URL;
      try {
        redirectTarget = new URL(location, targetUrl);
        validateAppUrl(redirectTarget.toString());
      } catch {
        return fail("target_url", "Target URL", "Target returned an unsafe redirect location.");
      }
      if (redirectTarget.origin !== new URL(targetUrl).origin) {
        return fail("target_url", "Target URL", "Refused an off-origin redirect during the connectivity check.");
      }
      return warn("target_url", "Target URL", `Reached ${targetUrl}, but it returned a same-origin redirect (${response.status}).`);
    }
    return response.ok || response.status < 500
      ? pass("target_url", "Target URL", `Reachable: ${targetUrl} (${response.status}).`)
      : warn("target_url", "Target URL", `Reached ${targetUrl}, but server returned ${response.status}.`);
  } catch (error) {
    return warn("target_url", "Target URL", `Could not reach ${targetUrl}.`, safeDoctorDiagnostic(error));
  } finally {
    clearTimeout(timeout);
  }
}

function safeDoctorDiagnostic(error: unknown): string {
  const safe = redactText(errorMessage(error)).replaceAll("\0", "�");
  if (safe.length <= MAX_DOCTOR_DIAGNOSTIC_CHARS) return safe;
  return `${safe.slice(0, MAX_DOCTOR_DIAGNOSTIC_CHARS - 23)}\n[diagnostic truncated]`;
}

async function checkPlaywright(checkBrowser?: () => Promise<void>): Promise<DoctorCheck> {
  try {
    if (checkBrowser) {
      await checkBrowser();
    } else {
      await execFileAsync(process.execPath, ["-e", "import('playwright').then(async ({ chromium }) => { const browser = await chromium.launch({ headless: true }); await browser.close(); })"], { timeout: 15000 });
    }
    return pass("playwright", "Playwright browser", "Playwright is installed and Chromium launched successfully.");
  } catch (error) {
    return fail("playwright", "Playwright browser", "Could not launch Chromium.", errorMessage(error));
  }
}

async function checkMcpServers(root: string): Promise<DoctorCheck[]> {
  return Promise.all([
    checkMcpCommand(root, "codex", ["mcp", "list"]),
    checkMcpCommand(root, "claude", ["mcp", "list"]),
    checkMcpCommand(root, "gemini", ["mcp", "list"])
  ]);
}

async function checkMcpCommand(root: string, command: Exclude<AgentExecKind, "custom">, args: string[]): Promise<DoctorCheck> {
  try {
    const result = await runAgentCapabilityProbe({
      kind: command,
      cwd: root,
      targetRoot: root,
      args,
      promptTransport: "stdin",
      timeoutMs: 10000,
      heartbeatMs: 5000,
      streamOutput: false
    });
    if (result.exitCode !== 0) {
      return warn(`mcp:${command}`, `${command} MCP`, `Could not inspect MCP configuration; command exited with ${result.exitCode ?? "unknown status"}.`);
    }
    const hasPlaywright = result.stdout.toLowerCase().includes("playwright");
    return hasPlaywright
      ? pass(`mcp:${command}`, `${command} MCP`, "Playwright MCP appears configured.")
      : warn(`mcp:${command}`, `${command} MCP`, "Command works, but Playwright MCP was not listed.");
  } catch (error) {
    return warn(`mcp:${command}`, `${command} MCP`, "Could not inspect MCP configuration.", errorMessage(error));
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function gitPredicate(git: TrustedGit, root: string, args: string[]): Promise<boolean> {
  try {
    await git.exec(args, { cwd: root });
    return true;
  } catch (error) {
    if (Number((error as { code?: unknown }).code) === 1) return false;
    throw error;
  }
}

function pass(id: string, label: string, message: string, detail?: string): DoctorCheck {
  return { id, label, status: "pass", message, detail };
}

function warn(id: string, label: string, message: string, detail?: string): DoctorCheck {
  return { id, label, status: "warn", message, detail };
}

function fail(id: string, label: string, message: string, detail?: string): DoctorCheck {
  return { id, label, status: "fail", message, detail };
}

function symbol(status: DoctorStatus): string {
  if (status === "pass") return "PASS";
  if (status === "warn") return "WARN";
  return "FAIL";
}

function extractPrimaryCause(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*Primary cause:\s*(.+?)\s*$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function formatDelegatedDiagnostics(primaryCause: string, result: AgentExecResult): string {
  const sections = [`Primary cause: ${redactText(primaryCause)}`];
  if (result.stdout.trim()) sections.push(`Captured stdout:\n${formatDiagnosticStream(result.stdout)}`);
  if (result.stderr.trim()) sections.push(`Captured stderr:\n${formatDiagnosticStream(result.stderr)}`);
  if (!result.stdout.trim() && !result.stderr.trim()) sections.push("Captured stdout/stderr: (no output)");
  return sections.join("\n");
}

function formatDiagnosticStream(output: string): string {
  const safe = redactText(output.trim());
  const limit = 2000;
  if (safe.length <= limit) return safe;
  const half = Math.floor(limit / 2);
  return `${safe.slice(0, half)}\n...[truncated ${safe.length - limit} characters]...\n${safe.slice(-half)}`;
}

function firstErrorLine(error: Error): string {
  return redactText(error.message.split(/\r?\n/, 1)[0] || error.name);
}

function defaultDoctorProgress(message: string): void {
  process.stderr.write(`[preflight-scout doctor] ${redactText(message)}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
