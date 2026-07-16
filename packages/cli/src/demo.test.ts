import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGenericDemoRepo } from "./demo.js";

const execFileAsync = promisify(execFile);

describe("createGenericDemoRepo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-demo-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a standalone git repo with a PR-style checkout change", async () => {
    const result = await createGenericDemoRepo({ output: path.join(dir, "shop") });
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD~1...HEAD"], { cwd: result.root });
    const config = await readFile(path.join(result.root, ".preflight-scout", "config.yml"), "utf8");
    const gitignore = await readFile(path.join(result.root, ".gitignore"), "utf8");

    expect(result.base).toBe("HEAD~1");
    expect(result.head).toBe("HEAD");
    expect(result.appUrl).toBe("http://127.0.0.1:4173");
    expect(stdout).toContain("index.html");
    expect(stdout).toContain("src/checkout.js");
    expect(config).toContain("valid_coupon: SAVE10");
    expect(config).toContain("baseRef: HEAD~1");
    expect(config).toContain("targetEnv: local");
    expect(gitignore).toContain(".preflight-scout/auth/");
  });

  it("creates a standalone authenticated dashboard repo", async () => {
    const result = await createGenericDemoRepo({ output: path.join(dir, "dashboard"), scenario: "auth-dashboard" });
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD~1...HEAD"], { cwd: result.root });
    const config = await readFile(path.join(result.root, ".preflight-scout", "config.yml"), "utf8");

    expect(result.appUrl).toBe("http://127.0.0.1:4173");
    expect(stdout).toContain("index.html");
    expect(stdout).toContain("src/auth-dashboard.js");
    expect(config).toContain("loginUrl: /login");
    expect(config).toContain("PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL");
    expect(config).toContain("storageState: .preflight-scout/auth/qa_user.json");
  });

  it("refuses to overwrite an unrelated existing directory, even with force", async () => {
    const unrelated = path.join(dir, "unrelated");
    const sentinel = path.join(unrelated, "keep-me.txt");
    await mkdir(unrelated, { recursive: true });
    await writeFile(sentinel, "preserve\n", { flag: "wx" });

    await expect(createGenericDemoRepo({ output: unrelated })).rejects.toThrow("already exists");
    await expect(createGenericDemoRepo({ output: unrelated, force: true })).rejects.toThrow("not a recognizable Preflight Scout demo");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
  });

  it("allows force replacement only after the demo marker exists", async () => {
    const output = path.join(dir, "replaceable");
    await createGenericDemoRepo({ output });
    await writeFile(path.join(output, "stale.txt"), "old\n");

    await expect(createGenericDemoRepo({ output, force: true })).resolves.toMatchObject({ root: output });
    await expect(readFile(path.join(output, "stale.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("does not replace a demo through a symlinked ancestor", async () => {
    const realParent = path.join(dir, "real-parent");
    const realOutput = path.join(realParent, "demo");
    await mkdir(realParent, { recursive: true });
    await createGenericDemoRepo({ output: realOutput });
    const sentinel = path.join(realOutput, "keep-me.txt");
    await writeFile(sentinel, "preserve\n");
    const alias = path.join(dir, "alias");
    await symlink(realParent, alias);

    await expect(createGenericDemoRepo({ output: path.join(alias, "demo"), force: true })).rejects.toThrow(
      "traverses symbolic link"
    );
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
  });

  it("rejects filesystem-root, home, and current-working-directory force targets before deletion", async () => {
    await expect(createGenericDemoRepo({ output: path.parse(dir).root, force: true })).rejects.toThrow("destructive demo output path");
    await expect(createGenericDemoRepo({ output: homedir(), force: true })).rejects.toThrow("destructive demo output path");
    await expect(createGenericDemoRepo({ output: process.cwd(), force: true })).rejects.toThrow("destructive demo output path");
  });
});
