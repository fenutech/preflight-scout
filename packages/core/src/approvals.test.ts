import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveAction, isActionApproved, loadApprovals } from "./approvals.js";

const execFileAsync = promisify(execFile);
const approvalRelativePath = ".preflight-scout/approvals.local.yml";

describe("approval file boundaries", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "preflight-scout-approvals-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), `${approvalRelativePath}\n`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads and replaces an ignored, untracked local approval file", async () => {
    await expect(approveAction(root, "send_email", "test account")).resolves.toMatchObject({
      approvals: [{ action: "send_email", reason: "test account" }]
    });
    await expect(loadApprovals(root)).resolves.toMatchObject({
      approvals: [{ action: "send_email", reason: "test account" }]
    });
  });

  it("rejects an approval file that has been force-added to Git", async () => {
    await mkdir(path.join(root, ".preflight-scout"), { recursive: true });
    await writeFile(path.join(root, ...approvalRelativePath.split("/")), "approvals: []\n");
    await execFileAsync("git", ["add", "--force", "--", approvalRelativePath], { cwd: root });

    await expect(loadApprovals(root)).rejects.toThrow("must not be tracked by Git");
    await expect(approveAction(root, "send_email")).rejects.toThrow("must not be tracked by Git");
  });

  it("rejects approvals until the local path is ignored", async () => {
    await writeFile(path.join(root, ".gitignore"), "");

    await expect(loadApprovals(root)).rejects.toThrow(`add ${approvalRelativePath} to .gitignore`);
    await expect(approveAction(root, "send_email")).rejects.toThrow(`add ${approvalRelativePath} to .gitignore`);
  });

  it("rejects the legacy repository-shaped approval filename", async () => {
    await mkdir(path.join(root, ".preflight-scout"), { recursive: true });
    await writeFile(path.join(root, ".preflight-scout", "approvals.yml"), "approvals: []\n");

    await expect(loadApprovals(root)).rejects.toThrow("Refusing legacy approval file");
  });

  it.skipIf(process.platform === "win32")("refuses approval reads and writes through a symlinked .preflight-scout directory", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-approvals-external-"));
    try {
      await writeFile(path.join(external, "approvals.local.yml"), "approvals: []\n");
      await symlink(external, path.join(root, ".preflight-scout"));

      await expect(loadApprovals(root)).rejects.toThrow("symbolic link");
      await expect(approveAction(root, "send_email")).rejects.toThrow("symbolic link");
      await expect(readFile(path.join(external, "approvals.local.yml"), "utf8")).resolves.toBe("approvals: []\n");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects oversized approval YAML", async () => {
    await mkdir(path.join(root, ".preflight-scout"), { recursive: true });
    await writeFile(path.join(root, ...approvalRelativePath.split("/")), `# ${"x".repeat(1024 * 1024)}\n`);

    await expect(loadApprovals(root)).rejects.toThrow("oversized text file");
  });

  it.each([
    ["non-array approvals", "approvals: nope\n"],
    ["unknown record fields", "approvals:\n  - action: send_email\n    approvedAt: 2026-07-15T10:00:00.000Z\n    extra: rejected\n"],
    ["blank action", "approvals:\n  - action: '   '\n    approvedAt: 2026-07-15T10:00:00.000Z\n"],
    ["invalid timestamp", "approvals:\n  - action: send_email\n    approvedAt: yesterday\n"]
  ])("rejects malformed approval state: %s", async (_label, contents) => {
    await mkdir(path.join(root, ".preflight-scout"), { recursive: true });
    await writeFile(path.join(root, ...approvalRelativePath.split("/")), contents);

    await expect(loadApprovals(root)).rejects.toThrow();
  });

  it("rejects approval collections above the bounded record count", async () => {
    await mkdir(path.join(root, ".preflight-scout"), { recursive: true });
    const records = Array.from({ length: 129 }, (_, index) => [
      `  - action: action_${index}`,
      "    approvedAt: 2026-07-15T10:00:00.000Z"
    ].join("\n")).join("\n");
    await writeFile(path.join(root, ...approvalRelativePath.split("/")), `approvals:\n${records}\n`);

    await expect(loadApprovals(root)).rejects.toThrow();
  });

  it("fails closed instead of throwing for an invalid in-memory approval state", () => {
    expect(isActionApproved({ approvals: undefined } as unknown as { approvals: [] }, "send_email")).toBe(false);
  });
});
