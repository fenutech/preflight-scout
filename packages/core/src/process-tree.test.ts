import { describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath, terminateProcessTree } from "./process-tree.js";

describe("process-tree termination", () => {
  it("derives taskkill only from a drive-root Windows system directory", () => {
    expect(resolveWindowsTaskkillPath("C:\\Windows")).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(resolveWindowsTaskkillPath("d:\\WINDOWS\\")).toBe("d:\\WINDOWS\\System32\\taskkill.exe");
    expect(resolveWindowsTaskkillPath("C:\\workspace\\Windows")).toBeUndefined();
    expect(resolveWindowsTaskkillPath("C:\\Windows\\System32")).toBeUndefined();
    expect(resolveWindowsTaskkillPath("\\\\server\\share\\Windows")).toBeUndefined();
    expect(resolveWindowsTaskkillPath("Windows")).toBeUndefined();
    expect(resolveWindowsTaskkillPath(undefined)).toBeUndefined();
  });

  it("fails safely without a trusted Windows system root and exposes no environment values", async () => {
    const kill = vi.fn(() => true);
    const secret = "environment-secret-that-must-not-appear";
    const result = await terminateProcessTree({ pid: 1234, kill }, "SIGTERM", {
      platform: "win32",
      sourceEnv: {
        SystemRoot: "C:\\workspace\\Windows",
        PREFLIGHT_SCOUT_TEST_SECRET: secret
      }
    });

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.confirmed).toBe(false);
    expect(result.diagnostic).toContain("OS-owned System32 taskkill executable");
    expect(result.diagnostic).not.toContain(secret);
    expect(result.diagnostic).not.toContain("workspace");
  });

  it("preserves direct-child signaling when no POSIX process group is available", async () => {
    const kill = vi.fn(() => true);

    await expect(terminateProcessTree({ kill }, "SIGKILL", { platform: "linux" }))
      .resolves.toEqual({ confirmed: true });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
