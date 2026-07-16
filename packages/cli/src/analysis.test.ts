import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAnalysisArtifacts, type ImpactMap, type QAMission } from "@preflight-scout/core";
import { resolveReviewedAnalysis } from "./analysis.js";

describe("resolveReviewedAnalysis", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads the reviewed impact map and mission without running fresh analysis", async () => {
    const analysisDir = await mkdtemp(path.join(tmpdir(), "preflight-scout-reviewed-analysis-"));
    tempDirs.push(analysisDir);
    const reviewed = analysis("reviewed");
    const analyze = vi.fn(async () => analysis("fresh"));
    await writeAnalysisArtifacts(analysisDir, reviewed);

    await expect(resolveReviewedAnalysis({ analysisDir, analyze })).resolves.toEqual(reviewed);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("runs fresh analysis when no reviewed artifact directory is supplied", async () => {
    const fresh = analysis("fresh");
    const analyze = vi.fn(async () => fresh);

    await expect(resolveReviewedAnalysis({ analyze })).resolves.toEqual(fresh);
    expect(analyze).toHaveBeenCalledOnce();
  });
});

function analysis(marker: string): { impactMap: ImpactMap; mission: QAMission } {
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
    }
  };
}
