import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readImpactMapArtifact, readMissionArtifact, writeAnalysisArtifacts } from "./artifacts.js";
import type { ImpactMap, QAMission } from "./types.js";

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

    await writeAnalysisArtifacts(dir, { impactMap, mission });

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
