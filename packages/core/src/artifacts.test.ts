import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAnalysisEvidenceDirectory,
  publishAnalysisPdf,
  readAnalysisArtifactBundle,
  readImpactMapArtifact,
  readMissionArtifact,
  writeAnalysisArtifacts
} from "./artifacts.js";
import {
  ANALYSIS_SCHEMA_DIGEST,
  PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME,
  PREFLIGHT_SCOUT_VERSION,
  sha256Text
} from "./provenance.js";
import type { AnalysisProvenance, ExecutionRuntimeIdentity, ImpactMap, MissionRunResult, QAMission } from "./types.js";

const EXECUTION_RUNTIME: ExecutionRuntimeIdentity = {
  entrypoint: "cli-browser",
  digest: sha256Text("test-cli-browser-runtime")
};

describe("analysis artifacts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-artifacts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads impact and mission artifacts", async () => {
    const impactMap: ImpactMap = {
      summary: "Checkout changed.",
      risk: "high",
      changedFiles: [{ path: "checkout.tsx", status: "modified" }],
      affectedRoutes: [],
      affectedAreas: [{ kind: "component", name: "Checkout", evidence: ["checkout.tsx"], risk: "high" }],
      suggestedRoles: ["standard_user"],
      unknowns: []
    };
    const mission: QAMission = {
      id: "mission-1",
      title: "Validate checkout",
      risk: "high",
      summary: "Checkout changed.",
      affectedAreas: impactMap.affectedAreas,
      manualChecklist: ["Apply a valid promo code."],
      edgeCases: ["Expired promo code."],
      automationCandidates: [],
      unknowns: []
    };

    await writeAnalysisArtifacts(dir, { boundary: dir, impactMap, mission });

    await expect(readImpactMapArtifact(path.join(dir, "impact-map.json"))).resolves.toEqual(impactMap);
    await expect(readMissionArtifact(path.join(dir, "mission.json"))).resolves.toEqual(mission);
    await expect(readFile(path.join(dir, "report.md"), "utf8")).resolves.toContain("# Preflight Scout Report");
    await expect(readFile(path.join(dir, "report.html"), "utf8")).resolves.toContain("<!doctype html>");
    await expect(readFile(path.join(dir, "report-summary.json"), "utf8")).resolves.toContain("no_browser_evidence");
  });

  it("rejects oversized structured artifacts before parsing", async () => {
    const artifact = path.join(dir, "mission.json");
    await writeFile(artifact, "{}");
    await truncate(artifact, 16 * 1024 * 1024 + 1);

    await expect(readMissionArtifact(artifact)).rejects.toThrow("oversized text file");
  });

  it("round-trips an exactly bound analysis manifest", async () => {
    const artifacts = boundArtifacts("round-trip", dir);

    await writeAnalysisArtifacts(dir, artifacts);
    const bundle = await readAnalysisArtifactBundle(dir, dir, artifacts.provenance);

    expect(bundle.impactMap).toEqual(artifacts.impactMap);
    expect(bundle.mission).toEqual(artifacts.mission);
    expect(bundle.provenance).toEqual(artifacts.provenance);
    expect(bundle.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.runResults).toBeUndefined();
  });

  it.each([
    ["toolVersion", "0.0.0", "created by Preflight Scout 0.0.0"],
    ["schemaDigest", sha256Text("different-schema"), "artifact schema has changed"]
  ] as const)("rejects an internally valid manifest with incompatible %s", async (field, value, message) => {
    const artifacts = boundArtifacts(`runtime-${field}`, dir);
    await writeAnalysisArtifacts(dir, {
      ...artifacts,
      provenance: { ...artifacts.provenance, [field]: value }
    });

    await expect(readAnalysisArtifactBundle(dir, dir)).rejects.toThrow(message);
  });

  it("rejects an exact analysis producer mismatch for executable reuse", async () => {
    const artifacts = boundArtifacts("runtime-producer", dir);
    await writeAnalysisArtifacts(dir, artifacts);
    const expected: AnalysisProvenance = {
      ...artifacts.provenance,
      analysisRuntime: {
        ...artifacts.provenance.analysisRuntime,
        digest: sha256Text("different-cli-runtime")
      }
    };

    await expect(readAnalysisArtifactBundle(dir, dir, expected)).rejects.toThrow(
      "exact Preflight Scout analysis-producer package code/build has changed"
    );
  });

  it("rejects a core report runtime mismatch even for report-only reads", async () => {
    const artifacts = boundArtifacts("runtime-core", dir);
    await writeAnalysisArtifacts(dir, {
      ...artifacts,
      provenance: {
        ...artifacts.provenance,
        analysisRuntime: {
          ...artifacts.provenance.analysisRuntime,
          coreDigest: sha256Text("different-core-runtime")
        }
      }
    });

    await expect(readAnalysisArtifactBundle(dir, dir)).rejects.toThrow("exact Preflight Scout core report package code/build has changed");
  });

  it("rejects independently tampered impact and mission artifacts", async () => {
    const artifacts = boundArtifacts("analysis-tamper", dir);
    await writeAnalysisArtifacts(dir, artifacts);
    await writeFile(path.join(dir, "impact-map.json"), `${JSON.stringify({
      ...artifacts.impactMap,
      summary: "tampered but schema-valid impact"
    }, null, 2)}\n`);

    await expect(readAnalysisArtifactBundle(dir, dir, artifacts.provenance)).rejects.toThrow(
      "impact-map.json no longer matches its reviewed digest"
    );

    await writeAnalysisArtifacts(dir, artifacts);
    await writeFile(path.join(dir, "mission.json"), `${JSON.stringify({
      ...artifacts.mission,
      title: "tampered but schema-valid mission"
    }, null, 2)}\n`);

    await expect(readAnalysisArtifactBundle(dir, dir, artifacts.provenance)).rejects.toThrow(
      "mission.json no longer matches its reviewed digest"
    );
  });

  it("rejects tampered declared browser results", async () => {
    const artifacts = boundArtifacts("result-tamper", dir);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    await writeAnalysisArtifacts(dir, { ...artifacts, runResults: [runResult] });
    await writeFile(path.join(dir, "run-results.json"), `${JSON.stringify([{
      ...runResult,
      status: "failed"
    }], null, 2)}\n`);

    await expect(readAnalysisArtifactBundle(dir, dir, artifacts.provenance)).rejects.toThrow(
      "declared browser result artifact is missing or no longer matches its digest"
    );
  });

  it("rejects tampered declared browser evidence", async () => {
    const artifacts = boundArtifacts("evidence-tamper", dir);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    await writeAnalysisArtifacts(dir, { ...artifacts, runResults: [runResult] });
    await writeFile(path.join(dir, "evidence", "final-observation.json"), "{\"changed\":true}\n");

    await expect(readAnalysisArtifactBundle(dir, dir, artifacts.provenance)).rejects.toThrow(
      "declared browser result or evidence artifacts are malformed or no longer match their digests"
    );
  });

  it.each(["report.md", "report.html", "report-summary.json"])(
    "rejects a tampered declared %s before reuse or publication",
    async (reportFile) => {
      const artifacts = boundArtifacts(`report-tamper-${reportFile}`, dir);
      await writeAnalysisArtifacts(dir, artifacts);
      await writeFile(path.join(dir, reportFile), "forged report\n");

      await expect(readAnalysisArtifactBundle(dir, dir)).rejects.toThrow(
        `${reportFile} no longer matches its declared digest`
      );
    }
  );

  it("requires an execution identity for bound browser results", async () => {
    const artifacts = boundArtifacts("missing-executor", dir);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    const { executionRuntime: _executionRuntime, ...withoutExecutionRuntime } = artifacts;

    await expect(writeAnalysisArtifacts(dir, {
      ...withoutExecutionRuntime,
      runResults: [runResult]
    })).rejects.toThrow("require the exact Preflight Scout executor package-code/build identity");
  });

  it("rejects old evidence promotion under a different browser execution runtime", async () => {
    const artifacts = boundArtifacts("executor-mismatch", dir);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    await writeAnalysisArtifacts(dir, { ...artifacts, runResults: [runResult] });

    await expect(readAnalysisArtifactBundle(dir, dir, artifacts.provenance, {
      entrypoint: "cli-browser",
      digest: sha256Text("new-browser-runner")
    })).rejects.toThrow("exact Preflight Scout browser-executor package code/build has changed");
  });

  it("preserves recorded execution identity during report-only rewrites", async () => {
    const artifacts = boundArtifacts("report-preserves-executor", dir);
    const actionExecutionRuntime: ExecutionRuntimeIdentity = {
      entrypoint: "github-action-browser",
      digest: sha256Text("action-browser-executor")
    };
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    await writeAnalysisArtifacts(dir, {
      ...artifacts,
      executionRuntime: actionExecutionRuntime,
      runResults: [runResult]
    });
    const original = await readAnalysisArtifactBundle(dir, dir);

    await writeAnalysisArtifacts(dir, {
      boundary: dir,
      impactMap: original.impactMap,
      mission: original.mission,
      provenance: original.provenance,
      executionRuntime: original.executionRuntime,
      runResults: original.runResults,
      expectedPreviousBundleSha256: original.bundleSha256
    });

    const rebuilt = await readAnalysisArtifactBundle(dir, dir);
    expect(rebuilt.executionRuntime).toEqual(actionExecutionRuntime);
  });

  it("permits new browser-runner code to replace results without invalidating reviewed analysis", async () => {
    const artifacts = boundArtifacts("new-browser-results", dir);
    await writeAnalysisArtifacts(dir, artifacts);
    const reviewed = await readAnalysisArtifactBundle(dir, dir, artifacts.provenance);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    const newExecutionRuntime: ExecutionRuntimeIdentity = {
      entrypoint: "cli-browser",
      digest: sha256Text("new-browser-runner")
    };

    await writeAnalysisArtifacts(dir, {
      ...artifacts,
      executionRuntime: newExecutionRuntime,
      runResults: [runResult],
      expectedPreviousBundleSha256: reviewed.bundleSha256
    });

    await expect(readAnalysisArtifactBundle(
      dir,
      dir,
      artifacts.provenance,
      newExecutionRuntime
    )).resolves.toMatchObject({ executionRuntime: newExecutionRuntime });
  });

  it("rejects outside evidence before writing any report artifact", async () => {
    const runDir = path.join(dir, "outside-evidence-run");
    const artifacts = boundArtifacts("outside-evidence", dir);
    const outsideEvidence = path.join(dir, "outside-observation.json");
    await writeFile(outsideEvidence, "{}\n");

    await expect(writeAnalysisArtifacts(runDir, {
      ...artifacts,
      runResults: [runResultForEvidence(artifacts.mission.automationCandidates[0]!.id, outsideEvidence)]
    })).rejects.toThrow("browser evidence leaves the declared run directory");
    await expect(access(path.join(runDir, "report.md"))).rejects.toThrow();
  });

  it("serializes only portable run-relative evidence paths and remains valid after moving the bundle", async () => {
    const sourceRun = path.join(dir, "source-run");
    const movedRun = path.join(dir, "moved-run");
    const artifacts = boundArtifacts("portable-bundle", dir);
    const runResult = await createRunResult(sourceRun, artifacts.mission.automationCandidates[0]!.id);
    await writeAnalysisArtifacts(sourceRun, { ...artifacts, runResults: [runResult] });

    const serializedResults = await readFile(path.join(sourceRun, "run-results.json"), "utf8");
    expect(serializedResults).not.toContain(dir);
    expect(serializedResults).toContain('"evidence/final-observation.json"');
    await cp(sourceRun, movedRun, { recursive: true });

    const movedBundle = await readAnalysisArtifactBundle(movedRun, dir, artifacts.provenance);
    expect(movedBundle.runResults?.[0]?.artifacts).toEqual(["evidence/final-observation.json"]);
  });

  it("rebuilds supplied report summaries from normalized run-result paths", async () => {
    const runDir = path.join(dir, "normalized-summary");
    const artifacts = boundArtifacts("normalized-summary", dir);
    const runResult = await createRunResult(runDir, artifacts.mission.automationCandidates[0]!.id);
    const generatedAt = "2026-07-18T01:02:03.000Z";
    const reportSummary = {
      generatedAt,
      title: "stale caller summary",
      risk: "high" as const,
      verdict: "ready_for_human_review" as const,
      releaseDecision: {
        status: "ready_for_human_review" as const,
        reason: "stale caller summary",
        nextSteps: []
      },
      counts: {
        affectedAreas: 0,
        manualChecks: 0,
        edgeCases: 0,
        suggestedBrowserMissions: 0,
        browserMissions: 1,
        passed: 1,
        failed: 0,
        blocked: 0
      },
      browserMissions: [{
        id: runResult.missionId,
        status: runResult.status,
        artifacts: runResult.artifacts,
        evidence: runResult.evidence
      }]
    };
    expect(JSON.stringify(reportSummary)).toContain(runDir);

    await writeAnalysisArtifacts(runDir, {
      ...artifacts,
      runResults: [runResult],
      reportSummary
    });

    const serializedSummary = await readFile(path.join(runDir, "report-summary.json"), "utf8");
    expect(serializedSummary).not.toContain(dir);
    expect(serializedSummary).not.toContain("stale caller summary");
    expect(JSON.parse(serializedSummary)).toMatchObject({
      generatedAt,
      title: artifacts.mission.title,
      browserMissions: [{
        artifacts: ["evidence/final-observation.json"],
        evidence: { finalObservationPath: "evidence/final-observation.json" }
      }]
    });
  });

  it("never rediscovers stale browser results that a fresh generation did not declare", async () => {
    const artifacts = boundArtifacts("stale-result", dir);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    const staleResultText = `${JSON.stringify([runResult], null, 2)}\n`;
    await writeAnalysisArtifacts(dir, { ...artifacts, runResults: [runResult] });

    const fresh = {
      ...artifacts,
      provenance: provenance("fresh-generation")
    };
    await writeAnalysisArtifacts(dir, fresh);
    await writeFile(path.join(dir, "run-results.json"), staleResultText);

    const bundle = await readAnalysisArtifactBundle(dir, dir, fresh.provenance);
    const reportSummary = JSON.parse(await readFile(path.join(dir, "report-summary.json"), "utf8")) as {
      verdict: string;
      counts: { browserMissions: number };
    };
    expect(bundle.runResults).toBeUndefined();
    expect(reportSummary).toMatchObject({
      verdict: "no_browser_evidence",
      counts: { browserMissions: 0 }
    });
  });

  it("refuses a same-directory rewrite after its source bundle changes", async () => {
    const artifacts = boundArtifacts("compare-before-replace", dir);
    await writeAnalysisArtifacts(dir, artifacts);
    const original = await readAnalysisArtifactBundle(dir, dir, artifacts.provenance);
    const replacement = {
      ...artifacts,
      provenance: provenance("concurrent-replacement")
    };
    await writeAnalysisArtifacts(dir, replacement);

    await expect(writeAnalysisArtifacts(dir, {
      ...artifacts,
      expectedPreviousBundleSha256: original.bundleSha256
    })).rejects.toThrow("analysis generation changed while this command was running");
    await expect(readAnalysisArtifactBundle(dir, dir, replacement.provenance)).resolves.toMatchObject({
      provenance: replacement.provenance
    });
  });

  it("refuses to bless evidence changed after a bundle was reviewed", async () => {
    const artifacts = boundArtifacts("bundle-cas", dir);
    const runResult = await createRunResult(dir, artifacts.mission.automationCandidates[0]!.id);
    await writeAnalysisArtifacts(dir, { ...artifacts, runResults: [runResult] });
    const reviewed = await readAnalysisArtifactBundle(dir, dir, artifacts.provenance);
    await writeFile(path.join(dir, "evidence", "final-observation.json"), "{\"changed\":true}\n");

    await expect(writeAnalysisArtifacts(dir, {
      ...artifacts,
      runResults: reviewed.runResults,
      expectedPreviousBundleSha256: reviewed.bundleSha256
    })).rejects.toThrow("analysis generation changed while this command was running");
    await expect(access(path.join(dir, "analysis-manifest.json"))).resolves.toBeUndefined();
  });

  it("isolates concurrent browser-evidence generations before manifest publication", async () => {
    const runDir = path.join(dir, "shared-run");
    const artifacts = boundArtifacts("isolated-evidence", dir);
    await writeAnalysisArtifacts(runDir, artifacts);
    const reviewed = await readAnalysisArtifactBundle(runDir, dir, artifacts.provenance);
    const [firstGeneration, secondGeneration] = await Promise.all([
      createAnalysisEvidenceDirectory(runDir, dir),
      createAnalysisEvidenceDirectory(runDir, dir)
    ]);
    expect(firstGeneration).not.toBe(secondGeneration);
    const firstEvidence = path.join(firstGeneration, "final-observation.json");
    const secondEvidence = path.join(secondGeneration, "final-observation.json");
    await Promise.all([
      writeFile(firstEvidence, "{\"generation\":1}\n"),
      writeFile(secondEvidence, "{\"generation\":2}\n")
    ]);

    const publications = await Promise.allSettled([
      writeAnalysisArtifacts(runDir, {
        ...artifacts,
        runResults: [runResultForEvidence(artifacts.mission.automationCandidates[0]!.id, firstEvidence)],
        expectedPreviousBundleSha256: reviewed.bundleSha256
      }),
      writeAnalysisArtifacts(runDir, {
        ...artifacts,
        runResults: [runResultForEvidence(artifacts.mission.automationCandidates[0]!.id, secondEvidence)],
        expectedPreviousBundleSha256: reviewed.bundleSha256
      })
    ]);
    expect(publications.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(publications.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const published = await readAnalysisArtifactBundle(runDir, dir, artifacts.provenance);
    const publishedPath = published.runResults?.[0]?.artifacts[0];
    expect([
      path.basename(firstGeneration),
      path.basename(secondGeneration)
    ].some((generation) => publishedPath?.includes(generation))).toBe(true);
    await expect(readFile(firstEvidence, "utf8")).resolves.toBe("{\"generation\":1}\n");
    await expect(readFile(secondEvidence, "utf8")).resolves.toBe("{\"generation\":2}\n");
  });

  it("refuses a late PDF from an obsolete analysis generation", async () => {
    const runDir = path.join(dir, "pdf-race-run");
    const first = boundArtifacts("pdf-first", dir);
    const firstPublication = await writeAnalysisArtifacts(runDir, first);
    const firstTemporaryDirectory = await createAnalysisEvidenceDirectory(runDir, dir);
    const firstTemporaryPdf = path.join(firstTemporaryDirectory, "report.pdf");
    await writeFile(firstTemporaryPdf, "%PDF-first\n");

    const second = boundArtifacts("pdf-second", dir);
    const secondPublication = await writeAnalysisArtifacts(runDir, second);
    await expect(publishAnalysisPdf({
      runDir,
      boundary: dir,
      temporaryPdfPath: firstTemporaryPdf,
      expectedBundleSha256: firstPublication.bundleSha256!
    })).rejects.toThrow("analysis generation changed while report.pdf was rendering");
    await expect(access(path.join(runDir, "report.pdf"))).rejects.toThrow();

    const secondTemporaryDirectory = await createAnalysisEvidenceDirectory(runDir, dir);
    const secondTemporaryPdf = path.join(secondTemporaryDirectory, "report.pdf");
    await writeFile(secondTemporaryPdf, "%PDF-second\n");
    await publishAnalysisPdf({
      runDir,
      boundary: dir,
      temporaryPdfPath: secondTemporaryPdf,
      expectedBundleSha256: secondPublication.bundleSha256!
    });
    await expect(readFile(path.join(runDir, "report.pdf"), "utf8")).resolves.toBe("%PDF-second\n");
    const published = await readAnalysisArtifactBundle(runDir, dir, second.provenance);
    expect(published.manifest.artifacts.reportPdfSha256).toBe(sha256Text("%PDF-second\n"));
    await writeFile(path.join(runDir, "report.pdf"), "%PDF-forged\n");
    await expect(readAnalysisArtifactBundle(runDir, dir)).rejects.toThrow(
      "report.pdf is missing or no longer matches its declared digest"
    );
  });

  it("rejects an undeclared stale PDF and competing publishers", async () => {
    const runDir = path.join(dir, "pdf-publication-run");
    const artifacts = boundArtifacts("pdf-publication", dir);
    const publication = await writeAnalysisArtifacts(runDir, artifacts);
    await writeFile(path.join(runDir, "report.pdf"), "%PDF-stale\n");
    await expect(readAnalysisArtifactBundle(runDir, dir)).rejects.toThrow(
      "undeclared stale report.pdf is present"
    );
    await rm(path.join(runDir, "report.pdf"));

    const temporaryDirectories = await Promise.all([
      createAnalysisEvidenceDirectory(runDir, dir),
      createAnalysisEvidenceDirectory(runDir, dir)
    ]);
    const temporaryPdfs = temporaryDirectories.map((directory, index) => path.join(directory, `report.pdf`));
    await Promise.all(temporaryPdfs.map((file, index) => writeFile(file, `%PDF-${index + 1}\n`)));
    const results = await Promise.allSettled(temporaryPdfs.map((temporaryPdfPath) => publishAnalysisPdf({
      runDir,
      boundary: dir,
      temporaryPdfPath,
      expectedBundleSha256: publication.bundleSha256!
    })));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(readAnalysisArtifactBundle(runDir, dir, artifacts.provenance)).resolves.toMatchObject({
      manifest: { artifacts: { reportPdfSha256: expect.stringMatching(/^sha256:/) } }
    });
  });

  it("leaves no reusable manifest when generation fails before evidence is complete", async () => {
    const artifacts = boundArtifacts("manifest-last", dir);
    await writeAnalysisArtifacts(dir, artifacts);
    const incompleteResult: MissionRunResult = {
      missionId: artifacts.mission.automationCandidates[0]!.id,
      status: "passed",
      results: [{ stepId: "complete", status: "passed", message: "Incomplete evidence" }],
      artifacts: [path.join(dir, "evidence", "missing.json")]
    };

    await expect(writeAnalysisArtifacts(dir, {
      ...artifacts,
      runResults: [incompleteResult]
    })).rejects.toThrow("browser evidence is missing or could not be read safely");
    await expect(access(path.join(dir, "analysis-manifest.json"))).rejects.toThrow();
  });

  it("serializes same-directory writers and rejects a concurrent stale generation", async () => {
    const original = boundArtifacts("concurrent-original", dir);
    await writeAnalysisArtifacts(dir, original);
    const bundle = await readAnalysisArtifactBundle(dir, dir, original.provenance);
    const first = {
      ...boundArtifacts("concurrent-first", dir),
      markdown: `# First writer\n\n${"x".repeat(8 * 1024 * 1024)}\n`,
      expectedPreviousBundleSha256: bundle.bundleSha256
    };
    const second = {
      ...boundArtifacts("concurrent-second", dir),
      expectedPreviousBundleSha256: bundle.bundleSha256
    };

    const firstWrite = writeAnalysisArtifacts(dir, first);
    await waitForFile(path.join(dir, ".analysis-generation.lock"));
    await expect(writeAnalysisArtifacts(dir, second)).rejects.toThrow("another writer owns this run directory");
    await firstWrite;
    await expect(readAnalysisArtifactBundle(dir, dir, first.provenance)).resolves.toMatchObject({
      provenance: first.provenance
    });
  });

  it.skipIf(process.platform === "win32")("does not clean through a symlinked run-directory ancestor", async () => {
    const repository = path.join(dir, "repository");
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-artifacts-outside-"));
    try {
      await mkdir(path.join(repository, ".git"), { recursive: true });
      const externalRun = path.join(external, "nested");
      await mkdir(externalRun, { recursive: true });
      const cleanupNames = ["analysis-manifest.json", "run-result.json", "run-results.json", "report.pdf"];
      await Promise.all(cleanupNames.map((name) => writeFile(path.join(externalRun, name), `outside-${name}\n`)));
      await symlink(external, path.join(repository, "link"));
      const runDir = path.join(repository, "link", "nested");

      await expect(writeAnalysisArtifacts(runDir, boundArtifacts("symlink-cleanup", repository))).rejects.toThrow(
        /symbolic link|unsafe directory/
      );
      for (const name of cleanupNames) {
        await expect(readFile(path.join(externalRun, name), "utf8")).resolves.toBe(`outside-${name}\n`);
      }
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not read a bound analysis through a symlinked run-directory ancestor", async () => {
    const repository = path.join(dir, "repository");
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-artifacts-read-outside-"));
    try {
      await mkdir(repository);
      const externalRun = path.join(external, "nested");
      await mkdir(externalRun, { recursive: true });
      const artifacts = boundArtifacts("symlink-read", external);
      await writeAnalysisArtifacts(externalRun, artifacts);
      await symlink(external, path.join(repository, "link"));

      await expect(readAnalysisArtifactBundle(
        path.join(repository, "link", "nested"),
        repository,
        artifacts.provenance
      )).rejects.toThrow("analysis directory could not be read safely");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects artifact reads through a symlinked repository path", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-artifacts-external-"));
    try {
      await mkdir(path.join(dir, ".git"));
      await writeFile(path.join(external, "mission.json"), "{}\n");
      await symlink(external, path.join(dir, ".preflight-scout"));

      await expect(readMissionArtifact(path.join(dir, ".preflight-scout", "mission.json"))).rejects.toThrow("symbolic link");
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

function boundArtifacts(marker: string, boundary: string): {
  boundary: string;
  impactMap: ImpactMap;
  mission: QAMission;
  provenance: AnalysisProvenance;
  executionRuntime: ExecutionRuntimeIdentity;
} {
  const impactMap: ImpactMap = {
    summary: `${marker} impact`,
    risk: "high",
    changedFiles: [{ path: "checkout.tsx", status: "modified" }],
    affectedRoutes: [{ path: "/checkout", file: "checkout.tsx", kind: "page" }],
    affectedAreas: [{ kind: "route", name: "Checkout", evidence: ["checkout.tsx"], risk: "high" }],
    suggestedRoles: [],
    unknowns: []
  };
  return {
    boundary,
    impactMap,
    mission: {
      id: `${marker}-mission`,
      title: `${marker} mission`,
      risk: "high",
      summary: `${marker} summary`,
      affectedAreas: impactMap.affectedAreas,
      manualChecklist: [],
      edgeCases: [],
      automationCandidates: [{
        id: `${marker}-flow`,
        title: `${marker} flow`,
        risk: "high",
        reason: ["The checkout changed."],
        steps: []
      }],
      unknowns: []
    },
    provenance: provenance(marker),
    executionRuntime: EXECUTION_RUNTIME
  };
}

function provenance(marker: string): AnalysisProvenance {
  return {
    createdAt: "2026-07-18T00:00:00.000Z",
    toolVersion: PREFLIGHT_SCOUT_VERSION,
    analysisRuntime: PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME,
    schemaDigest: ANALYSIS_SCHEMA_DIGEST,
    repositoryDigest: sha256Text(`repository-${marker}`),
    repositoryContextDigest: sha256Text(`repository-context-${marker}`),
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    contractDigest: sha256Text(`contract-${marker}`)
  };
}

async function createRunResult(dir: string, missionId: string): Promise<MissionRunResult> {
  const evidencePath = path.join(dir, "evidence", "final-observation.json");
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, "{\"ready\":true}\n");
  return {
    missionId,
    status: "passed",
    results: [{ stepId: "complete", status: "passed", message: "Reviewed mission passed." }],
    artifacts: [evidencePath],
    evidence: { finalObservationPath: evidencePath }
  };
}

function runResultForEvidence(missionId: string, evidencePath: string): MissionRunResult {
  return {
    missionId,
    status: "passed",
    results: [{ stepId: "complete", status: "passed", message: "Reviewed mission passed." }],
    artifacts: [evidencePath],
    evidence: { finalObservationPath: evidencePath }
  };
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  throw new Error("Timed out waiting for analysis generation lock.");
}
