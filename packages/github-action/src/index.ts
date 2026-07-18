import * as core from "@actions/core";
import * as github from "@actions/github";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  analyzePullRequest,
  buildHumanReportSummary,
  createAnalysisEvidenceDirectory,
  createAnalysisProvenance,
  createDefaultLLMFromEnv,
  writeAnalysisArtifacts,
  type MissionRunResult
} from "@preflight-scout/core";
import { uploadReportArtifact } from "./artifacts.js";
import { renderPullRequestComment } from "./comment.js";
import { parseFailOn, shouldFail, statusDescription } from "./gate.js";
import { defaultArtifactName, resolveActionAppUrl, setCommitStatus, upsertPullRequestComment } from "./github.js";
import { ensurePullRequestRefs } from "./git.js";
import { inputValue, readInputs } from "./inputs.js";
import { ACTION_ANALYSIS_RUNTIME, ACTION_EXECUTION_RUNTIME, runAutomationCandidates, selectAutomationCandidates } from "./missions.js";
import { resolveActionOutputDirectory } from "./output.js";

async function main(): Promise<void> {
  const pull = github.context.payload.pull_request;
  if (!pull) throw new Error("Preflight Scout only runs on pull_request events for now.");

  const inputs = readInputs();
  const workspace = process.cwd();
  const output = await resolveActionOutputDirectory(workspace, inputs.outputDir);
  const failOn = parseFailOn(inputs.failOn);
  const octokit = github.getOctokit(inputs.token);
  await setCommitStatus(octokit, pull, "pending", "Preflight Scout analysis is running");

  await ensurePullRequestRefs(pull.base.sha, pull.head.sha);
  const analysis = await analyzePullRequest({
    root: workspace,
    base: pull.base.sha,
    head: pull.head.sha,
    title: pull.title,
    body: pull.body ?? undefined
  });

  let resolvedAppUrl: string | undefined;
  let runResults: MissionRunResult[] | undefined;
  if (inputs.mode === "analyze-and-run") {
    const selectedMissions = selectAutomationCandidates(analysis.mission, {
      missionId: inputs.missionId,
      allCandidates: inputs.allCandidates,
      missionLimit: inputs.missionLimit ?? analysis.contract.defaults?.missionLimit ?? 1
    });
    if (!selectedMissions.length) {
      core.info("No runnable browser missions were generated; publishing the manual analysis without browser evidence.");
    } else {
      resolvedAppUrl = await resolveActionAppUrl({
        explicitUrl: inputs.appUrl,
        target: inputs.target,
        targetEnv: inputs.targetEnv,
        contract: analysis.contract,
        octokit,
        pull,
        detectDeploymentUrl: inputs.detectDeploymentUrl
      });
      const llm = createDefaultLLMFromEnv();
      if (!llm) throw new Error("mode=analyze-and-run requires an LLM provider.");
      runResults = await runAutomationCandidates(selectedMissions, {
        appUrl: resolvedAppUrl,
        contract: analysis.contract,
        llm,
        root: workspace,
        outputDir: await createAnalysisEvidenceDirectory(output.directory, output.boundary),
        headless: inputs.headless,
        maxTurns: inputs.maxTurns,
        storageState: inputs.storageState,
        saveStorageState: inputs.saveStorageState,
        trace: inputs.trace
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const provenance = await createAnalysisProvenance({
    root: workspace,
    baseCommit: pull.base.sha,
    headCommit: pull.head.sha,
    contract: analysis.contract,
    repoIndex: analysis.repoIndex,
    createdAt: generatedAt,
    analysisRuntime: ACTION_ANALYSIS_RUNTIME
  });
  const summary = buildHumanReportSummary({
    impactMap: analysis.impactMap,
    mission: analysis.mission,
    runResults,
    generatedAt
  });
  await writeAnalysisArtifacts(output.directory, {
    boundary: output.boundary,
    impactMap: analysis.impactMap,
    mission: analysis.mission,
    provenance,
    ...(runResults ? { executionRuntime: ACTION_EXECUTION_RUNTIME } : {}),
    runResults,
    reportSummary: summary
  });

  await fs.access(path.join(output.directory, "report.md"));
  const artifactName = inputs.artifactName ?? defaultArtifactName(pull);
  const artifactId = inputs.uploadArtifact
    ? await uploadReportArtifact(output.directory, artifactName, output.boundary)
    : undefined;
  if (inputs.comment) {
    await upsertPullRequestComment(octokit, pull, renderPullRequestComment({
      summary,
      impactMap: analysis.impactMap,
      mission: analysis.mission,
      artifactName,
      artifactId,
      appUrl: resolvedAppUrl,
      failOn
    }));
  }

  core.setOutput("verdict", summary.verdict);
  core.setOutput("risk", summary.risk);
  core.setOutput("affected-count", String(summary.counts.affectedAreas));
  core.setOutput("manual-check-count", String(summary.counts.manualChecks));
  core.setOutput("browser-mission-count", String(summary.counts.browserMissions));
  core.setOutput("passed-count", String(summary.counts.passed));
  core.setOutput("failed-count", String(summary.counts.failed));
  core.setOutput("blocked-count", String(summary.counts.blocked));
  core.setOutput("fail-on", failOn);
  core.setOutput("report-path", path.join(output.directory, "report.md"));
  core.setOutput("report-html-path", path.join(output.directory, "report.html"));
  core.setOutput("summary-path", path.join(output.directory, "report-summary.json"));
  if (resolvedAppUrl) core.setOutput("app-url", resolvedAppUrl);
  if (artifactId) core.setOutput("artifact-id", String(artifactId));

  const failing = shouldFail(summary, failOn);
  const finalState = failing ? "failure" : "success";
  await setCommitStatus(
    octokit,
    pull,
    finalState,
    statusDescription(summary, failing)
  );
  if (failing) {
    core.setFailed(statusDescription(summary, failing));
  }
}

main().catch(async (error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
  const pull = github.context.payload.pull_request;
  const token = inputValue("github-token");
  if (pull && token) {
    try {
      await setCommitStatus(github.getOctokit(token), pull, "error", "Preflight Scout failed to complete");
    } catch {
      core.warning("Could not update the Preflight Scout commit status after failure.");
    }
  }
});
