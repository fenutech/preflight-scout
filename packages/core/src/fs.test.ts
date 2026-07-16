import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafeIndexedPath, readTextIfExists, walkFiles, writeTextEnsuringDir } from "./fs.js";

const execFileAsync = promisify(execFile);

describe("walkFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-files-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores the trusted Action checkout used by self-check analysis", async () => {
    for (const checkout of [".preflight-scout-trusted-action", ".preflight-trusted-action"]) {
      await mkdir(path.join(dir, checkout), { recursive: true });
      await writeFile(path.join(dir, checkout, "package.json"), "{}\n");
    }
    await writeFile(path.join(dir, "package.json"), "{}\n");

    await expect(walkFiles(dir)).resolves.toEqual(["package.json"]);
  });

  it("uses Git tracking and ignore rules before applying the file cap", async () => {
    await git(dir, ["init", "--quiet"]);
    await mkdir(path.join(dir, "ignored-customer"), { recursive: true });
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), "ignored-customer/\n");
    await writeFile(path.join(dir, "ignored-customer", "customer-alice.json"), "private\n");
    await writeFile(path.join(dir, "src", "tracked.ts"), "export {};\n");
    await writeFile(path.join(dir, "src", "untracked.ts"), "export {};\n");
    await git(dir, ["add", "src/tracked.ts"]);

    const files = await walkFiles(dir, { maxFiles: 2 });
    const uncappedFiles = await walkFiles(dir);

    expect(files).toContain("src/tracked.ts");
    expect(files).not.toContain("ignored-customer/customer-alice.json");
    expect(files).toHaveLength(2);
    expect(uncappedFiles).toContain("src/untracked.ts");
    expect(uncappedFiles).not.toContain("ignored-customer/customer-alice.json");
  });

  it("always excludes credential, run, build, environment, and package artifacts", async () => {
    await git(dir, ["init", "--quiet"]);
    const excluded = [
      ".env.customer-alice",
      "packages/app/.env-customer-bob",
      ".preflight-scout/auth/customer-alice.json",
      ".preflight-scout/runs/latest/report.json",
      "packages/app/.preflight-scout/auth/customer-bob.json",
      ".preflight-scout/package-check/preflight-scout-0.1.0.tgz",
      ".preflight/auth/legacy-customer.json",
      ".preflight/runs/latest/legacy-report.json",
      "packages/app/.preflight/auth/legacy-customer.json",
      ".preflight/package-check/legacy-package.tgz",
      ".preflight/config.yml",
      ".preflight/context.md",
      ".preflight/flows.yml",
      ".preflight/policies.yml",
      ".preflight/approvals.local.yml",
      "dist/bundle.js",
      "packages/app/tsconfig.tsbuildinfo",
      "playwright/.auth/customer-alice.json",
      "test-results/customer-alice/storage-state.json",
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".aws/credentials",
      ".ssh/id_rsa",
      "config/credentials.json",
      "deploy/secrets.yaml",
      "infra/kubeconfig",
      "certificates/signing-key.pem"
    ];
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "app.ts"), "export {};\n");
    for (const relative of excluded) {
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await writeFile(path.join(dir, relative), "sensitive\n");
    }
    await git(dir, ["add", "src/app.ts"]);
    await git(dir, ["add", "--force", ...excluded]);

    const files = await walkFiles(dir);

    expect(files).toContain("src/app.ts");
    for (const relative of excluded) expect(files).not.toContain(relative);
  });

  it("falls back to a bounded safe filesystem walk outside Git repositories", async () => {
    await mkdir(path.join(dir, "node_modules", "dependency"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "dependency", "index.js"), "generated\n");
    await writeFile(path.join(dir, ".env.local"), "SECRET=value\n");
    await writeFile(path.join(dir, "one.ts"), "export {};\n");
    await writeFile(path.join(dir, "two.ts"), "export {};\n");

    const files = await walkFiles(dir, { maxFiles: 1 });

    expect(files).toEqual(["one.ts"]);
  });

  it.skipIf(process.platform === "win32")("omits hard-linked files from Git-visible inventory and boundary reads", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-files-hardlink-external-"));
    try {
      await git(dir, ["init", "--quiet"]);
      const outsideSecret = path.join(external, "outside-secret.txt");
      const linkedReadme = path.join(dir, "README.md");
      await writeFile(outsideSecret, "outside-hardlink-secret\n");
      await link(outsideSecret, linkedReadme);
      await git(dir, ["add", "README.md"]);

      await expect(walkFiles(dir)).resolves.not.toContain("README.md");
      await expect(readTextIfExists(linkedReadme, { boundary: dir })).rejects.toThrow("hard-linked file");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("omits hard-linked files from non-Git inventory", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-files-hardlink-external-"));
    try {
      const outsideSecret = path.join(external, "outside-secret.txt");
      await writeFile(outsideSecret, "outside-hardlink-secret\n");
      await link(outsideSecret, path.join(dir, "README.md"));

      await expect(walkFiles(dir)).resolves.not.toContain("README.md");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("fails closed when Git metadata exists but ignore state cannot be inspected", async () => {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, "private-customer-file.json"), "private\n");

    await expect(walkFiles(dir)).rejects.toThrow("Unable to inspect Git tracking and ignore rules safely");
  });

  it("rejects absolute, traversal, environment, archive, and storage-state paths", () => {
    expect(isSafeIndexedPath("src/app.ts")).toBe(true);
    expect(isSafeIndexedPath("/Users/alice/private.ts")).toBe(false);
    expect(isSafeIndexedPath("../private.ts")).toBe(false);
    expect(isSafeIndexedPath(".env.production")).toBe(false);
    expect(isSafeIndexedPath(".preflight/auth/legacy-customer.json")).toBe(false);
    expect(isSafeIndexedPath("packages/app/.preflight/runs/latest/report.json")).toBe(false);
    expect(isSafeIndexedPath(".preflight/config.yml")).toBe(false);
    expect(isSafeIndexedPath("packages/app/.preflight/approvals.local.yml")).toBe(false);
    expect(isSafeIndexedPath("release/package.tgz")).toBe(false);
    expect(isSafeIndexedPath("packages/app/tsconfig.tsbuildinfo")).toBe(false);
    expect(isSafeIndexedPath("evidence/qa-storage-state.json")).toBe(false);
    expect(isSafeIndexedPath(".npmrc")).toBe(false);
    expect(isSafeIndexedPath(".aws/credentials")).toBe(false);
    expect(isSafeIndexedPath("config/credentials.json")).toBe(false);
    expect(isSafeIndexedPath("deploy/secrets.yaml")).toBe(false);
    expect(isSafeIndexedPath("infra/kubeconfig")).toBe(false);
    expect(isSafeIndexedPath("keys/id_ed25519")).toBe(false);
    expect(isSafeIndexedPath("certificates/signing-key.pem")).toBe(false);
    expect(isSafeIndexedPath("src/auth/credentials.ts")).toBe(true);
    expect(isSafeIndexedPath("src/tokens.ts")).toBe(true);
    expect(isSafeIndexedPath("src/client-secret.ts")).toBe(true);
    expect(isSafeIndexedPath("src/service-account.ts")).toBe(true);
  });

  it("supports consecutive atomic text writes", async () => {
    const output = path.join(dir, "artifacts", "report.json");

    await writeTextEnsuringDir(output, "first\n");
    await writeTextEnsuringDir(output, "second\n");

    expect(await readFile(output, "utf8")).toBe("second\n");
  });

  it.skipIf(process.platform === "win32")("refuses to follow an output-file symlink", async () => {
    const external = path.join(dir, "external.txt");
    const output = path.join(dir, "artifacts", "report.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(external, "do-not-overwrite\n");
    await symlink(external, output);

    await expect(writeTextEnsuringDir(output, "unsafe\n")).rejects.toThrow("non-regular file");
    expect(await readFile(external, "utf8")).toBe("do-not-overwrite\n");
  });

  it.skipIf(process.platform === "win32")("refuses symlinked write ancestors", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-files-external-"));
    try {
      await symlink(external, path.join(dir, ".preflight-scout"));

      await expect(writeTextEnsuringDir(
        path.join(dir, ".preflight-scout", "config.yml"),
        "unsafe\n",
        { boundary: dir }
      )).rejects.toThrow("unsafe directory");
      await expect(readFile(path.join(external, "config.yml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses boundary-aware reads through symlinks", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-files-read-external-"));
    try {
      await writeFile(path.join(external, "config.yml"), "external-secret\n");
      await symlink(external, path.join(dir, ".preflight-scout"));

      await expect(readTextIfExists(path.join(dir, ".preflight-scout", "config.yml"), {
        boundary: dir,
        maxBytes: 1024
      })).rejects.toThrow("symbolic link");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("fails closed before reading oversized text", async () => {
    const oversized = path.join(dir, "large.txt");
    await writeFile(oversized, "x".repeat(1025));

    await expect(readTextIfExists(oversized, { maxBytes: 1024 })).rejects.toThrow("oversized text file");
  });

  it("allows advisory callers to omit oversized text explicitly", async () => {
    const oversized = path.join(dir, "large.txt");
    await writeFile(oversized, "x".repeat(1025));

    await expect(readTextIfExists(oversized, {
      maxBytes: 1024,
      oversize: "omit"
    })).resolves.toBeUndefined();
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
