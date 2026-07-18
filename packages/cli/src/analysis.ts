import {
  createCompositeRuntimeDigest,
  PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST,
  readAnalysisArtifactBundle,
  resolvePackageRuntimeIdentity,
  type AnalysisRuntimeIdentity,
  type AnalysisProvenance,
  type ExecutionRuntimeIdentity,
  type ImpactMap,
  type QAMission
} from "@preflight-scout/core";
import { PREFLIGHT_SCOUT_BROWSER_RUNNER_RUNTIME_DIGEST } from "@preflight-scout/browser-runner";

const CLI_PACKAGE_RUNTIME_DIGEST = resolvePackageRuntimeIdentity(import.meta.url, "@preflight-scout/cli");

export const CLI_ANALYSIS_RUNTIME: AnalysisRuntimeIdentity = Object.freeze({
  entrypoint: "cli",
  digest: createCompositeRuntimeDigest("analysis:cli", {
    cli: CLI_PACKAGE_RUNTIME_DIGEST,
    core: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
  }),
  coreDigest: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
});

export const CLI_EXECUTION_RUNTIME: ExecutionRuntimeIdentity = Object.freeze({
  entrypoint: "cli-browser",
  digest: createCompositeRuntimeDigest("execution:cli-browser", {
    browser: PREFLIGHT_SCOUT_BROWSER_RUNNER_RUNTIME_DIGEST,
    cli: CLI_PACKAGE_RUNTIME_DIGEST,
    core: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
  })
});

export interface ReviewedAnalysis {
  impactMap: ImpactMap;
  mission: QAMission;
  provenance: AnalysisProvenance;
  sourceBundleSha256?: string;
}

export async function resolveReviewedAnalysis(options: {
  analysisDir?: string;
  boundary?: string;
  expectedProvenance?: AnalysisProvenance;
  analyze: () => Promise<ReviewedAnalysis>;
}): Promise<ReviewedAnalysis> {
  if (!options.analysisDir) return options.analyze();
  if (!options.expectedProvenance) {
    throw new Error("Expected analysis provenance is required when reusing --analysis-dir.");
  }

  if (!options.boundary) {
    throw new Error("A trusted repository boundary is required when reusing --analysis-dir.");
  }
  const bundle = await readAnalysisArtifactBundle(options.analysisDir, options.boundary, options.expectedProvenance);
  return {
    impactMap: bundle.impactMap,
    mission: bundle.mission,
    provenance: bundle.provenance,
    sourceBundleSha256: bundle.bundleSha256
  };
}
