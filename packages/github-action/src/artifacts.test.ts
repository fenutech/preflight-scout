import {
  ANALYSIS_SCHEMA_DIGEST,
  PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME,
  PREFLIGHT_SCOUT_VERSION,
  sha256Text,
  writeAnalysisArtifacts,
  type AnalysisProvenance,
  type ExecutionRuntimeIdentity,
  type ImpactMap,
  type MissionRunResult,
  type QAMission
} from "@preflight-scout/core";
import { access, chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadReportArtifact } from "./artifacts.js";

describe("uploadReportArtifact", () => {
  let temporaryRoot: string;
  let outputDir: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-action-artifacts-"));
    outputDir = path.join(temporaryRoot, "artifacts");
    await mkdir(outputDir);
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("uploads only the manifest-declared generation from a private staging root", async () => {
    await writeBoundBundle(outputDir, true);
    await writeFile(path.join(outputDir, "stale-auth-state.json"), '{"cookies":[{"value":"do-not-upload"}]}\n');
    let stagingRoot: string | undefined;
    const uploader = vi.fn(async (_name: string, files: string[], root: string) => {
      stagingRoot = root;
      const relative = files.map((file) => path.relative(root, file).split(path.sep).join("/"));
      expect(relative).toEqual([
        "analysis-manifest.json",
        "browser-evidence/current/final-observation.json",
        "impact-map.json",
        "mission.json",
        "report-summary.json",
        "report.html",
        "report.md",
        "run-results.json"
      ]);
      expect(relative).not.toContain("stale-auth-state.json");
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      for (const file of files) expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(root, "browser-evidence", "current", "final-observation.json"), "utf8"))
        .toBe('{"ready":true}\n');
      return { id: 42 };
    });

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, { uploader })).resolves.toBe(42);
    expect(uploader).toHaveBeenCalledOnce();
    await expect(access(stagingRoot!)).rejects.toThrow();
  });

  it("keeps uploaded bytes fixed when the mutable source changes after staging", async () => {
    await writeBoundBundle(outputDir, false);
    const sourceReport = path.join(outputDir, "report.md");
    const reviewedReport = await readFile(sourceReport, "utf8");
    const uploader = vi.fn(async (_name: string, files: string[], root: string) => {
      await writeFile(sourceReport, "mutated after staging\n");
      const stagedReport = files.find((file) => path.relative(root, file) === "report.md");
      expect(stagedReport).toBeDefined();
      expect(await readFile(stagedReport!, "utf8")).toBe(reviewedReport);
      return { id: 7 };
    });

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, { uploader })).resolves.toBe(7);
  });

  it("fails closed when a declared source changes during staging", async () => {
    await writeBoundBundle(outputDir, false);
    const uploader = vi.fn(async () => ({ id: 1 }));
    const afterSourceOpen = vi.fn(async (relativePath: string) => {
      if (relativePath === "report.md") {
        await writeFile(path.join(outputDir, relativePath), "mutated during staging\n");
      }
    });

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader,
      afterSourceOpen
    })).rejects.toThrow(/changed while staging|declared digest/);
    expect(uploader).not.toHaveBeenCalled();
  });

  it("fails before reading a leaf replaced between lstat and open", async () => {
    await writeBoundBundle(outputDir, false);
    const uploader = vi.fn(async () => ({ id: 1 }));
    const beforeSourceOpen = vi.fn(async (relativePath: string) => {
      if (relativePath !== "report.md") return;
      const source = path.join(outputDir, relativePath);
      await rename(source, `${source}.reviewed`);
      await writeFile(source, "replacement bytes must not be accepted\n");
    });

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader,
      beforeSourceOpen
    })).rejects.toThrow(/non-regular|staged safely/);
    expect(uploader).not.toHaveBeenCalled();
  });

  it("refuses a private staging base inside the target boundary", async () => {
    await writeBoundBundle(outputDir, false);
    const uploader = vi.fn(async () => ({ id: 1 }));

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader,
      stagingBase: outputDir
    })).rejects.toThrow("no safe runner temporary directory");
    expect(uploader).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("normalizes a safe temporary-directory alias before staging", async () => {
    await writeBoundBundle(outputDir, false);
    const canonicalStagingBase = path.join(temporaryRoot, "runner-temp");
    const stagingAlias = path.join(temporaryRoot, "runner-temp-alias");
    await mkdir(canonicalStagingBase);
    await symlink(canonicalStagingBase, stagingAlias);

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      stagingBase: stagingAlias,
      uploader: async () => ({ id: 11 })
    })).resolves.toBe(11);
  });

  it.skipIf(process.platform === "win32")("rejects a declared file replaced by a symlink", async () => {
    await writeBoundBundle(outputDir, false);
    const external = path.join(temporaryRoot, "runner-secret.txt");
    await writeFile(external, "do-not-upload\n");
    await rm(path.join(outputDir, "report.md"));
    await symlink(external, path.join(outputDir, "report.md"));

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader: vi.fn(async () => ({ id: 1 }))
    })).rejects.toThrow(/symbolic link|read safely/);
    expect(await readFile(external, "utf8")).toBe("do-not-upload\n");
  });

  it.skipIf(process.platform === "win32")("rejects a declared hard link", async () => {
    await writeBoundBundle(outputDir, false);
    const external = path.join(temporaryRoot, "runner-secret.txt");
    await writeFile(external, "do-not-upload\n");
    await rm(path.join(outputDir, "report.md"));
    await link(external, path.join(outputDir, "report.md"));

    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader: vi.fn(async () => ({ id: 1 }))
    })).rejects.toThrow(/hard-linked|read safely/);
  });

  it("cleans private staging files when the uploader fails", async () => {
    await writeBoundBundle(outputDir, false);
    let stagingRoot: string | undefined;
    await expect(uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader: vi.fn(async (_name, _files, root) => {
        stagingRoot = root;
        throw new Error("upload failed");
      })
    })).rejects.toThrow("upload failed");
    await expect(access(stagingRoot!)).rejects.toThrow();
  });

  it("does not let permissive source modes escape into staging", async () => {
    await writeBoundBundle(outputDir, false);
    await chmod(path.join(outputDir, "report.md"), 0o666);
    await uploadReportArtifact(outputDir, "reviewed", outputDir, {
      uploader: async (_name, files, root) => {
        const stagedReport = files.find((file) => path.relative(root, file) === "report.md")!;
        expect((await stat(stagedReport)).mode & 0o777).toBe(0o600);
        return { id: 9 };
      }
    });
  });
});

