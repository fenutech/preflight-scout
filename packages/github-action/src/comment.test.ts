import { describe, expect, it } from "vitest";
import { renderPullRequestComment } from "./comment.js";
import type { HumanReportSummary, ImpactMap, QAMission } from "@preflight-scout/core";

const summary: HumanReportSummary = {
  generatedAt: "2026-04-22T10:00:00.000Z",
  title: "Checkout QA",
  risk: "high",
  verdict: "needs_attention",
  releaseDecision: {
    status: "do_not_ship_yet",
    reason: "1 browser mission failed and 0 were blocked.",
    nextSteps: ["Review failed evidence.", "Rerun Preflight Scout before production."]
  },
  counts: {
    affectedAreas: 1,
    manualChecks: 2,
    edgeCases: 1,
    suggestedBrowserMissions: 2,
    browserMissions: 2,
    passed: 1,
    failed: 1,
    blocked: 0
  },
  browserMissions: [
    { id: "valid-coupon", title: "Valid coupon", status: "passed", artifacts: [] },
    { id: "expired-coupon", title: "Expired coupon", status: "failed", finalMessage: "Expired coupon did not show an error.", artifacts: [] }
  ]
};

const impactMap: ImpactMap = {
  summary: "Checkout changed",
  risk: "high",
  changedFiles: [],
  affectedRoutes: [],
  affectedAreas: [],
  suggestedRoles: [],
  unknowns: []
};

const mission: QAMission = {
  id: "checkout",
  title: "Checkout QA",
  risk: "high",
  summary: "Checkout changed",
  affectedAreas: [{ kind: "component", name: "Promo form", evidence: ["checkout.js"], risk: "high" }],
  manualChecklist: ["Apply SAVE10.", "Apply EXPIRED10."],
  edgeCases: ["Empty promo."],
  automationCandidates: [],
  unknowns: []
};

describe("renderPullRequestComment", () => {
  it("renders a concise PR summary with artifact guidance", () => {
    const markdown = renderPullRequestComment({
      summary,
      impactMap,
      mission,
      artifactName: "preflight-scout-pr-1-abc1234",
      artifactId: 123,
      appUrl: "https://preview.example.com",
      failOn: "needs_attention"
    });

    expect(markdown).toContain("## Preflight Scout");
    expect(markdown).toContain("**Verdict:** Needs attention before production");
    expect(markdown).toContain("**Release readiness:** Do not ship yet");
    expect(markdown).toContain("1 browser mission failed");
    expect(markdown).toContain("Expired coupon did not show an error.");
    expect(markdown).toContain("preflight-scout-pr-1-abc1234");
    expect(markdown).toContain("<!-- preflight-scout-report -->");
    expect(markdown.length).toBeLessThan(4000);
  });

  it("neutralizes untrusted Markdown, mentions, HTML, and forged report markers", () => {
    const malicious = "@attacker\n## injected [click](javascript:alert(1)) <script>alert(1)</script> <!-- preflight-scout-report -->";
    const markdown = renderPullRequestComment({
      summary: {
        ...summary,
        generatedAt: malicious,
        releaseDecision: { ...summary.releaseDecision, reason: malicious },
        browserMissions: [
          { id: "bad", title: malicious, status: "failed", finalMessage: malicious, artifacts: [] }
        ]
      },
      impactMap,
      mission: {
        ...mission,
        manualChecklist: [malicious],
        affectedAreas: [{ ...mission.affectedAreas[0]!, name: malicious, kind: malicious }]
      },
      artifactName: malicious,
      appUrl: `https://preview.example.test/${malicious}`,
      failOn: malicious
    });

    expect(markdown.split("<!-- preflight-scout-report -->")).toHaveLength(2);
    expect(markdown).not.toContain("@attacker");
    expect(markdown).toContain("@\u200battacker");
    expect(markdown).not.toContain("\n## injected");
    expect(markdown).not.toContain("](javascript:");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("&lt;!-- preflight-scout-report --&gt;");
  });
});
