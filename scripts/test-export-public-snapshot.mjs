import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exporter = path.join(root, "scripts", "export-public-snapshot.sh");
const boundaryHelper = path.join(root, "scripts", "verify-public-snapshot-boundary.mjs");
const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-public-export-"));
const packageNames = ["agent-exec", "browser-runner", "cli", "core", "github-action", "mcp"];
const packageAssets = ["LICENSE", "NOTICE", "OUTPUT-LICENSE.md", "THIRD_PARTY_NOTICES.md"];
const fullSourceFixtureExcludedSegments = new Set([
  ".git",
  ".next",
  ".npm-cache",
  ".preflight",
  ".preflight-trusted-action",
  ".preflight-scout-trusted-action",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results"
]);
for (const localStatePath of [
  ".preflight/auth/legacy.json",
  ".preflight-scout/auth/current.json",
  ".preflight-trusted-action/package.json",
  ".preflight-scout-trusted-action/package.json"
]) {
  if (shouldCopyFullSourceFixture(path.join(root, localStatePath))) {
    throw new Error(`Full-source fixture must exclude local state: ${localStatePath}`);
  }
}
if (!shouldCopyFullSourceFixture(path.join(root, "examples", "nextjs-saas", ".preflight-scout", "config.yml"))) {
  throw new Error("Full-source fixture must retain the public nested Preflight Scout example config.");
}

