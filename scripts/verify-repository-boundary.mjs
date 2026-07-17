import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveExternalTool } from "./resolve-external-tool.mjs";

const execFileAsync = promisify(execFile);

try {
  await main();
} catch (error) {
  console.error(`Repository boundary check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main() {
  if (process.argv.length > 3) {
    throw new Error("usage: verify-repository-boundary.mjs [repository-root]");
  }
  const requestedRoot = path.resolve(process.argv[2] ?? process.cwd());
  const root = await realpath(requestedRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`repository root is not a regular directory: ${root}`);
  }

  const gitCommand = await resolveExternalTool("git", { repoRoot: root });
  const entries = await readTrackedEntries(root, gitCommand);
  const trackedPaths = new Set(entries.map(({ filePath }) => filePath));
  const trackedContents = new Map();

  for (const { filePath, mode, objectId, stage } of entries) {
    if (stage !== "0") throw new Error(`unmerged tracked path is not allowed: ${filePath}`);
    if (mode !== "100644" && mode !== "100755") {
      const kind = mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : `mode ${mode}`;
      throw new Error(`tracked path is a ${kind}, not a regular file: ${filePath}`);
    }

    trackedContents.set(filePath, await verifyTrackedFile(root, filePath, objectId));
  }

  assertNoDuplicateStageZeroEntries(entries);
  verifyMarkdownLinks(trackedPaths, trackedContents);
  console.log(`Repository boundary passed: ${trackedPaths.size} tracked regular files and closed relative Markdown links.`);
}

async function readTrackedEntries(root, gitCommand) {
  const { stdout } = await execFileAsync(gitCommand, [
    "-C",
    root,
    "-c",
    "core.fsmonitor=false",
    "ls-files",
    "--stage",
    "-z"
  ], {
    cwd: root,
    encoding: "utf8",
    env: trustedGitEnvironment(gitCommand),
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    windowsHide: true
  });

  const entries = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Git returned an invalid tracked-file record");
    const metadata = record.slice(0, tab).split(" ");
    if (metadata.length !== 3) throw new Error("Git returned invalid tracked-file metadata");
    const [mode, objectId, stage] = metadata;
    if (!/^[0-7]{6}$/u.test(mode) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId) || !/^[0-3]$/u.test(stage)) {
      throw new Error("Git returned invalid tracked-file metadata");
    }
    const filePath = record.slice(tab + 1);
    validateRepositoryPath(filePath, "tracked files");
    entries.push({ filePath, mode, objectId, stage });
  }
  if (entries.length === 0) throw new Error("repository has no tracked files");
  return entries;
}

async function verifyTrackedFile(root, filePath, objectId) {
  const segments = filePath.split("/");
  let ancestor = root;
  for (const segment of segments.slice(0, -1)) {
    ancestor = path.join(ancestor, segment);
    const stats = await lstat(ancestor).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats) throw new Error(`tracked path is missing or non-regular in the worktree: ${filePath}`);
    if (stats.isSymbolicLink()) {
      throw new Error(`tracked path has a symlinked ancestor: ${filePath} (${path.relative(root, ancestor)})`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`tracked path has a non-directory ancestor: ${filePath} (${path.relative(root, ancestor)})`);
    }
    const resolvedAncestor = await realpath(ancestor);
    assertPathWithinRoot(root, resolvedAncestor, filePath);
  }

  const candidatePath = path.join(root, ...segments);
  const stats = await lstat(candidatePath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`tracked path is missing or non-regular in the worktree: ${filePath}`);
  }
  if (stats.nlink !== 1) throw new Error(`tracked path has multiple hard links: ${filePath}`);

  const resolvedPath = await realpath(candidatePath);
  assertPathWithinRoot(root, resolvedPath, filePath);
  if (resolvedPath !== candidatePath) {
    throw new Error(`tracked path does not resolve canonically beneath the repository root: ${filePath}`);
  }

  const handle = await open(resolvedPath, "r");
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile() || openedStats.nlink !== 1 || openedStats.dev !== stats.dev || openedStats.ino !== stats.ino) {
      throw new Error(`tracked path changed while it was being validated: ${filePath}`);
    }
    const contents = await handle.readFile();
    const actualObjectId = gitBlobObjectId(contents, objectId.length);
    if (actualObjectId !== objectId) {
      throw new Error(`tracked path content differs from the Git index: ${filePath}`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function gitBlobObjectId(contents, objectIdLength) {
  const algorithm = objectIdLength === 40 ? "sha1" : objectIdLength === 64 ? "sha256" : undefined;
  if (!algorithm) throw new Error(`unsupported Git object ID length: ${objectIdLength}`);
  return createHash(algorithm)
    .update(`blob ${contents.length}\0`, "utf8")
    .update(contents)
    .digest("hex");
}

function assertPathWithinRoot(root, candidate, filePath) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    return;
  }
  throw new Error(`tracked path resolves outside the repository root: ${filePath}`);
}

function assertNoDuplicateStageZeroEntries(entries) {
  const seen = new Set();
  for (const { filePath, stage } of entries) {
    if (stage !== "0") continue;
    if (seen.has(filePath)) throw new Error(`tracked files contain a duplicate entry: ${filePath}`);
    seen.add(filePath);
  }
}

function verifyMarkdownLinks(trackedPaths, trackedContents) {
  const trackedDirectories = expectedDirectories(trackedPaths);
  for (const sourcePath of [...trackedPaths].filter((filePath) => filePath.toLowerCase().endsWith(".md"))) {
    const markdown = trackedContents.get(sourcePath).toString("utf8");
    for (const { destination, offset } of extractMarkdownDestinations(markdown)) {
      const target = resolveMarkdownTarget(sourcePath, destination);
      if (!target) continue;
      const candidates = [target];
      if (trackedDirectories.has(target)) candidates.push(`${target}/README.md`);
      if (!candidates.some((candidate) => trackedPaths.has(candidate))) {
        const line = markdown.slice(0, offset).split("\n").length;
        throw new Error(`tracked Markdown link leaves the tracked repository: ${sourcePath}:${line} -> ${destination}`);
      }
    }
  }
}

function extractMarkdownDestinations(markdown) {
  const results = [];
  const patterns = [
    /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+[^)]*)?\)/gu,
    /^\s*\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)(?:\s+.*)?$/gmu
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      results.push({ destination: match[1], offset: match.index ?? 0 });
    }
  }
  return results;
}

function resolveMarkdownTarget(sourcePath, rawDestination) {
  let destination = rawDestination;
  if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
  if (!destination || destination.startsWith("#") || destination.startsWith("//")) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)) return undefined;
  const separatorIndex = destination.search(/[?#]/u);
  if (separatorIndex >= 0) destination = destination.slice(0, separatorIndex);
  if (!destination) return undefined;
  try {
    destination = decodeURIComponent(destination);
  } catch {
    throw new Error(`invalid encoded Markdown link in ${sourcePath}: ${rawDestination}`);
  }
  if (destination.includes("\\")) throw new Error(`non-portable Markdown link in ${sourcePath}: ${rawDestination}`);
  const sourceDirectory = path.posix.dirname(sourcePath);
  const target = (destination.startsWith("/")
    ? path.posix.normalize(destination.slice(1))
    : path.posix.normalize(path.posix.join(sourceDirectory, destination))).replace(/\/$/u, "");
  if (!target || target === "." || target === ".." || target.startsWith("../")) {
    throw new Error(`Markdown link escapes the repository in ${sourcePath}: ${rawDestination}`);
  }
  validateRepositoryPath(target, "Markdown link");
  return target;
}

function expectedDirectories(trackedPaths) {
  const directories = new Set();
  for (const filePath of trackedPaths) {
    const segments = filePath.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

function validateRepositoryPath(entry, label) {
  if (!entry || entry !== entry.trim()) throw new Error(`${label} contains an empty or padded path`);
  if (/[\u0000-\u001f\u007f]/u.test(entry)) throw new Error(`${label} contains a control character`);
  if (entry.includes("\\")) throw new Error(`${label} contains a non-portable backslash path: ${entry}`);
  if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) {
    throw new Error(`${label} contains an absolute path: ${entry}`);
  }
  const segments = entry.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an invalid or traversing path: ${entry}`);
  }
  if (segments.includes(".git")) throw new Error(`${label} attempts to include Git metadata: ${entry}`);
  if (path.posix.normalize(entry) !== entry) throw new Error(`${label} contains a non-canonical path: ${entry}`);
}

function trustedGitEnvironment(gitCommand) {
  const env = {
    PATH: path.dirname(gitCommand),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LC_ALL: "C"
  };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "SYSTEMROOT", "WINDIR", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
