import {
  createTrustedGit,
  createAnalysisEvidenceDirectory,
  writeAnalysisArtifacts,
  type ImpactMap,
  type QAMission
} from "@preflight-scout/core";
import { access, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveActionOutputDirectory } from "./output.js";

describe("resolveActionOutputDirectory", () => {
  let workspace: string;
  const cleanup: string[] = [];

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "preflight-scout-action-workspace-"));
    cleanup.push(workspace);
    const git = await createTrustedGit({ targetRoot: workspace });
    await git.exec(["init", "--quiet"], { cwd: workspace });
    await writeFile(path.join(workspace, ".gitignore"), ".preflight-scout/\n");
  });

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("keeps repository-local Action output under the canonical workspace boundary", async () => {
    const canonicalWorkspace = await realpath(workspace);

    await expect(resolveActionOutputDirectory(
      workspace,
      path.join(".preflight-scout", "runs", "github-action")
    )).resolves.toEqual({
      directory: path.join(canonicalWorkspace, ".preflight-scout", "runs", "github-action"),
      boundary: canonicalWorkspace
    });
    await expect(lstat(path.join(workspace, ".preflight-scout"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a repository-local Action output that Git does not ignore", async () => {
    await expect(resolveActionOutputDirectory(
      workspace,
      "preflight-report"
    )).rejects.toThrow("must be untracked and ignored by Git as a directory");
    await expect(lstat(path.join(workspace, "preflight-report"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the repository root as an Action output directory", async () => {
    await expect(resolveActionOutputDirectory(workspace, "."))
      .rejects.toThrow("must be untracked and ignored by Git as a directory");
  });

  it("rejects contents-only ignores that re-include a generated report", async () => {
    await writeFile(
      path.join(workspace, ".gitignore"),
      ".preflight-scout/\npreflight-report/*\n!preflight-report/report.md\n"
    );

    await expect(resolveActionOutputDirectory(workspace, "preflight-report"))
      .rejects.toThrow("must be untracked and ignored by Git as a directory");
    await expect(lstat(path.join(workspace, "preflight-report"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a tracked repository-local Action output even when a directory rule ignores it", async () => {
    const trackedOutput = path.join(workspace, "tracked-output");
    await mkdir(trackedOutput);
    await writeFile(path.join(trackedOutput, "report.md"), "tracked\n");
    await writeFile(path.join(workspace, ".gitignore"), ".preflight-scout/\ntracked-output/\n");
    const git = await createTrustedGit({ targetRoot: workspace });
    await git.exec(["add", "--force", "--", "tracked-output/report.md"], { cwd: workspace });

    await expect(resolveActionOutputDirectory(workspace, "tracked-output"))
      .rejects.toThrow("must be untracked and ignored by Git as a directory");
  });

  it("derives one canonical boundary for an external Action output and every artifact write", async () => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-action-external-"));
    cleanup.push(externalRoot);
    const canonicalExternalRoot = await realpath(externalRoot);
    const outputDir = path.join(externalRoot, "nested", "reviewed-run");

    const output = await resolveActionOutputDirectory(workspace, outputDir);
    expect(output).toEqual({
      directory: path.join(canonicalExternalRoot, "nested", "reviewed-run"),
      boundary: canonicalExternalRoot
    });

    const evidenceDirectory = await createAnalysisEvidenceDirectory(output.directory, output.boundary);
    const impactMap: ImpactMap = {
      summary: "Checkout changed.",
      risk: "low",
      changedFiles: [],
      affectedRoutes: [],
      affectedAreas: [],
      suggestedRoles: [],
      unknowns: []
    };
    const mission: QAMission = {
      id: "checkout-review",
      title: "Review checkout",
      risk: "low",
      summary: "Review checkout.",
      affectedAreas: [],
      manualChecklist: [],
      edgeCases: [],
      automationCandidates: [],
      unknowns: []
    };
    await expect(writeAnalysisArtifacts(output.directory, {
      boundary: output.boundary,
      impactMap,
      mission
    })).resolves.toEqual({ bundleSha256: undefined });
    await expect(access(path.join(output.directory, "report.html"))).resolves.toBeUndefined();
    await expect(access(evidenceDirectory)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("rejects a repository-local output that traverses a symlink", async () => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-action-symlink-"));
    cleanup.push(externalRoot);
    await mkdir(path.join(workspace, ".preflight-scout"));
    await symlink(externalRoot, path.join(workspace, ".preflight-scout", "runs"));

    await expect(resolveActionOutputDirectory(
      workspace,
      path.join(workspace, ".preflight-scout", "runs", "github-action")
    )).rejects.toThrow("unsafe repository-local Action output directory");
  });

  it.skipIf(process.platform === "win32")("applies repository policy when an external alias resolves into the workspace", async () => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-action-alias-"));
    cleanup.push(externalRoot);
    const alias = path.join(externalRoot, "workspace-link");
    await symlink(workspace, alias);

    await expect(resolveActionOutputDirectory(workspace, path.join(alias, "preflight-report")))
      .rejects.toThrow("must be untracked and ignored by Git as a directory");
    await expect(lstat(path.join(workspace, "preflight-report"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
