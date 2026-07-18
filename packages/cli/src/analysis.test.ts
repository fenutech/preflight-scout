import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_SCHEMA_DIGEST,
  PREFLIGHT_SCOUT_VERSION,
  sha256Text,
  writeAnalysisArtifacts,
  type AnalysisProvenance,
  type ImpactMap,
  type QAMission
} from "@preflight-scout/core";
import { CLI_ANALYSIS_RUNTIME, resolveReviewedAnalysis, type ReviewedAnalysis } from "./analysis.js";

describe("resolveReviewedAnalysis", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads an exactly bound reviewed analysis without running fresh analysis", async () => {
    const analysisDir = await temporaryAnalysisDir(tempDirs);
    const reviewed = analysis("reviewed");
    const analyze = vi.fn(async () => analysis("fresh"));
    await writeAnalysisArtifacts(analysisDir, { boundary: analysisDir, ...reviewed });

    const resolved = await resolveReviewedAnalysis({
      analysisDir,
      boundary: analysisDir,
      expectedProvenance: reviewed.provenance,
      analyze
    });

    expect(resolved).toMatchObject(reviewed);
    expect(resolved.sourceBundleSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("runs fresh analysis when no reviewed artifact directory is supplied", async () => {
    const fresh = analysis("fresh");
    const analyze = vi.fn(async () => fresh);

    await expect(resolveReviewedAnalysis({ analyze })).resolves.toEqual(fresh);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("rejects GitHub Action analysis for CLI executable reuse", async () => {
    const analysisDir = await temporaryAnalysisDir(tempDirs);
    const reviewed = analysis("action-produced");
    reviewed.provenance = {
      ...reviewed.provenance,
      analysisRuntime: {
        entrypoint: "github-action",
        digest: sha256Text("github-action-producer"),
        coreDigest: reviewed.provenance.analysisRuntime.coreDigest
      }
    };
    await writeAnalysisArtifacts(analysisDir, { boundary: analysisDir, ...reviewed });
    const expectedProvenance: AnalysisProvenance = {
      ...reviewed.provenance,
      analysisRuntime: CLI_ANALYSIS_RUNTIME
    };

    await expect(resolveReviewedAnalysis({
      analysisDir,
      boundary: analysisDir,
      expectedProvenance,
      analyze: vi.fn(async () => reviewed)
    })).rejects.toThrow("analysis-producer package code/build has changed");
  });

  it("rejects a legacy analysis directory without a provenance manifest", async () => {
    const analysisDir = await temporaryAnalysisDir(tempDirs);
    const reviewed = analysis("legacy");
    await writeAnalysisArtifacts(analysisDir, {
      boundary: analysisDir,
      impactMap: reviewed.impactMap,
      mission: reviewed.mission
    });

    await expect(resolveReviewedAnalysis({
      analysisDir,
      boundary: analysisDir,
      expectedProvenance: reviewed.provenance,
      analyze: vi.fn(async () => reviewed)
    })).rejects.toThrow(/analysis-manifest\.json is missing.*Rerun `preflight-scout analyze`/);
  });

  it.each([
    ["repositoryDigest", "different repository"],
    ["repositoryContextDigest", "indexed repository context has changed"],
    ["baseCommit", "reviewed base commit has changed"],
    ["headCommit", "reviewed head commit has changed"],
    ["contractDigest", "contract has changed"]
  ] as const)("rejects reuse when %s does not match", async (field, message) => {
    const analysisDir = await temporaryAnalysisDir(tempDirs);
    const reviewed = analysis(`mismatch-${field}`);
    await writeAnalysisArtifacts(analysisDir, { boundary: analysisDir, ...reviewed });
    const expectedProvenance: AnalysisProvenance = {
      ...reviewed.provenance,
      [field]: field === "baseCommit"
        ? "3".repeat(40)
        : field === "headCommit"
          ? "4".repeat(40)
          : sha256Text(`different-${field}`)
    };

    await expect(resolveReviewedAnalysis({
      analysisDir,
      boundary: analysisDir,
      expectedProvenance,
      analyze: vi.fn(async () => reviewed)
    })).rejects.toThrow(message);
  });
});

async function temporaryAnalysisDir(tempDirs: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "preflight-scout-reviewed-analysis-"));
  tempDirs.push(directory);
  return directory;
}

function analysis(marker: string): ReviewedAnalysis {
  const impactMap: ImpactMap = {
    summary: `${marker} impact`,
    risk: "medium",
    changedFiles: [{ path: `${marker}.ts`, status: "modified" }],
    affectedRoutes: [],
    affectedAreas: [],
    suggestedRoles: [],
    unknowns: []
  };
  return {
    impactMap,
    mission: {
      id: `${marker}-mission`,
      title: `${marker} mission`,
      risk: "medium",
      summary: `${marker} summary`,
      affectedAreas: [],
      manualChecklist: [],
      edgeCases: [],
      automationCandidates: [{
        id: `${marker}-flow`,
        title: `${marker} flow`,
        risk: "medium",
        reason: [`${marker} reason`],
        steps: []
      }],
      unknowns: []
    },
    provenance: provenance(marker)
  };
}

function provenance(marker: string): AnalysisProvenance {
  return {
    createdAt: "2026-07-18T00:00:00.000Z",
    toolVersion: PREFLIGHT_SCOUT_VERSION,
    analysisRuntime: CLI_ANALYSIS_RUNTIME,
    schemaDigest: ANALYSIS_SCHEMA_DIGEST,
    repositoryDigest: sha256Text(`repository-${marker}`),
    repositoryContextDigest: sha256Text(`repository-context-${marker}`),
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    contractDigest: sha256Text(`contract-${marker}`)
  };
}
