import type { QAContract, QAFlowMission } from "@preflight-scout/core";
import { resolveContractStorageStatePath, resolveRepoPath } from "./local.js";

export interface AuthLoginOptions {
  role?: string;
  startPath?: string;
  saveStorageState?: string;
}

export function buildAuthLoginMission(contract: QAContract, options: AuthLoginOptions = {}): QAFlowMission {
  const role = options.role ?? firstRole(contract) ?? "standard_user";
  const credentials = contract.auth?.roles?.[role];
  const usernameEnv = credentials?.usernameEnv;
  const passwordEnv = credentials?.passwordEnv;
  const signedInTarget = credentials?.signedInTarget?.trim();
  if (!signedInTarget) {
    throw new Error(
      `Auth role ${role} must configure signedInTarget with an exact, role-appropriate locator (for example testid=user-menu) before Preflight Scout can save authenticated state.`
    );
  }
  return {
    id: `auth-login-${safeId(role)}`,
    title: `Create authenticated browser session for ${role}`,
    role,
    startPath: options.startPath ?? contract.auth?.loginUrl ?? "/",
    risk: "medium",
    reason: [
      "A reusable Playwright storage state lets future Preflight Scout missions validate authenticated flows without re-entering credentials.",
      "This is an existing-user sign-in mission, not a registration or sign-up flow.",
      usernameEnv && passwordEnv
        ? `Use credential environment variables ${usernameEnv} and ${passwordEnv}; do not reveal their values.`
        : "Credential environment variables are not fully configured; block if the live app requires missing credentials."
    ],
    steps: [
      {
        id: "login-and-confirm-session",
        action: "login",
        policyLabel: "login",
        instruction: "Authenticate this existing user role only from the reviewed mission startPath using the configured credential env vars. Do not discover or substitute another login URL. If the app rejects the configured credentials, finish_fail or blocked with the visible rejection evidence."
      },
      {
        id: "confirm-signed-in-marker",
        action: "assert_visible",
        target: signedInTarget,
        instruction: `Verify the reviewed signed-in marker for ${role} is visible before saving reusable authenticated state.`
      }
    ]
  };
}

export async function resolveAuthStorageStatePath(root: string, contract: QAContract, options: AuthLoginOptions = {}): Promise<string> {
  const role = options.role ?? firstRole(contract) ?? "standard_user";
  if (options.saveStorageState !== undefined) return resolveRepoPath(root, options.saveStorageState);
  const configured = contract.auth?.roles?.[role]?.storageState
    ?? contract.auth?.saveStorageState
    ?? contract.defaults?.saveStorageState
    ?? `.preflight-scout/auth/${safeId(role)}.json`;
  return resolveContractStorageStatePath(root, configured, "--save-storage-state");
}

function firstRole(contract: QAContract): string | undefined {
  return Object.keys(contract.auth?.roles ?? {})[0];
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "user";
}
