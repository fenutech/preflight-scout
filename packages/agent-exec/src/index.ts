import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import * as processTree from "@preflight-scout/core";
import {
  browserCredentialKindForEnvName,
  redactText,
  type QAMission,
  type QAContract
} from "@preflight-scout/core";

export type AgentExecKind = "codex" | "claude" | "gemini" | "custom";

export const AGENT_OUTPUT_LIMIT_CHARS = 200_000;

const COMMON_AGENT_ENV_PATTERN = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|COLORTERM|LANG|LC_.+|TZ|CI|NO_COLOR|FORCE_COLOR|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_STATE_HOME|PLAYWRIGHT_BROWSERS_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)$/i;

const AGENT_KIND_ENV_PATTERNS: Record<AgentExecKind, RegExp> = {
  codex: /^(CODEX_HOME|OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_ORGANIZATION|OPENAI_PROJECT|OPENAI_PROJECT_ID)$/i,
  claude: /^(CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS)$/i,
  gemini: /^(GEMINI_CLI_HOME|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|GOOGLE_GENAI_USE_VERTEXAI|CLOUDSDK_CONFIG)$/i,
  custom: /$a/
};

export function buildAgentEnvironment(
  kind: AgentExecKind,
  options: {
    sourceEnv?: NodeJS.ProcessEnv;
    credentialEnvNames?: readonly string[];
  } = {}
): NodeJS.ProcessEnv {
  const sourceEnv = options.sourceEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  const kindPattern = AGENT_KIND_ENV_PATTERNS[kind];

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && (COMMON_AGENT_ENV_PATTERN.test(key) || kindPattern.test(key))) {
      env[key] = value;
    }
  }

  for (const key of new Set(options.credentialEnvNames ?? [])) {
    if (!browserCredentialKindForEnvName(key)) {
      throw new Error(
        `Credential environment variable ${key} is not an authorized dedicated browser credential; use PREFLIGHT_SCOUT_BROWSER_<ROLE_OR_LABEL>_(EMAIL|USERNAME|PASSWORD).`
      );
    }
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }

  env.PREFLIGHT_SCOUT_DELEGATED_SANDBOX = "1";
  return env;
}

export interface AgentExecOptions {
  kind: AgentExecKind;
  appUrl: string;
  mission: QAMission;
  contract: QAContract;
  storageStateOutput?: string;
  evidenceDir?: string;
  cwd?: string;
  /** Repository/application boundary that built-in agent executables must not resolve from. */
  targetRoot?: string;
  command?: string;
  args?: string[];
  promptTransport?: "stdin" | "argv";
  timeoutMs?: number;
  heartbeatMs?: number;
  onProgress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean | "signals";
  additionalInstructions?: string[];
}

export interface AgentAuthLoginOptions {
  kind: AgentExecKind;
  appUrl: string;
  role: string;
  usernameEnv?: string;
  passwordEnv?: string;
  signedInTarget: string;
  storageStateOutput: string;
  evidenceDir: string;
  startPath?: string;
  cwd?: string;
  /** Repository/application boundary that built-in agent executables must not resolve from. */
  targetRoot?: string;
  command?: string;
  args?: string[];
  promptTransport?: "stdin" | "argv";
  timeoutMs?: number;
  heartbeatMs?: number;
  onProgress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean | "signals";
}

export interface AgentCapabilityProbeOptions {
  kind: AgentExecKind;
  cwd: string;
  /** Repository/application boundary that built-in agent executables must not resolve from. */
  targetRoot?: string;
  command?: string;
  args?: string[];
  promptTransport?: "stdin" | "argv";
  timeoutMs?: number;
  heartbeatMs?: number;
  onProgress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean | "signals";
  toolDenyPolicyPath?: string;
}

