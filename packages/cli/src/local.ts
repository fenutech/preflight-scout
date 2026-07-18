import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertPathHasNoSymlinks,
  createTrustedGit,
  readTextIfExists,
  resolveTrustedGitCommit,
  type ProgressCallback,
  type QAContract,
  type QAFlowMission,
  type TrustedGit
} from "@preflight-scout/core";
const TRUST_ENV_FILE_CONTROLS = "PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS";
const PRIVILEGED_ENV_FILE_KEYS = new Set([
  "PREFLIGHT_SCOUT_LLM_PROVIDER",
  "PREFLIGHT_SCOUT_LLM_PROVIDER_ATTEMPTS",
  "PREFLIGHT_SCOUT_BASE_REF",
  "PREFLIGHT_SCOUT_MODEL",
  "PREFLIGHT_SCOUT_REASONING_EFFORT",
  "PREFLIGHT_SCOUT_PROGRESS",
  "PREFLIGHT_SCOUT_OPENAI_BASE_URL",
  "PREFLIGHT_SCOUT_ANTHROPIC_BASE_URL",
  "PREFLIGHT_SCOUT_GEMINI_BASE_URL",
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "ZDOTDIR",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "PERL5OPT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "SSH_ASKPASS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSLKEYLOGFILE",
  "OPENSSL_CONF",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_CLI_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "CLOUDSDK_CONFIG",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH"
]);

export async function assertCanWriteConfig(root: string, force: boolean): Promise<void> {
  const configPath = path.join(root, ".preflight-scout", "config.yml");
  if (!force && await exists(configPath)) {
    throw new Error(`${configPath} already exists. Pass --force to overwrite it.`);
  }
}

export async function loadEnvFile(root: string, envFile?: string): Promise<string | undefined> {
  if (!envFile) return undefined;
  const resolvedRoot = path.resolve(root);
  const envPath = path.resolve(resolvedRoot, envFile);
  if (!await exists(envPath)) return undefined;

  let repoLocal = false;
  if (isPathWithin(resolvedRoot, envPath)) {
    repoLocal = true;
    await assertPathHasNoSymlinks(resolvedRoot, envPath, { allowMissing: false, leafType: "file" });
    await assertRepoEnvFileIsIgnoredAndUntracked(resolvedRoot, envPath);
  }

  const text = await readTextIfExists(envPath, {
    ...(repoLocal ? { boundary: resolvedRoot } : {}),
    maxBytes: 1024 * 1024
  });
  if (text === undefined) return undefined;
  const entries: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    entries.push(parsed);
  }

  assertEnvFileControlsAreTrusted(envPath, entries.map(([key]) => key));
  for (const [key, value] of entries) {
    process.env[key] ??= value;
  }
  return envPath;
}

export function parseTargetEnv(value: string | undefined, label: string): "auto" | "local" | "staging" | undefined {
  if (!value) return undefined;
  if (value === "auto" || value === "local" || value === "staging") return value;
  throw new Error(`${label} must be auto, local, or staging.`);
}

