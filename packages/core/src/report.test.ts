import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENERATED_OUTPUT_LICENSE, buildHumanReportSummary, renderHumanReport, renderHumanReportHtml } from "./report.js";
import type { ImpactMap, MissionRunResult, QAMission } from "./types.js";

const impactMap: ImpactMap = {
  summary: "Checkout changed.",
  risk: "high",
  changedFiles: [{ path: "checkout.tsx", status: "modified" }],
  affectedRoutes: [{ path: "/checkout", file: "checkout.tsx", kind: "page" }],
  affectedAreas: [{ kind: "component", name: "Checkout", evidence: ["checkout.tsx changed total rendering"], risk: "high" }],
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
  automationCandidates: [
    {
      id: "auto-checkout",
      title: "Checkout happy path",
      role: "buyer",
      startPath: "/checkout",
      risk: "high",
      reason: ["Checkout total rendering changed."],
      steps: []
    }
  ],
  unknowns: ["Disposable payment data is not configured."]
};

function createRunResult(runDir: string): MissionRunResult {
  const missionDir = path.join(runDir, "auto-checkout");
  return {
    missionId: "auto-checkout",
    status: "failed",
    results: [
      { stepId: "turn-1", status: "passed", message: "Opened checkout." },
      {
        stepId: "turn-2",
        status: "failed",
        message: "Total did not update.",
        screenshotPath: path.join(missionDir, "turn-2.png")
      }
    ],
    artifacts: [
      path.join(missionDir, "turn-1-observation.png"),
      path.join(missionDir, "turn-2.png"),
      path.join(missionDir, "trace.zip"),
      path.join(missionDir, "console-errors.json"),
      path.join(missionDir, "network-errors.json")
    ],
    evidence: {
      tracePath: path.join(missionDir, "trace.zip"),
      consolePath: path.join(missionDir, "console-errors.json"),
      networkPath: path.join(missionDir, "network-errors.json")
    }
  };
}

