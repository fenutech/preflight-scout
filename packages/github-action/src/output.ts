import { assertPathHasNoSymlinks } from "@preflight-scout/core";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ActionOutputDirectory {
  directory: string;
  boundary: string;
}

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
    return {
      directory: path.join(canonicalWorkspace, relative),
      boundary: canonicalWorkspace
    };
  }

  return resolveExternalActionOutputDirectory(requested);
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
