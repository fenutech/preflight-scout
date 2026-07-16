import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { HumanReportSummary, ImpactMap, MissionRunResult, QAMission } from "./types.js";
import { buildHumanReportSummary, renderHumanReport, renderHumanReportHtml } from "./report.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sampleRoot = path.join(repositoryRoot, "examples", "sample-report");
const sampleGeneratedAt = "2026-07-13T12:00:00.000Z";

describe("committed sample report", () => {
  it("matches the report renderer used by real CLI runs", async () => {
    const [impactMap, mission, runResults, committedSummary, committedMarkdown, committedHtml] = await Promise.all([
      readJson<ImpactMap>("impact-map.json"),
      readJson<QAMission>("mission.json"),
      readJson<MissionRunResult[]>("run-results.json"),
      readJson<HumanReportSummary>("report-summary.json"),
      readFile(path.join(sampleRoot, "report.md"), "utf8"),
      readFile(path.join(sampleRoot, "report.html"), "utf8")
    ]);

    const input = {
      impactMap,
      mission,
      runResults,
      runDir: sampleRoot,
      generatedAt: committedSummary.generatedAt
    };

    expect(committedSummary.generatedAt).toBe(sampleGeneratedAt);
    expect(committedMarkdown).toContain("1 browser check failed; 0 were blocked.");
    expect(committedMarkdown).not.toContain("Browser results\u200B:");
    expect(renderHumanReport(input)).toBe(committedMarkdown);
    expect(renderHumanReportHtml(input)).toBe(committedHtml);
    expect(buildHumanReportSummary(input)).toEqual(committedSummary);
  });
});

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(path.join(sampleRoot, relative), "utf8")) as T;
}
