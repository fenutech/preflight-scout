import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTRACT, indexRepository, loadContract, resolveTargetUrl, writeInitialContract, type LLMMessage, type QAContract } from "./index.js";

const contract: QAContract = {
  app: {
    localUrl: "http://127.0.0.1:3000",
    stagingUrl: "https://staging.example.com",
    targets: {
      frontend: {
        localUrl: "http://127.0.0.1:3000",
        stagingUrl: "https://frontend-staging.example.com"
      },
      admin: {
        localUrl: "http://127.0.0.1:3001"
      }
    }
  },
  criticalFlows: [],
  sensitiveAreas: [],
  dangerousActions: {
    allowed: [],
    requireApproval: [],
    forbidden: []
  },
  testData: {},
  unknowns: []
};
const pristineExportedDefault = structuredClone(DEFAULT_CONTRACT);

describe("resolveTargetUrl", () => {
  it("prefers an explicit URL", () => {
    expect(resolveTargetUrl(contract, { url: "https://preview.example.com" })).toBe("https://preview.example.com");
  });

  it("can select local or staging URLs from the QA contract", () => {
    expect(resolveTargetUrl(contract, { env: "local" })).toBe("http://127.0.0.1:3000");
    expect(resolveTargetUrl(contract, { env: "staging" })).toBe("https://staging.example.com");
  });

  it("can select named app targets from the QA contract", () => {
    expect(resolveTargetUrl(contract, { target: "frontend", env: "staging" })).toBe("https://frontend-staging.example.com");
    expect(resolveTargetUrl(contract, { target: "admin", env: "local" })).toBe("http://127.0.0.1:3001");
  });

  it("fails closed when an explicit local environment is unavailable", () => {
    expect(() => resolveTargetUrl({ ...contract, app: { stagingUrl: "https://staging.example.com" } }, { env: "local" }))
      .toThrow("No local app URL configured");
    expect(() => resolveTargetUrl(contract, { target: "frontend", env: "local" }))
      .not.toThrow();
    expect(() => resolveTargetUrl({
      ...contract,
      app: { targets: { stagingOnly: { stagingUrl: "https://staging.example.com" } } }
    }, { target: "stagingOnly", env: "local" })).toThrow("No local app URL configured");
  });

  it("fails closed when an explicit staging environment is unavailable", () => {
    expect(() => resolveTargetUrl(contract, { target: "admin", env: "staging" }))
      .toThrow("No staging app URL configured");
    expect(() => resolveTargetUrl({ ...contract, app: { localUrl: "http://127.0.0.1:3000" } }, { env: "staging" }))
      .toThrow("No staging app URL configured");
    expect(() => resolveTargetUrl({ ...contract, app: { url: "https://default.example.com" } }, { env: "staging" }))
      .toThrow("No staging app URL configured");
  });

  it("retains cross-environment fallback only for automatic selection", () => {
    expect(resolveTargetUrl({ ...contract, app: { stagingUrl: "https://staging.example.com" } }, { env: "auto" }))
      .toBe("https://staging.example.com");
    expect(resolveTargetUrl({ ...contract, app: { localUrl: "http://127.0.0.1:3000" } }, { env: "auto" }))
      .toBe("http://127.0.0.1:3000");
  });

  it("uses the generic app URL environment variable only for automatic selection", () => {
    const previous = process.env.PREFLIGHT_SCOUT_APP_URL;
    process.env.PREFLIGHT_SCOUT_APP_URL = "https://generic.example.com";
    try {
      expect(resolveTargetUrl({ ...contract, app: { localUrl: "http://127.0.0.1:3000" } }, { env: "local" }))
        .toBe("http://127.0.0.1:3000");
      expect(() => resolveTargetUrl({ ...contract, app: { localUrl: "http://127.0.0.1:3000" } }, { env: "staging" }))
        .toThrow("No staging app URL configured");
      expect(resolveTargetUrl({ ...contract, app: {} }, { env: "auto" }))
        .toBe("https://generic.example.com");
    } finally {
      if (previous === undefined) delete process.env.PREFLIGHT_SCOUT_APP_URL;
      else process.env.PREFLIGHT_SCOUT_APP_URL = previous;
    }
  });

  it("validates environment names before applying direct URL overrides", () => {
    expect(() => resolveTargetUrl(contract, { url: "https://preview.example.com", env: "production" }))
      .toThrow("Invalid target environment");
    expect(resolveTargetUrl(contract, { url: "https://preview.example.com", env: "staging" }))
      .toBe("https://preview.example.com");
  });

  it("rejects unknown named app targets", () => {
    expect(() => resolveTargetUrl(contract, { target: "mobile", env: "local" })).toThrow("App target");
  });

  it("rejects invalid target environments", () => {
    expect(() => resolveTargetUrl(contract, { env: "production" })).toThrow("Invalid target environment");
  });

  it("fails closed when no target URL exists", () => {
    expect(() => resolveTargetUrl({ ...contract, app: {} })).toThrow("No app URL configured");
  });

  it.each([
    "file:///tmp/private",
    "data:text/plain,private",
    "javascript:alert(1)",
    "https://user:password@example.invalid/private",
    "/relative-only"
  ])("rejects an unsafe app URL before it reaches an execution surface: %s", (url) => {
    expect(() => resolveTargetUrl(contract, { url })).toThrow(/App URL must/);
  });

  it("rejects oversized app URLs before execution", () => {
    expect(() => resolveTargetUrl(contract, { url: `https://example.test/${"x".repeat(5000)}` })).toThrow(
      "4096-character safety limit"
    );
  });
});

