import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTrustedExecutable } from "./trusted-executable.js";

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface TrustedGitOptions {
  targetRoot: string;
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface TrustedGitRunOptions {
  cwd?: string;
  maxBuffer?: number;
  timeout?: number;
}

export interface TrustedGit {
  executable: string;
  env: NodeJS.ProcessEnv;
  exec(args: readonly string[], options?: TrustedGitRunOptions): Promise<{ stdout: string; stderr: string }>;
}

export async function createTrustedGit(options: TrustedGitOptions): Promise<TrustedGit> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const resolved = await resolveTrustedExecutable({
    command: "git",
    targetRoot: options.targetRoot,
    sourceEnv
  });
  const gitEnv = buildGitEnvironment(sourceEnv, resolved.searchPath);

  return {
    executable: resolved.executable,
    env: gitEnv,
    async exec(args, runOptions = {}) {
      const { stdout, stderr } = await execFileAsync(resolved.executable, [
        "-c",
        "core.fsmonitor=false",
        ...args
      ], {
        cwd: runOptions.cwd,
        encoding: "utf8",
        env: gitEnv,
        maxBuffer: runOptions.maxBuffer,
        timeout: runOptions.timeout,
        shell: false,
        windowsHide: true
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    }
  };
}

export async function resolveTrustedGitCommit(
  git: TrustedGit,
  cwd: string,
  reference: string
): Promise<string> {
  const { stdout } = await git.exec(
    ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
    { cwd, maxBuffer: 1024 }
  );
  const object = stdout.trim();
  if (!GIT_OBJECT_ID.test(object)) {
    throw new Error(`Git returned an invalid commit object for ${reference}.`);
  }
  return object;
}

function buildGitEnvironment(sourceEnv: NodeJS.ProcessEnv, searchPath: string): NodeJS.ProcessEnv {
  const allowed = /^(HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.+|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|SSH_AUTH_SOCK|SSH_AGENT_PID|XDG_CONFIG_HOME|SYSTEMROOT|WINDIR|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)$/i;
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(sourceEnv)) {
    const normalized = key.toUpperCase();
    if (value === undefined || seen.has(normalized) || !allowed.test(key)) continue;
    seen.add(normalized);
    env[normalized] = value;
  }
  env.PATH = searchPath;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  return env;
}