export function renderInitSummary(root: string, contract: QAContract): string {
  const roles = Object.keys(contract.auth?.roles ?? {});
  const urls = [
    contract.app.url ? `app.url=${contract.app.url}` : undefined,
    contract.app.localUrl ? `app.localUrl=${contract.app.localUrl}` : undefined,
    contract.app.stagingUrl ? `app.stagingUrl=${contract.app.stagingUrl}` : undefined,
    ...Object.entries(contract.app.targets ?? {}).flatMap(([name, target]) => [
      target.url ? `app.targets.${name}.url=${target.url}` : undefined,
      target.localUrl ? `app.targets.${name}.localUrl=${target.localUrl}` : undefined,
      target.stagingUrl ? `app.targets.${name}.stagingUrl=${target.stagingUrl}` : undefined
    ])
  ].filter(Boolean);
  const missing = contract.unknowns.length ? contract.unknowns.map((item) => `- ${item}`).join("\n") : "- none";
  return [
    "Preflight Scout init wrote:",
    `- ${path.join(root, ".preflight-scout", "config.yml")}`,
    `- ${path.join(root, ".preflight-scout", "context.md")}`,
    `- ${path.join(root, ".preflight-scout", "flows.yml")}`,
    `- ${path.join(root, ".preflight-scout", "policies.yml")}`,
    `- ${path.join(root, ".env.preflight-scout.example")}`,
    `- ${path.join(root, ".gitignore")} (ensured .preflight-scout/auth/, .preflight-scout/runs/, .preflight-scout/approvals.local.yml, and .env.preflight-scout.local are ignored)`,
    "",
    `App: ${contract.app.name ?? "unknown"}`,
    `URLs: ${urls.join(", ") || "none configured yet"}`,
    `Roles: ${roles.join(", ") || "none configured yet"}`,
    `Default target: ${contract.defaults?.target ?? "default"}`,
    `Default base: ${contract.defaults?.baseRef ?? "auto from git origin/HEAD"}`,
    "",
    "Things to review:",
    missing
  ].join("\n");
}

export async function resolveBaseRef(root: string, explicit: string | undefined, contract: QAContract): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const git = await createTrustedGit({ targetRoot: resolvedRoot });
  const selected = explicit ?? process.env.PREFLIGHT_SCOUT_BASE_REF ?? contract.defaults?.baseRef;
  if (selected) return resolveTrustedGitCommit(git, resolvedRoot, selected);
  const originHead = await tryGit(git, root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return resolveTrustedGitCommit(git, resolvedRoot, originHead);
  const upstreamBase = await tryGit(git, root, ["merge-base", "--fork-point", "@{upstream}", "HEAD"]);
  if (upstreamBase) return resolveTrustedGitCommit(git, resolvedRoot, upstreamBase);
  throw new Error("Could not resolve a base ref. Pass --base, set PREFLIGHT_SCOUT_BASE_REF, or add defaults.baseRef to .preflight-scout/config.yml.");
}

export async function resolveHeadRef(root: string, reference = "HEAD"): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const git = await createTrustedGit({ targetRoot: resolvedRoot });
  return resolveTrustedGitCommit(git, resolvedRoot, reference);
}

export async function resolveStorageOptions(
  root: string,
  contract: QAContract,
  missions: QAFlowMission[],
  explicit: { storageState?: string; saveStorageState?: string }
): Promise<{ storageState?: string; saveStorageState?: string }> {
  const configuredAuthRoles = new Set(Object.keys(contract.auth?.roles ?? {}));
  const selectedAuthRoles = new Set(
    missions
      .map((mission) => mission.role)
      .filter((role): role is string => typeof role === "string" && configuredAuthRoles.has(role))
  );
  const roleStorage = new Set(
    [...selectedAuthRoles]
      .map((role) => contract.auth?.roles?.[role]?.storageState ?? contract.auth?.storageState ?? contract.defaults?.storageState)
      .filter((value): value is string => Boolean(value))
  );
  const roleSaveStorage = new Set(
    [...selectedAuthRoles]
      .map((role) => contract.auth?.roles?.[role]?.storageState ?? contract.auth?.saveStorageState ?? contract.defaults?.saveStorageState)
      .filter((value): value is string => Boolean(value))
  );
  const roleStorageState = selectedAuthRoles.size > 0 && roleStorage.size === 1 ? [...roleStorage][0] : undefined;
  const roleSaveStorageState = selectedAuthRoles.size > 0 && roleSaveStorage.size === 1 ? [...roleSaveStorage][0] : undefined;
  const storageState = await resolveSelectedStorageStatePath(root, explicit.storageState, roleStorageState, "--storage-state");
  const saveStorageState = await resolveSelectedStorageStatePath(root, explicit.saveStorageState, roleSaveStorageState, "--save-storage-state");
  return {
    storageState,
    saveStorageState
  };
}

