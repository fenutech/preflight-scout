import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyReleaseVersion } from "./verify-release-version.mjs";

const version = "1.2.3-beta.1";
const staleVersion = "1.2.2";
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-release-version-"));

try {
  await createFixture(fixtureRoot, version);

  const result = await verifyReleaseVersion(version, fixtureRoot);
  assert.deepEqual(result, {
    manifests: 6,
    sourceVersions: 3,
    releaseDocuments: 5,
    packageReadmes: 2
  });

  await withMutatedFile(
    "README.md",
    (contents) => contents.replace(
      `npm view @preflight-scout/cli@${version}`,
      `npm view @preflight-scout/cli@${staleVersion}`
    ),
    /README\.md \(CLI package pin\): 1\.2\.2/
  );

  await withMutatedFile(
    "skills/preflight-scout/SKILL.md",
    (contents) => contents.replace(`--skill-version ${version}`, `--skill-version ${staleVersion}`),
    /skills\/preflight-scout\/SKILL\.md \(skill compatibility pin\): 1\.2\.2/
  );

  await withMutatedFile(
    "packages/mcp/README.md",
    (contents) => contents.replace(`@preflight-scout/mcp@${version}`, `@preflight-scout/mcp@${staleVersion}`),
    /packages\/mcp\/README\.md \(@preflight-scout\/mcp package pin\): 1\.2\.2/
  );

  await withMutatedFile(
    "packages/cli/package.json",
    (contents) => contents.replace('"@preflight-scout/mcp": "workspace:*"', '"@preflight-scout/mcp": "workspace:^"'),
    /packages\/cli\/package\.json \(dependencies @preflight-scout\/mcp\): workspace:\^; expected workspace:\*/
  );

  await withMutatedFile(
    "docs/public-alpha.md",
    (contents) => contents.replace(`v${version}`, `v${staleVersion}`),
    /docs\/public-alpha\.md \(release tag\): 1\.2\.2/
  );

  await assert.rejects(
    verifyReleaseVersion(`v${version}`, fixtureRoot),
    /exact SemVer without a leading v/
  );

  console.log("Release-version guard tests passed aligned, stale-doc, stale-skill, stale-package-README, and exact-SemVer cases.");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function withMutatedFile(file, mutate, expectedError) {
  const absolute = path.join(fixtureRoot, file);
  const original = await readFile(absolute, "utf8");
  await writeFile(absolute, mutate(original), "utf8");
  try {
    await assert.rejects(verifyReleaseVersion(version, fixtureRoot), expectedError);
  } finally {
    await writeFile(absolute, original, "utf8");
  }
}

async function createFixture(root, releaseVersion) {
  const installDocument = [
    `Use the official \`v${releaseVersion}\` release.`,
    `npm view @preflight-scout/cli@${releaseVersion} version`,
    `npm install --global @preflight-scout/cli@${releaseVersion}`,
    `preflight-scout update-check --skill-version ${releaseVersion}`,
    ""
  ].join("\n");
  const files = {
    "package.json": json({ name: "preflight-scout", version: releaseVersion }),
    "apps/site/package.json": json({ name: "@preflight-scout/site", version: releaseVersion }),
    "packages/cli/package.json": json({
      name: "@preflight-scout/cli",
      version: releaseVersion,
      dependencies: { "@preflight-scout/mcp": "workspace:*" }
    }),
    "packages/mcp/package.json": json({ name: "@preflight-scout/mcp", version: releaseVersion }),
    ".codex-plugin/plugin.json": json({ name: "preflight-scout", version: releaseVersion }),
    ".claude-plugin/plugin.json": json({ name: "preflight-scout", version: releaseVersion }),
    "packages/cli/src/index.ts": `program.version("${releaseVersion}");\n`,
    "packages/mcp/src/index.ts": `const server = { name: "preflight-scout", version: "${releaseVersion}" };\n`,
    ".github/workflows/release-candidate.yml": [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      version:",
      `        default: "${releaseVersion}"`,
      ""
    ].join("\n"),
    "README.md": installDocument,
    "docs/public-alpha.md": installDocument,
    "docs/skills.md": installDocument,
    "skills/preflight-scout/references/cli-installation.md": installDocument,
    "skills/preflight-scout/SKILL.md": [
      "---",
      "name: preflight-scout",
      "description: Fixture",
      "---",
      `preflight-scout update-check --skill-version ${releaseVersion}`,
      ""
    ].join("\n"),
    "packages/cli/README.md": `After the v${releaseVersion} release, install @preflight-scout/cli@${releaseVersion}.\n`,
    "packages/mcp/README.md": `After the v${releaseVersion} release, install @preflight-scout/mcp@${releaseVersion}.\n`,
    "CHANGELOG.md": `## [${releaseVersion}] - Unreleased\n`,
    // GitHub Action examples intentionally follow the immutable release commit in a later PR.
    "docs/github-action.md": "Use fenutech/preflight-scout@0000000000000000000000000000000000000000 # v0.1.0\n"
  };

  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