async function writeBoundBundle(directory: string, withResult: boolean): Promise<void> {
  const impactMap: ImpactMap = {
    summary: "Checkout changed.",
    risk: "high",
    changedFiles: [{ path: "src/checkout.ts", status: "modified" }],
    affectedRoutes: [],
    affectedAreas: [{ kind: "component", name: "Checkout", evidence: ["src/checkout.ts"], risk: "high" }],
    suggestedRoles: [],
    unknowns: []
  };
  const mission: QAMission = {
    id: "checkout-review",
    title: "Review checkout",
    risk: "high",
    summary: "Review the changed checkout.",
    affectedAreas: impactMap.affectedAreas,
    manualChecklist: [],
    edgeCases: [],
    automationCandidates: [{
      id: "checkout",
      title: "Checkout",
      risk: "high",
      reason: ["Checkout changed."],
      steps: []
    }],
    unknowns: []
  };
  const provenance: AnalysisProvenance = {
    createdAt: "2026-07-18T00:00:00.000Z",
    toolVersion: PREFLIGHT_SCOUT_VERSION,
    analysisRuntime: PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME,
    schemaDigest: ANALYSIS_SCHEMA_DIGEST,
    repositoryDigest: sha256Text("repository"),
    repositoryContextDigest: sha256Text("repository-context"),
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    contractDigest: sha256Text("contract")
  };
  let runResults: MissionRunResult[] | undefined;
  if (withResult) {
    const observation = path.join(directory, "browser-evidence", "current", "final-observation.json");
    await mkdir(path.dirname(observation), { recursive: true });
    await writeFile(observation, '{"ready":true}\n');
    runResults = [{
      missionId: "checkout",
      status: "passed",
      results: [{ stepId: "verify", status: "passed", message: "Checkout rendered." }],
      artifacts: [observation],
      evidence: { finalObservationPath: observation }
    }];
  }
  const executionRuntime: ExecutionRuntimeIdentity = {
    entrypoint: "github-action-browser",
    digest: sha256Text("github-action-browser-runtime")
  };
  await writeAnalysisArtifacts(directory, {
    boundary: directory,
    impactMap,
    mission,
    provenance,
    runResults,
    executionRuntime: runResults ? executionRuntime : undefined
  });
}