export async function resolveContractStorageStatePath(
  root: string,
  configuredPath: string,
  explicitFlag: "--storage-state" | "--save-storage-state"
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const authBoundary = path.join(resolvedRoot, ".preflight-scout", "auth");
  const resolvedPath = path.resolve(resolvedRoot, configuredPath);
  const relativeToBoundary = path.relative(authBoundary, resolvedPath);
  if (
    relativeToBoundary === ""
    || relativeToBoundary === ".."
    || relativeToBoundary.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToBoundary)
  ) {
    throw contractStoragePathError(
      configuredPath,
      `it must resolve to a file beneath ${authBoundary}`,
      explicitFlag
    );
  }

  const sidecarPath = `${resolvedPath}.preflight-scout.json`;
  try {
    await assertPathHasNoSymlinks(resolvedRoot, resolvedPath, { allowMissing: true, leafType: "file" });
    await assertPathHasNoSymlinks(resolvedRoot, sidecarPath, { allowMissing: true, leafType: "file" });
  } catch (error) {
    throw contractStoragePathError(
      configuredPath,
      "the storage-state path or its metadata sidecar traverses symbolic link or existing non-regular path",
      explicitFlag,
      error
    );
  }

  const relativePaths = [resolvedPath, sidecarPath]
    .map((candidate) => path.relative(resolvedRoot, candidate).split(path.sep).join("/"));
  const git = await createTrustedGit({ targetRoot: resolvedRoot });
  try {
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: resolvedRoot });
    if (stdout.trim() !== "true") throw new Error("not inside a Git worktree");
  } catch (error) {
    throw contractStoragePathError(
      configuredPath,
      "Git could not verify that the path belongs to a worktree",
      explicitFlag,
      error
    );
  }

  try {
    for (const relativePath of relativePaths) {
      if (await gitPredicate(git, resolvedRoot, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", relativePath])) {
        throw contractStoragePathError(
          configuredPath,
          `the resolved storage path or metadata sidecar is tracked by Git; remove it from the index and keep .preflight-scout/auth/ ignored`,
          explicitFlag
        );
      }
      if (!await gitPredicate(git, resolvedRoot, ["check-ignore", "--quiet", "--", relativePath])) {
        throw contractStoragePathError(
          configuredPath,
          `the resolved storage path or metadata sidecar is not ignored by Git; add .preflight-scout/auth/ to .gitignore`,
          explicitFlag
        );
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing contract-derived storage state path ")) throw error;
    throw contractStoragePathError(
      configuredPath,
      `Git could not prove that ${resolvedPath} is both ignored and untracked`,
      explicitFlag,
      error
    );
  }

  return resolvedPath;
}

export async function resolveContractOutputDir(
  root: string,
  configuredPath: string,
  explicitFlag = "--output-dir"
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const runsBoundary = path.join(resolvedRoot, ".preflight-scout", "runs");
  const resolvedPath = path.resolve(resolvedRoot, configuredPath);
  const relativeToBoundary = path.relative(runsBoundary, resolvedPath);
  if (
    relativeToBoundary === ""
    || relativeToBoundary === ".."
    || relativeToBoundary.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToBoundary)
  ) {
    throw contractOutputPathError(
      configuredPath,
      `it must resolve to a directory beneath ${runsBoundary}`,
      explicitFlag
    );
  }

  try {
    await assertPathHasNoSymlinks(resolvedRoot, resolvedPath, { allowMissing: true, leafType: "directory" });
  } catch (error) {
    throw contractOutputPathError(
      configuredPath,
      "the output directory traverses a symbolic link or existing non-directory path",
      explicitFlag,
      error
    );
  }

  const relativePath = path.relative(resolvedRoot, resolvedPath).split(path.sep).join("/");
  try {
    const git = await createTrustedGit({ targetRoot: resolvedRoot });
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: resolvedRoot });
    if (stdout.trim() !== "true") throw new Error("not inside a Git worktree");
    if (await gitPredicate(git, resolvedRoot, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", relativePath])) {
      throw contractOutputPathError(
        configuredPath,
        `the resolved output directory ${resolvedPath} is tracked by Git; remove it from the index and keep .preflight-scout/runs/ ignored`,
        explicitFlag
      );
    }
    if (!await gitPredicate(git, resolvedRoot, ["check-ignore", "--quiet", "--", relativePath])) {
      throw contractOutputPathError(
        configuredPath,
        `the resolved output directory ${resolvedPath} is not ignored by Git; add .preflight-scout/runs/ to .gitignore`,
        explicitFlag
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing contract-derived output directory ")) throw error;
    throw contractOutputPathError(
      configuredPath,
      `Git could not prove that ${resolvedPath} is both ignored and untracked`,
      explicitFlag,
      error
    );
  }

  return resolvedPath;
}

export async function resolveAnalysisOutputDir(
  root: string,
  explicitPath: string | undefined,
  configuredPath: string | undefined
): Promise<{ directory: string; boundary: string }> {
  const resolvedRoot = path.resolve(root);
  if (!explicitPath) {
    return {
      directory: await resolveContractOutputDir(resolvedRoot, configuredPath ?? ".preflight-scout/runs/latest"),
      boundary: resolvedRoot
    };
  }
  const requested = path.resolve(resolveRepoPath(resolvedRoot, explicitPath));
  if (isPathWithin(resolvedRoot, requested)) {
    return { directory: requested, boundary: resolvedRoot };
  }
  return resolveExternalWriteDirectory(requested);
}

export async function resolveArtifactReadDirectory(
  root: string,
  value: string
): Promise<{ directory: string; boundary: string }> {
  const resolvedRoot = path.resolve(root);
  const requested = path.resolve(resolveRepoPath(resolvedRoot, value));
  if (isPathWithin(resolvedRoot, requested)) {
    return { directory: requested, boundary: resolvedRoot };
  }
  try {
    const canonical = await fs.realpath(requested);
    const stats = await fs.lstat(canonical);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a directory");
    return { directory: canonical, boundary: canonical };
  } catch {
    throw new Error("The explicit external artifact directory does not exist or is unsafe.");
  }
}

export async function resolveArtifactReadFile(
  root: string,
  value: string
): Promise<{ file: string; boundary: string }> {
  const resolvedRoot = path.resolve(root);
  const requested = path.resolve(resolveRepoPath(resolvedRoot, value));
  if (isPathWithin(resolvedRoot, requested)) {
    return { file: requested, boundary: resolvedRoot };
  }
  try {
    const canonical = await fs.realpath(requested);
    const stats = await fs.lstat(canonical);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a file");
    return { file: canonical, boundary: path.dirname(canonical) };
  } catch {
    throw new Error("The explicit external artifact file does not exist or is unsafe.");
  }
}

export function createProgressReporter(enabled = true): ProgressCallback {
  enabled = enabled && process.env.PREFLIGHT_SCOUT_PROGRESS !== "0";
  const startedAt = Date.now();
  return (message) => {
    if (!enabled) return;
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`[preflight-scout ${elapsedSeconds}s] ${message}\n`);
  };
}

export function resolveRepoPath(root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

async function resolveExternalWriteDirectory(
  requested: string
): Promise<{ directory: string; boundary: string }> {
  let existing = requested;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalBoundary = await fs.realpath(existing);
      const stats = await fs.lstat(canonicalBoundary);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe directory");
      return {
        directory: path.join(canonicalBoundary, ...missingSegments),
        boundary: canonicalBoundary
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("The explicit external output directory is unsafe.");
      }
    }
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("The explicit external output directory has no safe existing ancestor.");
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return undefined;
  let value = match[2] ?? "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1]!, value.replace(/\\n/g, "\n")];
}

async function assertRepoEnvFileIsIgnoredAndUntracked(root: string, envPath: string): Promise<void> {
  const relativePath = path.relative(root, envPath);
  try {
    const git = await createTrustedGit({ targetRoot: path.resolve(root) });
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: root });
    if (stdout.trim() !== "true") throw new Error("not inside a Git worktree");

    if (await gitPredicate(git, root, ["ls-files", "--error-unmatch", "--", relativePath])) {
      throw new Error(`Refusing to load ${envPath}: repository-local environment files must be untracked and ignored by Git, but this file is tracked.`);
    }
    if (!await gitPredicate(git, root, ["check-ignore", "--quiet", "--", relativePath])) {
      throw new Error(`Refusing to load ${envPath}: repository-local environment files must be untracked and ignored by Git, but this file is not ignored.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing to load ")) throw error;
    throw new Error(`Refusing to load ${envPath}: could not verify that the repository-local environment file is untracked and ignored by Git.`, { cause: error });
  }
}

function assertEnvFileControlsAreTrusted(envPath: string, keys: string[]): void {
  const normalizedKeys = keys.map((key) => key.toUpperCase());
  if (normalizedKeys.includes(TRUST_ENV_FILE_CONTROLS)) {
    throw new Error(`${TRUST_ENV_FILE_CONTROLS} must be set in the trusted parent environment and must not appear in ${envPath}.`);
  }

  const privilegedKeys = [...new Set(normalizedKeys.filter(isPrivilegedEnvFileKey))].sort();
  if (!privilegedKeys.length || process.env[TRUST_ENV_FILE_CONTROLS] === "1") return;
  throw new Error(
    `Refusing privileged environment controls from ${envPath}: ${privilegedKeys.join(", ")}. `
    + `Set ${TRUST_ENV_FILE_CONTROLS}=1 in the trusted parent environment only when this ignored local file is intentionally trusted.`
  );
}

function isPrivilegedEnvFileKey(key: string): boolean {
  return PRIVILEGED_ENV_FILE_KEYS.has(key)
    || key.startsWith("PREFLIGHT_SCOUT_EXEC_")
    || key.startsWith("PREFLIGHT_SCOUT_AGENT_")
    || key.startsWith("PREFLIGHT_SCOUT_LLM_")
    || key.startsWith("GIT_")
    || key.startsWith("XDG_");
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

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function tryGit(git: TrustedGit, root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await git.exec(args, { cwd: root });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSelectedStorageStatePath(
  root: string,
  explicitPath: string | undefined,
  configuredPath: string | undefined,
  explicitFlag: "--storage-state" | "--save-storage-state"
): Promise<string | undefined> {
  if (explicitPath !== undefined) return resolveOptionalRepoPath(root, explicitPath);
  if (!configuredPath) return undefined;
  return resolveContractStorageStatePath(root, configuredPath, explicitFlag);
}

function contractStoragePathError(
  configuredPath: string,
  reason: string,
  explicitFlag: "--storage-state" | "--save-storage-state",
  cause?: unknown
): Error {
  return new Error(
    `Refusing contract-derived storage state path ${JSON.stringify(configuredPath)}: ${reason}. `
    + `If an external path is intentional, pass it explicitly with ${explicitFlag}.`,
    cause === undefined ? undefined : { cause }
  );
}

function contractOutputPathError(
  configuredPath: string,
  reason: string,
  explicitFlag: string,
  cause?: unknown
): Error {
  return new Error(
    `Refusing contract-derived output directory ${JSON.stringify(configuredPath)}: ${reason}. `
    + `If another path is intentional, pass it explicitly with ${explicitFlag}.`,
    cause === undefined ? undefined : { cause }
  );
}

function resolveOptionalRepoPath(root: string, value: string | undefined): string | undefined {
  return value ? resolveRepoPath(root, value) : undefined;
}
