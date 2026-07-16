import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTrustedExecutable } from "./trusted-executable.js";

describe("resolveTrustedExecutable", () => {
  let target: string;
  let external: string;

  beforeEach(async () => {
    target = await mkdtemp(path.join(tmpdir(), "preflight-scout-trusted-executable-target-"));
    external = await mkdtemp(path.join(tmpdir(), "preflight-scout-trusted-executable-external-"));
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });

  it("rejects empty and relative target roots", async () => {
    await expect(resolveTrustedExecutable({
      command: process.execPath,
      targetRoot: ""
    })).rejects.toThrow("absolute target root");
    await expect(resolveTrustedExecutable({
      command: process.execPath,
      targetRoot: "relative/repository"
    })).rejects.toThrow("absolute target root");
  });

  it("skips relative, in-repository, and case-variant PATH poisoning", async () => {
    const poisoned = path.join(target, "node_modules", ".bin");
    await mkdir(poisoned, { recursive: true });
    await writeFile(path.join(poisoned, path.basename(process.execPath)), "not the runtime\n");

    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: [".", poisoned, path.dirname(process.execPath)].join(path.delimiter),
      Path: poisoned,
      PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "must-not-affect-resolution"
    };
    const result = await resolveTrustedExecutable({
      command: path.basename(process.execPath),
      targetRoot: target,
      sourceEnv
    });

    expect(result.executable).toBe(await realpath(process.execPath));
    expect(Object.keys(result.env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(result.searchPath.split(path.delimiter)).not.toContain(poisoned);
  });

  it.runIf(process.platform !== "win32")("rejects a PATH symlink whose canonical target is inside the repository", async () => {
    const poisoned = path.join(target, "node_modules", ".bin");
    const linked = path.join(external, "linked-bin");
    await mkdir(poisoned, { recursive: true });
    await symlink(poisoned, linked);

    const result = await resolveTrustedExecutable({
      command: path.basename(process.execPath),
      targetRoot: target,
      sourceEnv: {
        PATH: [linked, path.dirname(process.execPath)].join(path.delimiter)
      }
    });

    expect(result.executable).toBe(await realpath(process.execPath));
    expect(result.searchPath.split(path.delimiter)).not.toContain(await realpath(linked));
  });

  it("rejects an absolute executable supplied by the target repository", async () => {
    const executable = path.join(target, process.platform === "win32" ? "tool.exe" : "tool");
    await writeFile(executable, "not trusted\n", { mode: 0o755 });

    await expect(resolveTrustedExecutable({
      command: executable,
      targetRoot: target,
      sourceEnv: { PATH: path.dirname(process.execPath) }
    })).rejects.toThrow("not a trusted regular executable");
  });
});
