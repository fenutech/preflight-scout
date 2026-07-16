import path from "node:path";
import YAML from "yaml";
import { browserCredentialKindForEnvName } from "./credential-env.js";
import { readTextIfExists, writeTextEnsuringDir } from "./fs.js";
import { redactRepoIndex } from "./redaction.js";
import type { QAContract, RepoIndex } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import { QAContractSchema } from "./schemas.js";

export type TargetEnvironment = "auto" | "local" | "staging";
const MAX_APP_URL_CHARS = 4096;

export class AppUrlValidationError extends Error {
  override readonly name = "AppUrlValidationError";
}

export const DEFAULT_CONTRACT: QAContract = {
  app: {
    previewUrlSource: "unknown"
  },
  defaults: {
    target: "default",
    targetEnv: "auto",
    outputDir: ".preflight-scout/runs/latest",
    missionLimit: 2,
    headless: true,
    trace: true
  },
  criticalFlows: ["login", "signup", "onboarding", "checkout", "billing", "settings"],
  sensitiveAreas: ["auth", "payments", "permissions", "data deletion", "webhooks"],
  dangerousActions: {
    allowed: ["login", "navigate", "search", "add_to_cart", "update_test_record"],
    requireApproval: ["submit_payment", "send_email", "invite_user", "delete_record", "cancel_subscription"],
    forbidden: ["production_write", "real_payment", "delete_account"]
  },
  testData: {},
  unknowns: ["staging URL", "test credentials", "safe test data"]
};

export async function loadContract(root: string): Promise<QAContract> {
  const filePath = path.join(root, ".preflight-scout", "config.yml");
  const text = await readTextIfExists(filePath, { boundary: root, maxBytes: 1024 * 1024 });
  if (!text) return DEFAULT_CONTRACT;
  return QAContractSchema.parse(normalizeContract(YAML.parse(text) as Partial<QAContract>));
}

export function resolveTargetUrl(contract: QAContract, options: { url?: string; env?: TargetEnvironment | string; target?: string } = {}): string {
  if (options.url) return validateAppUrl(options.url);
  if (process.env.PREFLIGHT_SCOUT_APP_URL) return validateAppUrl(process.env.PREFLIGHT_SCOUT_APP_URL);

  const env = options.env ?? "auto";
  if (!isTargetEnvironment(env)) {
    throw new Error(`Invalid target environment "${env}". Use auto, local, or staging.`);
  }

  const targetName = options.target ?? process.env.PREFLIGHT_SCOUT_TARGET ?? contract.defaults?.target;
  const target = targetName && targetName !== "default" ? contract.app.targets?.[targetName] : undefined;
  if (targetName && targetName !== "default" && !target) {
    const available = Object.keys(contract.app.targets ?? {});
    throw new Error(`App target "${targetName}" was not found. Available targets: ${available.join(", ") || "none"}.`);
  }
  const appTarget = target ?? contract.app;

  if (env === "local" && appTarget.localUrl) return validateAppUrl(appTarget.localUrl);
  if (env === "staging" && (appTarget.stagingUrl ?? appTarget.url)) return validateAppUrl(appTarget.stagingUrl ?? appTarget.url!);

  const resolved = appTarget.localUrl ?? appTarget.stagingUrl ?? appTarget.url;
  if (resolved) return validateAppUrl(resolved);

  const targetHint = targetName && targetName !== "default" ? ` for app target "${targetName}"` : "";
  throw new Error(`No app URL configured${targetHint}. Pass --url, set PREFLIGHT_SCOUT_APP_URL, or add app.localUrl/app.stagingUrl or app.targets.<name> URLs to .preflight-scout/config.yml.`);
}