describe("human report", () => {
  let suiteRoot: string;
  let runDir: string;
  let runResult: MissionRunResult;

  beforeAll(async () => {
    suiteRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-report-"));
    runDir = path.join(suiteRoot, "run");
    const missionDir = path.join(runDir, "auto-checkout");
    await mkdir(missionDir, { recursive: true });
    for (const name of ["turn-1-observation.png", "turn-2.png", "trace.zip", "console-errors.json", "network-errors.json"]) {
      await writeFile(path.join(missionDir, name), `fixture ${name}`);
    }
    runResult = createRunResult(runDir);
  });

  afterAll(async () => {
    await rm(suiteRoot, { recursive: true, force: true });
  });

  it("renders a human-readable report with mission evidence", () => {
    const markdown = renderHumanReport({
      impactMap,
      mission,
      runResults: [runResult],
      runDir,
      generatedAt: "2026-04-22T10:00:00.000Z"
    });

    expect(markdown).toContain("# Preflight Scout Report");
    expect(markdown).toContain("RELEASE QA REPORT / LOCAL FILES / REVIEW BEFORE SHIPPING");
    expect(markdown).toContain("Verdict: **Needs attention before production**");
    expect(markdown).toContain("## Release result");
    expect(markdown).toContain("### DO NOT SHIP YET");
    expect(markdown).toContain("## Manual checks before production");
    expect(markdown).toContain("## Affected areas by risk");
    expect(markdown).toContain("### Results");
    expect(markdown).toContain("Checkout happy path");
    expect(markdown).toContain("- Suggested browser missions: 1");
    expect(markdown).toContain("- Executed browser missions: 1");
    expect(markdown).toContain("FAILED `turn-2`: Total did not update.");
    expect(markdown).toContain("auto-checkout/turn-2.png");
    expect(markdown).toContain("![turn-2.png](auto-checkout/turn-2.png)");
    expect(markdown).toContain("auto-checkout/trace.zip");
    expect(markdown).toContain("auto-checkout/console-errors.json");
    expect(markdown).toContain(GENERATED_OUTPUT_LICENSE.notice);
    expect(markdown).toContain(GENERATED_OUTPUT_LICENSE.url);
  });

  it("builds a machine-readable summary", () => {
    const summary = buildHumanReportSummary({
      impactMap,
      mission,
      runResults: [runResult],
      generatedAt: "2026-04-22T10:00:00.000Z"
    });

    expect(summary.verdict).toBe("needs_attention");
    expect(summary.releaseDecision.status).toBe("do_not_ship_yet");
    expect(summary.releaseDecision.nextSteps).toContain("Rerun Preflight Scout before production.");
    expect(summary.counts.suggestedBrowserMissions).toBe(1);
    expect(summary.counts.browserMissions).toBe(1);
    expect(summary.counts.failed).toBe(1);
    expect(summary.browserMissions[0]?.finalMessage).toBe("Total did not update.");
    expect(summary.browserMissions[0]?.evidence?.tracePath).toContain("trace.zip");
  });

  it("renders a print-friendly HTML report with screenshot evidence", () => {
    const html = renderHumanReportHtml({
      impactMap,
      mission,
      runResults: [runResult],
      runDir,
      generatedAt: "2026-04-22T10:00:00.000Z"
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Preflight Scout Report");
    expect(html).toContain("PRE-FLIGHT REPORT");
    expect(html).toContain("Needs attention before production");
    expect(html).toContain("Release result");
    expect(html).toContain("Do not ship yet");
    expect(html).toContain("Manual checks before production");
    expect(html).toContain("Suggested browser checks");
    expect(html).toContain("Executed browser checks");
    expect(html).toContain("auto-checkout/turn-2.png");
    expect(html).toContain("@media print");
    expect(html).toContain("color-scheme: dark");
    expect(html).toContain("--lime: #d0e94e");
    expect(html).toContain("class=\"decision hold\">Do not ship yet</p>");
    expect(html).toContain("class=\"mission-card failed\"");
    expect(html).toContain("class=\"step-status failed\"");
    expect(html).toContain("http-equiv=\"Content-Security-Policy\"");
    expect(html).toContain("name=\"robots\" content=\"noindex, nofollow\"");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`content="${GENERATED_OUTPUT_LICENSE.id}"`);
    expect(html).toContain(GENERATED_OUTPUT_LICENSE.notice);
    expect(html).toContain(`href="${GENERATED_OUTPUT_LICENSE.url}"`);
  });

  it("keeps long untrusted report metadata inside the instrument rail", () => {
    const longMissionId = `mission-${"x".repeat(128)}`;
    const html = renderHumanReportHtml({
      impactMap,
      mission: { ...mission, id: longMissionId },
      runResults: [runResult],
      runDir,
      generatedAt: "2026-04-22T10:00:00.000Z"
    });

    expect(html).toContain(longMissionId);
    expect(html).toContain(".instrument-rail > span");
    expect(html).toContain("overflow-wrap: anywhere");
  });

  it("uses distinct instrument states for passed and pending release decisions", () => {
    const passedResult: MissionRunResult = {
      ...runResult,
      status: "passed",
      results: runResult.results.map((step) => ({ ...step, status: "passed" as const }))
    };
    const passedHtml = renderHumanReportHtml({ impactMap, mission, runResults: [passedResult], runDir });
    const pendingHtml = renderHumanReportHtml({ impactMap, mission });

    expect(passedHtml).toContain("class=\"decision clear\">Ready for human review</p>");
    expect(passedHtml).toContain("class=\"mission-card passed\"");
    expect(passedHtml).toContain("data-tone=\"passed\"");
    expect(pendingHtml).toContain("class=\"decision pending\">Needs browser evidence</p>");
    expect(pendingHtml).toContain("class=\"empty-state\"");
  });

  it("marks checklist-only reports as needing browser evidence", () => {
    const summary = buildHumanReportSummary({
      impactMap,
      mission,
      generatedAt: "2026-04-22T10:00:00.000Z"
    });

    expect(summary.verdict).toBe("no_browser_evidence");
    expect(summary.releaseDecision.status).toBe("needs_browser_evidence");
    expect(summary.releaseDecision.nextSteps.join("\n")).toContain("Run the suggested browser missions");
  });

  it("renders only regular evidence files beneath the run directory", async () => {
    const missionDir = path.join(runDir, "auto-checkout");
    const safeEvidence = path.join(missionDir, "safe evidence (1).png");
    const outsideEvidence = path.join(suiteRoot, "outside.png");
    const symlinkEvidence = path.join(missionDir, "outside-link.png");
    const directoryEvidence = path.join(missionDir, "not-a-file.png");
    await writeFile(safeEvidence, "safe");
    await writeFile(outsideEvidence, "outside");
    await symlink(outsideEvidence, symlinkEvidence);
    await mkdir(directoryEvidence);

    const unsafeResult: MissionRunResult = {
      ...runResult,
      results: [
        { stepId: "safe", status: "passed", screenshotPath: safeEvidence },
        { stepId: "url", status: "passed", screenshotPath: "https://evil.example/evidence.png" },
        { stepId: "script", status: "passed", screenshotPath: "javascript:alert(1)" },
        { stepId: "absolute", status: "passed", screenshotPath: outsideEvidence },
        { stepId: "traversal", status: "passed", screenshotPath: "../outside.png" },
        { stepId: "symlink", status: "passed", screenshotPath: symlinkEvidence },
        { stepId: "directory", status: "passed", screenshotPath: directoryEvidence }
      ],
      evidence: undefined
    };

    const markdown = renderHumanReport({ impactMap, mission, runResults: [unsafeResult], runDir });
    const html = renderHumanReportHtml({ impactMap, mission, runResults: [unsafeResult], runDir });
    const safeHref = "auto-checkout/safe%20evidence%20(1).png";

    expect(markdown).toContain(`![safe evidence \\(1\\).png](${safeHref})`);
    expect(html).toContain(`src="${safeHref}"`);
    expect(markdown).not.toContain("](https://evil.example");
    expect(markdown).not.toContain("](javascript:");
    expect(markdown).not.toContain("[outside.png](");
    expect(markdown).not.toContain("[outside-link.png](");
    expect(markdown).not.toContain("[not-a-file.png](");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("outside-link.png");
  });

  it("omits evidence links when no run directory is supplied", () => {
    const markdown = renderHumanReport({ impactMap, mission, runResults: [runResult] });
    const html = renderHumanReportHtml({ impactMap, mission, runResults: [runResult] });

    expect(markdown).not.toContain("![turn-2.png]");
    expect(markdown).not.toContain("[trace.zip](");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain(">trace.zip</a>");
  });

  it.skipIf(process.platform === "win32")("omits hard-linked evidence even when its path is inside the run directory", async () => {
    const outsideEvidence = path.join(suiteRoot, "outside-hardlink-secret.png");
    const hardLink = path.join(runDir, "auto-checkout", "hard-linked-secret.png");
    await writeFile(outsideEvidence, "outside secret");
    await link(outsideEvidence, hardLink);
    const hardLinkedResult: MissionRunResult = {
      ...runResult,
      results: [{ stepId: "hardlink", status: "passed", screenshotPath: hardLink }],
      evidence: undefined
    };

    const markdown = renderHumanReport({ impactMap, mission, runResults: [hardLinkedResult], runDir });
    const html = renderHumanReportHtml({ impactMap, mission, runResults: [hardLinkedResult], runDir });

    expect(markdown).not.toContain("[hard-linked-secret.png](");
    expect(html).not.toContain("hard-linked-secret.png");
  });

  it("neutralizes untrusted Markdown, mentions, HTML, and forged report markers", () => {
    const malicious = "@attacker\n## injected [click](javascript:alert(1)) <script>alert(1)</script> <!-- preflight-scout-report --> `break`";
    const maliciousMission: QAMission = {
      ...mission,
      summary: malicious,
      manualChecklist: [malicious],
      edgeCases: [malicious],
      unknowns: [malicious],
      affectedAreas: [{ ...mission.affectedAreas[0]!, name: malicious, evidence: [malicious] }],
      automationCandidates: [{ ...mission.automationCandidates[0]!, title: malicious, reason: [malicious], role: malicious, startPath: malicious }]
    };
    const maliciousImpact: ImpactMap = {
      ...impactMap,
      affectedRoutes: [{ path: malicious, file: malicious, kind: "page" }]
    };
    const maliciousResult: MissionRunResult = {
      ...runResult,
      results: [{ stepId: malicious, status: "failed", message: malicious }],
      evidence: undefined
    };

    const markdown = renderHumanReport({
      impactMap: maliciousImpact,
      mission: maliciousMission,
      runResults: [maliciousResult],
      runDir,
      generatedAt: malicious
    });
    const humanSections = markdown.slice(0, markdown.indexOf("## Machine-readable summary"));

    expect(markdown.split("<!-- preflight-scout-report -->")).toHaveLength(2);
    expect(markdown).not.toContain("@attacker");
    expect(markdown).toContain("@\u200battacker");
    expect(markdown).not.toContain("\n## injected");
    expect(humanSections).not.toContain("](javascript:");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("&lt;!-- preflight-scout-report --&gt;");
  });
});
