import path from "node:path";
import { MAX_REPOSITORY_FILES, readTextIfExists, walkFilesWithCoverage } from "./fs.js";
import type { RepoIndex } from "./types.js";

const MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "Gemfile",
  "requirements.txt",
  "pyproject.toml",
  "composer.json",
  "go.mod",
  "Cargo.toml",
  "README.md"
];

export async function indexRepository(root: string, options: { maxFiles?: number } = {}): Promise<RepoIndex> {
  const envLimit = process.env.PREFLIGHT_SCOUT_MAX_REPO_FILES;
  const maxFiles = options.maxFiles ?? (envLimit === undefined ? undefined : Number(envLimit));
  if (envLimit !== undefined && options.maxFiles === undefined && (!/^[0-9]+$/.test(envLimit) || !Number.isSafeInteger(maxFiles) || maxFiles! < 1 || maxFiles! > MAX_REPOSITORY_FILES)) {
    throw new Error(`PREFLIGHT_SCOUT_MAX_REPO_FILES must be an integer from 1 through ${MAX_REPOSITORY_FILES}.`);
  }
  const { files, coverage } = await walkFilesWithCoverage(root, { maxFiles });
  const manifests: Record<string, string> = {};
  for (const manifest of MANIFEST_FILES) {
    if (!files.includes(manifest)) continue;
    const text = await readTextIfExists(path.join(root, manifest), {
      boundary: root,
      maxBytes: 64 * 1024,
      oversize: "omit"
    });
    if (text) manifests[manifest] = text.slice(0, 12000);
  }

  return {
    root,
    files,
    fileInventoryCoverage: coverage,
    manifests,
    packageManager: explicitPackageManager(files),
    frameworks: [],
    routes: [],
    components: [],
    tests: [],
    configFiles: [],
    integrationHints: []
  };
}

function explicitPackageManager(files: string[]): RepoIndex["packageManager"] {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  return undefined;
}
