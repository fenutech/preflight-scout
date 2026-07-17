import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepository } from "./repo-indexer.js";

describe("indexRepository", () => {
  const repositories: string[] = [];

  afterEach(async () => {
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

  it("marks an inventory at the file limit as complete", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "preflight-scout-repo-index-"));
    repositories.push(repository);
    await writeFile(path.join(repository, "one.ts"), "export {};\n");
    await writeFile(path.join(repository, "two.ts"), "export {};\n");

    const index = await indexRepository(repository, { maxFiles: 2 });

    expect(index.files).toEqual(["one.ts", "two.ts"]);
    expect(index.fileInventoryCoverage).toEqual({
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
