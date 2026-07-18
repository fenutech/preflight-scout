import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRequiredUnknown,
  createImpactMap,
  INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN,
  MAX_IMPACT_PROMPT_CHARS
} from "./impact-mapper.js";
import type { LLMClient, LLMMessage, StructuredJsonOptions } from "./llm.js";
import { indexRepository } from "./repo-indexer.js";
import type { ImpactMap, PullRequestContext, QAContract, RepoIndex } from "./types.js";

describe("impact prompt budgets", () => {
  it("bounds large repository and changed-file context with transparent coverage markers", async () => {
    const llm = new CapturingImpactLLM();
    const repoIndex: RepoIndex = {
      root: ".",
      files: Array.from({ length: 3000 }, (_, index) => `packages/area-${index}/${"segment-".repeat(20)}file.ts`),
      manifests: { "package.json": JSON.stringify({ name: "large-repo" }) },
      packageManager: "pnpm",
      frameworks: ["test-framework"],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: []
    };
    const pullRequest: PullRequestContext = {
      base: "a".repeat(40),
      head: "b".repeat(40),
      files: Array.from({ length: 300 }, (_, index) => ({
        path: `src/feature-${index}.ts`,
        status: "modified" as const,
        additions: 100,
        deletions: 50,
        patch: "p".repeat(12_000),
        content: "c".repeat(20_000),
        contextStatus: "included" as const
      })),
      contextCoverage: {
        totalFiles: 300,
        filesWithContext: 100,
        omittedFiles: 200,
        contextChars: 500_000,
        maxContextFiles: 100,
        maxContextChars: 512 * 1024,
        complete: false,
        note: "Source context is incomplete."
      }
    };

    await createImpactMap({ repoIndex, contract, pullRequest, llm });

    const userMessage = llm.messages.find((message) => message.role === "user")?.content ?? "";
    const totalPromptChars = llm.messages.reduce((total, message) => total + message.content.length, 0);
    const payload = JSON.parse(userMessage) as any;
    expect(totalPromptChars).toBeLessThanOrEqual(MAX_IMPACT_PROMPT_CHARS);
    expect(payload.pullRequest.files.length).toBeLessThan(pullRequest.files.length);
    expect(payload.pullRequest.promptCoverage).toMatchObject({ complete: false, totalChangedFiles: 300 });
    expect(payload.pullRequest.promptCoverage.omittedChangedFiles).toBeGreaterThan(0);
    expect(payload.pullRequest.contextCoverage.complete).toBe(false);
    expect(payload.repositoryInventory.promptCoverage.complete).toBe(false);
    expect(payload.repositoryInventory.promptCoverage.omittedEntries).toBeGreaterThan(0);
    expect(payload).not.toHaveProperty("repoIndex");
    expect(llm.messages.find((message) => message.role === "system")?.content).toContain("mean unclassified, not absent");
  });

  it.skipIf(process.platform === "win32")("never sends a hard-linked manifest outside the target repo to the LLM", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-hardlink-prompt-"));
    const repo = path.join(tempRoot, "repo");
    const sentinel = "outside-hardlink-secret-must-not-reach-llm";
    try {
      await mkdir(repo);
      const outside = path.join(tempRoot, "outside-secret.txt");
      await writeFile(outside, sentinel, "utf8");
      await link(outside, path.join(repo, "README.md"));
      await writeFile(path.join(repo, "src.ts"), "export {};\n", "utf8");

      const repoIndex = await indexRepository(repo);
      const llm = new CapturingImpactLLM();
      await createImpactMap({
        repoIndex,
        contract,
        pullRequest: {
          base: "a".repeat(40),
          head: "b".repeat(40),
          files: [{ path: "src.ts", status: "modified", patch: "+export {};" }]
        },
        llm
      });

      expect(repoIndex.files).not.toContain("README.md");
      expect(llm.messages.map((message) => message.content).join("\n")).not.toContain(sentinel);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("deterministically carries incomplete repository inventory into the model context and result", async () => {
    const llm = new CapturingImpactLLM();
    const repoIndex: RepoIndex = {
      root: ".",
      files: ["src/one.ts", "src/two.ts"],
      fileInventoryCoverage: {
        maxFiles: 2,
        includedFiles: 2,
        complete: false,
        note: "Repository inventory reached the 2-file limit; additional safe files were omitted."
      },
      manifests: {},
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: []
    };

    const result = await createImpactMap({
      repoIndex,
      contract,
      pullRequest: { files: [] },
      llm
    });

    const payload = JSON.parse(llm.messages.find((message) => message.role === "user")?.content ?? "{}") as any;
    expect(payload.repositoryInventory.fileInventoryCoverage).toMatchObject({ complete: false, maxFiles: 2 });
    expect(result.unknowns).toContain(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  });

  it("treats missing inventory coverage as explicitly unknown and non-exhaustive", async () => {
    const llm = new CapturingImpactLLM([]);
    const repoIndex: RepoIndex = {
      root: ".",
      files: ["src/one.ts"],
      manifests: {},
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: []
    };

    const result = await createImpactMap({ repoIndex, contract, pullRequest: { files: [] }, llm });

    const payload = JSON.parse(llm.messages.find((message) => message.role === "user")?.content ?? "{}") as any;
    expect(payload.repositoryInventory.fileInventoryCoverage).toMatchObject({
      state: "unknown",
      complete: false,
      includedFiles: 1
    });
    expect(payload.repositoryInventory.fileInventoryCoverage.note).toContain("metadata is unavailable");
    expect(payload.repositoryInventory.fileInventoryCoverage).not.toHaveProperty("maxFiles");
    expect(result.unknowns).toContain(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  });

  it("redacts and bounds inventory coverage notes before the impact prompt", async () => {
    const llm = new CapturingImpactLLM([]);
    const root = "/Users/alice/Customers/acme-private-app";
    const secret = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const repoIndex: RepoIndex = {
      root,
      files: ["src/one.ts"],
      fileInventoryCoverage: {
        maxFiles: 1,
        includedFiles: 1,
        complete: false,
        note: `root=${root}; token=${secret}; ${"detail ".repeat(400)}`
      },
      manifests: {},
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: []
    };

    await createImpactMap({ repoIndex, contract, pullRequest: { files: [] }, llm });

    const prompt = llm.messages.map((message) => message.content).join("\n");
    const payload = JSON.parse(llm.messages.find((message) => message.role === "user")?.content ?? "{}") as any;
    expect(prompt).not.toContain(root);
    expect(prompt).not.toContain(secret);
    expect(payload.repositoryInventory.fileInventoryCoverage.note).toContain("[REDACTED_REPO_ROOT]");
    expect(payload.repositoryInventory.fileInventoryCoverage.note).toContain("[REDACTED_SECRET]");
    expect(payload.repositoryInventory.fileInventoryCoverage.note.length).toBeLessThanOrEqual(1024);
  });

  it("reserves schema space for deterministic inventory coverage", async () => {
    const llm = new CapturingImpactLLM(Array.from({ length: 200 }, (_, index) => `provider unknown ${index}`));
    const repoIndex: RepoIndex = {
      root: ".",
      files: [],
      fileInventoryCoverage: { maxFiles: 0, includedFiles: 0, complete: false },
      manifests: {},
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: []
    };

    const result = await createImpactMap({ repoIndex, contract, pullRequest: { files: [] }, llm });

    expect(result.unknowns).toHaveLength(200);
    expect(result.unknowns).toContain(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  });

  it("preserves a required unknown even when it originally appears beyond the limit", () => {
    const unknowns = [
      ...Array.from({ length: 200 }, (_, index) => `provider unknown ${index}`),
      INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN
    ];

    const result = appendRequiredUnknown(unknowns, INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN, 200);

    expect(result).toHaveLength(200);
    expect(result.at(-1)).toBe(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  });
});

const contract: QAContract = {
  app: { localUrl: "http://127.0.0.1:4173" },
  criticalFlows: ["checkout"],
  sensitiveAreas: ["payments"],
  dangerousActions: { allowed: ["navigate"], requireApproval: [], forbidden: ["real_payment"] },
  testData: {},
  unknowns: []
};

class CapturingImpactLLM implements LLMClient {
  messages: LLMMessage[] = [];

  constructor(private readonly unknowns = ["Changed-file and repository context was truncated by the prompt budget."]) {}

  async completeJson<T>(messages: LLMMessage[], _options: StructuredJsonOptions<T>): Promise<T> {
    this.messages = messages;
    return {
      summary: "Large change with incomplete prompt coverage.",
      risk: "high",
      changedFiles: [],
      affectedRoutes: [],
      affectedAreas: [],
      suggestedRoles: [],
      unknowns: this.unknowns
    } as ImpactMap as T;
  }
}
