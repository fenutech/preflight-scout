import { describe, expect, it } from "vitest";
import { parseFailOn, shouldFail } from "./gate.js";
import type { HumanReportSummary } from "@preflight-scout/core";

function summary(counts: Partial<HumanReportSummary["counts"]>, verdict: HumanReportSummary["verdict"] = "needs_attention"): HumanReportSummary {
  return {
    generatedAt: "2026-04-22T10:00:00.000Z",
    title: "QA",
    risk: "medium",
    verdict,
    counts: {
      affectedAreas: 0,
      manualChecks: 0,
      edgeCases: 0,
      browserMissions: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      ...counts
    },
    browserMissions: []
  };
}

describe("gate", () => {
  it("parses fail-on modes", () => {
    expect(parseFailOn(undefined)).toBe("needs_attention");
    expect(parseFailOn("never")).toBe("never");
    expect(() => parseFailOn("always")).toThrow("fail-on");
  });

  it("supports non-blocking and failed-only gates", () => {
    expect(shouldFail(summary({ failed: 1 }), "never")).toBe(false);
    expect(shouldFail(summary({ blocked: 1 }), "failed_only")).toBe(false);
    expect(shouldFail(summary({ failed: 1 }), "failed_only")).toBe(true);
    expect(shouldFail(summary({ blocked: 1 }), "needs_attention")).toBe(true);
    expect(shouldFail(summary({}, "ready_for_human_review"), "needs_attention")).toBe(false);
    expect(shouldFail(summary({ browserMissions: 0 }, "needs_attention"), "needs_attention")).toBe(true);
  });
});
