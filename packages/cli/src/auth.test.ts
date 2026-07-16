import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QAContract } from "@preflight-scout/core";
import { buildAuthLoginMission, resolveAuthStorageStatePath } from "./auth.js";

const execFileAsync = promisify(execFile);

const contract: QAContract = {
  app: { localUrl: "http://127.0.0.1:3000" },
  auth: {
    loginUrl: "/sign-in",
    roles: {
      admin_user: {
        usernameEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL",
        passwordEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_PASSWORD",
        storageState: ".preflight-scout/auth/admin.json",
        signedInTarget: "testid=admin-user-menu"
      }
    }
  },
  criticalFlows: [],
  sensitiveAreas: [],
  dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
  testData: {},
  unknowns: []
};

describe("auth login helpers", () => {
  it("builds a generic LLM-owned login mission from config", () => {
    const mission = buildAuthLoginMission(contract, { role: "admin_user" });

    expect(mission.id).toBe("auth-login-admin_user");
    expect(mission.role).toBe("admin_user");
    expect(mission.startPath).toBe("/sign-in");
    expect(mission.steps[0]?.policyLabel).toBe("login");
    expect(mission.steps[0]?.instruction).toContain("only from the reviewed mission startPath");
    expect(mission.steps[1]).toMatchObject({
      id: "confirm-signed-in-marker",
      action: "assert_visible",
      target: "testid=admin-user-menu"
    });
    expect(mission.reason.join("\n")).toContain("PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL");
    expect(mission.reason.join("\n")).toContain("existing-user");
  });

  it("uses an explicit login start path only when provided", () => {
    const mission = buildAuthLoginMission(contract, { role: "admin_user", startPath: "/sign-in" });

    expect(mission.startPath).toBe("/sign-in");
  });

  it("fails closed when the role has no deterministic signed-in marker", () => {
    const missingMarker: QAContract = {
      ...contract,
      auth: {
        ...contract.auth,
        roles: { admin_user: { usernameEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL" } }
      }
    };

    expect(() => buildAuthLoginMission(missingMarker, { role: "admin_user" }))
      .toThrow(/signedInTarget/);
  });
});

describe("resolveAuthStorageStatePath", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "preflight-scout-auth-storage-"));
    outside = await mkdtemp(path.join(tmpdir(), "preflight-scout-auth-outside-"));
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

  it("resolves ignored, untracked role config and generated default paths", async () => {
    await expect(resolveAuthStorageStatePath(root, contract, { role: "admin_user" }))
      .resolves.toBe(path.join(root, ".preflight-scout/auth/admin.json"));
    await expect(resolveAuthStorageStatePath(root, { ...contract, auth: undefined }, { role: "QA User" }))
      .resolves.toBe(path.join(root, ".preflight-scout/auth/qa_user.json"));
  });

  it("keeps an explicit auth login output path trusted", async () => {
    const explicitOutsidePath = path.join(outside, "override.json");

    await expect(resolveAuthStorageStatePath(root, contract, {
      role: "admin_user",
      saveStorageState: explicitOutsidePath
    })).resolves.toBe(explicitOutsidePath);
  });

  it("rejects unsafe configured auth login paths", async () => {
    const unsafeContract: QAContract = {
      ...contract,
      auth: {
        roles: {
          admin_user: {
            storageState: "../outside.json"
          }
        }
      }
    };

    await expect(resolveAuthStorageStatePath(root, unsafeContract, { role: "admin_user" }))
      .rejects.toThrow(/beneath .*\.preflight-scout.*auth/);
  });

  it("rejects a generated auth login default when Git does not ignore it", async () => {
    await writeFile(path.join(root, ".gitignore"), "", "utf8");

    await expect(resolveAuthStorageStatePath(root, { ...contract, auth: undefined }, { role: "QA User" }))
      .rejects.toThrow(/not ignored by Git/);
  });
});
