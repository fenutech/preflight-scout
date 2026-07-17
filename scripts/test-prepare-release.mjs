import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./prepare-release.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoots = [];

try {
  await testSuccessfulPreparation();
  await testRejectsPrereleaseAndBuildVersions();
  await testRejectsNonIncreasingVersionWithoutWrites();
  await testRejectsEmptyUnreleasedWithoutWrites();
  await testRejectsMissingReleaseSurfaceWithoutWrites();
  await testRejectsOutOfOrderChangelogWithoutWrites();
  await testWorkflowBoundary();
  console.log("Release-preparation tests passed lockstep mutation, changelog promotion, SemVer, fail-closed, and workflow-boundary cases.");
} finally {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

async function testSuccessfulPreparation() {
  const root = await createFixture("1.2.3", changelogNotes());
  const result = await prepareRelease("1.3.0", { root, releaseDate: "2026-07-18" });

  assert.deepEqual(result, {
    currentVersion: "1.2.3",
    targetVersion: "1.3.0",
    releaseDate: "2026-07-18",
    filesChanged: 20,
    manifestsChanged: 7,
    packageReadmesChanged: 3
  });

  for (const file of [
    "package.json",
    "apps/site/package.json",
    "packages/cli/package.json",
    "packages/core/package.json",
    "packages/mcp/package.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json"
  ]) {
    assert.equal(JSON.parse(await read(root, file)).version, "1.3.0", file);
  }
  assert.match(await read(root, "packages/cli/src/index.ts"), /\.version\("1\.3\.0"\)/);
  assert.match(await read(root, "packages/mcp/src/index.ts"), /version: "1\.3\.0"/);
  assert.match(await read(root, ".github/workflows/release-candidate.yml"), /default: "1\.3\.0"/);
  assert.match(await read(root, "docs/release-checklist.md"), /VERSION="1\.3\.0"/);

  for (const file of [
    "README.md",
    "docs/public-alpha.md",
    "docs/skills.md",
    "skills/preflight-scout/references/cli-installation.md"
  ]) {
    const contents = await read(root, file);
    assert.match(contents, /v1\.3\.0/);
    assert.match(contents, /@preflight-scout\/cli@1\.3\.0/);
    assert.match(contents, /update-check --skill-version 1\.3\.0/);
    assert.doesNotMatch(contents, /1\.2\.3/);
  }
  assert.match(await read(root, "skills/preflight-scout/SKILL.md"), /update-check --skill-version 1\.3\.0/);
  assert.match(await read(root, "packages/cli/README.md"), /@preflight-scout\/cli@1\.3\.0/);
  assert.match(await read(root, "packages/core/README.md"), /@preflight-scout\/core@1\.3\.0/);
  assert.match(await read(root, "packages/mcp/README.md"), /@preflight-scout\/mcp@1\.3\.0/);

  const changelog = await read(root, "CHANGELOG.md");
  assert.match(changelog, /^## \[Unreleased\]\n\n## \[1\.3\.0\] - 2026-07-18$/m);
  assert.match(changelog, /## \[1\.3\.0\][\s\S]*### Added[\s\S]*Added deterministic release preparation\.[\s\S]*## \[1\.2\.3\]/);
}

async function testRejectsPrereleaseAndBuildVersions() {
  const root = await createFixture("1.2.3", changelogNotes());
  const before = await snapshot(root);
  for (const target of ["1.2.4-beta.1", "1.2.4+build.1"]) {
    await assert.rejects(
      prepareRelease(target, { root, releaseDate: "2026-07-18" }),
      /must be stable SemVer X\.Y\.Z/
    );
    assert.deepEqual(await snapshot(root), before);
  }
}

async function testRejectsNonIncreasingVersionWithoutWrites() {
  const root = await createFixture("1.2.3", changelogNotes());
  const before = await snapshot(root);
  await assert.rejects(
    prepareRelease("1.2.3", { root, releaseDate: "2026-07-18" }),
    /must be greater than current version 1\.2\.3/
  );
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(
    prepareRelease("v1.2.4", { root, releaseDate: "2026-07-18" }),
    /must be stable SemVer X\.Y\.Z/
  );
}

async function testRejectsEmptyUnreleasedWithoutWrites() {
  const root = await createFixture("1.2.3", "");
  const before = await snapshot(root);
  await assert.rejects(
    prepareRelease("1.2.4", { root, releaseDate: "2026-07-18" }),
    /\#\# \[Unreleased\] must contain release notes/
  );
  assert.deepEqual(await snapshot(root), before);
}

async function testRejectsMissingReleaseSurfaceWithoutWrites() {
  const root = await createFixture("1.2.3", changelogNotes());
  const publicAlpha = path.join(root, "docs/public-alpha.md");
  await writeFile(publicAlpha, (await readFile(publicAlpha, "utf8")).replace(
    "preflight-scout update-check --skill-version 1.2.3",
    "preflight-scout update-check"
  ));
  const before = await snapshot(root);
  await assert.rejects(
    prepareRelease("1.2.4", { root, releaseDate: "2026-07-18" }),
    /docs\/public-alpha\.md skill compatibility pin is missing/
  );
  assert.deepEqual(await snapshot(root), before);
}

async function testRejectsOutOfOrderChangelogWithoutWrites() {
  const root = await createFixture("1.2.3", changelogNotes());
  const changelog = path.join(root, "CHANGELOG.md");
  await writeFile(changelog, (await readFile(changelog, "utf8")).replace(
    "## [1.2.3] - 2026-07-17",
    "## [1.4.0] - 2026-07-17\n\nFuture drift.\n\n## [1.2.3] - 2026-07-16"
  ));
  const before = await snapshot(root);
  await assert.rejects(
    prepareRelease("1.3.0", { root, releaseDate: "2026-07-18" }),
    /first release after ## \[Unreleased\] is 1\.4\.0; expected current version 1\.2\.3/
  );
  assert.deepEqual(await snapshot(root), before);
}

async function testWorkflowBoundary() {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/prepare-release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /gh auth setup-git/);
  assert.match(workflow, /codex\/release-v\$\{VERSION\}/);
  assert.match(workflow, /explicit approval, thumbs-up, or no-blocker comment/);
  assert.match(workflow, /prepared_tree.*git rev-parse.*remote_ref.*\^\{tree\}/);
  assert.match(workflow, /refusing to replace a reviewed tree/);
  assert.match(workflow, /github-actions\[bot\]/);
  assert.match(workflow, /compare\/main\.\.\.\$\{branch\}\?expand=1/);
  assert.match(workflow, /gh workflow run ci\.yml/);
  for (const forbidden of [
    "pull-requests: write",
    "gh pr create",
    "gh pr edit",
    "gh pr merge",
    "git tag",
    "npm publish",
    "pnpm publish",
    "gh release create",
    "--force"
  ]) {
    assert.equal(workflow.includes(forbidden), false, `workflow must not contain ${forbidden}`);
  }
}

async function createFixture(version, unreleased) {
  const root = await mkdtemp(path.join(tmpdir(), "preflight-scout-prepare-release-"));
  fixtureRoots.push(root);
  const installDocument = [
    `Use the official v${version} release.`,
    `npm view @preflight-scout/cli@${version} version`,
    `npm install --global @preflight-scout/cli@${version}`,
    `preflight-scout update-check --skill-version ${version}`,
    ""
  ].join("\n");
  const files = {
    "package.json": json({ name: "preflight-scout", version, private: true }),
    "apps/site/package.json": json({ name: "@preflight-scout/site", version, private: true }),
    "packages/cli/package.json": json({ name: "@preflight-scout/cli", version }),
    "packages/core/package.json": json({ name: "@preflight-scout/core", version }),
    "packages/mcp/package.json": json({ name: "@preflight-scout/mcp", version }),
    ".codex-plugin/plugin.json": json({ name: "preflight-scout", version }),
    ".claude-plugin/plugin.json": json({ name: "preflight-scout", version }),
    "packages/cli/src/index.ts": `program.version("${version}");\n`,
    "packages/mcp/src/index.ts": `const server = { name: "preflight-scout", version: "${version}" };\n`,
    ".github/workflows/release-candidate.yml": [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      version:",
      `        default: "${version}"`,
      ""
    ].join("\n"),
    "README.md": installDocument,
    "docs/public-alpha.md": installDocument,
    "docs/skills.md": installDocument,
    "skills/preflight-scout/references/cli-installation.md": installDocument,
    "skills/preflight-scout/SKILL.md": `preflight-scout update-check --skill-version ${version}\n`,
    "docs/release-checklist.md": `VERSION="${version}" # exact release\n`,
    "packages/cli/README.md": `After v${version}, install @preflight-scout/cli@${version}.\n`,
    "packages/core/README.md": `After v${version}, install @preflight-scout/core@${version}.\n`,
    "packages/mcp/README.md": `After v${version}, install @preflight-scout/mcp@${version}.\n`,
    "CHANGELOG.md": [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      unreleased,
      ...(unreleased ? [""] : []),
      `## [${version}] - 2026-07-17`,
      "",
      "Previous release.",
      ""
    ].join("\n")
  };

  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return root;
}

function changelogNotes() {
  return "### Added\n\n- Added deterministic release preparation.";
}

async function snapshot(root) {
  const files = [
    "package.json",
    "apps/site/package.json",
    "packages/cli/package.json",
    "packages/core/package.json",
    "packages/mcp/package.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "packages/cli/src/index.ts",
    "packages/mcp/src/index.ts",
    ".github/workflows/release-candidate.yml",
    "README.md",
    "docs/public-alpha.md",
    "docs/skills.md",
    "skills/preflight-scout/references/cli-installation.md",
    "skills/preflight-scout/SKILL.md",
    "docs/release-checklist.md",
    "packages/cli/README.md",
    "packages/core/README.md",
    "packages/mcp/README.md",
    "CHANGELOG.md"
  ];
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await read(root, file)])));
}

async function read(root, file) {
  return readFile(path.join(root, file), "utf8");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