try {
  const repo = await createFixtureRepo("regular");
  const regularOutput = path.join(tempRoot, "regular-output", "snapshot.tar.gz");
  assertSuccess(run(repo.exporter, [regularOutput]), "regular public snapshot export");
  const listing = run("tar", ["-tzf", regularOutput]);
  assertSuccess(listing, "public snapshot listing");
  const archiveEntries = listing.stdout.trimEnd().split(/\r?\n/u);
  if (!archiveEntries.includes("preflight-scout/README.md")) {
    throw new Error("Public snapshot did not contain the committed fixture file.");
  }
  if (archiveEntries.includes("preflight-scout/docs/publication.md")) {
    throw new Error("Public snapshot contained the private publication runbook.");
  }
  if (archiveEntries.includes("preflight-scout/apps/site/AGENTS.md")) {
    throw new Error("Public snapshot contained private website design instructions.");
  }
  if (archiveEntries.includes("preflight-scout/design-qa.md")) {
    throw new Error("Public snapshot contained the private design QA record.");
  }
  if (archiveEntries.includes("preflight-scout/scripts/public-snapshot-staging-only-files.txt")) {
    throw new Error("Public snapshot contained its private staging-only classification.");
  }
  for (const packageName of packageNames) {
    for (const packageAsset of packageAssets) {
      const archivePath = `preflight-scout/packages/${packageName}/${packageAsset}`;
      if (!archiveEntries.includes(archivePath)) {
        throw new Error(`Public snapshot did not contain required package asset ${archivePath}.`);
      }
    }
  }
  const regularContents = path.join(tempRoot, "regular-contents.txt");
  const regularMetadata = path.join(tempRoot, "regular-metadata.txt");
  const metadataListing = run("tar", ["-tvzf", regularOutput]);
  assertSuccess(metadataListing, "public snapshot metadata listing");
  await writeFile(regularContents, listing.stdout, "utf8");
  await writeFile(regularMetadata, metadataListing.stdout, "utf8");
  assertSuccess(
    run(process.execPath, [repo.helper, "archive", repo.publicManifest, regularContents, regularMetadata, "preflight-scout/"]),
    "direct exact-archive boundary verification"
  );
  await writeFile(regularContents, `${listing.stdout}preflight-scout/docs/publication.md\n`, "utf8");
  await writeFile(regularMetadata, `${metadataListing.stdout}-rw-r--r--  0 fixture fixture 0 Jan  1 00:00 preflight-scout/docs/publication.md\n`, "utf8");
  assertRejected(
    run(process.execPath, [repo.helper, "archive", repo.publicManifest, regularContents, regularMetadata, "preflight-scout/"]),
    "archive entry set does not exactly match the public manifest",
    "archive-listing tampering"
  );

  const fullRepo = await createFullSourceFixtureRepo("documented-snapshot-review");
  const fullArchive = path.join(tempRoot, "documented-snapshot-review.tar.gz");
  assertSuccess(run(fullRepo.exporter, [fullArchive]), "full public snapshot export");
  const reviewParent = path.join(tempRoot, "documented-snapshot-extraction");
  await mkdir(reviewParent);
  assertSuccess(run("tar", ["-xzf", fullArchive, "-C", reviewParent]), "full public snapshot extraction");
  const reviewRoot = path.join(reviewParent, "preflight-scout");
  await assertAbsent(path.join(reviewRoot, ".git"), "Extracted public snapshot unexpectedly contained Git metadata.");
  await assertAbsent(path.join(reviewRoot, "docs", "publication.md"), "Extracted public snapshot contained docs/publication.md.");
  await assertAbsent(path.join(reviewRoot, "apps", "site", "AGENTS.md"), "Extracted public snapshot contained apps/site/AGENTS.md.");
  await assertAbsent(path.join(reviewRoot, "design-qa.md"), "Extracted public snapshot contained design-qa.md.");
  await assertAbsent(
    path.join(reviewRoot, "scripts", "public-snapshot-staging-only-files.txt"),
    "Extracted public snapshot contained the staging-only manifest."
  );
  const extractedHelper = path.join(reviewRoot, "scripts", "verify-public-snapshot-boundary.mjs");
  const extractedManifest = path.join(reviewRoot, "scripts", "public-snapshot-files.txt");
  assertSuccess(
    run(process.execPath, [extractedHelper, "tree", reviewRoot, extractedManifest]),
    "closed-world verification in an extracted pre-git-init snapshot"
  );
  assertSuccess(
    run(process.execPath, ["scripts/verify-repository.mjs"], reviewRoot),
    "repository verification in an extracted pre-git-init snapshot"
  );
  await mkdir(path.join(reviewRoot, "docs"), { recursive: true });
  await writeFile(path.join(reviewRoot, "docs", "publication.md"), "must remain private\n", "utf8");
  assertRejected(
    run(process.execPath, [extractedHelper, "tree", reviewRoot, extractedManifest]),
    "public tree file set does not exactly match the public manifest",
    "private file injected into an extracted tree"
  );
  await rm(path.join(reviewRoot, "docs", "publication.md"));

  await initializeRepository(reviewRoot, "public snapshot fixture");
  assertSuccess(
    run(process.execPath, [
      extractedHelper,
      "worktree",
      reviewRoot,
      "git",
      extractedManifest,
      path.join(reviewRoot, "scripts", "public-snapshot-staging-only-files.txt")
    ], reviewRoot),
    "closed-world verification after Git initialization without staging-only files"
  );

  const untrackedAsset = "packages/core/LICENSE";
  assertSuccess(run("git", ["rm", "--cached", "--", untrackedAsset], fullRepo.root), "remove package asset from the fixture index");
  const untrackedVerification = runBoundaryWorktree(fullRepo);
  assertRejected(untrackedVerification, `public manifest entry is missing or untracked: ${untrackedAsset}`, "untracked public entry");

  const unclassifiedRepo = await createFixtureRepo("unclassified-tracked-file");
  await writeFile(path.join(unclassifiedRepo.root, "private-notes.md"), "not classified\n", "utf8");
  await commitAll(unclassifiedRepo.root, "add unclassified file");
  assertRejected(
    run(unclassifiedRepo.exporter, [path.join(tempRoot, "unclassified.tar.gz")]),
    "tracked path is not classified as public or staging-only: private-notes.md",
    "unclassified tracked file"
  );

  const missingPublicRepo = await createFixtureRepo("missing-public-entry");
  await rewritePublicManifest(missingPublicRepo.root, (paths) => [...paths, "ghost.md"]);
  await commitAll(missingPublicRepo.root, "add missing public entry");
  assertRejected(
    run(missingPublicRepo.exporter, [path.join(tempRoot, "missing-public-entry.tar.gz")]),
    "public manifest entry is missing or untracked: ghost.md",
    "missing or untracked public entry"
  );

  const privateTamperRepo = await createFixtureRepo("private-manifest-tampering");
  await rewritePublicManifest(privateTamperRepo.root, (paths) => [...paths, "docs/publication.md"]);
  await writeManifest(
    path.join(privateTamperRepo.root, "scripts", "public-snapshot-staging-only-files.txt"),
    ["scripts/public-snapshot-staging-only-files.txt"]
  );
  await commitAll(privateTamperRepo.root, "attempt to publish private runbook");
  assertRejected(
    run(privateTamperRepo.exporter, [path.join(tempRoot, "private-tamper.tar.gz")]),
    "required staging-only path cannot be public: docs/publication.md",
    "private runbook manifest tampering"
  );

  const designInstructionTamperRepo = await createFixtureRepo("design-instruction-manifest-tampering");
  await mkdir(path.join(designInstructionTamperRepo.root, "apps", "site"), { recursive: true });
  await writeFile(path.join(designInstructionTamperRepo.root, "apps", "site", "AGENTS.md"), "private visual source path\n", "utf8");
  await rewritePublicManifest(designInstructionTamperRepo.root, (paths) => [...paths, "apps/site/AGENTS.md"]);
  await commitAll(designInstructionTamperRepo.root, "attempt to publish private website instructions");
  assertRejected(
    run(designInstructionTamperRepo.exporter, [path.join(tempRoot, "design-instruction-tamper.tar.gz")]),
    "required staging-only path cannot be public: apps/site/AGENTS.md",
    "private website instruction manifest tampering"
  );

  const designQaTamperRepo = await createFixtureRepo("design-qa-manifest-tampering");
  await rewritePublicManifest(designQaTamperRepo.root, (paths) => [...paths, "design-qa.md"]);
  await writeManifest(
    path.join(designQaTamperRepo.root, "scripts", "public-snapshot-staging-only-files.txt"),
    ["docs/publication.md", "scripts/public-snapshot-staging-only-files.txt"]
  );
  await commitAll(designQaTamperRepo.root, "attempt to publish private design QA evidence");
  assertRejected(
    run(designQaTamperRepo.exporter, [path.join(tempRoot, "design-qa-tamper.tar.gz")]),
    "required staging-only path cannot be public: design-qa.md",
    "private design QA manifest tampering"
  );

  const duplicateRepo = await createFixtureRepo("duplicate-manifest-entry");
  await rewritePublicManifest(duplicateRepo.root, (paths) => [...paths, "README.md"]);
  await commitAll(duplicateRepo.root, "duplicate manifest entry");
  assertRejected(
    run(duplicateRepo.exporter, [path.join(tempRoot, "duplicate.tar.gz")]),
    "public manifest contains a duplicate entry: README.md",
    "duplicate manifest entry"
  );

  const traversalRepo = await createFixtureRepo("traversing-manifest-entry");
  await rewritePublicManifest(traversalRepo.root, (paths) => [...paths, "../outside.txt"]);
  await commitAll(traversalRepo.root, "traversing manifest entry");
  assertRejected(
    run(traversalRepo.exporter, [path.join(tempRoot, "traversal.tar.gz")]),
    "public manifest contains an invalid or traversing path: ../outside.txt",
    "traversing manifest entry"
  );

  const leakingLinkRepo = await createFixtureRepo("public-link-to-private-doc", undefined, {
    readme: "# Public fixture\n\n[private release notes](docs/publication.md)\n"
  });
  assertRejected(
    run(leakingLinkRepo.exporter, [path.join(tempRoot, "leaking-link.tar.gz")]),
    "public Markdown link leaves the public manifest: README.md:3 -> docs/publication.md",
    "public Markdown link to a staging-only file"
  );

  const missingAssetRepo = await createFixtureRepo("missing-package-asset", undefined, {
    omitPackageAsset: "packages/core/LICENSE"
  });
  const missingAssetResult = run(missingAssetRepo.exporter, [path.join(tempRoot, "missing-package-asset.tar.gz")]);
  assertRejected(missingAssetResult, "required package asset", "missing package asset");

  const poisonBin = path.join(repo.root, "node_modules", ".bin");
  const poisonMarker = path.join(tempRoot, "poison-marker.txt");
  await mkdir(poisonBin, { recursive: true });
  for (const name of ["git", "node", "tar", "gzip", "shasum", "awk", "grep", "mkdir", "mktemp", "mv", "rm", "dirname", "basename"]) {
    const shim = path.join(poisonBin, name);
    await writeFile(shim, "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$PREFLIGHT_SCOUT_POISON_MARKER\"\nexit 97\n", { encoding: "utf8", mode: 0o755 });
  }
  const poisonOutput = path.join(tempRoot, "poison-output", "snapshot.tar.gz");
  const poisonResult = run(repo.exporter, [poisonOutput], undefined, {
    ...process.env,
    PATH: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`,
    PREFLIGHT_SCOUT_POISON_MARKER: poisonMarker
  });
  assertSuccess(poisonResult, "public snapshot export with a poisoned repository PATH entry");
  await assertAbsent(poisonMarker, "Public snapshot exporter executed a repository-local command shim.");

  const sentinel = path.join(tempRoot, "outside-sentinel.txt");
  await writeFile(sentinel, "must not be overwritten", "utf8");
  const symlinkOutputDir = path.join(tempRoot, "symlink-output");
  await mkdir(symlinkOutputDir);
  const symlinkOutput = path.join(symlinkOutputDir, "snapshot.tar.gz");
  await symlink(sentinel, symlinkOutput);
  const outputSymlinkResult = run(repo.exporter, [symlinkOutput]);
  assertRejected(outputSymlinkResult, "symlink", "output-file symlink");
  if (await readFile(sentinel, "utf8") !== "must not be overwritten" || !(await lstat(symlinkOutput)).isSymbolicLink()) {
    throw new Error("Public snapshot exporter modified an output symlink or its target.");
  }

  const redirectedDirectory = path.join(tempRoot, "redirected-directory");
  const directorySymlink = path.join(tempRoot, "directory-symlink");
  await mkdir(redirectedDirectory);
  await symlink(redirectedDirectory, directorySymlink, "dir");
  const directorySymlinkResult = run(repo.exporter, [path.join(directorySymlink, "snapshot.tar.gz")]);
  assertRejected(directorySymlinkResult, "symlink", "output-directory symlink");
  await assertAbsent(
    path.join(redirectedDirectory, "snapshot.tar.gz"),
    "Public snapshot exporter wrote through an output-directory symlink."
  );

  const symlinkRepo = await createFixtureRepo("tracked-symlink", sentinel);
  const trackedSymlinkOutput = path.join(tempRoot, "tracked-symlink.tar.gz");
  const trackedSymlinkResult = run(symlinkRepo.exporter, [trackedSymlinkOutput]);
  assertRejected(trackedSymlinkResult, "tracked path is a symlink, not a regular file", "tracked symlink");
  await assertAbsent(trackedSymlinkOutput, "Public snapshot exporter installed an archive containing a tracked symlink.");

  const hardlinkRepo = await createFixtureRepo("tracked-hardlink");
  await link(path.join(hardlinkRepo.root, "README.md"), path.join(hardlinkRepo.root, "hardlinked-copy.md"));
  await rewritePublicManifest(hardlinkRepo.root, (paths) => [...paths, "hardlinked-copy.md"]);
  await commitAll(hardlinkRepo.root, "add hard-linked public file");
  assertRejected(
    run(hardlinkRepo.exporter, [path.join(tempRoot, "tracked-hardlink.tar.gz")]),
    "tracked path has multiple hard links",
    "tracked hard link"
  );

  const submoduleRepo = await createFixtureRepo("tracked-submodule", undefined, { extraPublicPaths: ["vendor/submodule"] });
  const fixtureHead = run("git", ["rev-parse", "HEAD"], submoduleRepo.root);
  assertSuccess(fixtureHead, "read fixture commit for submodule entry");
  assertSuccess(
    run("git", ["update-index", "--add", "--cacheinfo", `160000,${fixtureHead.stdout.trim()},vendor/submodule`], submoduleRepo.root),
    "add fixture gitlink"
  );
  assertRejected(runBoundaryWorktree(submoduleRepo), "tracked path is a submodule, not a regular file", "tracked submodule");

  console.log(
    "Public snapshot export is a closed-world allowlist: private staging material is absent, links stay public, " +
      "extracted trees verify before Git initialization, and unsafe paths, modes, tools, and destinations are rejected."
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function createFixtureRepo(name, trackedSymlinkTarget, {
  extraPublicPaths = [],
  omitPackageAsset,
  readme = "# Public fixture\n"
} = {}) {
  const repo = path.join(tempRoot, name);
  const scripts = path.join(repo, "scripts");
  await mkdir(scripts, { recursive: true });
  const fixtureExporter = path.join(scripts, "export-public-snapshot.sh");
  const fixtureHelper = path.join(scripts, "verify-public-snapshot-boundary.mjs");
  await copyFile(exporter, fixtureExporter);
  await chmod(fixtureExporter, 0o755);
  await copyFile(boundaryHelper, fixtureHelper);
  await writeFile(path.join(repo, "README.md"), readme, "utf8");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n", "utf8");
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, "docs", "publication.md"), "# Private publication runbook\n", "utf8");
  await writeFile(path.join(repo, "design-qa.md"), "# Private design QA\n", "utf8");

  const publicPaths = [
    ".gitignore",
    "README.md",
    "scripts/export-public-snapshot.sh",
    "scripts/public-snapshot-files.txt",
    "scripts/verify-public-snapshot-boundary.mjs",
    ...extraPublicPaths
  ];
  for (const packageName of packageNames) {
    const packageDirectory = path.join(repo, "packages", packageName);
    await mkdir(packageDirectory, { recursive: true });
    for (const packageAsset of packageAssets) {
      const relativePath = path.posix.join("packages", packageName, packageAsset);
      publicPaths.push(relativePath);
      if (relativePath === omitPackageAsset) continue;
      await writeFile(path.join(packageDirectory, packageAsset), `${packageAsset} fixture\n`, "utf8");
    }
  }
  if (trackedSymlinkTarget) {
    publicPaths.push("outside-sentinel.txt");
    await symlink(trackedSymlinkTarget, path.join(repo, "outside-sentinel.txt"));
  }
  await writeManifest(path.join(scripts, "public-snapshot-files.txt"), publicPaths);
  await writeManifest(path.join(scripts, "public-snapshot-staging-only-files.txt"), [
    "design-qa.md",
    "docs/publication.md",
    "scripts/public-snapshot-staging-only-files.txt"
  ]);

  await initializeRepository(repo, "fixture");
  return {
    root: repo,
    exporter: fixtureExporter,
    helper: fixtureHelper,
    publicManifest: path.join(scripts, "public-snapshot-files.txt"),
    stagingManifest: path.join(scripts, "public-snapshot-staging-only-files.txt")
  };
}

async function createFullSourceFixtureRepo(name) {
  const repo = path.join(tempRoot, name);
  await cp(root, repo, {
    recursive: true,
    filter: (source) => shouldCopyFullSourceFixture(source)
  });
  const fixtureExporter = path.join(repo, "scripts", "export-public-snapshot.sh");
  await chmod(fixtureExporter, 0o755);
  await initializeRepository(repo, "full public fixture");
  return {
    root: repo,
    exporter: fixtureExporter,
    helper: path.join(repo, "scripts", "verify-public-snapshot-boundary.mjs"),
    publicManifest: path.join(repo, "scripts", "public-snapshot-files.txt"),
    stagingManifest: path.join(repo, "scripts", "public-snapshot-staging-only-files.txt")
  };
}

function shouldCopyFullSourceFixture(source) {
  const relative = path.relative(root, source);
  if (!relative) return true;
  if (relative === path.join("apps", "site", "public", "example-report") || relative.startsWith(`${path.join("apps", "site", "public", "example-report")}${path.sep}`)) return false;
  const segments = relative.split(path.sep);
  if (segments[0] === ".preflight-scout") return false;
  if (segments.some((segment) => fullSourceFixtureExcludedSegments.has(segment))) return false;
  if (segments.at(-1) === ".DS_Store" || relative.endsWith(".tsbuildinfo")) return false;
  if (segments.length === 1 && segments[0].startsWith(".env") && segments[0] !== ".env.example" && segments[0] !== ".env.preflight-scout.example") {
    return false;
  }
  return true;
}

async function initializeRepository(repo, commitMessage) {
  for (const [command, args] of [
    ["git", ["init", "--initial-branch=main"]],
    ["git", ["config", "user.name", "Preflight Scout Test"]],
    ["git", ["config", "user.email", "preflight-scout@example.invalid"]],
    ["git", ["add", "."]],
    ["git", ["commit", "-m", commitMessage]]
  ]) {
    assertSuccess(run(command, args, repo), `${command} ${args.join(" ")}`);
  }
}

async function commitAll(repo, commitMessage) {
  assertSuccess(run("git", ["add", "-A"], repo), "stage fixture mutation");
  assertSuccess(run("git", ["commit", "-m", commitMessage], repo), "commit fixture mutation");
}

async function rewritePublicManifest(repo, transform) {
  const manifest = path.join(repo, "scripts", "public-snapshot-files.txt");
  const paths = (await readFile(manifest, "utf8")).trimEnd().split("\n");
  await writeManifest(manifest, transform(paths));
}

async function writeManifest(manifest, entries) {
  await writeFile(manifest, `${[...entries].sort(compareStrings).join("\n")}\n`, "utf8");
}

function runBoundaryWorktree(repo) {
  return run(process.execPath, [
    repo.helper,
    "worktree",
    repo.root,
    "git",
    repo.publicManifest,
    repo.stagingManifest
  ], repo.root);
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
    throw new Error(`Public snapshot boundary did not reject ${label}:\n${combinedOutput(result)}`);
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

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
