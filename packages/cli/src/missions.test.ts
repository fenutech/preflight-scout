import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QAContract, QAFlowMission, QAMission } from "@preflight-scout/core";
import { resolveStorageOptions } from "./local.js";
import { runAutomationCandidates, safeArtifactSegment, selectAutomationCandidates } from "./missions.js";

const execFileAsync = promisify(execFile);

describe("selectAutomationCandidates", () => {
  it("runs the first two LLM-ranked missions by default", () => {
    expect(selectAutomationCandidates(mission()).map((candidate) => candidate.id)).toEqual(["first", "second"]);
  });

  it("honors explicit mission limit, mission id, and all-candidates modes", () => {
    expect(selectAutomationCandidates(mission(), { missionLimit: 1 }).map((candidate) => candidate.id)).toEqual(["first"]);
    expect(selectAutomationCandidates(mission(), { missionId: "third" }).map((candidate) => candidate.id)).toEqual(["third"]);
    expect(selectAutomationCandidates(mission(), { allCandidates: true }).map((candidate) => candidate.id)).toEqual(["first", "second", "third"]);
  });

  it("preserves an all-manual mission while explicit missing ids still fail", () => {
    const allManual = { ...mission(), automationCandidates: [] };

    expect(selectAutomationCandidates(allManual)).toEqual([]);
    expect(selectAutomationCandidates(allManual, { allCandidates: true })).toEqual([]);
    expect(() => selectAutomationCandidates(allManual, { missionId: "missing" }))
      .toThrow('Automation candidate "missing" was not found. Available candidates: (none)');
  });

  it.each(["../outside", "nested/path", "nested\\path", ".", "", "mission id"])("rejects unsafe mission artifact id %j", (id) => {
    expect(() => safeArtifactSegment(id, "mission id")).toThrow("safe single path segment");
  });

  it("refuses to relocate authentication state into multi-mission evidence directories", async () => {
    await expect(runAutomationCandidates([flow("first"), flow("second")], {
      appUrl: "https://example.test",
      contract: emptyContract(),
      llm: { completeJson: async () => { throw new Error("must not run"); } },
      root: "/tmp/repo",
      outputDir: "/tmp/repo/.preflight-scout/runs/latest",
      headless: true,
      saveStorageState: "/tmp/repo/.preflight-scout/auth/session.json"
    })).rejects.toThrow("multi-mission run");
  });
});

