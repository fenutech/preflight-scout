import { spawnSync } from "node:child_process";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "scripts", "verify-repository-boundary.mjs");
const resolver = path.join(root, "scripts", "resolve-external-tool.mjs");
const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-repository-boundary-"));

try {
  const regular = await createFixture("regular");
  assertSuccess(runBoundary(regular), "regular repository boundary");

  const spacedPath = await createFixture("path-with-spaces");
  await writeFile(path.join(spacedPath, "docs", "guide with spaces.md"), "# Spaced guide\n", "utf8");
  await writeFile(
    path.join(spacedPath, "README.md"),
    "# Fixture\n\n[Guide](docs/guide.md)\n[Spaced guide](<docs/guide with spaces.md>)\n",
    "utf8"
  );
  await commitAll(spacedPath, "add tracked path with spaces");
  assertSuccess(runBoundary(spacedPath), "tracked path and Markdown link with spaces");

  const sha256 = await createFixture("sha256-repository", { objectFormat: "sha256" });
  assertSuccess(runBoundary(sha256), "SHA-256 repository boundary");

  const poisoned = await createFixture("poisoned-path");
  const poisonBin = path.join(poisoned, "node_modules", ".bin");
  const poisonMarker = path.join(tempRoot, "poison-marker.txt");
  await mkdir(poisonBin, { recursive: true });
  const fakeGit = path.join(poisonBin, "git");
  await writeFile(fakeGit, "#!/bin/sh\nprintf 'used' > \"$PREFLIGHT_SCOUT_POISON_MARKER\"\nexit 97\n", { mode: 0o755 });
  assertSuccess(runBoundary(poisoned, {
    ...process.env,
    PATH: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`,
    PREFLIGHT_SCOUT_POISON_MARKER: poisonMarker
  }), "repository boundary with poisoned repository PATH");
  await assertAbsent(poisonMarker, "Repository boundary executed a repository-local Git shim.");

  const missing = await createFixture("missing-file");
  await rm(path.join(missing, "README.md"));
  assertRejected(runBoundary(missing), "tracked path is missing or non-regular in the worktree: README.md", "missing file");

  const nonRegular = await createFixture("non-regular-file");
  await rm(path.join(nonRegular, "README.md"));
  await mkdir(path.join(nonRegular, "README.md"));
  assertRejected(runBoundary(nonRegular), "tracked path is missing or non-regular in the worktree: README.md", "non-regular file");

  const symlinked = await createFixture("tracked-symlink");
  const sentinel = path.join(tempRoot, "outside.txt");
  await writeFile(sentinel, "outside\n", "utf8");
  await rm(path.join(symlinked, "docs", "guide.md"));
  await symlink(sentinel, path.join(symlinked, "docs", "guide.md"));
  await commitAll(symlinked, "replace guide with a symlink");
  assertRejected(runBoundary(symlinked), "tracked path is a symlink, not a regular file: docs/guide.md", "tracked symlink");

  const symlinkedAncestor = await createFixture("symlinked-parent-directory");
  const trackedDirectory = path.join(symlinkedAncestor, "nested");
  await mkdir(trackedDirectory);
  await writeFile(path.join(trackedDirectory, "guide.md"), "# Nested guide\n", "utf8");
  await commitAll(symlinkedAncestor, "add nested guide");
  const redirectedDirectory = path.join(tempRoot, "outside-directory");
  await mkdir(redirectedDirectory);
  await writeFile(path.join(redirectedDirectory, "guide.md"), "# Nested guide\n", "utf8");
  await rm(trackedDirectory, { recursive: true });
  await symlink(redirectedDirectory, trackedDirectory, "dir");
  assertRejected(
    runBoundary(symlinkedAncestor),
    "tracked path has a symlinked ancestor: nested/guide.md (nested)",
    "symlinked parent directory escape"
  );

  const hardlinked = await createFixture("tracked-hardlink");
  await link(path.join(hardlinked, "README.md"), path.join(hardlinked, "README-copy.md"));
  await commitAll(hardlinked, "add hard-linked file");
  assertRejected(runBoundary(hardlinked), "tracked path has multiple hard links", "tracked hard link");

  const submodule = await createFixture("tracked-submodule");
  const head = run("git", ["rev-parse", "HEAD"], submodule);
  assertSuccess(head, "read fixture commit");
  assertSuccess(
    run("git", ["update-index", "--add", "--cacheinfo", `160000,${head.stdout.trim()},vendor/module`], submodule),
    "add fixture gitlink"
  );
  assertRejected(runBoundary(submodule), "tracked path is a submodule, not a regular file: vendor/module", "tracked submodule");

  const unmerged = await createFixture("unmerged");
  await writeFile(path.join(unmerged, "conflict.txt"), "base\n", "utf8");
  await commitAll(unmerged, "add conflict base");
  assertSuccess(run("git", ["checkout", "-b", "conflicting-change"], unmerged), "create conflicting branch");
  await writeFile(path.join(unmerged, "conflict.txt"), "branch\n", "utf8");
  await commitAll(unmerged, "change on branch");
  assertSuccess(run("git", ["checkout", "main"], unmerged), "return to main");
  await writeFile(path.join(unmerged, "conflict.txt"), "main\n", "utf8");
  await commitAll(unmerged, "change on main");
  const merge = run("git", ["merge", "conflicting-change"], unmerged);
  if (merge.status === 0) throw new Error("Fixture merge unexpectedly avoided a conflict.");
  assertRejected(runBoundary(unmerged), "unmerged tracked path is not allowed: conflict.txt", "unmerged index entry");

  const unsafeIndexHiddenBySafeWorktree = await createFixture("unsafe-index-safe-worktree");
  await writeFile(
    path.join(unsafeIndexHiddenBySafeWorktree, "README.md"),
    "# Unsafe staged candidate\n\n[outside](../outside.md)\n",
    "utf8"
  );
  assertSuccess(run("git", ["add", "--", "README.md"], unsafeIndexHiddenBySafeWorktree), "stage unsafe candidate");
  await writeFile(
    path.join(unsafeIndexHiddenBySafeWorktree, "README.md"),
    "# Safe worktree disguise\n\n[Guide](docs/guide.md)\n",
    "utf8"
  );
  assertRejected(
    runBoundary(unsafeIndexHiddenBySafeWorktree),
    "tracked path content differs from the Git index: README.md",
    "unsafe staged candidate hidden by a safe unstaged rewrite"
  );

  const safeIndexWithUnsafeWorktree = await createFixture("safe-index-unsafe-worktree");
  await writeFile(
    path.join(safeIndexWithUnsafeWorktree, "README.md"),
    "# Safe staged candidate\n\n[Guide](docs/guide.md)\n",
    "utf8"
  );
  assertSuccess(run("git", ["add", "--", "README.md"], safeIndexWithUnsafeWorktree), "stage safe candidate");
  await writeFile(
    path.join(safeIndexWithUnsafeWorktree, "README.md"),
    "# Unsafe worktree rewrite\n\n[outside](../outside.md)\n",
    "utf8"
  );
  assertRejected(
    runBoundary(safeIndexWithUnsafeWorktree),
    "tracked path content differs from the Git index: README.md",
    "safe staged candidate with an unsafe unstaged rewrite"
  );

  const untrackedLink = await createFixture("untracked-markdown-link");
  await writeFile(path.join(untrackedLink, "README.md"), "# Fixture\n\n[private](private.md)\n", "utf8");
  await commitAll(untrackedLink, "link to untracked file");
  await writeFile(path.join(untrackedLink, "private.md"), "not tracked\n", "utf8");
  assertRejected(
    runBoundary(untrackedLink),
    "tracked Markdown link leaves the tracked repository: README.md:3 -> private.md",
    "Markdown link to an untracked file"
  );

  const escapingLink = await createFixture("escaping-markdown-link");
  await writeFile(path.join(escapingLink, "README.md"), "# Fixture\n\n[outside](../../outside.md)\n", "utf8");
  await commitAll(escapingLink, "add escaping link");
  assertRejected(
    runBoundary(escapingLink),
    "Markdown link escapes the repository in README.md: ../../outside.md",
    "escaping Markdown link"
  );

  const encodedTraversal = await createFixture("encoded-traversal-link");
  await writeFile(path.join(encodedTraversal, "README.md"), "# Fixture\n\n[outside](%2e%2e/outside.md)\n", "utf8");
  await commitAll(encodedTraversal, "add encoded traversal link");
  assertRejected(
    runBoundary(encodedTraversal),
    "Markdown link escapes the repository in README.md: %2e%2e/outside.md",
    "encoded Markdown traversal"
  );

  console.log(
    "Repository boundary binds SHA-1/SHA-256 index blobs to canonical worktree paths and rejects unmerged, " +
      "unsafe-mode, missing, non-regular, symlinked-ancestor, hard-linked, mismatched, and Markdown-escaping content."
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function createFixture(name, { objectFormat = "sha1" } = {}) {
  const repository = path.join(tempRoot, name);
  await mkdir(path.join(repository, "scripts"), { recursive: true });
  await mkdir(path.join(repository, "docs"), { recursive: true });
  await copyFile(helper, path.join(repository, "scripts", "verify-repository-boundary.mjs"));
  await copyFile(resolver, path.join(repository, "scripts", "resolve-external-tool.mjs"));
  await writeFile(path.join(repository, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(path.join(repository, "README.md"), "# Fixture\n\n[Guide](docs/guide.md)\n", "utf8");
  await writeFile(path.join(repository, "docs", "guide.md"), "# Guide\n\n[Home](../README.md)\n", "utf8");
  await writeFile(path.join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path.join(repository, "executable.sh"), 0o755);
  await initializeRepository(repository, objectFormat);
  return repository;
}

async function initializeRepository(repository, objectFormat) {
  for (const [command, args] of [
    ["git", ["init", "--initial-branch=main", `--object-format=${objectFormat}`]],
    ["git", ["config", "user.name", "Preflight Scout Test"]],
    ["git", ["config", "user.email", "preflight-scout@example.invalid"]],
    ["git", ["add", "."]],
    ["git", ["commit", "-m", "fixture"]]
  ]) {
    assertSuccess(run(command, args, repository), `${command} ${args.join(" ")}`);
  }
}

async function commitAll(repository, message) {
  assertSuccess(run("git", ["add", "-A"], repository), "stage fixture mutation");
  assertSuccess(run("git", ["commit", "-m", message], repository), "commit fixture mutation");
}

function runBoundary(repository, env = process.env) {
  return run(process.execPath, [path.join(repository, "scripts", "verify-repository-boundary.mjs"), repository], repository, env);
}

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...env, LC_ALL: "C" }
  });
}

function assertSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with ${result.status}:\n${combinedOutput(result)}`);
}

function assertRejected(result, expectedMessage, label) {
  if (result.error) throw result.error;
  if (result.status === 0 || !combinedOutput(result).includes(expectedMessage)) {
    throw new Error(`Repository boundary did not reject ${label}:\n${combinedOutput(result)}`);
  }
}

async function assertAbsent(filePath, message) {
  try {
    await lstat(filePath);
    throw new Error(message);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}
