import {
  assertPathHasNoSymlinks,
  createTrustedGit,
  type TrustedGit
} from "@preflight-scout/core";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ActionOutputDirectory {
  directory: string;
  boundary: string;
}

const REPOSITORY_LOCAL_OUTPUT_POLICY_ERROR =
  "Refusing a repository-local Action output directory: it must be untracked and ignored by Git as a directory.";

export async function resolveActionOutputDirectory(
  workspace: string,
  outputDir: string
): Promise<ActionOutputDirectory> {
  const resolvedWorkspace = path.resolve(workspace);
  const requested = path.resolve(resolvedWorkspace, outputDir);
  const canonicalWorkspace = await canonicalDirectory(
    resolvedWorkspace,
    "The GitHub Action workspace is not a safe directory."
  );

  if (isPathWithin(resolvedWorkspace, requested)) {
    try {
      await assertPathHasNoSymlinks(resolvedWorkspace, requested, {
        allowMissing: true,
        leafType: "directory"
      });
    } catch {
      throw new Error("Refusing an unsafe repository-local Action output directory.");
    }
    const relative = path.relative(resolvedWorkspace, requested);
    const repositoryLocal = {
      directory: path.join(canonicalWorkspace, relative),
      boundary: canonicalWorkspace
    };
    await assertRepositoryLocalActionOutputIsIgnored(repositoryLocal.boundary, repositoryLocal.directory);
    return repositoryLocal;
  }

  const external = await resolveExternalActionOutputDirectory(requested);
  if (!isPathWithin(canonicalWorkspace, external.directory)) return external;

  try {
    await assertPathHasNoSymlinks(canonicalWorkspace, external.directory, {
      allowMissing: true,
      leafType: "directory"
    });
  } catch {
    throw new Error("Refusing an unsafe repository-local Action output directory.");
  }
  await assertRepositoryLocalActionOutputIsIgnored(canonicalWorkspace, external.directory);
  return {
    directory: external.directory,
    boundary: canonicalWorkspace
  };
}

async function assertRepositoryLocalActionOutputIsIgnored(
  workspace: string,
  outputDir: string
): Promise<void> {
  const relativePath = path.relative(workspace, outputDir).split(path.sep).join("/");
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
    throw repositoryLocalOutputPolicyError();
  }

  try {
    const git = await createTrustedGit({ targetRoot: workspace });
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: workspace });
    if (stdout.trim() !== "true") throw new Error("not inside a Git worktree");
    if (await gitPredicate(git, workspace, [
      "--literal-pathspecs",
      "ls-files",
      "--error-unmatch",
      "--",
      relativePath
    ])) {
      throw repositoryLocalOutputPolicyError();
    }
    if (!await gitProvesDirectoryIsExcluded(git, workspace, relativePath)) {
      throw repositoryLocalOutputPolicyError();
    }
  } catch (error) {
    if (error instanceof Error && error.message === REPOSITORY_LOCAL_OUTPUT_POLICY_ERROR) throw error;
    throw new Error(
      "Refusing a repository-local Action output directory because Git could not prove it is untracked and ignored.",
      { cause: error }
    );
  }
}

async function gitProvesDirectoryIsExcluded(
  git: TrustedGit,
  workspace: string,
  relativePath: string
): Promise<boolean> {
  const directoryPath = `${relativePath}/`;
  if (!await gitPredicate(git, workspace, [
    "check-ignore",
    "--quiet",
    "--no-index",
    "--",
    directoryPath
  ])) return false;

  const { stdout } = await git.exec([
    "-c",
    "core.quotePath=false",
    "check-ignore",
    "--verbose",
    "--no-index",
    "--",
    directoryPath
  ], { cwd: workspace, maxBuffer: 64 * 1024 });
  const output = stdout.replace(/\r?\n$/, "");
  const pathSuffix = `\t${directoryPath}`;
  return output.endsWith(pathSuffix)
    && output.slice(0, -pathSuffix.length).endsWith("/");
}

async function gitPredicate(git: TrustedGit, workspace: string, args: string[]): Promise<boolean> {
  try {
    await git.exec(args, { cwd: workspace });
    return true;
  } catch (error) {
    if (Number((error as { code?: unknown }).code) === 1) return false;
    throw error;
  }
}

function repositoryLocalOutputPolicyError(): Error {
  return new Error(REPOSITORY_LOCAL_OUTPUT_POLICY_ERROR);
}

async function resolveExternalActionOutputDirectory(requested: string): Promise<ActionOutputDirectory> {
  let existing = requested;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalBoundary = await canonicalDirectory(
        existing,
        "The external Action output directory has an unsafe existing ancestor."
      );
      return {
        directory: path.join(canonicalBoundary, ...missingSegments),
        boundary: canonicalBoundary
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error("The external Action output directory has no safe existing ancestor.");
    }
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
}

async function canonicalDirectory(directory: string, errorMessage: string): Promise<string> {
  try {
    const canonical = await fs.realpath(directory);
    const stats = await fs.lstat(canonical);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(errorMessage);
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    if (error instanceof Error && error.message === errorMessage) throw error;
    throw new Error(errorMessage);
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
  );
}