export interface AgentExecResult {
  kind: AgentExecKind;
  command: string;
  args: string[];
  promptTransport: "stdin" | "argv";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class AgentExecError extends Error {
  readonly result: AgentExecResult;
  readonly timedOut: boolean;
  readonly primaryCause?: string;

  constructor(message: string, result: AgentExecResult, options?: {
    timedOut?: boolean;
    secretValues?: readonly string[];
    sensitivePrompt?: string;
  }) {
    super(redactPromptEcho(redactAgentText(message, options?.secretValues), options?.sensitivePrompt).slice(0, 6000));
    this.name = "AgentExecError";
    this.result = sanitizeErrorResult(result, options?.secretValues, options?.sensitivePrompt);
    this.timedOut = options?.timedOut ?? false;
    this.primaryCause = extractReportedPrimaryCause(
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
      options?.secretValues,
      options?.sensitivePrompt
    );
  }
}

export async function runAgentExecution(options: AgentExecOptions): Promise<AgentExecResult> {
  const prompt = renderAgentPrompt(options);
  const commandSpec = resolveAgentCommand(options, prompt);
  return runPreparedCommand({
    kind: options.kind,
    ...commandSpec,
    cwd: options.cwd,
    targetRoot: options.targetRoot,
    timeoutMs: options.timeoutMs ?? 1000 * 60 * 20,
    heartbeatMs: options.heartbeatMs ?? 1000 * 30,
    onProgress: options.onProgress,
    env: options.env,
    streamOutput: options.streamOutput ?? false,
    sensitivePrompt: prompt
  });
}

export async function runAgentAuthLogin(options: AgentAuthLoginOptions): Promise<AgentExecResult> {
  const prompt = renderAuthLoginPrompt(options);
  const commandSpec = resolveAgentCommand(options, prompt);
  return runPreparedCommand({
    kind: options.kind,
    ...commandSpec,
    cwd: options.cwd,
    targetRoot: options.targetRoot,
    timeoutMs: options.timeoutMs ?? 1000 * 60 * 10,
    heartbeatMs: options.heartbeatMs ?? 1000 * 30,
    onProgress: options.onProgress,
    env: options.env,
    streamOutput: options.streamOutput ?? "signals",
    sensitivePrompt: prompt
  });
}

export async function runAgentCapabilityProbe(options: AgentCapabilityProbeOptions): Promise<AgentExecResult> {
  const prompt = renderAgentCapabilityProbePrompt();
  const commandSpec = resolveAgentCommand({
    kind: options.kind,
    cwd: options.cwd,
    command: options.command,
    args: options.args,
    promptTransport: options.promptTransport ?? (options.kind === "custom" ? "argv" : "stdin"),
    reasoningEffort: "low",
    executionProfile: "capability-probe",
    toolDenyPolicyPath: options.toolDenyPolicyPath
  }, prompt);
  return runPreparedCommand({
    kind: options.kind,
    ...commandSpec,
    cwd: options.cwd,
    targetRoot: options.targetRoot,
    timeoutMs: options.timeoutMs ?? 1000 * 30,
    heartbeatMs: options.heartbeatMs ?? 1000 * 5,
    onProgress: options.onProgress,
    env: options.env,
    streamOutput: options.streamOutput ?? "signals",
    sensitivePrompt: prompt
  });
}

export function renderAgentCapabilityProbePrompt(): string {
  return `You are running a bounded Preflight Scout doctor probe.

Do not use browser, network, shell, MCP, filesystem, or any other tool.
Do not inspect or modify the repository.
This probe checks only that this agent CLI can accept and complete a non-interactive prompt. It does not run browser QA.

Reply with exactly one line formed by joining these two fragments with no quotes, spaces, or punctuation between them:
PREFLIGHT_SCOUT_AGENT_
RUNTIME=ready
`;
}

export function renderAgentPrompt(options: AgentExecOptions): string {
  return redactText(`You are executing a Preflight Scout mission.

Target app URL:
${options.appUrl}

Rules:
- Use your browser/playwright/MCP tools if available.
- You MUST execute browser work with available Playwright MCP tools, a Playwright skill, or Playwright CLI/library calls. Do not only describe what should happen.
- Figure out browser actions on the fly from the live page.
- Do not use hardcoded heuristics or generic checklists.
- Do not perform dangerous actions unless the QA contract explicitly allows them.
- If credentials, safe data, permissions, or approvals are missing, report blocked.
- Do not create or modify GitHub/GitLab issues, pull requests, releases, branches, commits, tags, deployments, or package publications.
- Do not push, publish, deploy, or edit tracked application source files. Only write Preflight Scout artifacts, screenshots, traces, temporary notes, and the requested storage state.
- Return a concise report with passed, failed, blocked, evidence, and human follow-ups.
${options.additionalInstructions?.map((instruction) => `- ${instruction}`).join("\n") ?? ""}
${options.storageStateOutput ? `- If authentication succeeds, save Playwright storageState JSON to: ${options.storageStateOutput}` : ""}
${options.evidenceDir ? `- Write screenshots, traces, notes, or other evidence under this directory when your tools allow it: ${options.evidenceDir}` : ""}
${options.storageStateOutput ? "- If authentication cannot be completed, stop with a blocked/failed report that includes the current URL, visible app error, evidence paths, and a line starting exactly `Primary cause:`." : ""}

QA Contract:
${JSON.stringify(options.contract, null, 2)}

Mission:
${JSON.stringify(options.mission, null, 2)}
`);
}

export function renderAuthLoginPrompt(options: AgentAuthLoginOptions): string {
  const credentialLines = options.usernameEnv && options.passwordEnv
    ? `- Username/email env var: ${options.usernameEnv}
- Password env var: ${options.passwordEnv}`
    : "- Credential env vars are not fully configured; if the app requires credentials, report blocked.";
  return `You are tasked with logging into this app.

URL:
${options.appUrl}

Reviewed login start path:
${options.startPath ?? "/"}

Role:
${options.role}

Credentials:
${credentialLines}

Storage state output:
${options.storageStateOutput}

Evidence directory:
${options.evidenceDir}

Reviewed signed-in marker:
${options.signedInTarget}

Rules:
- Use Playwright MCP, a Playwright skill, Playwright CLI/library calls, or another available browser automation tool.
- Open only the reviewed app URL and reviewed login start path above. Do not discover or substitute another sign-in URL.
- Do not create a new user, sign up, invite users, reset passwords, or mutate real user data.
- Do not create or modify GitHub/GitLab issues, pull requests, releases, branches, commits, tags, deployments, or package publications.
- Do not push, publish, deploy, or edit tracked application source files.
- Only write screenshots, traces, notes, temporary files, and the requested Playwright storageState under the evidence/storage paths above.
- Treat login as successful only after the exact reviewed signed-in marker resolves to one visible element.
- If login succeeds, save Playwright storageState JSON exactly to the storage state output path, then emit the exact line \`PREFLIGHT_SCOUT_AUTH_VERIFIED=1\`.
- If login is impossible, stop and explain the visible reason. Include one line starting exactly \`Primary cause:\`.
- Emit short milestone lines as you work, for example \`PREFLIGHT_SCOUT_AGENT_PROGRESS=login-form-found\`, \`PREFLIGHT_SCOUT_AGENT_PROGRESS=credentials-submitted\`, or \`PREFLIGHT_SCOUT_AGENT_PROGRESS=credentials-rejected\`.

Return a concise report with status, current URL, evidence paths, and any human follow-up needed.
`;
}

interface AgentCommandOptions {
  kind: AgentExecKind;
  cwd?: string;
  command?: string;
  args?: string[];
  promptTransport?: "stdin" | "argv";
  reasoningEffort?: string;
  executionProfile?: "default" | "capability-probe";
  toolDenyPolicyPath?: string;
}

export function resolveAgentCommand(options: AgentCommandOptions, prompt: string): { command: string; args: string[]; input?: string; promptTransport: "stdin" | "argv" } {
  const promptTransport = options.promptTransport ?? (options.kind === "custom" ? "argv" : "stdin");

  if (options.kind === "custom") {
    if (!options.command) throw new Error("custom agent execution requires command");
    return {
      command: options.command,
      args: promptTransport === "argv" ? [...(options.args ?? []), prompt] : (options.args ?? []),
      input: promptTransport === "stdin" ? prompt : undefined,
      promptTransport
    };
  }

  if (options.kind === "codex") {
    const model = process.env.PREFLIGHT_SCOUT_EXEC_MODEL ?? process.env.PREFLIGHT_SCOUT_MODEL;
    const reasoningEffort = options.reasoningEffort ?? process.env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT ?? process.env.PREFLIGHT_SCOUT_REASONING_EFFORT;
    const modelArgs = model ? ["-m", model] : [];
    const reasoningArgs = reasoningEffort ? ["-c", renderCodexReasoningConfig(reasoningEffort)] : [];
    const capabilityProbeArgs = options.executionProfile === "capability-probe"
      ? ["--ignore-user-config", "--ignore-rules", "--disable", "plugins"]
      : [];
    const sandboxArgs = options.executionProfile === "capability-probe"
      ? ["--sandbox", "read-only"]
      : ["--sandbox", "workspace-write", "-c", "sandbox_policy.network_access=enabled"];
    return {
      command: options.command ?? "codex",
      args: options.args ?? (promptTransport === "stdin"
        ? ["exec", ...modelArgs, ...reasoningArgs, ...capabilityProbeArgs, ...sandboxArgs, "--skip-git-repo-check", "--ephemeral", ...(options.cwd ? ["-C", options.cwd] : []), "-"]
        : ["exec", ...modelArgs, ...reasoningArgs, ...capabilityProbeArgs, ...sandboxArgs, "--skip-git-repo-check", "--ephemeral", ...(options.cwd ? ["-C", options.cwd] : []), prompt]),
      input: promptTransport === "stdin" ? prompt : undefined,
      promptTransport
    };
  }

  if (options.kind === "claude") {
    const model = process.env.PREFLIGHT_SCOUT_EXEC_MODEL ?? process.env.PREFLIGHT_SCOUT_MODEL;
    const reasoningEffort = options.reasoningEffort ?? process.env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT ?? process.env.PREFLIGHT_SCOUT_REASONING_EFFORT;
    const modelArgs = model ? ["--model", model] : [];
    const effortArgs = reasoningEffort ? ["--effort", reasoningEffort] : [];
    const capabilityProbeArgs = options.executionProfile === "capability-probe"
      ? ["--safe-mode", "--no-chrome", "--strict-mcp-config", "--tools", "", "--disable-slash-commands", "--permission-mode", "plan"]
      : ["--disallowedTools", "Bash(gh:*),Bash(git push:*),Bash(npm publish:*),Bash(pnpm publish:*),Bash(yarn publish:*),Bash(vercel:*),Bash(netlify:*),Bash(fly:*),Bash(aws:*),Write,Edit,NotebookEdit"];
    return {
      command: options.command ?? "claude",
      args: options.args ?? (promptTransport === "stdin"
        ? ["--no-session-persistence", ...modelArgs, ...effortArgs, ...capabilityProbeArgs, "-p", "Execute the Preflight Scout mission provided on stdin."]
        : ["--no-session-persistence", ...modelArgs, ...effortArgs, ...capabilityProbeArgs, "-p", prompt]),
      input: promptTransport === "stdin" ? prompt : undefined,
      promptTransport
    };
  }

  const model = process.env.PREFLIGHT_SCOUT_EXEC_MODEL ?? process.env.PREFLIGHT_SCOUT_MODEL;
  const modelArgs = model ? ["-m", model] : [];
  const capabilityProbeArgs = options.executionProfile === "capability-probe"
    ? [
        "--approval-mode", "plan",
        "--allowed-mcp-server-names", "__preflight_scout_no_mcp__",
        ...(options.toolDenyPolicyPath ? ["--admin-policy", options.toolDenyPolicyPath] : [])
      ]
    : [];
  return {
    command: options.command ?? "gemini",
    args: options.args ?? (promptTransport === "stdin"
      ? ["--sandbox", ...modelArgs, ...capabilityProbeArgs, "-p", "Execute the Preflight Scout mission provided on stdin."]
      : ["--sandbox", ...modelArgs, ...capabilityProbeArgs, "-p", prompt]),
    input: promptTransport === "stdin" ? prompt : undefined,
    promptTransport
  };
}

function renderCodexReasoningConfig(reasoningEffort: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(reasoningEffort)) {
    throw new Error("Delegated Codex reasoning effort must contain only letters, numbers, underscores, or hyphens");
  }
  return process.platform === "win32"
    ? `model_reasoning_effort='${reasoningEffort}'`
    : `model_reasoning_effort="${reasoningEffort}"`;
}

