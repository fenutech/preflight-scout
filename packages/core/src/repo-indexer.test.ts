import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexRepository } from "./repo-indexer.js";

describe("indexRepository", () => {
  const repositories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(repositories.splice(0).map((repository) =>
      rm(repository, { recursive: true, force: true })
    ));
  });

  it("omits oversized advisory manifests without aborting repository indexing", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "preflight-scout-repo-index-"));
    repositories.push(repository);
    await writeFile(path.join(repository, "package.json"), '{"name":"fixture"}\n');
    await writeFile(path.join(repository, "pnpm-lock.yaml"), "x".repeat(64 * 1024 + 1));

    const index = await indexRepository(repository);

    expect(index.packageManager).toBe("pnpm");
    expect(index.files).toContain("pnpm-lock.yaml");
    expect(index.manifests["package.json"]).toContain('"fixture"');
    expect(index.manifests).not.toHaveProperty("pnpm-lock.yaml");
  });

  it("indexes more than the former 5000-file ceiling without dropping root manifests", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "preflight-scout-large-index-"));
    repositories.push(repository);
    await mkdir(path.join(repository, "a-source"));
    for (let start = 0; start < 5001; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 5001 - start) }, (_, index) =>
        writeFile(path.join(repository, "a-source", `file-${start + index}.ts`), "export {};")));
    }
    await writeFile(path.join(repository, "package.json"), '{"name":"large-fixture"}');
    await writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const index = await indexRepository(repository);
    expect(index.files).toHaveLength(5003);
    expect(index.fileInventoryCoverage).toMatchObject({ complete: true, maxFiles: 50000 });
    const capped = await indexRepository(repository, { maxFiles: 2 });
    expect(capped.files).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(capped.manifests["package.json"]).toContain("large-fixture");
    expect(capped.packageManager).toBe("pnpm");
    expect(capped.fileInventoryCoverage?.complete).toBe(false);
  }, 20000);

  it("honors and validates the trusted environment inventory limit", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "preflight-scout-index-env-"));
    repositories.push(repository);
    await writeFile(path.join(repository, "one.ts"), "export {};");
    await writeFile(path.join(repository, "two.ts"), "export {};");
    vi.stubEnv("PREFLIGHT_SCOUT_MAX_REPO_FILES", "1");
    expect((await indexRepository(repository)).fileInventoryCoverage).toMatchObject({ maxFiles: 1, complete: false });
    expect((await indexRepository(repository, { maxFiles: 2 })).fileInventoryCoverage?.complete).toBe(true);
    for (const invalid of ["", "0", "-1", "1.5", "Infinity", "250001", "1e4"]) {
      vi.stubEnv("PREFLIGHT_SCOUT_MAX_REPO_FILES", invalid);
      await expect(indexRepository(repository)).rejects.toThrow("PREFLIGHT_SCOUT_MAX_REPO_FILES must be an integer");
    }
  });

  it("marks an inventory at the file limit as complete", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "preflight-scout-repo-index-"));
    repositories.push(repository);
    await writeFile(path.join(repository, "one.ts"), "export {};\n");
    await writeFile(path.join(repository, "two.ts"), "export {};\n");

    const index = await indexRepository(repository, { maxFiles: 2 });

    expect(index.files).toEqual(["one.ts", "two.ts"]);
    expect(index.fileInventoryCoverage).toEqual({
      state: "known",
      complete: true,
      includedFiles: 2,
      maxFiles: 2
    });
  });

  it("marks an inventory beyond the file limit as incomplete", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "preflight-scout-repo-index-"));
    repositories.push(repository);
    await writeFile(path.join(repository, "one.ts"), "export {};\n");
    await writeFile(path.join(repository, "two.ts"), "export {};\n");
    await writeFile(path.join(repository, "three.ts"), "export {};\n");

    const index = await indexRepository(repository, { maxFiles: 2 });

    expect(index.files).toEqual(["one.ts", "three.ts"]);
    expect(index.fileInventoryCoverage).toMatchObject({
      complete: false,
      includedFiles: 2,
      maxFiles: 2
    });
    expect(index.fileInventoryCoverage.note).toContain("additional safe files were omitted");
  });
});
