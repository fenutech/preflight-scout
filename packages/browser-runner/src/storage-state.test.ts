import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeStorageStatePath, validateStorageStateInput, writeStorageStateMetadata } from "./storage-state.js";

describe("storage-state safety", () => {
  let dir: string;
  let storagePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-storage-state-"));
    storagePath = path.join(dir, "qa-user.json");
    await writeFile(storagePath, '{"cookies":[],"origins":[]}\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a bounded regular Playwright storage-state file", async () => {
    await expect(validateStorageStateInput(storagePath)).resolves.toBeUndefined();
  });

  it("fails closed when an invalid-state sidecar is malformed", async () => {
    await writeFile(`${storagePath}.preflight-scout.json`, '{"status":"invalid"');

    await expect(validateStorageStateInput(storagePath)).resolves.toContain("metadata");
    await expect(validateStorageStateInput(storagePath)).resolves.toContain("malformed");
  });

  it("rejects sidecars with an unknown status instead of treating them as valid", async () => {
    await writeFile(`${storagePath}.preflight-scout.json`, JSON.stringify({ status: "unknown", savedAt: new Date().toISOString() }));

    await expect(validateStorageStateInput(storagePath)).resolves.toContain("malformed");
  });

  it.skipIf(process.platform === "win32")("refuses a sidecar symlink without overwriting its target", async () => {
    const external = path.join(dir, "external.txt");
    await writeFile(external, "do-not-overwrite\n");
    await symlink(external, `${storagePath}.preflight-scout.json`);

    await expect(writeStorageStateMetadata(storagePath, {
      status: "invalid",
      savedAt: new Date().toISOString(),
      reason: "blocked"
    })).rejects.toThrow("non-regular file");

    expect(await readFile(external, "utf8")).toBe("do-not-overwrite\n");
    expect((await lstat(`${storagePath}.preflight-scout.json`)).isSymbolicLink()).toBe(true);
  });

  it("supports consecutive atomic metadata writes with private permissions", async () => {
    await writeStorageStateMetadata(storagePath, {
      status: "invalid",
      savedAt: new Date().toISOString(),
      reason: "first"
    });
    await writeStorageStateMetadata(storagePath, {
      status: "valid",
      savedAt: new Date().toISOString()
    });

    expect(await readFile(`${storagePath}.preflight-scout.json`, "utf8")).toContain('"status": "valid"');
    expect((await lstat(`${storagePath}.preflight-scout.json`)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect((await lstat(`${storagePath}.preflight-scout.json`)).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === "win32")("rejects symlinked storage-state inputs", async () => {
    const external = path.join(dir, "external-state.json");
    const linked = path.join(dir, "linked-state.json");
    await writeFile(external, '{"cookies":[],"origins":[]}\n');
    await symlink(external, linked);

    await expect(validateStorageStateInput(linked)).resolves.toContain("Symlinks");
  });

  it.skipIf(process.platform === "win32")("canonicalizes an explicit symlinked parent before safe reads and writes", async () => {
    const realParent = path.join(dir, "canonical-parent");
    const linkedParent = path.join(dir, "linked-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent, "dir");
    const linkedStorage = path.join(linkedParent, "session.json");
    const canonicalStorage = path.join(realParent, "session.json");
    await writeFile(canonicalStorage, '{"cookies":[],"origins":[]}\n');

    await expect(canonicalizeStorageStatePath(linkedStorage)).resolves.toBe(canonicalStorage);
    await expect(validateStorageStateInput(linkedStorage)).resolves.toBeUndefined();
    await writeStorageStateMetadata(linkedStorage, { status: "valid", savedAt: new Date().toISOString() });
    await expect(readFile(`${canonicalStorage}.preflight-scout.json`, "utf8")).resolves.toContain('"status": "valid"');
  });
});