interface AgentCommandRunOptions {
  kind: AgentExecKind;
  command: string;
  args: string[];
  input?: string;
  promptTransport: "stdin" | "argv";
  cwd?: string;
  targetRoot?: string;
  timeoutMs: number;
  heartbeatMs: number;
  onProgress?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  streamOutput: boolean | "signals";
  sensitivePrompt: string;
}

async function runPreparedCommand(options: AgentCommandRunOptions): Promise<AgentExecResult> {
  if (options.kind === "custom") {
    return runCommand({
      ...options,
      env: options.env ?? buildAgentEnvironment("custom")
    });
  }

  const sourceEnv = options.env ?? process.env;
  const selectedCredentialNames = options.env
    ? Object.keys(options.env).filter((key) => Boolean(browserCredentialKindForEnvName(key)))
    : [];
  const childEnv = buildAgentEnvironment(options.kind, {
    sourceEnv,
    credentialEnvNames: selectedCredentialNames
  });
  const prepared = await resolveTrustedAgentInvocation({
    command: options.command,
    args: options.args,
    sourceEnv: childEnv,
    targetRoot: options.targetRoot ?? options.cwd ?? process.cwd()
  });

  try {
    return await runCommand({
      ...options,
      command: prepared.command,
      args: prepared.args,
      env: withTrustedPath(childEnv, prepared.searchPath)
    });
  } finally {
    if (prepared.cleanupDir) {
      try {
        await rm(prepared.cleanupDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      } catch {
        throw new Error("Delegated agent executable-wrapper cleanup failed");
      }
    }
  }
}

async function resolveTrustedAgentInvocation(options: {
  command: string;
  args: string[];
  sourceEnv: NodeJS.ProcessEnv;
  targetRoot: string;
}): Promise<{ command: string; args: string[]; searchPath: string; cleanupDir?: string }> {
  const boundaries = await agentTargetBoundaries(options.targetRoot);
  const searchDirectories = await trustedPathDirectories(options.sourceEnv, boundaries);
  const executable = await findTrustedExecutable(options.command, searchDirectories, options.sourceEnv, boundaries);
  const searchPath = searchDirectories.join(path.delimiter);

  if (process.platform !== "win32" || !/\.(?:bat|cmd)$/i.test(executable)) {
    return { command: executable, args: options.args, searchPath };
  }

  const commandProcessor = await trustedWindowsCommandProcessor(options.sourceEnv, boundaries);
  const cleanupDir = await createTrustedWrapperDirectory(boundaries);
  const driverPath = path.join(cleanupDir, "preflight-scout-agent-invoke.cmd");
  try {
    const driver = [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      [quoteWindowsBatchValue(executable), ...options.args.map(quoteWindowsBatchValue)].join(" "),
      ""
    ].join("\r\n");
    await writeFile(driverPath, driver, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return {
      command: commandProcessor,
      args: ["/d", "/s", "/c", driverPath],
      searchPath,
      cleanupDir
    };
  } catch (error) {
    await rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function agentTargetBoundaries(targetRoot: string): Promise<string[]> {
  const target = await canonicalPath(targetRoot);
  const targetBoundary = await findGitRepositoryRoot(target) ?? target;
  const currentGitBoundary = await findGitRepositoryRoot(await canonicalPath(process.cwd()));
  const boundaries = [targetBoundary, currentGitBoundary].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Map(boundaries.map((candidate) => [pathComparisonKey(candidate), candidate])).values()];
}

async function trustedPathDirectories(sourceEnv: NodeJS.ProcessEnv, boundaries: string[]): Promise<string[]> {
  const rawPath = environmentValue(sourceEnv, "PATH") ?? "";
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawPath.split(path.delimiter).slice(0, 256)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const lexical = path.resolve(entry);
    if (boundaries.some((boundary) => isPathWithin(boundary, lexical))) continue;
    let canonical: string;
    try {
      canonical = await realpath(lexical);
      if (!(await stat(canonical)).isDirectory()) continue;
    } catch {
      continue;
    }
    const comparison = pathComparisonKey(canonical);
    if (seen.has(comparison) || boundaries.some((boundary) => isPathWithin(boundary, canonical))) continue;
    seen.add(comparison);
    directories.push(canonical);
  }
  return directories;
}

async function findTrustedExecutable(
  command: string,
  searchDirectories: string[],
  sourceEnv: NodeJS.ProcessEnv,
  boundaries: string[]
): Promise<string> {
  if (!command || command.includes("\0")) throw new Error("Delegated agent executable name is invalid");
  if (path.isAbsolute(command)) {
    const executable = await validateExecutable(command, boundaries);
    if (executable) return executable;
    throw new Error("Configured delegated agent executable is not a trusted executable outside the target repository");
  }
  if (command.includes("/") || command.includes("\\")) {
    throw new Error("Built-in delegated agent commands must resolve by a trusted PATH entry or an absolute executable outside the target repository");
  }

  for (const directory of searchDirectories) {
    for (const name of executableNames(command, sourceEnv)) {
      const executable = await validateExecutable(path.join(directory, name), boundaries);
      if (executable) return executable;
    }
  }
  throw new Error(`Could not resolve a trusted ${command} executable outside the target repository.`);
}

function executableNames(command: string, sourceEnv: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [command];
  if (path.extname(command)) return [command];
  const allowedExtensions = new Set([".com", ".exe", ".bat", ".cmd"]);
  const configured = (environmentValue(sourceEnv, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => allowedExtensions.has(extension));
  return [...new Set(configured)].map((extension) => `${command}${extension}`);
}

async function validateExecutable(candidate: string, boundaries: string[]): Promise<string | undefined> {
  try {
    const canonical = await realpath(candidate);
    if (boundaries.some((boundary) => isPathWithin(boundary, canonical)) || !(await stat(canonical)).isFile()) return undefined;
    if (process.platform === "win32") {
      if (!/\.(?:com|exe|bat|cmd)$/i.test(canonical)) return undefined;
    } else {
      await access(canonical, fsConstants.X_OK);
    }
    return canonical;
  } catch {
    return undefined;
  }
}

async function trustedWindowsCommandProcessor(sourceEnv: NodeJS.ProcessEnv, boundaries: string[]): Promise<string> {
  const systemRoot = environmentValue(sourceEnv, "SYSTEMROOT");
  const candidates = [
    environmentValue(sourceEnv, "COMSPEC"),
    systemRoot ? path.join(systemRoot, "System32", "cmd.exe") : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    const executable = await validateExecutable(candidate, boundaries);
    if (executable) return executable;
  }
  throw new Error("Could not resolve a trusted Windows command processor for the delegated agent wrapper");
}

async function createTrustedWrapperDirectory(boundaries: string[]): Promise<string> {
  const fixedTemporaryBases = process.platform === "win32" ? [] : ["/var/tmp", "/tmp"];
  const candidateBases = [...new Set([tmpdir(), homedir(), ...fixedTemporaryBases].map((candidate) => path.resolve(candidate)))];
  for (const base of candidateBases) {
    let canonicalBase: string;
    try {
      canonicalBase = await realpath(base);
    } catch {
      continue;
    }
    if (boundaries.some((boundary) => isPathWithin(boundary, canonicalBase))) continue;
    let candidate: string | undefined;
    try {
      candidate = await mkdtemp(path.join(canonicalBase, "preflight-scout-agent-"));
      const canonical = await realpath(candidate);
      if (boundaries.some((boundary) => pathsOverlap(boundary, canonical)) || await findGitRepositoryRoot(canonical)) {
        await rm(candidate, { recursive: true, force: true });
        continue;
      }
      return canonical;
    } catch {
      if (candidate) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  throw new Error("Could not create a trusted delegated agent wrapper directory outside the target repository");
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function findGitRepositoryRoot(start: string): Promise<string | undefined> {
  let current = path.resolve(start);
  for (;;) {
    try {
      await access(path.join(current, ".git"));
      return await canonicalPath(current);
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const match = Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value !== undefined);
  return match?.[1];
}

function withTrustedPath(env: NodeJS.ProcessEnv, trustedPath: string): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === "PATH") delete next[key];
  }
  next.PATH = trustedPath;
  return next;
}

function quoteWindowsBatchValue(value: string): string {
  if (/["\0\r\n]/.test(value)) throw new Error("Delegated agent executable arguments cannot contain quotes or newlines on Windows");
  return `"${value.replaceAll("%", "%%")}"`;
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(pathComparisonKey(parent), pathComparisonKey(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathComparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function runCommand(options: AgentCommandRunOptions & { env: NodeJS.ProcessEnv }): Promise<AgentExecResult> {
  return new Promise((resolve, reject) => {
    const childEnv = options.env;
    const childEnvSecrets = secretValuesFromEnv(childEnv);
    let stdout = "";
    let stderr = "";
    const streamBuffers = { stdout: "", stderr: "" };
    let capturedChars = 0;
    let settled = false;
    let terminationReason: "timeout" | "output-limit" | undefined;
    let terminationDiagnostic: string | undefined;
    let terminationProcessErrorCode: string | undefined;
    let terminationExitCode: number | null | undefined;
    let initialTerminationComplete = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let finalTimeoutTimer: NodeJS.Timeout | undefined;
    const startedAt = Date.now();
    const progress = options.onProgress ?? (() => undefined);
    const commandDisplay = formatCommandForDisplay(options.command, options.args);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        detached: process.platform !== "win32"
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      const errorCode = safeSubprocessErrorCode(error);
      reject(new AgentExecError(
        `${options.kind} agent command failed to start (${redactAgentText(errorCode, childEnvSecrets)})`,
        {
          kind: options.kind,
          command: options.command,
          args: options.args,
          promptTransport: options.promptTransport,
          exitCode: null,
          stdout,
          stderr
        },
        { secretValues: childEnvSecrets, sensitivePrompt: options.sensitivePrompt }
      ));
      return;
    }
    progress(`Started ${options.kind} agent command: ${commandDisplay}`);
    const timer = setTimeout(() => {
      beginTermination("timeout");
    }, options.timeoutMs);
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      progress(`Waiting for ${options.kind} agent command (${elapsed}s elapsed; timeout ${Math.round(options.timeoutMs / 1000)}s)`);
    }, options.heartbeatMs);
    child.stdout.on("data", (chunk) => {
      captureOutput("stdout", chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      captureOutput("stderr", chunk.toString());
    });
    child.stdin.on("error", () => undefined);
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
    child.on("error", (error) => {
      if (settled) return;
      const errorCode = safeSubprocessErrorCode(error);
      if (terminationReason) {
        terminationProcessErrorCode = errorCode;
        return;
      }
      settled = true;
      flushAgentOutput();
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finalTimeoutTimer) clearTimeout(finalTimeoutTimer);
      const result = buildRawResult(null);
      reject(new AgentExecError(
        appendCapturedDiagnostics(
          `${options.kind} agent command failed to start (${redactAgentText(errorCode, childEnvSecrets)})`,
          stdout,
          stderr,
          childEnvSecrets,
          options.sensitivePrompt
        ),
        result,
        { timedOut: terminationReason === "timeout", secretValues: childEnvSecrets, sensitivePrompt: options.sensitivePrompt }
      ));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      if (terminationReason) {
        terminationExitCode = exitCode;
        if (initialTerminationComplete) settleTermination(exitCode);
        return;
      }
      settled = true;
      flushAgentOutput();
      clearTimers();
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      progress(`${options.kind} agent command exited with ${exitCode ?? "unknown status"} after ${elapsed}s`);
      resolve(sanitizeSuccessResult(buildRawResult(exitCode), childEnvSecrets, options.sensitivePrompt));
    });

    function captureOutput(stream: "stdout" | "stderr", text: string): void {
      if (settled) return;
      const remaining = Math.max(0, AGENT_OUTPUT_LIMIT_CHARS - capturedChars);
      const accepted = text.slice(0, remaining);
      capturedChars += accepted.length;
      if (stream === "stdout") stdout += accepted;
      else stderr += accepted;
      if (accepted && options.streamOutput) {
        bufferAgentOutput(stream, accepted);
      }
      if (text.length > remaining) beginTermination("output-limit");
    }

    function bufferAgentOutput(stream: "stdout" | "stderr", text: string): void {
      const lines = `${streamBuffers[stream]}${text}`.split(/\r?\n/);
      streamBuffers[stream] = lines.pop() ?? "";
      for (const line of lines) {
        emitAgentOutput(
          progress,
          options.kind,
          stream,
          line,
          options.streamOutput,
          childEnvSecrets,
          options.sensitivePrompt
        );
      }
    }

    function flushAgentOutput(): void {
      if (!options.streamOutput) return;
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = streamBuffers[stream];
        streamBuffers[stream] = "";
        if (tail) {
          emitAgentOutput(
            progress,
            options.kind,
            stream,
            tail,
            options.streamOutput,
            childEnvSecrets,
            options.sensitivePrompt
          );
        }
      }
    }

    function beginTermination(reason: "timeout" | "output-limit"): void {
      if (settled || terminationReason) return;
      terminationReason = reason;
      if (reason === "timeout") {
        progress(`${options.kind} agent command reached its ${Math.round(options.timeoutMs / 1000)}s timeout; terminating it`);
      } else {
        progress(`${options.kind} agent command exceeded its ${AGENT_OUTPUT_LIMIT_CHARS}-character output limit; terminating it`);
      }
      void requestTermination("SIGTERM").then(() => {
        if (settled) return;
        initialTerminationComplete = true;
        if (terminationExitCode !== undefined) {
          settleTermination(terminationExitCode);
          return;
        }
        if (process.platform === "win32") {
          settleTermination(null);
          return;
        }
        forceKillTimer = setTimeout(() => {
          if (settled) return;
          progress(`${options.kind} agent command did not exit after SIGTERM; sending SIGKILL`);
          void requestTermination("SIGKILL").then(() => {
            if (settled) return;
            if (terminationExitCode !== undefined) {
              settleTermination(terminationExitCode);
              return;
            }
            finalTimeoutTimer = setTimeout(() => {
              if (!settled) settleTermination(null);
            }, 1000);
          });
        }, 1000);
      });
    }

    async function requestTermination(signal: NodeJS.Signals): Promise<void> {
      const result = await processTree.terminateProcessTree(child, signal).catch(() => ({
        confirmed: false,
        diagnostic: "Process-tree termination failed without exposing subprocess diagnostics."
      }));
      if (result.diagnostic) {
        terminationDiagnostic = redactAgentText(result.diagnostic, childEnvSecrets);
        progress(terminationDiagnostic);
      }
    }

    function buildRawResult(exitCode: number | null): AgentExecResult {
      return {
        kind: options.kind,
        command: options.command,
        args: options.args,
        promptTransport: options.promptTransport,
        exitCode,
        stdout,
        stderr
      };
    }

    function clearTimers(): void {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finalTimeoutTimer) clearTimeout(finalTimeoutTimer);
    }

    function settleTermination(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      flushAgentOutput();
      clearTimers();
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const result = buildRawResult(exitCode);
      const timedOut = terminationReason === "timeout";
      const reason = timedOut
        ? `timed out after ${Math.round(options.timeoutMs / 1000)}s`
        : `exceeded the ${AGENT_OUTPUT_LIMIT_CHARS}-character output limit`;
      progress(`${options.kind} agent command ${reason} after ${elapsed}s; captured ${stdout.length} stdout and ${stderr.length} stderr characters`);
      reject(new AgentExecError(
        appendCapturedDiagnostics(
          `${options.kind} agent command ${reason}${terminationDiagnostic ? `; ${terminationDiagnostic}` : ""}${terminationProcessErrorCode ? `; subprocess emitted ${terminationProcessErrorCode} during cleanup` : ""}: ${commandDisplay}`,
          stdout,
          stderr,
          childEnvSecrets,
          options.sensitivePrompt
        ),
        result,
        { timedOut, secretValues: childEnvSecrets, sensitivePrompt: options.sensitivePrompt }
      ));
    }
  });
}

function appendCapturedDiagnostics(
  message: string,
  stdout: string,
  stderr: string,
  secretValues: readonly string[] = [],
  sensitivePrompt?: string
): string {
  const sections = [message];
  if (stdout.trim()) sections.push(`Captured stdout:\n${formatCapturedOutput(stdout, secretValues, sensitivePrompt)}`);
  if (stderr.trim()) sections.push(`Captured stderr:\n${formatCapturedOutput(stderr, secretValues, sensitivePrompt)}`);
  return sections.join("\n");
}

function formatCapturedOutput(output: string, secretValues: Iterable<string> = [], sensitivePrompt?: string): string {
  const redacted = redactPromptEcho(redactAgentText(output.trim(), secretValues), sensitivePrompt);
  const limit = 2000;
  if (redacted.length <= limit) return redacted;
  const half = Math.floor(limit / 2);
  return `${redacted.slice(0, half)}\n...[truncated ${redacted.length - limit} characters]...\n${redacted.slice(-half)}`;
}

function safeSubprocessErrorCode(error: unknown): string {
  const value = typeof error === "object" && error !== null && "code" in error && error.code
    ? String(error.code)
    : error instanceof Error
      ? error.name
      : "unknown error";
  return /^[A-Za-z0-9_]+$/.test(value) ? value : "unknown error";
}

function sanitizeSuccessResult(
  result: AgentExecResult,
  secretValues: readonly string[] = [],
  sensitivePrompt?: string
): AgentExecResult {
  const perStreamLimit = Math.floor(AGENT_OUTPUT_LIMIT_CHARS / 2);
  return Object.freeze({
    ...result,
    command: "[command redacted]",
    args: Object.freeze(result.args.map((_, index) => `[arg ${index + 1} redacted]`)) as unknown as string[],
    stdout: formatBoundedOutput(result.stdout, secretValues, perStreamLimit, sensitivePrompt),
    stderr: formatBoundedOutput(result.stderr, secretValues, perStreamLimit, sensitivePrompt)
  });
}

function formatBoundedOutput(output: string, secretValues: Iterable<string>, limit: number, sensitivePrompt?: string): string {
  const redacted = redactPromptEcho(redactAgentText(output, secretValues), sensitivePrompt);
  if (redacted.length <= limit) return redacted;
  const marker = "\n...[truncated after redaction]...\n";
  const available = Math.max(0, limit - marker.length);
  const first = Math.ceil(available / 2);
  return `${redacted.slice(0, first)}${marker}${redacted.slice(-(available - first))}`;
}

function sanitizeErrorResult(
  result: AgentExecResult,
  secretValues: readonly string[] = [],
  sensitivePrompt?: string
): AgentExecResult {
  return Object.freeze({
    ...result,
    command: "[command redacted]",
    args: Object.freeze(result.args.map((_, index) => `[arg ${index + 1} redacted]`)) as unknown as string[],
    stdout: formatCapturedOutput(result.stdout, secretValues, sensitivePrompt),
    stderr: formatCapturedOutput(result.stderr, secretValues, sensitivePrompt)
  });
}

function extractReportedPrimaryCause(
  output: string,
  secretValues: Iterable<string> = [],
  sensitivePrompt?: string
): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*Primary cause:\s*(.+?)\s*$/i);
    if (match?.[1]) return redactPromptEcho(redactAgentText(match[1], secretValues), sensitivePrompt).slice(0, 500);
  }
  return undefined;
}

function formatCommandForDisplay(_command: string, args: string[]): string {
  return `[agent command; ${args.length} args]`;
}

function emitAgentOutput(
  progress: (message: string) => void,
  kind: AgentExecKind,
  stream: "stdout" | "stderr",
  text: string,
  mode: boolean | "signals",
  secretValues: Iterable<string> = [],
  sensitivePrompt?: string
): void {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (mode === "signals" && !isSignalLine(line)) continue;
    const safeLine = redactPromptEcho(redactAgentText(line, secretValues), sensitivePrompt).slice(0, 500);
    progress(`${kind} ${stream}: ${safeLine}${safeLine.length === 500 ? "..." : ""}`);
  }
}

function secretValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && /(TOKEN|KEY|SECRET|PASSWORD|PASS|API|AUTH|CREDENTIAL|COOKIE|SESSION|HEADER|PROXY|EMAIL|USERNAME)/i.test(key))
    .map(([, value]) => value as string);
}

function redactAgentText(value: string, secretValues: Iterable<string> = []): string {
  let redacted = value;
  const secrets = [...new Set(secretValues)]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED_ENV_SECRET]");
  return redactText(redacted);
}

function redactPromptEcho(value: string, sensitivePrompt: string | undefined): string {
  if (!sensitivePrompt || sensitivePrompt.length < 8) return value;
  let redacted = value.split(sensitivePrompt).join("[REDACTED_PROMPT_ECHO]");
  const promptLines = new Set(
    sensitivePrompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 8)
  );
  redacted = redacted.split(/\r?\n/).map((line) => (
    promptLines.has(line.trim()) ? "[REDACTED_PROMPT_ECHO]" : line
  )).join("\n");
  return redacted;
}

function isSignalLine(line: string): boolean {
  return /^(PREFLIGHT_SCOUT_|Primary cause:|Current URL:|Evidence:|Status:|Passed:|Failed:|Blocked:)/i.test(line);
}
