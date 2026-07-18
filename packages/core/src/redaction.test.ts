import { describe, expect, it } from "vitest";
import {
  MAX_REPO_INVENTORY_COVERAGE_NOTE_CHARS,
  redactPullRequestContext,
  redactRepoIndex,
  redactText
} from "./redaction.js";
import type { PullRequestContext, RepoIndex } from "./types.js";

describe("redactText", () => {
  it("redacts common secret-looking tokens", () => {
    const stripeShapedToken = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");
    expect(redactText(`stripe key ${stripeShapedToken}`)).toContain("[REDACTED_SECRET]");
    for (const token of [
      ["gho", "_", "a".repeat(30)].join(""),
      ["glpat", "-", "b".repeat(30)].join(""),
      ["npm", "_", "c".repeat(36)].join(""),
      ["sk", "-proj-", "d".repeat(30)].join(""),
      ["AIza", "e".repeat(35)].join("")
    ]) {
      expect(redactText(`token=${token}`)).not.toContain(token);
    }
  });

  it("redacts common PEM private-key encodings with matching boundaries", () => {
    for (const label of [
      "PRIVATE KEY",
      "ENCRYPTED PRIVATE KEY",
      "RSA PRIVATE KEY",
      "DSA PRIVATE KEY",
      "EC PRIVATE KEY",
      "OPENSSH PRIVATE KEY"
    ]) {
      const pem = `-----BEGIN ${label}-----\nsensitive-body\n-----END ${label}-----`;
      expect(redactText(`before\n${pem}\nafter`)).toBe("before\n[REDACTED_SECRET]\nafter");
    }
  });

  it("redacts repeated unterminated PEM private-key blocks in one forward pass", () => {
    const malformed = "-----BEGIN RSA PRIVATE KEY-----\nsensitive-body\n".repeat(20_000);

    expect(redactText(`before\n${malformed}`)).toBe("before\n[REDACTED_SECRET]");
  });

  it("does not let a mismatched PEM end boundary expose a truncated private key", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "sensitive-body",
      "-----END EC PRIVATE KEY-----",
      "trailing-sensitive-data"
    ].join("\n");

    expect(redactText(`before\n${pem}`)).toBe("before\n[REDACTED_SECRET]");
  });

  it("parses PEM boundaries before replacing an overlapping supplied secret", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "sensitive-body",
      "-----END RSA PRIVATE KEY-----"
    ].join("\n");

    expect(redactText(`before\n${pem}\nafter`, ["RSA PRIVATE KEY"]))
      .toBe("before\n[REDACTED_SECRET]\nafter");
  });

  it("does not expose an outer tail after a nested PEM opening boundary", () => {
    const malformed = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "outer-secret-a",
      "-----BEGIN RSA PRIVATE KEY-----",
      "inner-secret",
      "-----END RSA PRIVATE KEY-----",
      "outer-secret-b",
      "-----END RSA PRIVATE KEY-----",
      "trailing-sensitive-data"
    ].join("\n");

    expect(redactText(`before\n${malformed}`)).toBe("before\n[REDACTED_SECRET]");
  });

  it("redacts explicitly supplied child-process secrets", () => {
    const secret = "only-in-child-env-secret";
    expect(redactText(`failure: ${secret}`, [secret])).toBe("failure: [REDACTED_ENV_SECRET]");
  });

  it("redacts dedicated browser credentials even when their values are short", () => {
    const previous = process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD;
    process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD = "x";
    try {
      expect(redactText("field=x")).toBe("field=[REDACTED_ENV_SECRET]");
    } finally {
      if (previous === undefined) delete process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD;
      else process.env.PREFLIGHT_SCOUT_BROWSER_QA_PASSWORD = previous;
    }
  });

  it("still redacts short credentials left under the retired environment namespace", () => {
    const previous = process.env.PREFLIGHT_BROWSER_LEGACY_QA_PASSWORD;
    process.env.PREFLIGHT_BROWSER_LEGACY_QA_PASSWORD = "z";
    try {
      expect(redactText("field=z")).toBe("field=[REDACTED_ENV_SECRET]");
    } finally {
      if (previous === undefined) delete process.env.PREFLIGHT_BROWSER_LEGACY_QA_PASSWORD;
      else process.env.PREFLIGHT_BROWSER_LEGACY_QA_PASSWORD = previous;
    }
  });

  it("builds a safe LLM view without local roots or sensitive artifact names", () => {
    const secret = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const repoIndex: RepoIndex = {
      root: "/Users/alice/Customers/acme-private-app",
      files: [
        "src/app.ts",
        `src/${secret}.ts`,
        ".env.customer-alice",
        ".preflight-scout/auth/customer-alice.json"
      ],
      manifests: {
        "package.json": `{\"publishToken\":\"${secret}\"}`,
        ".env.customer-alice": `TOKEN=${secret}`
      },
      packageManager: "pnpm",
      frameworks: [`framework-${secret}`],
      routes: [
        { path: `/private/${secret}`, file: "src/app.ts", kind: "page" },
        { path: "/auth", file: ".preflight-scout/auth/customer-alice.json", kind: "page" }
      ],
      components: [{ name: `Account-${secret}`, file: "src/app.ts" }],
      tests: ["src/app.test.ts", ".preflight-scout/runs/latest/private.test.ts"],
      configFiles: ["vite.config.ts", ".env.customer-alice"],
      integrationHints: [`provider-${secret}`, `workspace=${"/Users/alice/Customers/acme-private-app"}`]
    };

    const safe = redactRepoIndex(repoIndex);
    const serialized = JSON.stringify(safe);

    expect(safe.root).toBe(".");
    expect(safe.files).toContain("src/app.ts");
    expect(safe.files).toContain("src/[REDACTED_SECRET].ts");
    expect(safe.routes).toHaveLength(1);
    expect(safe.manifests).toHaveProperty("package.json");
    expect(safe.manifests).not.toHaveProperty(".env.customer-alice");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).toContain("[REDACTED_REPO_ROOT]");
    expect(serialized).not.toContain("customer-alice");
    expect(serialized).not.toContain(secret);
  });

  it("clones, redacts, and bounds repository inventory coverage notes", () => {
    const root = "/Users/alice/Customers/acme-private-app";
    const secret = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const repoIndex: RepoIndex = {
      root,
      files: ["src/app.ts"],
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

    const safe = redactRepoIndex(repoIndex);

    expect(safe.fileInventoryCoverage).not.toBe(repoIndex.fileInventoryCoverage);
    expect(safe.fileInventoryCoverage?.note).toContain("[REDACTED_REPO_ROOT]");
    expect(safe.fileInventoryCoverage?.note).toContain("[REDACTED_SECRET]");
    expect(safe.fileInventoryCoverage?.note?.length).toBeLessThanOrEqual(MAX_REPO_INVENTORY_COVERAGE_NOTE_CHARS);
    expect(JSON.stringify(safe.fileInventoryCoverage)).not.toContain(root);
    expect(JSON.stringify(safe.fileInventoryCoverage)).not.toContain(secret);
  });

  it("redacts JSON-escaped Windows roots without relying on path casing", () => {
    const root = "C:\\Users\\Alice\\private-workspace";
    const repoIndex: RepoIndex = {
      root,
      files: ["src/app.ts"],
      manifests: {
        "package.json": JSON.stringify({ workspace: "c:\\users\\alice\\private-workspace" })
      },
      packageManager: "pnpm",
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: [root, root.replaceAll("\\", "/")]
    };

    const serialized = JSON.stringify(redactRepoIndex(repoIndex));

    expect(serialized.toLowerCase()).not.toContain("users");
    expect(serialized.toLowerCase()).not.toContain("private-workspace");
    expect(serialized).toContain("[REDACTED_REPO_ROOT]");
  });

  it("removes the complete repo root before token-pattern redaction can fragment it", () => {
    const token = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");
    const root = `/Users/alice/${token}/private-workspace`;
    const repoIndex: RepoIndex = {
      root,
      files: ["src/app.ts"],
      manifests: { "package.json": JSON.stringify({ workspace: root }) },
      packageManager: "pnpm",
      frameworks: [],
      routes: [],
      components: [],
      tests: [],
      configFiles: [],
      integrationHints: [`root=${root}`]
    };

    const serialized = JSON.stringify(redactRepoIndex(repoIndex));

    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[REDACTED_REPO_ROOT]");
  });

  it("keeps sensitive changed-file metadata but omits its patch and content", () => {
    const marker = "postgres://qa-user:unique-password@example.invalid/private";
    const sensitivePaths = [
      ".env.production",
      ".aws/credentials",
      "config/credentials.json",
      "deploy/secrets.production.yaml",
      "evidence/qa-storage-state.json",
      "keys/signing.pem",
      ".preflight/config.yml",
      ".preflight/approvals.local.yml"
    ];
    const pullRequest: PullRequestContext = {
      base: "origin/main",
      head: "HEAD",
      files: [
        ...sensitivePaths.map((file) => ({
          path: file,
          status: "modified" as const,
          additions: 1,
          deletions: 1,
          patch: `+DATABASE_URL=${marker}`,
          content: `DATABASE_URL=${marker}`
        })),
        {
          path: "src/auth/credentials.ts",
          status: "modified",
          patch: "+export const credentialLabel = 'database';",
          content: "export const credentialLabel = 'database';"
        }
      ]
    };

    const safe = redactPullRequestContext(pullRequest);
    const serialized = JSON.stringify(safe);

    expect(safe.files.map((file) => file.path)).toEqual(pullRequest.files.map((file) => file.path));
    expect(safe.files.slice(0, sensitivePaths.length).every((file) => file.patch === "[OMITTED_SENSITIVE_FILE_CONTEXT]")).toBe(true);
    expect(safe.files.slice(0, sensitivePaths.length).every((file) => file.content === "[OMITTED_SENSITIVE_FILE_CONTEXT]")).toBe(true);
    expect(safe.files.at(-1)?.patch).toContain("credentialLabel");
    expect(serialized).not.toContain(marker);
  });
});
