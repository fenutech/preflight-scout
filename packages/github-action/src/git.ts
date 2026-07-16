import { createTrustedGit } from "@preflight-scout/core";

export type GitCommand = (args: string[]) => Promise<string>;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export async function ensurePullRequestRefs(
  baseSha: string,
  headSha: string,
  runGit?: GitCommand
): Promise<void> {
  const refs = [...new Set([validateCommitId(baseSha), validateCommitId(headSha)])];
  const command = runGit ?? await createDefaultGitCommand();
  const shallow = (await command(["rev-parse", "--is-shallow-repository"])).trim() === "true";
  if (shallow) {
    await command(["fetch", "--no-tags", "--unshallow", "origin", ...refs]);
    await requireCommits(refs, command);
    return;
  }

  const availability = await Promise.all(refs.map(async (sha) => ({
    sha,
    exists: await resolveCommitIfPresent(sha, command) !== undefined
  })));
  const missing = availability.filter((ref) => !ref.exists).map((ref) => ref.sha);
  if (!missing.length) return;

  await command(["fetch", "--no-tags", "origin", ...missing]);
  await requireCommits(missing, command);
}

async function resolveCommitIfPresent(sha: string, runGit: GitCommand): Promise<string | undefined> {
  try {
    const output = (await runGit([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${sha}^{commit}`
    ])).trim();
    if (!GIT_OBJECT_ID.test(output) || output.toLowerCase() !== sha.toLowerCase()) return undefined;
    return output.toLowerCase();
  } catch {
    return undefined;
  }
}

async function requireCommits(refs: string[], runGit: GitCommand): Promise<void> {
  for (const sha of refs) {
    if (!await resolveCommitIfPresent(sha, runGit)) {
      throw new Error(`Git did not resolve fetched pull-request object ${sha} to the requested commit.`);
    }
  }
}

function validateCommitId(value: string): string {
  if (!GIT_OBJECT_ID.test(value)) {
    throw new Error("Pull-request base and head revisions must be full Git commit object IDs.");
  }
  return value.toLowerCase();
}

async function createDefaultGitCommand(): Promise<GitCommand> {
  const cwd = process.cwd();
  const git = await createTrustedGit({ targetRoot: cwd });
  return async (args) => (await git.exec(args, { cwd })).stdout;
}
