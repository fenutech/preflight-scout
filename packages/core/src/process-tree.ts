import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const MAX_WINDOWS_PID = 0xffff_ffff;

export interface ProcessTreeChild {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ProcessTreeTerminationResult {
  confirmed: boolean;
  diagnostic?: string;
}

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
  windowsTaskkillTimeoutMs?: number;
}

/**
 * Terminate a spawned subprocess and its descendants.
 *
 * POSIX callers retain the existing detached-process-group signaling behavior.
 * Windows has no equivalent Node signal API, so it invokes the OS-owned
 * System32/taskkill.exe by absolute path with `/T /F`. Taskkill output is never
 * surfaced: callers receive only bounded, path-free diagnostics.
 */
export async function terminateProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  options: ProcessTreeTerminationOptions = {}
): Promise<ProcessTreeTerminationResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
        return { confirmed: true };
      } catch {
        // Fall back to signaling the direct child when the process group is gone.
      }
    }
    return terminateDirectChild(child, signal);
  }

  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0 || pid > MAX_WINDOWS_PID) {
    const fallback = terminateDirectChild(child, signal);
    return {
      confirmed: false,
      diagnostic: fallback.confirmed
        ? "Windows process-tree termination was unavailable for an invalid process identifier; the direct child was signaled."
        : "Windows process-tree termination was unavailable for an invalid process identifier."
    };
  }

  const sourceEnv = options.sourceEnv ?? process.env;
  const systemRoot = environmentValue(sourceEnv, "SYSTEMROOT");
  const taskkill = resolveWindowsTaskkillPath(systemRoot);
  if (!taskkill || !systemRoot) {
    const fallback = terminateDirectChild(child, signal);
    return {
      confirmed: false,
      diagnostic: fallback.confirmed
        ? "Windows process-tree termination requires the OS-owned System32 taskkill executable; the direct child was signaled."
        : "Windows process-tree termination requires the OS-owned System32 taskkill executable."
    };
  }

  const timeoutMs = options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    throw new Error("Windows process-tree termination timeout must be an integer between 1 and 10000 milliseconds.");
  }

  const result = await runWindowsTaskkill(taskkill, systemRoot, pid, timeoutMs);
  if (result.confirmed) return result;

  const fallback = terminateDirectChild(child, signal);
  return {
    confirmed: false,
    diagnostic: fallback.confirmed
      ? `${result.diagnostic ?? "Windows process-tree termination could not be confirmed"}; the direct child was signaled.`
      : result.diagnostic
  };
}

/** Resolve only a drive-root `Windows\\System32\\taskkill.exe` path. */
export function resolveWindowsTaskkillPath(systemRoot: string | undefined): string | undefined {
  if (typeof systemRoot !== "string" || !systemRoot.trim() || systemRoot.includes("\0")) return undefined;
  if (!path.win32.isAbsolute(systemRoot)) return undefined;
  const normalized = path.win32.resolve(systemRoot);
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) return undefined;
  if (path.win32.dirname(normalized).toLowerCase() !== parsed.root.toLowerCase()) return undefined;
  if (path.win32.basename(normalized).toLowerCase() !== "windows") return undefined;
  return path.win32.join(normalized, "System32", "taskkill.exe");
}

function runWindowsTaskkill(
  executable: string,
  systemRoot: string,
  pid: number,
  timeoutMs: number
): Promise<ProcessTreeTerminationResult> {
  return new Promise((resolve) => {
    let settled = false;
    let killer: ChildProcess;
    try {
      killer = spawn(executable, ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot
        }
      });
    } catch (error) {
      resolve({
        confirmed: false,
        diagnostic: `Windows process-tree termination failed to start (${safeErrorCode(error)}).`
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        killer.kill("SIGKILL");
      } catch {
        // The bounded result below is authoritative even if taskkill already exited.
      }
      resolve({
        confirmed: false,
        diagnostic: `Windows process-tree termination exceeded its ${timeoutMs}ms cleanup limit.`
      });
    }, timeoutMs);

    killer.once("error", (error) => {
      finish({
        confirmed: false,
        diagnostic: `Windows process-tree termination failed to start (${safeErrorCode(error)}).`
      });
    });
    killer.once("close", (exitCode) => {
      finish(exitCode === 0
        ? { confirmed: true }
        : {
            confirmed: false,
            diagnostic: `Windows process-tree termination exited with status ${safeExitCode(exitCode)}.`
          });
    });

    function finish(result: ProcessTreeTerminationResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
  });
}

function terminateDirectChild(child: ProcessTreeChild, signal: NodeJS.Signals): ProcessTreeTerminationResult {
  try {
    return child.kill(signal)
      ? { confirmed: true }
      : { confirmed: false, diagnostic: "Direct child termination could not be confirmed." };
  } catch {
    return { confirmed: false, diagnostic: "Direct child termination could not be confirmed." };
  }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value !== undefined)?.[1];
}

function safeErrorCode(error: unknown): string {
  const value = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
  return /^[A-Za-z0-9_]+$/.test(value) ? value : "unknown error";
}

function safeExitCode(exitCode: number | null): string {
  return Number.isSafeInteger(exitCode) && exitCode !== null ? String(exitCode) : "unknown";
}
