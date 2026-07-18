import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFile, resolveAnalysisOutputDir, resolveContractOutputDir, resolveContractStorageStatePath } from "./local.js";

const execFileAsync = promisify(execFile);
const controlledKeys = [
  "PREFLIGHT_SCOUT_APP_URL",
  "PREFLIGHT_SCOUT_LLM_PROVIDER",
  "PREFLIGHT_SCOUT_EXEC_COMMAND",
  "PREFLIGHT_SCOUT_OPENAI_BASE_URL",
  "PREFLIGHT_SCOUT_MODEL",
  "PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS",
  "PREFLIGHT_SCOUT_BROWSER_QA_EMAIL",
  "PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD",
  "OPENAI_API_KEY",
  "NODE_OPTIONS",
  "GEMINI_CLI_HOME",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_CUSTOM_HEADERS",
  "PLAYWRIGHT_BROWSERS_PATH",
  "GIT_EXEC_PATH",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
  "GIT_TRACE"
];

describe("loadEnvFile", () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-local-env-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
    process.env = { ...originalEnv };
    for (const key of controlledKeys) delete process.env[key];
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a tracked repository env file without mutating provider, command, gateway, or earlier values", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_APP_URL=https://mutated.example",
      "PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec",
      "PREFLIGHT_SCOUT_EXEC_COMMAND=./repo-script",
      "PREFLIGHT_SCOUT_OPENAI_BASE_URL=https://attacker.example",
      "PREFLIGHT_SCOUT_MODEL=attacker-model"
    ].join("\n"));
    await execFileAsync("git", ["add", "--force", ".env.preflight-scout.local"], { cwd: dir });
    process.env.OPENAI_API_KEY = "trusted-existing-key";

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("this file is tracked");

    expect(process.env.PREFLIGHT_SCOUT_APP_URL).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_LLM_PROVIDER).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_EXEC_COMMAND).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_MODEL).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe("trusted-existing-key");
  });

  it("rejects an unignored repository env file before applying any values", async () => {
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_APP_URL=https://mutated.example",
      "PREFLIGHT_SCOUT_EXEC_COMMAND=./repo-script"
    ].join("\n"));

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("this file is not ignored");

    expect(process.env.PREFLIGHT_SCOUT_APP_URL).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_EXEC_COMMAND).toBeUndefined();
  });

  it("rejects privileged controls from an ignored file atomically without trusted runtime opt-in", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_APP_URL=http://127.0.0.1:4173",
      "PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec",
      "PREFLIGHT_SCOUT_EXEC_COMMAND=./repo-script",
      "PREFLIGHT_SCOUT_OPENAI_BASE_URL=https://attacker.example",
      "NODE_OPTIONS=--require ./repo-script",
      "GEMINI_CLI_HOME=./repo-gemini-config",
      "GOOGLE_APPLICATION_CREDENTIALS=../host-credential.json",
      "ANTHROPIC_CUSTOM_HEADERS=x-dangerous: true",
      "PLAYWRIGHT_BROWSERS_PATH=./repo-browser"
    ].join("\n"));

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("Refusing privileged environment controls");

    expect(process.env.PREFLIGHT_SCOUT_APP_URL).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_LLM_PROVIDER).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_EXEC_COMMAND).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.GEMINI_CLI_HOME).toBeUndefined();
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  });

  it("loads ignored local credentials and app configuration", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_APP_URL=http://127.0.0.1:4173",
      "PREFLIGHT_SCOUT_BROWSER_QA_EMAIL=qa@example.com",
      "PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD=test-password",
      "OPENAI_API_KEY=test-provider-key"
    ].join("\n"));

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).resolves.toBe(path.join(dir, ".env.preflight-scout.local"));

    expect(process.env.PREFLIGHT_SCOUT_APP_URL).toBe("http://127.0.0.1:4173");
    expect(process.env.PREFLIGHT_SCOUT_BROWSER_QA_EMAIL).toBe("qa@example.com");
    expect(process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD).toBe("test-password");
    expect(process.env.OPENAI_API_KEY).toBe("test-provider-key");
  });

  it("allows privileged controls only after trusted parent-environment opt-in", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec",
      "PREFLIGHT_SCOUT_EXEC_COMMAND=trusted-agent",
      "PREFLIGHT_SCOUT_OPENAI_BASE_URL=https://trusted-gateway.example",
      "PREFLIGHT_SCOUT_MODEL=trusted-model"
    ].join("\n"));
    process.env.PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS = "1";

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).resolves.toBe(path.join(dir, ".env.preflight-scout.local"));

    expect(process.env.PREFLIGHT_SCOUT_LLM_PROVIDER).toBe("codex-exec");
    expect(process.env.PREFLIGHT_SCOUT_EXEC_COMMAND).toBe("trusted-agent");
    expect(process.env.PREFLIGHT_SCOUT_OPENAI_BASE_URL).toBe("https://trusted-gateway.example");
    expect(process.env.PREFLIGHT_SCOUT_MODEL).toBe("trusted-model");
  });

  it("does not allow the env file to opt itself into privileged controls", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1",
      "PREFLIGHT_SCOUT_EXEC_COMMAND=./repo-script"
    ].join("\n"));

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("must be set in the trusted parent environment");

    expect(process.env.PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS).toBeUndefined();
    expect(process.env.PREFLIGHT_SCOUT_EXEC_COMMAND).toBeUndefined();
  });

  it("rejects every Git control family from an untrusted repository env file", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), [
      "GIT_EXEC_PATH=./repo-git-exec",
      "GIT_PROXY_COMMAND=./repo-proxy",
      "GIT_ASKPASS=./repo-askpass",
      "GIT_TRACE=1"
    ].join("\n"));

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("Refusing privileged environment controls");
    expect(process.env.GIT_EXEC_PATH).toBeUndefined();
    expect(process.env.GIT_PROXY_COMMAND).toBeUndefined();
    expect(process.env.GIT_ASKPASS).toBeUndefined();
    expect(process.env.GIT_TRACE).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("rejects a repository env-file symlink before reading it", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-local-env-external-"));
    try {
      await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
      await writeFile(path.join(external, "secrets.env"), "OPENAI_API_KEY=external-secret\n");
      await symlink(path.join(external, "secrets.env"), path.join(dir, ".env.preflight-scout.local"));

      await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("symbolic link");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects an oversized repository environment file", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.local\n");
    await writeFile(path.join(dir, ".env.preflight-scout.local"), `# ${"x".repeat(1024 * 1024)}\n`);

    await expect(loadEnvFile(dir, ".env.preflight-scout.local")).rejects.toThrow("oversized text file");
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked storage-state metadata sidecar", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-storage-sidecar-"));
    try {
      await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/auth/\n");
      await mkdir(path.join(dir, ".preflight-scout", "auth"), { recursive: true });
      await writeFile(path.join(external, "metadata.json"), "{}\n");
      await symlink(
        path.join(external, "metadata.json"),
        path.join(dir, ".preflight-scout", "auth", "qa.json.preflight-scout.json")
      );

      await expect(resolveContractStorageStatePath(
        dir,
        ".preflight-scout/auth/qa.json",
        "--save-storage-state"
      )).rejects.toThrow("traverses symbolic link");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("resolves an ignored contract output directory beneath .preflight-scout/runs", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/runs/\n");

    await expect(resolveContractOutputDir(dir, ".preflight-scout/runs/latest")).resolves.toBe(
      path.join(dir, ".preflight-scout", "runs", "latest")
    );
  });

  it("uses the configured analysis output directory unless an explicit path overrides it", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/runs/\n");

    await expect(resolveAnalysisOutputDir(
      dir,
      undefined,
      ".preflight-scout/runs/configured-analysis"
    )).resolves.toEqual({
      directory: path.join(dir, ".preflight-scout", "runs", "configured-analysis"),
      boundary: dir
    });

    await expect(resolveAnalysisOutputDir(
      dir,
      ".preflight-scout/runs/explicit-analysis",
      ".preflight-scout/runs/configured-analysis"
    )).resolves.toEqual({
      directory: path.join(dir, ".preflight-scout", "runs", "explicit-analysis"),
      boundary: dir
    });
  });

  it("rejects an explicit in-repository output directory that Git does not ignore", async () => {
    await expect(resolveAnalysisOutputDir(
      dir,
      "preflight-output",
      undefined
    )).rejects.toThrow("must be untracked and ignored by Git");
  });

  it("accepts an explicit in-repository output directory only after Git excludes it", async () => {
    await writeFile(path.join(dir, ".gitignore"), "preflight-output/\n");

    await expect(resolveAnalysisOutputDir(
      dir,
      "preflight-output",
      undefined
    )).resolves.toEqual({
      directory: path.join(dir, "preflight-output"),
      boundary: dir
    });
  });

  it("accepts a directory exclusion even when a later child negation cannot take effect", async () => {
    await writeFile(
      path.join(dir, ".gitignore"),
      "preflight-output/\n!preflight-output/report.md\n"
    );

    await expect(resolveAnalysisOutputDir(
      dir,
      "preflight-output",
      undefined
    )).resolves.toEqual({
      directory: path.join(dir, "preflight-output"),
      boundary: dir
    });
    await expect(execFileAsync(
      "git",
      ["check-ignore", "--quiet", "--", "preflight-output/report.md"],
      { cwd: dir }
    )).resolves.toBeDefined();
  });

  it("rejects an explicit output when Git ignores only its contents and re-includes a generated report", async () => {
    await writeFile(
      path.join(dir, ".gitignore"),
      "preflight-output/*\n!preflight-output/report.md\n"
    );

    await expect(resolveAnalysisOutputDir(
      dir,
      "preflight-output",
      undefined
    )).rejects.toThrow("must be untracked and ignored by Git");
  });

  it("rejects an explicit in-repository output directory containing tracked files", async () => {
    await mkdir(path.join(dir, "preflight-output"));
    await writeFile(path.join(dir, "preflight-output", "tracked.txt"), "tracked\n");
    await execFileAsync("git", ["add", "preflight-output/tracked.txt"], { cwd: dir });

    await expect(resolveAnalysisOutputDir(
      dir,
      "preflight-output",
      undefined
    )).rejects.toThrow("must be untracked and ignored by Git");
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked explicit in-repository output directory", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-explicit-output-external-"));
    try {
      await writeFile(path.join(dir, ".gitignore"), "preflight-output/\n");
      await symlink(external, path.join(dir, "preflight-output"));

      await expect(resolveAnalysisOutputDir(
        dir,
        "preflight-output",
        undefined
      )).rejects.toThrow("unsafe symbolic-link or non-directory path");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a lexical external alias that canonicalizes to the repository root", async () => {
    const aliasParent = await mkdtemp(path.join(tmpdir(), "preflight-scout-output-alias-"));
    try {
      const alias = path.join(aliasParent, "repo-link");
      await symlink(dir, alias, "dir");

      await expect(resolveAnalysisOutputDir(
        dir,
        alias,
        undefined
      )).rejects.toThrow("repository root cannot be used as an artifact directory");
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("accepts a lexical external alias only when its canonical repository child is ignored", async () => {
    const output = path.join(dir, "preflight-output");
    const aliasParent = await mkdtemp(path.join(tmpdir(), "preflight-scout-output-alias-"));
    try {
      await mkdir(output);
      await writeFile(path.join(dir, ".gitignore"), "preflight-output/\n");
      const alias = path.join(aliasParent, "output-link");
      await symlink(output, alias, "dir");

      await expect(resolveAnalysisOutputDir(
        dir,
        alias,
        undefined
      )).resolves.toEqual({ directory: output, boundary: dir });
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a lexical external alias when its canonical repository child can re-include generated files", async () => {
    const output = path.join(dir, "preflight-output");
    const aliasParent = await mkdtemp(path.join(tmpdir(), "preflight-scout-output-alias-"));
    try {
      await mkdir(output);
      await writeFile(
        path.join(dir, ".gitignore"),
        "preflight-output/*\n!preflight-output/report.md\n"
      );
      const alias = path.join(aliasParent, "output-link");
      await symlink(output, alias, "dir");

      await expect(resolveAnalysisOutputDir(
        dir,
        alias,
        undefined
      )).rejects.toThrow("must be untracked and ignored by Git");
    } finally {
      await rm(aliasParent, { recursive: true, force: true });
    }
  });

  it("falls back to the standard analysis run directory when no output is configured", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/runs/\n");

    await expect(resolveAnalysisOutputDir(dir, undefined, undefined)).resolves.toEqual({
      directory: path.join(dir, ".preflight-scout", "runs", "latest"),
      boundary: dir
    });
  });

  it("derives a separate trusted boundary for an explicit external output", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-explicit-output-"));
    try {
      const canonicalExternal = await realpath(external);
      await expect(resolveAnalysisOutputDir(
        dir,
        path.join(external, "nested", "run"),
        undefined
      )).resolves.toEqual({
        directory: path.join(canonicalExternal, "nested", "run"),
        boundary: canonicalExternal
      });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("normalizes the standard macOS /tmp alias for a new explicit output", async () => {
    const alias = "/tmp";
    const aliasStats = await lstat(alias);
    if (!aliasStats.isSymbolicLink()) return;
    const canonicalTmp = await realpath(alias);
    const leaf = `preflight-scout-output-${process.pid}-${Date.now()}`;

    await expect(resolveAnalysisOutputDir(dir, path.join(alias, leaf), undefined)).resolves.toEqual({
      directory: path.join(canonicalTmp, leaf),
      boundary: canonicalTmp
    });
  });

  it("rejects contract output traversal outside .preflight-scout/runs", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/runs/\n");

    await expect(resolveContractOutputDir(dir, "../../outside")).rejects.toThrow("must resolve to a directory beneath");
    await expect(resolveContractOutputDir(dir, ".preflight-scout/runs")).rejects.toThrow("must resolve to a directory beneath");
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked contract output directory", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-output-external-"));
    try {
      await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/runs/\n");
      await mkdir(path.join(dir, ".preflight-scout"), { recursive: true });
      await symlink(external, path.join(dir, ".preflight-scout", "runs"));

      await expect(resolveContractOutputDir(dir, ".preflight-scout/runs/latest")).rejects.toThrow("symbolic link");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});
