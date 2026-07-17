import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRepository, loadContract, resolveTargetUrl, writeInitialContract, type QAContract } from "./index.js";

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
    await rm(dir, { recursive: true, force: true });
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
    const envExample = await readFile(path.join(dir, ".env.preflight-scout.example"), "utf8");
    const gitignore = await readFile(path.join(dir, ".gitignore"), "utf8");

    expect(written.defaults?.baseRef).toBe("origin/main");
    expect(written.defaults?.target).toBe("frontend");
    expect(loaded.app.targets?.frontend?.localUrl).toBe("http://127.0.0.1:3000");
    expect(loaded.defaults?.targetEnv).toBe("local");
    expect(loaded.auth?.roles?.admin?.usernameEnv).toBe("PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL");
    expect(loaded.auth?.roles?.admin?.storageState).toBe(".preflight-scout/auth/admin.json");
    expect(loaded.auth?.saveStorageState).toBe(".preflight-scout/auth/admin.json");
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
    let prompt = "";
    const llm = {
      async completeJson(messages: unknown) {
        prompt = JSON.stringify(messages);
        return contract;
      }
    };

    await writeInitialContract(dir, repoIndex, llm);

    expect(repoIndex.root).toBe(dir);
    expect(repoIndex.manifests["package.json"]).toContain(secret);
    expect(prompt).toContain("[REDACTED_SECRET]");
    expect(prompt).toContain("[REDACTED_REPO_ROOT]");
    expect(prompt).not.toContain(dir);
    expect(prompt).not.toContain("customer-alice");
    expect(prompt).not.toContain(secret);
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
