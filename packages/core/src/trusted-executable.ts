import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

interface PathBoundary {
  lexical: string;
  canonical: string;
}

export interface TrustedExecutableOptions {
  command: string;
  targetRoot: string;
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface TrustedExecutable {
  executable: string;
  searchPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve a fixed executable without allowing the target repository, its Git
 * metadata, the current repository, or relative PATH entries to supply it.
 * The returned environment contains one canonical PATH key whose entries are
 * the same trusted directories used for resolution.
 */
export async function resolveTrustedExecutable(options: TrustedExecutableOptions): Promise<TrustedExecutable> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const boundaries = await executableBoundaries(options.targetRoot);
  const searchDirectories = await trustedPathDirectories(sourceEnv, boundaries);
  const executable = await findTrustedExecutable(options.command, searchDirectories, sourceEnv, boundaries);
  const searchPath = searchDirectories.join(path.delimiter);
  return {
    executable,
    searchPath,
    env: withTrustedPath(sourceEnv, searchPath)
  };
}

async function executableBoundaries(targetRoot: string): Promise<PathBoundary[]> {
  if (!targetRoot || !path.isAbsolute(targetRoot)) {
    throw new Error("Trusted executable resolution requires an absolute target root");
  }

  const boundaries: PathBoundary[] = [];
  await addBoundary(boundaries, path.resolve(targetRoot));
  await addGitBoundaries(boundaries, path.resolve(targetRoot));
  await addGitBoundaries(boundaries, path.resolve(process.cwd()));

  const seen = new Set<string>();
  return boundaries.filter((boundary) => {
    const key = `${pathComparisonKey(boundary.lexical)}\0${pathComparisonKey(boundary.canonical)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function addGitBoundaries(boundaries: PathBoundary[], start: string): Promise<void> {
  const git = await findGitBoundary(start);
  if (!git) return;
  await addBoundary(boundaries, git.root);
  if (git.metadata) await addBoundary(boundaries, git.metadata);
}

async function findGitBoundary(start: string): Promise<{ root: string; metadata?: string } | undefined> {
  let current = path.resolve(start);
  for (;;) {
    const marker = path.join(current, ".git");
    try {
      const markerStats = await lstat(marker);
      if (markerStats.isDirectory() || markerStats.isSymbolicLink()) {
        return { root: current, metadata: marker };
      }
      if (markerStats.isFile()) {
        if (markerStats.size > 8192) return { root: current, metadata: marker };
        const firstLine = (await readFile(marker, "utf8")).split(/\r?\n/, 1)[0]?.trim() ?? "";
        const match = firstLine.match(/^gitdir:\s*(.+)$/i);
        const metadata = match?.[1] && !match[1].includes("\0")
          ? path.resolve(current, match[1])
          : marker;
        return { root: current, metadata };
      }
      return { root: current, metadata: marker };
    } catch (error) {
      if (!isMissingPathError(error)) return { root: current, metadata: marker };
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function addBoundary(boundaries: PathBoundary[], value: string): Promise<void> {
  const lexical = path.resolve(value);
  boundaries.push({ lexical, canonical: await canonicalPathAllowMissing(lexical) });
}

async function canonicalPathAllowMissing(value: string): Promise<string> {
  let cursor = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(cursor);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) return path.resolve(value);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(value);
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

async function trustedPathDirectories(sourceEnv: NodeJS.ProcessEnv, boundaries: PathBoundary[]): Promise<string[]> {
  const rawPath = environmentValue(sourceEnv, "PATH") ?? "";
  const directories: string[] = [];
  const seen = new Set<string>();

  for (const entry of rawPath.split(path.delimiter).slice(0, 256)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const lexical = path.resolve(entry);
    if (isInsideAnyBoundary(lexical, boundaries, "lexical")) continue;

    let canonical: string;
    try {
      canonical = await realpath(lexical);
      if (!(await stat(canonical)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!path.isAbsolute(canonical) || isInsideAnyBoundary(canonical, boundaries, "canonical")) continue;

    const key = pathComparisonKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(canonical);
  }
  return directories;
}

async function findTrustedExecutable(
  command: string,
  searchDirectories: string[],
  sourceEnv: NodeJS.ProcessEnv,
  boundaries: PathBoundary[]
): Promise<string> {
  if (!command || command.includes("\0")) throw new Error("Trusted executable name is invalid");
  if (path.isAbsolute(command)) {
    const executable = await validateExecutable(command, boundaries);
    if (executable) return executable;
    throw new Error("Configured executable is not a trusted regular executable outside the target repository");
  }
  if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
    throw new Error("Trusted commands must be absolute or resolve by a canonical absolute PATH entry");
  }

  for (const directory of searchDirectories) {
    for (const name of executableNames(command, sourceEnv)) {
      const executable = await validateExecutable(path.join(directory, name), boundaries);
      if (executable) return executable;
    }
  }
  throw new Error(`Could not resolve a trusted ${command} executable outside the target repository and Git boundary.`);
}

function executableNames(command: string, sourceEnv: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [command];
  const extension = path.extname(command).toLowerCase();
  const allowed = new Set([".com", ".exe"]);
  if (extension) return allowed.has(extension) ? [command] : [];

  const configured = (environmentValue(sourceEnv, "PATHEXT") ?? ".COM;.EXE")
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => allowed.has(item));
  return [...new Set(configured.length ? configured : [".com", ".exe"])].map((item) => `${command}${item}`);
}

async function validateExecutable(candidate: string, boundaries: PathBoundary[]): Promise<string | undefined> {
  const lexical = path.resolve(candidate);
  if (!path.isAbsolute(lexical) || isInsideAnyBoundary(lexical, boundaries, "lexical")) return undefined;
  try {
    const canonical = await realpath(lexical);
    if (!path.isAbsolute(canonical) || isInsideAnyBoundary(canonical, boundaries, "canonical")) return undefined;
    if (!(await stat(canonical)).isFile()) return undefined;
    if (process.platform === "win32") {
      if (!/\.(?:com|exe)$/i.test(canonical)) return undefined;
    } else {
      await access(canonical, fsConstants.X_OK);
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function isInsideAnyBoundary(candidate: string, boundaries: PathBoundary[], kind: keyof PathBoundary): boolean {
  return boundaries.some((boundary) => isPathWithin(boundary[kind], candidate));
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(pathComparisonKey(parent), pathComparisonKey(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathComparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (process.platform !== "win32") return undefined;
  return Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value !== undefined)?.[1];
}

function withTrustedPath(sourceEnv: NodeJS.ProcessEnv, searchPath: string): NodeJS.ProcessEnv {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }
  env.PATH = searchPath;
  return env;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
