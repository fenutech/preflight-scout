import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const REQUIRED_STAGING_ONLY_PATHS = new Set([
  "apps/site/AGENTS.md",
  "design-qa.md",
  "docs/publication.md",
  "scripts/public-snapshot-staging-only-files.txt"
]);

try {
  await main();
} catch (error) {
  console.error(`Public snapshot boundary check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "worktree" && args.length === 4) {
    await verifyWorktree(...args);
    return;
  }
  if (mode === "archive" && args.length === 4) {
    await verifyArchive(...args);
    return;
  }
  if (mode === "tree" && args.length === 2) {
    await verifyTree(...args);
    return;
  }
  throw new Error(
    "usage: verify-public-snapshot-boundary.mjs " +
      "worktree <repo-root> <git-command> <public-manifest> <staging-manifest> | " +
      "archive <public-manifest> <contents-file> <metadata-file> <prefix> | " +
      "tree <tree-root> <public-manifest>"
  );
}

async function verifyWorktree(repoRoot, gitCommand, publicManifestPath, stagingManifestPath) {
  const root = path.resolve(repoRoot);
  const publicManifest = await readManifest(publicManifestPath, "public manifest");
  const stagingManifest = await readManifest(stagingManifestPath, "staging-only manifest", { optional: true });
  validateClassification(publicManifest, stagingManifest);

  const manifestRelativePath = toRepoRelative(root, publicManifestPath, "public manifest");
  if (!publicManifest.includes(manifestRelativePath)) {
    throw new Error(`the public manifest must classify itself as public: ${manifestRelativePath}`);
  }

  const trackedEntries = readTrackedEntries(root, gitCommand);
  const trackedPaths = new Set(trackedEntries.map(({ filePath }) => filePath));
  const publicPaths = new Set(publicManifest);
  const stagingPaths = new Set(stagingManifest);

  for (const filePath of publicManifest) {
    if (!trackedPaths.has(filePath)) {
      throw new Error(`public manifest entry is missing or untracked: ${filePath}`);
    }
  }
  for (const filePath of stagingManifest) {
    if (!trackedPaths.has(filePath)) {
      throw new Error(`staging-only manifest entry is missing or untracked: ${filePath}`);
    }
  }
  for (const { filePath, mode, stage } of trackedEntries) {
    if (stage !== "0") throw new Error(`unmerged tracked path is not exportable: ${filePath}`);
    if (mode !== "100644" && mode !== "100755") {
      const kind = mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : `mode ${mode}`;
      throw new Error(`tracked path is a ${kind}, not a regular file: ${filePath}`);
    }
    if (!publicPaths.has(filePath) && !stagingPaths.has(filePath)) {
      throw new Error(`tracked path is not classified as public or staging-only: ${filePath}`);
    }
    const stat = await lstat(path.join(root, ...filePath.split("/"))).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`tracked path is missing or non-regular in the worktree: ${filePath}`);
    }
    if (stat.nlink !== 1) {
      throw new Error(`tracked path has multiple hard links: ${filePath}`);
    }
  }

  await verifyMarkdownLinks(root, publicManifest);
  console.log(`Public snapshot boundary: ${publicManifest.length} public and ${stagingManifest.length} staging-only files are classified.`);
}

async function verifyArchive(publicManifestPath, contentsPath, metadataPath, prefixArgument) {
  const publicManifest = await readManifest(publicManifestPath, "public manifest");
  validateClassification(publicManifest, []);
  const prefix = validateArchivePrefix(prefixArgument);
  const contents = await readLineList(contentsPath, "archive contents");
  const metadata = await readLineList(metadataPath, "archive metadata");
  if (contents.length !== metadata.length) {
    throw new Error(`archive listing and metadata lengths differ (${contents.length} vs ${metadata.length})`);
  }

  const expected = expectedArchiveEntries(publicManifest, prefix);
  assertExactSet(contents, expected, "archive entry");
  for (let index = 0; index < contents.length; index += 1) {
    const archivePath = contents[index];
    const expectedType = archivePath.endsWith("/") ? "d" : "-";
    const actualType = metadata[index]?.[0];
    if (actualType !== expectedType) {
      throw new Error(`archive contains a symlink or non-regular entry: ${archivePath}`);
    }
  }
  console.log(`Public snapshot archive exactly matches ${publicManifest.length} public files under ${prefix}.`);
}

async function verifyTree(treeRoot, publicManifestPath) {
  const root = path.resolve(treeRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`tree root is not a regular directory: ${root}`);
  }
  const publicManifest = await readManifest(publicManifestPath, "public manifest");
  validateClassification(publicManifest, []);
  const manifestRelativePath = toRepoRelative(root, publicManifestPath, "public manifest");
  if (!publicManifest.includes(manifestRelativePath)) {
    throw new Error(`the public manifest must classify itself as public: ${manifestRelativePath}`);
  }

  const { files, directories } = await walkTree(root);
  assertExactSet(files, publicManifest, "public tree file");
  assertExactSet(directories, expectedDirectories(publicManifest), "public tree directory");
  await verifyMarkdownLinks(root, publicManifest);
  console.log(`Public snapshot tree exactly matches ${publicManifest.length} public files.`);
}

async function readManifest(manifestPath, label, { optional = false } = {}) {
  let contents;
  try {
    contents = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (optional && error?.code === "ENOENT") return [];
    throw new Error(`${label} is unavailable: ${manifestPath}`);
  }
  if (!contents.endsWith("\n")) throw new Error(`${label} must end with a newline`);
  if (contents.includes("\r")) throw new Error(`${label} must use LF line endings`);
  const entries = contents.slice(0, -1).split("\n");
  if (entries.length === 1 && entries[0] === "") throw new Error(`${label} must not be empty`);
  for (const entry of entries) validateManifestPath(entry, label);
  const sorted = [...entries].sort(compareStrings);
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index] !== sorted[index]) throw new Error(`${label} entries must be sorted exactly`);
  }
  assertNoDuplicates(entries, label);
  return entries;
}

function validateManifestPath(entry, label) {
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

function validateClassification(publicManifest, stagingManifest) {
  const publicPaths = new Set(publicManifest);
  for (const filePath of stagingManifest) {
    if (publicPaths.has(filePath)) throw new Error(`path is classified more than once: ${filePath}`);
  }
  for (const filePath of REQUIRED_STAGING_ONLY_PATHS) {
    if (publicPaths.has(filePath)) throw new Error(`required staging-only path cannot be public: ${filePath}`);
  }
}

function readTrackedEntries(repoRoot, gitCommand) {
  const result = spawnSync(
    gitCommand,
    ["-C", repoRoot, "-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`could not enumerate tracked files: ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`);
  }
  const entries = [];
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("Git returned an invalid tracked-file record");
    const [mode, , stage] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    validateManifestPath(filePath, "tracked files");
    entries.push({ filePath, mode, stage });
  }
  assertNoDuplicates(entries.map(({ filePath }) => filePath), "tracked files");
  return entries;
}

async function walkTree(root) {
  const files = [];
  const directories = [];
  async function visit(absoluteDirectory, relativeDirectory) {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      validateManifestPath(relativePath, "public tree");
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`public tree contains a symlink: ${relativePath}`);
      if (stat.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`public tree file has multiple hard links: ${relativePath}`);
        files.push(relativePath);
      } else {
        throw new Error(`public tree contains a non-regular entry: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return { files, directories };
}

async function verifyMarkdownLinks(root, publicManifest) {
  const publicPaths = new Set(publicManifest);
  const publicDirectories = new Set(expectedDirectories(publicManifest));
  for (const sourcePath of publicManifest.filter((filePath) => filePath.toLowerCase().endsWith(".md"))) {
    const markdown = await readFile(path.join(root, ...sourcePath.split("/")), "utf8");
    for (const { destination, offset } of extractMarkdownDestinations(markdown)) {
      const target = resolveMarkdownTarget(sourcePath, destination);
      if (!target) continue;
      const candidates = [target];
      if (publicDirectories.has(target)) candidates.push(`${target}/README.md`);
      if (!candidates.some((candidate) => publicPaths.has(candidate))) {
        const line = markdown.slice(0, offset).split("\n").length;
        throw new Error(`public Markdown link leaves the public manifest: ${sourcePath}:${line} -> ${destination}`);
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
    throw new Error(`Markdown link escapes the public tree in ${sourcePath}: ${rawDestination}`);
  }
  validateManifestPath(target, "Markdown link");
  return target;
}

function expectedArchiveEntries(publicManifest, prefix) {
  const entries = new Set([prefix]);
  for (const directory of expectedDirectories(publicManifest)) entries.add(`${prefix}${directory}/`);
  for (const filePath of publicManifest) entries.add(`${prefix}${filePath}`);
  return [...entries].sort(compareStrings);
}

function expectedDirectories(publicManifest) {
  const directories = new Set();
  for (const filePath of publicManifest) {
    const segments = filePath.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [...directories].sort(compareStrings);
}

function validateArchivePrefix(prefix) {
  if (!prefix.endsWith("/")) throw new Error(`archive prefix must end in /: ${prefix}`);
  const withoutSlash = prefix.slice(0, -1);
  validateManifestPath(withoutSlash, "archive prefix");
  if (withoutSlash.includes("/")) throw new Error(`archive prefix must have exactly one segment: ${prefix}`);
  return prefix;
}

async function readLineList(filePath, label) {
  const contents = await readFile(filePath, "utf8");
  if (!contents.endsWith("\n")) throw new Error(`${label} must end with a newline`);
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length === 1 && !lines[0]) return [];
  assertNoDuplicates(lines, label);
  return lines;
}

function assertExactSet(actualValues, expectedValues, label) {
  assertNoDuplicates(actualValues, label);
  const actual = [...actualValues].sort(compareStrings);
  const expected = [...expectedValues].sort(compareStrings);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  const missing = expected.filter((value) => !actualSet.has(value));
  if (unexpected.length || missing.length) {
    const details = [];
    if (unexpected.length) details.push(`unexpected: ${unexpected.join(", ")}`);
    if (missing.length) details.push(`missing: ${missing.join(", ")}`);
    throw new Error(`${label} set does not exactly match the public manifest (${details.join("; ")})`);
  }
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} contains a duplicate entry: ${value}`);
    seen.add(value);
  }
}

function toRepoRelative(root, candidate, label) {
  const relative = path.relative(root, path.resolve(candidate)).split(path.sep).join("/");
  validateManifestPath(relative, label);
  if (relative.startsWith("../")) throw new Error(`${label} must be inside the repository`);
  return relative;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