export function validateAppUrl(value: string): string {
  if (value.length > MAX_APP_URL_CHARS) {
    throw new AppUrlValidationError(`App URL exceeds the ${MAX_APP_URL_CHARS}-character safety limit.`);
  }
  if (value !== value.trim()) {
    throw new AppUrlValidationError("App URL must not contain surrounding whitespace.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppUrlValidationError("App URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppUrlValidationError("App URL must use http: or https:.");
  }
  if (parsed.username || parsed.password) {
    throw new AppUrlValidationError("App URL must not contain embedded credentials.");
  }
  return value;
}

function isTargetEnvironment(value: string): value is TargetEnvironment {
  return value === "auto" || value === "local" || value === "staging";
}

export interface InitialContractOptions {
  appUrl?: string;
  localUrl?: string;
  stagingUrl?: string;
  target?: string;
  loginUrl?: string;
  role?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  storageState?: string;
  saveStorageState?: string;
  baseRef?: string;
  targetEnv?: TargetEnvironment;
  outputDir?: string;
}

export async function writeInitialContract(root: string, repoIndex: RepoIndex, llm?: LLMClient, options: InitialContractOptions = {}): Promise<QAContract> {
  const contract = applyInitialContractOptions(llm ? await draftContractWithLLM(repoIndex, llm) : draftBlankContract(repoIndex), options);
  await writeTextEnsuringDir(path.join(root, ".preflight-scout", "config.yml"), YAML.stringify(contract), { boundary: root });
  await writeTextEnsuringDir(path.join(root, ".preflight-scout", "context.md"), draftContext(repoIndex), { boundary: root });
  await writeTextEnsuringDir(path.join(root, ".preflight-scout", "flows.yml"), YAML.stringify(draftFlows(contract)), { boundary: root });
  await writeTextEnsuringDir(path.join(root, ".preflight-scout", "policies.yml"), YAML.stringify({
    approval_policy: "block_dangerous_actions_by_default",
    redaction: ["*_TOKEN", "*_KEY", "*PASSWORD*", "*SECRET*"],
    evidence: {
      screenshots: true,
      network_summary: true,
      playwright_trace: true
    }
  }), { boundary: root });
  await writeTextEnsuringDir(path.join(root, ".env.preflight-scout.example"), draftEnvExample(contract), { boundary: root });
  await ensurePreflightScoutGitignore(root);
  return contract;
}

export async function draftContractWithLLM(repoIndex: RepoIndex, llm: LLMClient): Promise<QAContract> {
  return llm.completeJson<QAContract>(contractPrompt(redactRepoIndex(repoIndex)), {
    schema: QAContractSchema,
    schemaName: "qa_contract"
  });
}

export function draftBlankContract(repoIndex: RepoIndex): QAContract {
  const contract = structuredClone(DEFAULT_CONTRACT);
  contract.app.name = repoIndex.root.split(path.sep).pop();
  contract.app.type = repoIndex.frameworks.join(", ") || "unknown";
  contract.unknowns = [
    "Configure an LLM provider to let Preflight Scout draft this file from repo context",
    "Add staging or preview URL source",
    "Add test credentials",
    "Add dangerous action rules",
    "Add product-specific safe test data"
  ];
  return contract;
}

function normalizeContract(input: Partial<QAContract>): QAContract {
  return {
    ...DEFAULT_CONTRACT,
    ...input,
    app: { ...DEFAULT_CONTRACT.app, ...input.app },
    auth: input.auth ? { ...DEFAULT_CONTRACT.auth, ...input.auth } : DEFAULT_CONTRACT.auth,
    defaults: { ...DEFAULT_CONTRACT.defaults, ...input.defaults },
    dangerousActions: { ...DEFAULT_CONTRACT.dangerousActions, ...input.dangerousActions },
    criticalFlows: input.criticalFlows ?? DEFAULT_CONTRACT.criticalFlows,
    sensitiveAreas: input.sensitiveAreas ?? DEFAULT_CONTRACT.sensitiveAreas,
    testData: input.testData ?? DEFAULT_CONTRACT.testData,
    unknowns: input.unknowns ?? DEFAULT_CONTRACT.unknowns
  };
}

function applyInitialContractOptions(contract: QAContract, options: InitialContractOptions): QAContract {
  const next = normalizeContract(contract);
  if (options.target && options.target !== "default") {
    next.app = { ...next.app, targets: { ...next.app.targets } };
    next.app.targets![options.target] = {
      ...next.app.targets![options.target],
      ...(options.appUrl ? { url: options.appUrl } : {}),
      ...(options.localUrl ? { localUrl: options.localUrl } : {}),
      ...(options.stagingUrl ? { stagingUrl: options.stagingUrl } : {})
    };
  } else {
    next.app = {
      ...next.app,
      ...(options.appUrl ? { url: options.appUrl } : {}),
      ...(options.localUrl ? { localUrl: options.localUrl } : {}),
      ...(options.stagingUrl ? { stagingUrl: options.stagingUrl } : {})
    };
  }
  if (options.loginUrl || options.role || options.usernameEnv || options.passwordEnv || options.storageState || options.saveStorageState) {
    next.auth = { ...next.auth };
    if (options.loginUrl) next.auth.loginUrl = options.loginUrl;
    if (options.storageState) next.auth.storageState = options.storageState;
    if (options.saveStorageState) next.auth.saveStorageState = options.saveStorageState;
    if (options.role || options.usernameEnv || options.passwordEnv) {
      const role = options.role ?? "standard_user";
      next.auth.roles = options.role ? {} : { ...next.auth.roles };
      next.auth.roles[role] = {
        ...next.auth.roles[role],
        ...(options.usernameEnv ? { usernameEnv: options.usernameEnv } : {}),
        ...(options.passwordEnv ? { passwordEnv: options.passwordEnv } : {}),
        storageState: options.storageState ?? options.saveStorageState ?? next.auth.roles[role]?.storageState ?? `.preflight-scout/auth/${safeId(role)}.json`
      };
    }
  }
  next.defaults = {
    ...next.defaults,
    ...(options.baseRef ? { baseRef: options.baseRef } : {}),
    ...(options.target ? { target: options.target } : {}),
    ...(options.targetEnv ? { targetEnv: options.targetEnv } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {})
  };
  return QAContractSchema.parse(next);
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "user";
}

async function ensurePreflightScoutGitignore(root: string): Promise<void> {
  const gitignorePath = path.join(root, ".gitignore");
  const existing = await readTextIfExists(gitignorePath, { boundary: root, maxBytes: 1024 * 1024 }) ?? "";
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const requiredEntries = [
    ".preflight-scout/auth/",
    ".preflight-scout/runs/",
    ".preflight-scout/approvals.local.yml",
    ".env.preflight-scout.local",
    "!.env.preflight-scout.example"
  ];
  const missingEntries = requiredEntries.filter((entry) => {
    const acceptedEntries = entry.endsWith("/") ? [entry, entry.slice(0, -1)] : [entry];
    return acceptedEntries.every((accepted) => !lines.has(accepted));
  });
  if (!missingEntries.length) return;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await writeTextEnsuringDir(gitignorePath, `${existing}${prefix}${missingEntries.join("\n")}\n`, { boundary: root });
}

function draftEnvExample(contract: QAContract): string {
  const names = new Set<string>([
    "OPENAI_API_KEY=",
    "ANTHROPIC_API_KEY=",
    "GEMINI_API_KEY=",
    "PREFLIGHT_SCOUT_APP_URL="
  ]);
  for (const credentials of Object.values(contract.auth?.roles ?? {})) {
    if (credentials.usernameEnv && browserCredentialKindForEnvName(credentials.usernameEnv) === "username") {
      names.add(`${credentials.usernameEnv}=`);
    }
    if (credentials.passwordEnv && browserCredentialKindForEnvName(credentials.passwordEnv) === "password") {
      names.add(`${credentials.passwordEnv}=`);
    }
  }
  return `${[
    "# Copy-safe values for .env.preflight-scout.local. Keep the copied file ignored and untracked.",
    ...names,
    "",
    "# Set privileged controls in the trusted parent shell, not in .env.preflight-scout.local:",
    "# export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec",
    "# export PREFLIGHT_SCOUT_MODEL=",
    "# export PREFLIGHT_SCOUT_LLM_TIMEOUT_MS=120000",
    "# export PREFLIGHT_SCOUT_OPENAI_BASE_URL=",
    "# export PREFLIGHT_SCOUT_EXEC_MODEL=",
    "# export PREFLIGHT_SCOUT_EXEC_TIMEOUT_MS="
  ].join("\n")}\n`;
}

function draftContext(repoIndex: RepoIndex): string {
  return `# Preflight Scout Context

This file is human-maintained context for release QA. Keep it short and concrete.

## Detected Stack

- Frameworks: ${repoIndex.frameworks.join(", ") || "unknown"}
- Package manager: ${repoIndex.packageManager ?? "unknown"}
- Integrations: ${repoIndex.integrationHints.join(", ") || "none detected"}

## Product Notes

[Describe the core product, critical user journeys, roles, and high-risk business rules.]

## Safe Test Data

[Add known safe records, test users, coupons, plans, or feature flags.]

## Human Review Rules

[List flows the agent should never complete without approval.]
`;
}

function draftFlows(contract: QAContract): unknown {
  return {
    flows: Object.fromEntries(
      contract.criticalFlows.map((flow) => [
        flowId(flow),
        {
          priority: ["login", "checkout", "billing"].includes(flow) ? "critical" : "important",
          roles: flow === "login" ? Object.keys(contract.auth?.roles ?? { standard_user: true }) : ["standard_user"],
          label: flow,
          start: inferFlowStart(flow, contract),
          success_condition: "LLM should infer visible success state from the live app and report blocked if ambiguous."
        }
      ])
    )
  };
}

function flowId(flow: string): string {
  return flow
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "flow";
}

function inferFlowStart(flow: string, contract: QAContract): string {
  if (flow === "login") return contract.auth?.loginUrl ?? "/login";
  return "/";
}

function contractPrompt(repoIndex: RepoIndex): LLMMessage[] {
  return [
    {
      role: "system",
      content: `You are Preflight Scout's init agent.

Return only valid JSON matching QAContract:
{
  "app": {"name":"string optional","type":"string optional","url":"default app URL optional","localUrl":"localhost/dev URL optional","stagingUrl":"deployed staging URL optional","targets":{"frontend":{"url":"optional","localUrl":"optional","stagingUrl":"optional","description":"optional"}},"previewUrlSource":"vercel|netlify|github_deployment|manual|unknown"},
  "auth": {"loginUrl":"string optional","storageState":"Playwright storageState path optional","saveStorageState":"path optional","roles":{"roleName":{"usernameEnv":"string optional","passwordEnv":"string optional","storageState":"path optional","signedInTarget":"exact locator proving this role is signed in, for example testid=user-menu","notes":"string optional"}}},
  "defaults": {"baseRef":"git base ref optional","target":"frontend optional","targetEnv":"auto|local|staging optional","outputDir":"run artifact dir optional","maxTurns":15,"missionLimit":2,"headless":true,"trace":true,"allCandidates":false,"storageState":"path optional","saveStorageState":"path optional"},
  "criticalFlows": ["string"],
  "sensitiveAreas": ["string"],
  "dangerousActions": {"allowed":["string"],"requireApproval":["string"],"forbidden":["string"]},
  "testData": {"key":"value"},
  "unknowns": ["string"]
}

Figure out the initial QA contract from repo facts. Be bold where the repo gives evidence, but mark unknowns where humans must confirm.
Prefer short flow names that identify durable product journeys, such as "public_codex_browse", "admin_login", or "checkout_happy_path"; do not put full sentences in criticalFlows.
Do not invent secrets. Use env var names for credentials.
This config is a draft for humans to review.`
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Draft the initial .preflight-scout/config.yml for this repository.",
          repoIndex
        },
        null,
        2
      )
    }
  ];
}
