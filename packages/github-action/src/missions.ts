import path from "node:path";
import { PREFLIGHT_SCOUT_BROWSER_RUNNER_RUNTIME_DIGEST, runBrowserMission } from "@preflight-scout/browser-runner";
import {
  createCompositeRuntimeDigest,
  PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST,
  resolvePackageRuntimeIdentity,
  type AnalysisRuntimeIdentity,
  type ExecutionRuntimeIdentity,
  type LLMClient,
  type MissionRunResult,
  type QAContract,
  type QAFlowMission,
  type QAMission
} from "@preflight-scout/core";

const ACTION_PACKAGE_RUNTIME_DIGEST = resolvePackageRuntimeIdentity(import.meta.url, "@preflight-scout/github-action");

export const ACTION_ANALYSIS_RUNTIME: AnalysisRuntimeIdentity = Object.freeze({
  entrypoint: "github-action",
  digest: createCompositeRuntimeDigest("analysis:github-action", {
    action: ACTION_PACKAGE_RUNTIME_DIGEST,
    core: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
  }),
  coreDigest: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
});

export const ACTION_EXECUTION_RUNTIME: ExecutionRuntimeIdentity = Object.freeze({
  entrypoint: "github-action-browser",
  digest: createCompositeRuntimeDigest("execution:github-action-browser", {
    action: ACTION_PACKAGE_RUNTIME_DIGEST,
    browser: PREFLIGHT_SCOUT_BROWSER_RUNNER_RUNTIME_DIGEST,
    core: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
  })
});

export async function runAutomationCandidates(
  missions: QAFlowMission[],
  options: {
    appUrl: string;
    contract: QAContract;
    llm: LLMClient;
    root: string;
    outputDir: string;
    headless: boolean;
    maxTurns?: number;
    storageState?: string;
    saveStorageState?: string;
    trace?: boolean;
  }
): Promise<MissionRunResult[]> {
  if (missions.length > 1 && options.saveStorageState) {
    throw new Error("Refusing to save authentication state during a multi-mission run. Authentication state must remain outside uploaded evidence directories.");
  }
  const useMissionSubdirs = missions.length > 1;
  const runResults: MissionRunResult[] = [];
  for (const mission of missions) {
    const missionOutputDir = useMissionSubdirs ? path.join(options.outputDir, mission.id) : options.outputDir;
    runResults.push(await runBrowserMission(mission, {
      baseUrl: options.appUrl,
      contract: options.contract,
      llm: options.llm,
      root: options.root,
      outputDir: missionOutputDir,
      headless: options.headless,
      maxTurns: options.maxTurns,
      storageState: options.storageState,
      saveStorageState: options.saveStorageState,
      trace: options.trace
    }));
  }
  return runResults;
}

export function selectAutomationCandidates(mission: QAMission, options: { missionId?: string; allCandidates?: boolean; missionLimit?: number } = {}): QAFlowMission[] {
  if (options.missionId && options.allCandidates) {
    throw new Error("Use either mission-id or all-candidates, not both.");
  }
  if (!mission.automationCandidates.length) {
    throw new Error("Mission artifact does not include automationCandidates.");
  }
  if (options.missionId) {
    const selected = mission.automationCandidates.find((candidate) => candidate.id === options.missionId);
    if (!selected) {
      const available = mission.automationCandidates.map((candidate) => candidate.id).join(", ");
      throw new Error(`Automation candidate "${options.missionId}" was not found. Available candidates: ${available}`);
    }
    return [selected];
  }
  return options.allCandidates ? mission.automationCandidates : mission.automationCandidates.slice(0, options.missionLimit ?? 1);
}
