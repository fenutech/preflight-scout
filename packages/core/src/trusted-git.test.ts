import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrustedGit, type TrustedGit } from "./trusted-git.js";

const execFileAsync = promisify(execFile);

describe("createTrustedGit", () => {
  let target: string;
  let external: string;
  let hostGit: TrustedGit;

  beforeEach(async () => {
    target = await mkdtemp(path.join(tmpdir(), "preflight-scout-trusted-git-target-"));
    external = await mkdtemp(path.join(tmpdir(), "preflight-scout-trusted-git-external-"));
    hostGit = await createTrustedGit({ targetRoot: target });
    await hostGit.exec(["init", "--quiet"], { cwd: target });
  });

  afterEach(async () => {
    await rm(target, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });

  it("does not execute an in-repository node_modules Git shim or expose secrets to it", async () => {
    const poisoned = path.join(target, "node_modules", ".bin");
    const marker = path.join(external, "shim-ran.txt");
    await mkdir(poisoned, { recursive: true });
    await writeGitShim(path.join(poisoned, gitShimName()), marker);

    const git = await createTrustedGit({
      targetRoot: target,
      sourceEnv: {
        ...process.env,
        PATH: [poisoned, path.dirname(hostGit.executable)].join(path.delimiter),
        PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "browser-secret-must-not-reach-shim",
        OPENAI_API_KEY: "provider-secret-must-not-reach-shim"
      }
    });
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: target });

    expect(stdout.trim()).toBe("true");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("passes only the minimal Git environment to a trusted executable", async () => {
    const wrapperDir = path.join(external, "trusted-bin");
    const capture = path.join(external, "git-env.txt");
    await mkdir(wrapperDir, { recursive: true });
    const wrapper = path.join(wrapperDir, "git");
    await writeFile(wrapper, [
      "#!/bin/sh",
      `env > ${shellQuote(capture)}`,
      `exec ${shellQuote(hostGit.executable)} \"$@\"`,
      ""
    ].join("\n"), { mode: 0o755 });

    const git = await createTrustedGit({
      targetRoot: target,
      sourceEnv: {
        ...process.env,
        PATH: [wrapperDir, path.dirname(hostGit.executable)].join(path.delimiter),
        Path: path.join(target, "node_modules", ".bin"),
        PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "browser-secret",
        OPENAI_API_KEY: "provider-secret",
        ANTHROPIC_API_KEY: "anthropic-secret"
      }
    });
    await git.exec(["--version"], { cwd: target });

    const captured = await readFile(capture, "utf8");
    expect(captured).toContain("GIT_TERMINAL_PROMPT=0");
    expect(captured).toContain("GCM_INTERACTIVE=Never");
    expect(captured).not.toContain("PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD");
    expect(captured).not.toContain("OPENAI_API_KEY");
    expect(captured).not.toContain("ANTHROPIC_API_KEY");
    expect(captured).not.toContain("browser-secret");
    expect(captured).not.toContain("provider-secret");
  });

  it.runIf(process.platform !== "win32")("disables repository-configured fsmonitor commands", async () => {
    const marker = path.join(external, "fsmonitor-ran.txt");
    const fsmonitor = path.join(target, "malicious-fsmonitor.sh");
    await writeFile(fsmonitor, `#!/bin/sh\nprintf '%s' \"$PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD\" > ${shellQuote(marker)}\n`, { mode: 0o755 });
    await hostGit.exec(["config", "core.fsmonitor", fsmonitor], { cwd: target });

    await execFileAsync(hostGit.executable, ["status", "--porcelain"], {
      cwd: target,
      env: { ...process.env, PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "baseline-secret" }
    });
    await expect(readFile(marker, "utf8")).resolves.toBe("baseline-secret");
    await rm(marker, { force: true });

    const git = await createTrustedGit({
      targetRoot: target,
      sourceEnv: {
        ...process.env,
        PATH: path.dirname(hostGit.executable),
        PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD: "fsmonitor-secret"
      }
    });
    await git.exec(["status", "--porcelain"], { cwd: target });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function gitShimName(): string {
  return process.platform === "win32" ? "git.cmd" : "git";
}

async function writeGitShim(filePath: string, marker: string): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(filePath, `@echo off\r\n>\"${marker}\" echo %PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD%\r\n`);
    return;
  }
  await writeFile(filePath, `#!/bin/sh\nprintf '%s' \"$PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD\" > ${shellQuote(marker)}\n`, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
