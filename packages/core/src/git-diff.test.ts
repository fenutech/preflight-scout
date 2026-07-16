import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_GIT_CONTEXT_FILES, readGitDiff, parseNameStatus } from "./git-diff.js";

const execFileAsync = promisify(execFile);

describe("Git diff paths", () => {
  let dir: string;
  let externalDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-git-diff-"));
    externalDir = await mkdtemp(path.join(tmpdir(), "preflight-scout-git-diff-external-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  });

  it("parses NUL-delimited spaces, tabs, and rename records", () => {
    expect(parseNameStatus([
      "M", "src/user profile.ts",
      "M", "src/with\ttab.ts",
      "R100", "src/old name.ts", "src/new name.ts",
      ""
    ].join("\0"))).toEqual([
      { path: "src/user profile.ts", status: "modified" },
      { path: "src/with\ttab.ts", status: "modified" },
      { path: "src/new name.ts", status: "renamed" }
    ]);
  });

  it("treats option-shaped revisions as refs and never lets Git create an output file", async () => {
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "qa@example.com"]);
    await git(["config", "user.name", "Preflight Scout"]);
    await writeFile(path.join(dir, "README.md"), "base\n");
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const marker = path.join(externalDir, "git-option-output.txt");

    await expect(readGitDiff({
      base: `--output=${marker}`,
      head: "HEAD",
      cwd: dir
    })).rejects.toThrow();
    await expect(access(marker)).rejects.toThrow();
  });

  it("reads patches, content, and stats for spaced and renamed paths", async () => {
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "qa@example.com"]);
    await git(["config", "user.name", "Preflight Scout"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "user profile.ts"), "export const user = 1;\n");
    await writeFile(path.join(dir, "src", "old name.ts"), "export const oldName = true;\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const base = (await gitOutput(["rev-parse", "HEAD"])).trim();

    await git(["mv", "src/old name.ts", "src/new name.ts"]);
    await writeFile(path.join(dir, "src", "user profile.ts"), "export const user = 1;\nexport const profile = 2;\n");
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "head"]);
    const head = (await gitOutput(["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(dir, "src", "user profile.ts"), "worktree-only content must not be read\n");

    const pullRequest = await readGitDiff({ base, head, cwd: dir, includePatch: true });
    const profile = pullRequest.files.find((file) => file.path === "src/user profile.ts");
    const renamed = pullRequest.files.find((file) => file.path === "src/new name.ts");

    expect(pullRequest.files.map((file) => file.path).sort()).toEqual(["src/new name.ts", "src/user profile.ts"]);
    expect(profile).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(profile?.patch).toContain("src/user profile.ts");
    expect(profile?.content).toContain("profile = 2");
    expect(profile?.content).not.toContain("worktree-only content");
    expect(renamed).toMatchObject({ status: "renamed", additions: 0, deletions: 0 });
    expect(renamed?.patch).toContain("src/new name.ts");
    expect(renamed?.content).toContain("oldName");
  });

  it("does not follow a changed symlink into the host filesystem", async () => {
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "qa@example.com"]);
    await git(["config", "user.name", "Preflight Scout"]);
    await writeFile(path.join(dir, "README.md"), "base\n");
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const base = (await gitOutput(["rev-parse", "HEAD"])).trim();

    const secret = "external-host-secret-must-never-be-returned";
    const secretPath = path.join(externalDir, "secret.txt");
    await writeFile(secretPath, `${secret}\n`);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await symlink(secretPath, path.join(dir, "src", "safe-name.txt"));
    await writeFile(path.join(dir, "src", "regular.txt"), "regular head content\n");
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "head"]);
    const head = (await gitOutput(["rev-parse", "HEAD"])).trim();

    const pullRequest = await readGitDiff({ base, head, cwd: dir, includePatch: true });
    const symlinkEntry = pullRequest.files.find((file) => file.path === "src/safe-name.txt");
    const regularEntry = pullRequest.files.find((file) => file.path === "src/regular.txt");

    expect(symlinkEntry).toMatchObject({ status: "added", content: undefined });
    expect(JSON.stringify(pullRequest)).not.toContain(secret);
    expect(regularEntry?.content).toBe("regular head content\n");
  });

  it("bounds content returned from large head blobs", async () => {
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "qa@example.com"]);
    await git(["config", "user.name", "Preflight Scout"]);
    await writeFile(path.join(dir, "README.md"), "base\n");
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const base = (await gitOutput(["rev-parse", "HEAD"])).trim();

    await writeFile(path.join(dir, "large.txt"), "x".repeat(1024 * 1024 + 1));
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "head"]);
    const head = (await gitOutput(["rev-parse", "HEAD"])).trim();

    const pullRequest = await readGitDiff({ base, head, cwd: dir, includePatch: true });
    const large = pullRequest.files.find((file) => file.path === "large.txt");

    expect(large?.content).toContain("file content omitted by Preflight Scout");
    expect(large?.content.length).toBeLessThan(200);
  });

  it("retains removed auth policy lines in a bounded deletion patch", async () => {
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "qa@example.com"]);
    await git(["config", "user.name", "Preflight Scout"]);
    await mkdir(path.join(dir, "src", "auth"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "auth", "policy.ts"),
      "export const requireMfa = true;\nexport const denyGuest = true;\n"
    );
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const base = (await gitOutput(["rev-parse", "HEAD"])).trim();

    await unlink(path.join(dir, "src", "auth", "policy.ts"));
    await git(["add", "--all", "--", "."]);
    await git(["commit", "--quiet", "-m", "head"]);
    const head = (await gitOutput(["rev-parse", "HEAD"])).trim();

    const pullRequest = await readGitDiff({ base, head, cwd: dir, includePatch: true });
    const policy = pullRequest.files.find((file) => file.path === "src/auth/policy.ts");

    expect(policy).toMatchObject({ status: "deleted", additions: 0, deletions: 2 });
    expect(policy?.content).toBeUndefined();
    expect(policy?.patch).toContain("-export const requireMfa = true;");
    expect(policy?.patch).toContain("-export const denyGuest = true;");
    expect(policy?.patch.length).toBeLessThanOrEqual(12050);
  });

  it("retains all changed-file metadata while marking context beyond the global file budget", async () => {
    await git(["init", "--quiet"]);
    await git(["config", "user.email", "qa@example.com"]);
    await git(["config", "user.name", "Preflight Scout"]);
    await writeFile(path.join(dir, "README.md"), "base\n");
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const base = (await gitOutput(["rev-parse", "HEAD"])).trim();

    await mkdir(path.join(dir, "many"), { recursive: true });
    await Promise.all(Array.from({ length: MAX_GIT_CONTEXT_FILES + 10 }, (_, index) =>
      writeFile(path.join(dir, "many", `file-${String(index).padStart(3, "0")}.txt`), `changed ${index}\n`)
    ));
    await git(["add", "--", "."]);
    await git(["commit", "--quiet", "-m", "large change"]);
    const head = (await gitOutput(["rev-parse", "HEAD"])).trim();

    const pullRequest = await readGitDiff({ base, head, cwd: dir, includePatch: true });
    const omitted = pullRequest.files.filter((file) => file.contextStatus === "omitted_changed_file_limit");

    expect(pullRequest.files).toHaveLength(MAX_GIT_CONTEXT_FILES + 10);
    expect(pullRequest.files.every((file) => typeof file.path === "string" && file.additions === 1)).toBe(true);
    expect(omitted).toHaveLength(10);
    expect(omitted[0]?.patch).toContain("metadata retained");
    expect(pullRequest.contextCoverage).toMatchObject({
      totalFiles: MAX_GIT_CONTEXT_FILES + 10,
      filesWithContext: MAX_GIT_CONTEXT_FILES,
      omittedFiles: 10,
      complete: false
    });
    expect(pullRequest.contextCoverage?.note).toContain("impact coverage as incomplete");
  }, 20_000);

  async function git(args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd: dir });
  }

  async function gitOutput(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: dir, encoding: "utf8" });
    return stdout;
  }
});