describe("writeInitialContract", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-contract-"));
  });

  afterEach(async () => {
    Object.assign(DEFAULT_CONTRACT, structuredClone(pristineExportedDefault));
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an independent deep copy for each no-config load", async () => {
    const first = await loadContract(dir);
    first.app.previewUrlSource = "manual";
    first.defaults!.missionLimit = 99;
    first.criticalFlows.push("poisoned flow");
    first.dangerousActions.allowed.push("poisoned action");
    first.testData.poisoned = "true";
    first.unknowns.push("poisoned unknown");

    const second = await loadContract(dir);

    expect(second).toEqual(pristineExportedDefault);
    expect(second).not.toBe(first);
    expect(second.defaults).not.toBe(first.defaults);
    expect(second.criticalFlows).not.toBe(first.criticalFlows);
    expect(second.dangerousActions).not.toBe(first.dangerousActions);
    expect(second.dangerousActions.allowed).not.toBe(first.dangerousActions.allowed);
    expect(second.testData).not.toBe(first.testData);
  });

  it("isolates runtime and init defaults from nested mutations of the public compatibility object", async () => {
    expect(Object.isFrozen(DEFAULT_CONTRACT)).toBe(false);
    DEFAULT_CONTRACT.app.previewUrlSource = "manual";
    DEFAULT_CONTRACT.defaults!.outputDir = ".preflight-scout/runs/export-poison";
    DEFAULT_CONTRACT.defaults!.missionLimit = 99;
    DEFAULT_CONTRACT.criticalFlows.push("export-poisoned flow");
    DEFAULT_CONTRACT.dangerousActions.allowed.push("export-poisoned action");
    DEFAULT_CONTRACT.testData.poisoned = "true";

    const loaded = await loadContract(dir);
    expect(loaded).toEqual(pristineExportedDefault);

    const repoIndex = await indexRepository(dir);
    const written = await writeInitialContract(dir, repoIndex, undefined, {
      appUrl: "http://127.0.0.1:3000",
      targetEnv: "local"
    });

    expect(written.defaults?.outputDir).toBe(".preflight-scout/runs/latest");
    expect(written.defaults?.missionLimit).toBe(2);
    expect(written.criticalFlows).not.toContain("export-poisoned flow");
    expect(written.dangerousActions.allowed).not.toContain("export-poisoned action");
    expect(written.testData).not.toHaveProperty("poisoned");
  });

  it("returns fresh default-derived structures for repeated partial-config loads", async () => {
    await mkdir(path.join(dir, ".preflight-scout"), { recursive: true });
    await writeFile(path.join(dir, ".preflight-scout", "config.yml"), "app:\n  name: fixture\n");

    const first = await loadContract(dir);
    first.defaults!.missionLimit = 99;
    first.criticalFlows.push("partial-poisoned flow");
    first.dangerousActions.allowed.push("partial-poisoned action");
    first.testData.poisoned = "true";
    first.unknowns.push("partial-poisoned unknown");

    const second = await loadContract(dir);

    expect(second.app.name).toBe("fixture");
    expect(second.defaults?.missionLimit).toBe(2);
    expect(second.criticalFlows).not.toContain("partial-poisoned flow");
    expect(second.dangerousActions.allowed).not.toContain("partial-poisoned action");
    expect(second.testData).not.toHaveProperty("poisoned");
    expect(second.unknowns).not.toContain("partial-poisoned unknown");
    expect(second.defaults).not.toBe(first.defaults);
    expect(second.dangerousActions.allowed).not.toBe(first.dangerousActions.allowed);
  });

  it("writes config defaults, auth env names, and an env example from explicit init facts", async () => {
    const repoIndex = await indexRepository(dir);
    const written = await writeInitialContract(dir, repoIndex, undefined, {
      localUrl: "http://127.0.0.1:3000",
      target: "frontend",
      baseRef: "origin/main",
      targetEnv: "local",
      role: "admin",
      usernameEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL",
      passwordEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_PASSWORD",
      saveStorageState: ".preflight-scout/auth/admin.json"
    });

    const loaded = await loadContract(dir);
    const context = await readFile(path.join(dir, ".preflight-scout", "context.md"), "utf8");
    const envExample = await readFile(path.join(dir, ".env.preflight-scout.example"), "utf8");
    const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");

    expect(written.defaults?.baseRef).toBe("origin/main");
    expect(written.defaults?.target).toBe("frontend");
    expect(loaded.app.targets?.frontend?.localUrl).toBe("http://127.0.0.1:3000");
    expect(loaded.defaults?.targetEnv).toBe("local");
    expect(loaded.auth?.roles?.admin?.usernameEnv).toBe("PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL");
    expect(loaded.auth?.roles?.admin?.storageState).toBe(".preflight-scout/auth/admin.json");
    expect(loaded.auth?.saveStorageState).toBe(".preflight-scout/auth/admin.json");
    expect(context).toContain("## Repository Inventory");
    expect(context).toContain("File inventory coverage: complete");
    expect(context).toContain("empty\nclassification field means unclassified, not absent");
    expect(context).not.toContain("## Detected Stack");
    expect(context).not.toContain("none detected");
    expect(envExample).toContain("PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL=");
    expect(envExample).toContain("PREFLIGHT_SCOUT_BROWSER_ADMIN_PASSWORD=");
    expect(envExample).toContain("OPENAI_API_KEY=");
    expect(envExample).toContain("PREFLIGHT_SCOUT_APP_URL=");
    expect(envExample).toContain("# export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec");
    expect(envExample.split(/\r?\n/)).not.toContain("PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec");
    expect(envExample.split(/\r?\n/)).not.toContain("PREFLIGHT_SCOUT_MODEL=");
    expect(envExample.split(/\r?\n/)).not.toContain("PREFLIGHT_SCOUT_EXEC_MODEL=");
    expect(gitignore).toContain(".preflight-scout/auth/");
    expect(gitignore).toContain(".preflight-scout/runs/");
    expect(gitignore).toContain(".preflight-scout/approvals.local.yml");
    expect(gitignore).toContain(".env.preflight-scout.local");
    expect(gitignore).toContain("!.env.preflight-scout.example");
  });

  it("marks an incomplete generated context as non-exhaustive", async () => {
    await writeFile(path.join(dir, "one.ts"), "export {};\n");
    await writeFile(path.join(dir, "two.ts"), "export {};\n");
    const repoIndex = await indexRepository(dir, { maxFiles: 1 });

    expect(repoIndex.fileInventoryCoverage?.complete).toBe(false);
    await writeInitialContract(dir, repoIndex);

    const context = await readFile(path.join(dir, ".preflight-scout", "context.md"), "utf8");
    expect(context).toContain("File inventory coverage: INCOMPLETE");
    expect(context).toContain("this inventory is not exhaustive");
  });

  it("renders explicit unknown inventory coverage without inventing a file limit", async () => {
    const repoIndex = await indexRepository(dir);
    repoIndex.fileInventoryCoverage = {
      state: "unknown",
      includedFiles: repoIndex.files.length,
      complete: false,
      note: "Coverage metadata is unavailable."
    };

    await writeInitialContract(dir, repoIndex);

    const context = await readFile(path.join(dir, ".preflight-scout", "context.md"), "utf8");
    expect(context).toContain("File inventory coverage: unknown");
    expect(context).toContain("do not treat this inventory as exhaustive");
    expect(context).not.toContain("undefined-file limit");
  });

  it.each([
    { targetEnv: "local" as const, url: "http://127.0.0.1:3000", field: "localUrl" as const },
    { targetEnv: "staging" as const, url: "https://staging.example.com", field: "stagingUrl" as const }
  ])("maps a generic init URL to the explicit $targetEnv environment", async ({ targetEnv, url, field }) => {
    const repoIndex = await indexRepository(dir);
    const written = await writeInitialContract(dir, repoIndex, undefined, {
      appUrl: url,
      targetEnv
    });

    expect(written.defaults?.targetEnv).toBe(targetEnv);
    expect(written.app[field]).toBe(url);
    expect(written.app.url).toBeUndefined();
    expect(resolveTargetUrl(written, { env: targetEnv })).toBe(url);
  });

  it.each([
    { targetEnv: "local" as const, url: "http://127.0.0.1:3000", field: "localUrl" as const },
    { targetEnv: "staging" as const, url: "https://frontend-staging.example.com", field: "stagingUrl" as const }
  ])("maps a generic init URL to the explicit $targetEnv environment for a named target", async ({ targetEnv, url, field }) => {
    const repoIndex = await indexRepository(dir);
    const written = await writeInitialContract(dir, repoIndex, undefined, {
      appUrl: url,
      target: "frontend",
      targetEnv
    });

    expect(written.app.targets?.frontend?.[field]).toBe(url);
    expect(written.app.targets?.frontend?.url).toBeUndefined();
    expect(resolveTargetUrl(written, { target: "frontend", env: targetEnv })).toBe(url);
  });

  it("preserves a generic init URL when an explicit environment URL is also supplied", async () => {
    const repoIndex = await indexRepository(dir);
    const written = await writeInitialContract(dir, repoIndex, undefined, {
      appUrl: "https://preview.example.com",
      localUrl: "http://127.0.0.1:3000",
      targetEnv: "local"
    });

    expect(written.app.url).toBe("https://preview.example.com");
    expect(written.app.localUrl).toBe("http://127.0.0.1:3000");
    expect(resolveTargetUrl(written, { env: "local" })).toBe("http://127.0.0.1:3000");
    expect(resolveTargetUrl(written, { env: "auto" })).toBe("http://127.0.0.1:3000");
  });

  it.each([
    { targetEnv: "local" as const, url: "http://127.0.0.1:3000", field: "localUrl" as const },
    { targetEnv: "staging" as const, url: "https://staging.example.com", field: "stagingUrl" as const }
  ])("maps --url with an LLM-selected $targetEnv and target", async ({ targetEnv, url, field }) => {
    const repoIndex = await indexRepository(dir);
    const llm = {
      async completeJson() {
        return {
          ...contract,
          app: { targets: { frontend: {} } },
          defaults: { target: "frontend", targetEnv }
        };
      }
    };

    const written = await writeInitialContract(dir, repoIndex, llm, { appUrl: url });

    expect(written.defaults?.target).toBe("frontend");
    expect(written.defaults?.targetEnv).toBe(targetEnv);
    expect(written.app.targets?.frontend?.[field]).toBe(url);
    expect(written.app.targets?.frontend?.url).toBeUndefined();
    expect(resolveTargetUrl(written)).toBe(url);
  });

  it("adds missing Preflight Scout ignore entries without duplicating existing ones", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".preflight-scout/auth/\n.env.preflight-scout.local\n");
    const repoIndex = await indexRepository(dir);

    await writeInitialContract(dir, repoIndex);

    const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore.match(/\.preflight-scout\/auth\//g)).toHaveLength(1);
    expect(gitignore).toContain(".preflight-scout/runs/");
    expect(gitignore).toContain(".preflight-scout/approvals.local.yml");
    expect(gitignore.match(/\.env\.preflight-scout\.local/g)).toHaveLength(1);
    expect(gitignore.match(/!\.env\.preflight-scout\.example/g)).toHaveLength(1);
  });

  it("does not mistake a local-env filename prefix for the required ignore entry", async () => {
    await writeFile(path.join(dir, ".gitignore"), ".env.preflight-scout.loca\n");
    const repoIndex = await indexRepository(dir);

    await writeInitialContract(dir, repoIndex);

    const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain(".env.preflight-scout.local");
  });

  it("uses an explicit auth save path as the default load path for that role", async () => {
    const repoIndex = await indexRepository(dir);
    const written = await writeInitialContract(dir, repoIndex, undefined, {
      role: "qa_user",
      usernameEnv: "PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL",
      passwordEnv: "PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD",
      saveStorageState: ".preflight-scout/auth/local-qa_user.json"
    });

    expect(written.auth?.roles?.qa_user?.storageState).toBe(".preflight-scout/auth/local-qa_user.json");
    expect(written.auth?.saveStorageState).toBe(".preflight-scout/auth/local-qa_user.json");
  });

  it("treats an explicit init role as the configured auth role set", async () => {
    const repoIndex = await indexRepository(dir);
    const llm = {
      async completeJson() {
        return {
          app: { previewUrlSource: "manual" },
          auth: {
            roles: {
              user: { usernameEnv: "PREFLIGHT_SCOUT_BROWSER_USER_EMAIL", passwordEnv: "PREFLIGHT_SCOUT_BROWSER_USER_PASSWORD" },
              admin: { usernameEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL", passwordEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_PASSWORD" }
            }
          },
          defaults: {},
          criticalFlows: ["login"],
          sensitiveAreas: ["auth"],
          dangerousActions: { allowed: ["login"], requireApproval: [], forbidden: [] },
          testData: {},
          unknowns: []
        };
      }
    };

    const written = await writeInitialContract(dir, repoIndex, llm, {
      role: "qa_user",
      usernameEnv: "PREFLIGHT_SCOUT_BROWSER_QA_EMAIL",
      passwordEnv: "PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD"
    });

    expect(Object.keys(written.auth?.roles ?? {})).toEqual(["qa_user"]);
    expect(written.auth?.roles?.qa_user?.usernameEnv).toBe("PREFLIGHT_SCOUT_BROWSER_QA_EMAIL");
  });

  it("replaces an init-model output directory with the guarded default", async () => {
    const repoIndex = await indexRepository(dir);
    const llm = {
      async completeJson() {
        return {
          ...contract,
          defaults: { outputDir: ".preflight-scout/runs" }
        };
      }
    };

    const written = await writeInitialContract(dir, repoIndex, llm);
    const loaded = await loadContract(dir);

    expect(written.defaults?.outputDir).toBe(".preflight-scout/runs/latest");
    expect(loaded.defaults?.outputDir).toBe(".preflight-scout/runs/latest");
  });

  it("preserves a human-supplied init output directory", async () => {
    const repoIndex = await indexRepository(dir);

    const written = await writeInitialContract(dir, repoIndex, undefined, {
      outputDir: ".preflight-scout/runs/reviewed"
    });

    expect(written.defaults?.outputDir).toBe(".preflight-scout/runs/reviewed");
  });

  it("sends only a redacted repository index to the init LLM", async () => {
    const secret = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");
    await writeFile(path.join(dir, "package.json"), `{\"privateToken\":\"${secret}\"}\n`);
    const repoIndex = await indexRepository(dir);
    repoIndex.files.push(".env.customer-alice", ".preflight-scout/auth/customer-alice.json");
    repoIndex.manifests["package.json"] += `\nworkspace=${dir}`;
    repoIndex.manifests[".env.customer-alice"] = `TOKEN=${secret}`;
    repoIndex.fileInventoryCoverage = {
      maxFiles: repoIndex.files.length,
      includedFiles: repoIndex.files.length,
      complete: false,
      note: `root=${dir}; token=${secret}; ${"detail ".repeat(400)}`
    };
    let messages: LLMMessage[] = [];
    const llm = {
      async completeJson(input: LLMMessage[]) {
        messages = input;
        return contract;
      }
    };

    await writeInitialContract(dir, repoIndex, llm);

    const prompt = JSON.stringify(messages);
    const userMessage = messages.find((message) => message.role === "user")?.content ?? "{}";
    const payload = JSON.parse(userMessage) as Record<string, unknown>;
    expect(repoIndex.root).toBe(dir);
    expect(repoIndex.manifests["package.json"]).toContain(secret);
    expect(prompt).toContain("[REDACTED_SECRET]");
    expect(prompt).toContain("[REDACTED_REPO_ROOT]");
    expect(payload).toHaveProperty("repositoryInventory");
    expect(payload).not.toHaveProperty("repoIndex");
    expect(prompt).toContain("mean unclassified, not absent");
    expect(prompt).not.toContain(dir);
    expect(prompt).not.toContain("customer-alice");
    expect(prompt).not.toContain(secret);
  });

  it("marks missing repository inventory coverage as unknown in the init prompt", async () => {
    const repoIndex: RepoIndex = {
      root: dir,
      files: ["src/app.ts"],
      manifests: {},
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: []
    };
    let prompt = "";
    const llm = {
      async completeJson(messages: unknown) {
        prompt = JSON.stringify(messages);
        return contract;
      }
    };

    await writeInitialContract(dir, repoIndex, llm);

    const serializedMessages = JSON.parse(prompt) as Array<{ role: string; content: string }>;
    const userMessage = serializedMessages.find((message) => message.role === "user")?.content ?? "{}";
    const payload = JSON.parse(userMessage) as { repositoryInventory: RepoIndex };
    expect(payload.repositoryInventory.fileInventoryCoverage).toMatchObject({
      state: "unknown",
      complete: false,
      includedFiles: 1
    });
    expect(payload.repositoryInventory.fileInventoryCoverage?.note).toContain("metadata is unavailable");
    expect(payload.repositoryInventory.fileInventoryCoverage).not.toHaveProperty("maxFiles");
  });

  it.skipIf(process.platform === "win32")("refuses to read or write contract files through a symlinked .preflight-scout directory", async () => {
    const external = await mkdtemp(path.join(tmpdir(), "preflight-scout-contract-external-"));
    try {
      await writeFile(path.join(external, "config.yml"), "app: {}\nunknowns: []\n");
      await symlink(external, path.join(dir, ".preflight-scout"));

      await expect(loadContract(dir)).rejects.toThrow("symbolic link");
      const repoIndex = await indexRepository(dir);
      await expect(writeInitialContract(dir, repoIndex)).rejects.toThrow("unsafe directory");
      await expect(readFile(path.join(external, "context.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects an oversized structured contract instead of parsing a prefix", async () => {
    await mkdir(path.join(dir, ".preflight-scout"), { recursive: true });
    await writeFile(path.join(dir, ".preflight-scout", "config.yml"), `# ${"x".repeat(1024 * 1024)}\n`);

    await expect(loadContract(dir)).rejects.toThrow("oversized text file");
  });
});
