import path from "node:path";
import {
  readImpactMapArtifact,
  readMissionArtifact,
  type ImpactMap,
  type QAMission
} from "@preflight-scout/core";

export interface ReviewedAnalysis {
  impactMap: ImpactMap;
  mission: QAMission;
}

export async function resolveReviewedAnalysis(options: {
  analysisDir?: string;
  analyze: () => Promise<ReviewedAnalysis>;
}): Promise<ReviewedAnalysis> {
  if (!options.analysisDir) return options.analyze();

  return {
    impactMap: await readImpactMapArtifact(path.join(options.analysisDir, "impact-map.json")),
    mission: await readMissionArtifact(path.join(options.analysisDir, "mission.json"))
  };
}
