import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { assertPathHasNoSymlinks, readTextIfExists, writeTextEnsuringDir } from "./fs.js";
import { createTrustedGit, type TrustedGit } from "./trusted-git.js";

const APPROVALS_RELATIVE_PATH = ".preflight-scout/approvals.local.yml";
const LEGACY_APPROVALS_RELATIVE_PATH = ".preflight-scout/approvals.yml";
const ApprovalRecordSchema = z.object({
  action: z.string().min(1).max(128).refine((value) => value.trim() === value, "action must not have surrounding whitespace"),
  reason: z.string().min(1).max(2000).refine((value) => value.trim() === value, "reason must not have surrounding whitespace").optional(),
  approvedAt: z.string().max(64).datetime({ offset: true })
}).strict();
const ApprovalStateSchema = z.object({
  approvals: z.array(ApprovalRecordSchema).max(128)
}).strict();

export interface ApprovalRecord {
  action: string;
  reason?: string;
  approvedAt: string;
}

export interface ApprovalState {
  approvals: ApprovalRecord[];
}

export async function loadApprovals(root: string): Promise<ApprovalState> {
  const resolvedRoot = path.resolve(root);
  await assertNoLegacyApprovals(resolvedRoot);
  const filePath = await assertLocalApprovalPath(resolvedRoot);
  const text = await readTextIfExists(filePath, { boundary: resolvedRoot, maxBytes: 1024 * 1024 });
  if (!text) return { approvals: [] };
  return ApprovalStateSchema.parse(YAML.parse(text, { maxAliasCount: 20 }));
}

export async function approveAction(root: string, action: string, reason?: string): Promise<ApprovalState> {
  const state = await loadApprovals(root);
  const next = ApprovalStateSchema.parse({
    approvals: [
      ...state.approvals.filter((approval) => approval.action !== action),
      {
        action,
        reason,
        approvedAt: new Date().toISOString()
      }
    ]
  });
  const resolvedRoot = path.resolve(root);
  const filePath = await assertLocalApprovalPath(resolvedRoot);
  await writeTextEnsuringDir(filePath, YAML.stringify(next), { boundary: resolvedRoot, mode: 0o600 });
  return next;
}

export function isActionApproved(state: ApprovalState, action: string): boolean {
  const parsed = ApprovalStateSchema.safeParse(state);
  return parsed.success && parsed.data.approvals.some((approval) => approval.action === action);
}

async function assertNoLegacyApprovals(root: string): Promise<void> {
  const legacyPath = path.join(root, ...LEGACY_APPROVALS_RELATIVE_PATH.split("/"));
  const legacy = await readTextIfExists(legacyPath, { boundary: root, maxBytes: 1024 * 1024 });
  if (legacy !== undefined) {
    throw new Error(
      `Refusing legacy approval file ${legacyPath}. Remove it and recreate approvals with preflight-scout approve so they are stored locally in ${APPROVALS_RELATIVE_PATH}.`
    );
  }
}

async function assertLocalApprovalPath(root: string): Promise<string> {
  const filePath = path.join(root, ...APPROVALS_RELATIVE_PATH.split("/"));
  await assertPathHasNoSymlinks(root, filePath, { allowMissing: true, leafType: "file" });

  try {
    const git = await createTrustedGit({ targetRoot: root });
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: root, maxBuffer: 1024 });
    if (stdout.trim() !== "true") throw new Error("not inside a Git worktree");
    if (await gitPredicate(git, root, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", APPROVALS_RELATIVE_PATH])) {
      throw new Error(`Refusing approval file ${filePath}: approval decisions must not be tracked by Git.`);
    }
    if (!await gitPredicate(git, root, ["check-ignore", "--quiet", "--", APPROVALS_RELATIVE_PATH])) {
      throw new Error(`Refusing approval file ${filePath}: add ${APPROVALS_RELATIVE_PATH} to .gitignore first.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing approval file ")) throw error;
    throw new Error(
      `Refusing approval file ${filePath}: Git could not prove that it is ignored and untracked.`,
      { cause: error }
    );
  }
  return filePath;
}

async function gitPredicate(git: TrustedGit, root: string, args: string[]): Promise<boolean> {
  try {
    await git.exec(args, { cwd: root, maxBuffer: 1024 });
    return true;
  } catch (error) {
    if (Number((error as { code?: unknown }).code) === 1) return false;
    throw error;
  }
}