describe("resolveStorageOptions", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "preflight-scout-storage-options-"));
    outside = await mkdtemp(path.join(tmpdir(), "preflight-scout-storage-outside-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), ".preflight-scout/auth/\n", "utf8");
    await mkdir(path.join(root, ".preflight-scout", "auth"), { recursive: true });
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  });

  it("does not load auth storage for public or unconfigured-role missions", async () => {
    const contract: QAContract = {
      app: {},
      auth: {
        saveStorageState: ".preflight-scout/auth/local-qa_user.json",
        roles: {
          qa_user: {
            storageState: ".preflight-scout/auth/qa_user.json"
          }
        }
      },
      criticalFlows: [],
      sensitiveAreas: [],
      dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
      testData: {},
      unknowns: []
    };

    await expect(resolveStorageOptions(root, contract, [flow("public")], {})).resolves.toEqual({
      storageState: undefined,
      saveStorageState: undefined
    });
    await expect(resolveStorageOptions(root, contract, [{ ...flow("none"), role: "none" }], {})).resolves.toMatchObject({ storageState: undefined });
    await expect(resolveStorageOptions(root, contract, [{ ...flow("guest"), role: "guest" }], {})).resolves.toMatchObject({ storageState: undefined });
  });

  it("loads ignored, untracked auth storage only for exact configured auth roles", async () => {
    const contract: QAContract = {
      app: {},
      auth: {
        storageState: ".preflight-scout/auth/global.json",
        roles: {
          qa_user: {
            storageState: ".preflight-scout/auth/qa_user.json"
          },
          admin: {}
        }
      },
      criticalFlows: [],
      sensitiveAreas: [],
      dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
      testData: {},
      unknowns: []
    };

    await expect(resolveStorageOptions(root, contract, [{ ...flow("auth"), role: "qa_user" }], {})).resolves.toEqual({
      storageState: path.join(root, ".preflight-scout/auth/qa_user.json"),
      saveStorageState: path.join(root, ".preflight-scout/auth/qa_user.json")
    });
    await expect(resolveStorageOptions(root, contract, [{ ...flow("admin"), role: "admin" }], {})).resolves.toEqual({
      storageState: path.join(root, ".preflight-scout/auth/global.json"),
      saveStorageState: undefined
    });
  });

  it("keeps explicit run and replay paths trusted, including absolute and parent-relative paths", async () => {
    const absoluteStorage = path.join(outside, "manual-input.json");
    const parentRelativeSave = "../manual-output.json";

    await expect(resolveStorageOptions(root, emptyContract(), [flow("public")], {
      storageState: absoluteStorage,
      saveStorageState: parentRelativeSave
    })).resolves.toEqual({
      storageState: absoluteStorage,
      saveStorageState: path.join(root, parentRelativeSave)
    });
  });

  it("rejects contract-derived absolute and parent-traversal paths outside .preflight-scout/auth", async () => {
    const absoluteContract = storageContract(path.join(outside, "state.json"));
    const traversalContract = storageContract(".preflight-scout/auth/../../state.json");
    const missionWithRole = [{ ...flow("auth"), role: "qa_user" }];

    await expect(resolveStorageOptions(root, absoluteContract, missionWithRole, {})).rejects.toThrow(/beneath .*\.preflight-scout.*auth/);
    await expect(resolveStorageOptions(root, traversalContract, missionWithRole, {})).rejects.toThrow(/beneath .*\.preflight-scout.*auth/);
  });

  it("rejects contract-derived paths when the auth boundary, an ancestor, or the target is a symlink to outside", async () => {
    const missionWithRole = [{ ...flow("auth"), role: "qa_user" }];
    const linkedDirectory = path.join(root, ".preflight-scout", "auth", "linked");
    await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    await expect(resolveStorageOptions(
      root,
      storageContract(".preflight-scout/auth/linked/state.json"),
      missionWithRole,
      {}
    )).rejects.toThrow(/traverses (?:a )?symbolic link/);

    await rm(linkedDirectory, { force: true });
    const linkedTarget = path.join(root, ".preflight-scout", "auth", "state.json");
    await symlink(outside, linkedTarget, process.platform === "win32" ? "junction" : "dir");
    await expect(resolveStorageOptions(root, storageContract(".preflight-scout/auth/state.json"), missionWithRole, {}))
      .rejects.toThrow(/traverses symbolic link/);

    await rm(linkedTarget, { force: true });
    const authBoundary = path.join(root, ".preflight-scout", "auth");
    await rm(authBoundary, { recursive: true, force: true });
    await symlink(outside, authBoundary, process.platform === "win32" ? "junction" : "dir");
    await expect(resolveStorageOptions(root, storageContract(".preflight-scout/auth/state.json"), missionWithRole, {}))
      .rejects.toThrow(/traverses symbolic link/);
  });

  it("rejects contract-derived paths that Git cannot prove are ignored and untracked", async () => {
    const missionWithRole = [{ ...flow("auth"), role: "qa_user" }];
    await writeFile(path.join(root, ".gitignore"), "", "utf8");
    await expect(resolveStorageOptions(root, storageContract(".preflight-scout/auth/unignored.json"), missionWithRole, {}))
      .rejects.toThrow(/not ignored by Git/);

    await writeFile(path.join(root, ".gitignore"), ".preflight-scout/auth/\n", "utf8");
    await writeFile(path.join(root, ".preflight-scout", "auth", "tracked.json"), "{}\n", "utf8");
    await execFileAsync("git", ["add", "--force", ".preflight-scout/auth/tracked.json"], { cwd: root });
    await expect(resolveStorageOptions(root, storageContract(".preflight-scout/auth/tracked.json"), missionWithRole, {}))
      .rejects.toThrow(/tracked by Git/);
  });

  it("fails closed when the repository is not a verifiable Git worktree", async () => {
    await rm(path.join(root, ".git"), { recursive: true, force: true });

    await expect(resolveStorageOptions(
      root,
      storageContract(".preflight-scout/auth/state.json"),
      [{ ...flow("auth"), role: "qa_user" }],
      {}
    )).rejects.toThrow(/Git could not verify that the path belongs to a worktree/);
  });
});

function mission(): QAMission {
  return {
    id: "qa",
    title: "QA mission",
    risk: "medium",
    summary: "Test mission",
    affectedAreas: [],
    manualChecklist: [],
    edgeCases: [],
    automationCandidates: ["first", "second", "third"].map(flow),
    unknowns: []
  };
}

function flow(id: string): QAFlowMission {
  return {
    id,
    title: id,
    risk: "medium",
    reason: [],
    steps: []
  };
}

function storageContract(storageState: string): QAContract {
  return {
    ...emptyContract(),
    auth: {
      roles: {
        qa_user: { storageState }
      }
    }
  };
}

function emptyContract(): QAContract {
  return {
    app: {},
    criticalFlows: [],
    sensitiveAreas: [],
    dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
    testData: {},
    unknowns: []
  };
}
