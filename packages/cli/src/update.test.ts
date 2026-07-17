import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_UPDATE_RESPONSE_BYTES,
  OFFICIAL_NPM_DIST_TAGS_URL,
  UPDATE_CHECK_TIMEOUT_MS,
  buildUpdateInstructions,
  checkForUpdates,
  renderUpdateCheck
} from "./update.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = path.join(repoRoot, "packages", "cli", "src", "index.ts");

describe("update check", () => {
  it("checks only the fixed official registry endpoint with bounded redirect-safe options", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ latest: "0.1.0" }));

    const result = await checkForUpdates({ cliVersion: "0.1.0", skillVersion: "0.1.0", fetchImpl });

    expect(result).toMatchObject({
      cliVersion: "0.1.0",
      skillVersion: "0.1.0",
      skillCompatibility: "compatible",
      compatible: true,
      registry: { status: "current", latestVersion: "0.1.0" },
      mutated: false
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(OFFICIAL_NPM_DIST_TAGS_URL, expect.objectContaining({
      method: "GET",
      redirect: "error",
      signal: expect.any(AbortSignal)
    }));
  });

  it("bounds the production check at three seconds and reports timeout without failing compatibility", async () => {
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(3000);
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      skillVersion: "0.1.0",
      fetchImpl,
      timeoutMs: 5
    });

    expect(result.compatible).toBe(true);
    expect(result.registry).toMatchObject({
      status: "unavailable",
      message: "unavailable (official npm registry check timed out after 5ms)"
    });
  });

  it("reports an available update with exact pinned CLI, Codex, and Claude commands", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      skillVersion: "0.1.0",
      fetchImpl: async () => jsonResponse({ latest: "0.1.1" })
    });
    const rendered = renderUpdateCheck(result);

    expect(result.registry).toMatchObject({ status: "update-available", latestVersion: "0.1.1" });
    expect(rendered).toContain("npm install --global @preflight-scout/cli@0.1.1 --registry=https://registry.npmjs.org/");
    expect(rendered).toContain("codex plugin marketplace upgrade preflight-scout");
    expect(rendered).toContain("codex plugin list --marketplace preflight-scout");
    expect(rendered).toContain("claude plugin marketplace update preflight-scout");
    expect(rendered).toContain("claude plugin update preflight-scout@preflight-scout");
    expect(rendered).toContain("No changes were made.");
  });

  it("marks a skill mismatch incompatible even when the registry is unavailable", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      skillVersion: "0.1.1",
      fetchImpl: async () => {
        throw new Error("proxy credentials and local paths must not be echoed");
      }
    });

    expect(result).toMatchObject({
      skillCompatibility: "incompatible",
      compatible: false,
      registry: { status: "unavailable", message: "unavailable (could not reach the official npm registry)" }
    });
    expect(renderUpdateCheck(result)).not.toContain("proxy credentials");
  });

  it("does not suggest an unsafe marketplace refresh when the skill is ahead of the published CLI", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      skillVersion: "0.1.1",
      fetchImpl: async () => jsonResponse({ latest: "0.1.0" })
    });
    const rendered = renderUpdateCheck(result);

    expect(result.compatible).toBe(false);
    expect(result.instructions).toBeUndefined();
    expect(rendered).toContain("Agent Skill is newer than the latest published CLI");
    expect(rendered).toContain("No matching published release is available");
    expect(rendered).toContain("one trusted source release");
    expect(rendered).not.toContain("npm install --global");
    expect(rendered).not.toContain("codex plugin marketplace upgrade");
    expect(rendered).not.toContain("claude plugin update");
  });

  it("suggests only a plugin refresh when the skill is older than the current published CLI", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.1.1",
      skillVersion: "0.1.0",
      fetchImpl: async () => jsonResponse({ latest: "0.1.1" })
    });
    const rendered = renderUpdateCheck(result);

    expect(result.instructions?.cli).toBeUndefined();
    expect(result.instructions?.codex).toContain("codex plugin marketplace upgrade preflight-scout");
    expect(result.instructions?.claude).toContain("claude plugin update preflight-scout@preflight-scout");
    expect(rendered).not.toContain("npm install --global");
  });

  it("keeps registry failure nonblocking when the supplied skill matches", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      skillVersion: "0.1.0",
      fetchImpl: async () => {
        throw new Error("offline");
      }
    });

    expect(result.compatible).toBe(true);
    expect(result.registry.status).toBe("unavailable");
  });

  it.each([
    ["invalid JSON", new Response("not json", { status: 200 }), "invalid JSON"],
    ["invalid metadata", jsonResponse({ latest: "latest" }), "invalid dist-tag metadata"],
    ["HTTP failure", new Response("ignored secret response", { status: 503 }), "HTTP 503"],
    ["oversized body", new Response("x".repeat(MAX_UPDATE_RESPONSE_BYTES + 1), { status: 200 }), "exceeded"]
  ])("reports %s without throwing or exposing response bodies", async (_label, response, expected) => {
    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      fetchImpl: async () => response
    });

    expect(result.registry.status).toBe("unavailable");
    expect(result.registry.message).toContain(expected);
    expect(result.registry.message).not.toContain("secret response");
  });

  it("does not suggest downgrading a source build newer than the registry", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.2.0-beta.2",
      fetchImpl: async () => jsonResponse({ latest: "0.1.9" })
    });
    const rendered = renderUpdateCheck(result);

    expect(result.registry.status).toBe("newer-than-registry");
    expect(rendered).toContain("no downgrade suggested");
    expect(rendered).not.toContain("npm install --global");
  });

  it("rejects malformed skill versions as incompatible without trusting them as commands", async () => {
    const result = await checkForUpdates({
      cliVersion: "0.1.0",
      skillVersion: "0.1.0; npm publish",
      fetchImpl: async () => jsonResponse({ latest: "0.1.0" })
    });

    expect(result.compatible).toBe(false);
    expect(result.skillVersion).toBe("invalid");
    expect(result.instructions).toBeUndefined();
    expect(renderUpdateCheck(result)).not.toContain("npm publish");
  });

  it("builds only semantic-version-pinned instructions", () => {
    expect(buildUpdateInstructions("0.1.1").cli?.[0]).toContain("@preflight-scout/cli@0.1.1");
    expect(() => buildUpdateInstructions("latest")).toThrow("exact semantic version");
  });

  it("exposes the read-only command and compatibility options in CLI help", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cliPath, "update-check", "--help"], {
      cwd: repoRoot,
      env: { ...process.env, PREFLIGHT_SCOUT_LLM_PROVIDER: "none" }
    });

    expect(stdout).toContain("without changing installed software");
    expect(stdout).toContain("--skill-version <version>");
    expect(stdout).toContain("--json");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
