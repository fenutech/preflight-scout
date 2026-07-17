import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), "..");
const semverSource = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
const exactSemver = new RegExp(`^${semverSource}$`);
const exactStableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const semverBoundary = String.raw`(?![0-9A-Za-z+-]|\.[0-9A-Za-z-])`;

const releaseInstallDocuments = [
  "README.md",
  "docs/public-alpha.md",
  "docs/skills.md",
  "skills/preflight-scout/references/cli-installation.md"
];

export async function prepareRelease(targetVersion, options = {}) {
  const root = path.resolve(options.root ?? defaultRoot);
  const releaseDate = options.releaseDate ?? new Date().toISOString().slice(0, 10);
  if (typeof targetVersion !== "string" || !exactStableSemver.test(targetVersion)) {
    throw new Error("Target version must be stable SemVer X.Y.Z without a leading v, prerelease, or build metadata.");
  }
  const target = parseSemver(targetVersion, "Target version");
  assertReleaseDate(releaseDate);

  const originals = new Map();
  const planned = new Map();
  const read = async (file) => {
    if (!originals.has(file)) originals.set(file, await readFile(path.join(root, file), "utf8"));
    return planned.get(file) ?? originals.get(file);
  };
  const plan = async (file, transform) => {
    const before = await read(file);
    const after = transform(before);
    if (after === before) throw new Error(`${file} was not changed; the release surface is missing or already inconsistent.`);
    planned.set(file, after);
  };

  const rootManifest = parseJson(await read("package.json"), "package.json");
  const currentVersion = rootManifest.version;
  const current = parseSemver(currentVersion, "Current package.json version");
  if (compareSemver(target, current) <= 0) {
    throw new Error(`Target version ${targetVersion} must be greater than current version ${currentVersion}.`);
  }

  const packageEntries = await readdir(path.join(root, "packages"), { withFileTypes: true });
  const packageManifestFiles = packageEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "package.json"))
    .sort();
  if (packageManifestFiles.length === 0) throw new Error("No package manifests were found beneath packages/.");

  const manifestFiles = [
    "package.json",
    "apps/site/package.json",
    ...packageManifestFiles,
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json"
  ];
  const packageNames = new Map();
  for (const file of manifestFiles) {
    const contents = await read(file);
    const manifest = parseJson(contents, file);
    if (manifest.version !== currentVersion) {
      throw new Error(`${file} has version ${String(manifest.version)}; expected current version ${currentVersion}.`);
    }
    if (file.startsWith("packages/")) {
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@preflight-scout/")) {
        throw new Error(`${file} must declare an @preflight-scout package name.`);
      }
      if (packageNames.has(manifest.name)) throw new Error(`Duplicate package name ${manifest.name}.`);
      packageNames.set(manifest.name, file);
    }
    await plan(file, (text) => replaceExactlyOne(
      text,
      new RegExp(`("version"\\s*:\\s*")${escapeRegExp(currentVersion)}(")`),
      `$1${targetVersion}$2`,
      `${file} version`
    ));
  }

  await plan("packages/cli/src/index.ts", (text) => replaceExactlyOne(
    text,
    new RegExp(`(\\.version\\(["'])${escapeRegExp(currentVersion)}(["']\\))`),
    `$1${targetVersion}$2`,
    "CLI runtime version"
  ));
  await plan("packages/mcp/src/index.ts", (text) => replaceExactlyOne(
    text,
    new RegExp(`(name:\\s*["']preflight-scout["'][\\s\\S]*?version:\\s*["'])${escapeRegExp(currentVersion)}(["'])`),
    `$1${targetVersion}$2`,
    "MCP runtime version"
  ));
  for (const file of releaseInstallDocuments) {
    await plan(file, (text) => {
      let updated = replaceAtLeastOne(
        text,
        new RegExp(`v${escapeRegExp(currentVersion)}${semverBoundary}`, "g"),
        `v${targetVersion}`,
        `${file} release tag`
      );
      updated = replaceAtLeastOne(
        updated,
        new RegExp(`@preflight-scout/cli@${escapeRegExp(currentVersion)}${semverBoundary}`, "g"),
        `@preflight-scout/cli@${targetVersion}`,
        `${file} CLI package pin`
      );
      return replaceAtLeastOne(
        updated,
        new RegExp(`(preflight-scout update-check --skill-version\\s+)${escapeRegExp(currentVersion)}${semverBoundary}`, "g"),
        `$1${targetVersion}`,
        `${file} skill compatibility pin`
      );
    });
  }

  await plan("skills/preflight-scout/SKILL.md", (text) => replaceAtLeastOne(
    text,
    new RegExp(`(preflight-scout update-check --skill-version\\s+)${escapeRegExp(currentVersion)}${semverBoundary}`, "g"),
    `$1${targetVersion}`,
    "Agent Skill compatibility pin"
  ));
  await plan("docs/release-checklist.md", (text) => replaceExactlyOne(
    text,
    new RegExp(`(VERSION=["'])${escapeRegExp(currentVersion)}(["'])`),
    `$1${targetVersion}$2`,
    "release checklist version"
  ));

  for (const [packageName, manifestFile] of packageNames) {
    const readme = path.join(path.dirname(manifestFile), "README.md");
    await plan(readme, (text) => {
      let updated = replaceAtLeastOne(
        text,
        new RegExp(`v${escapeRegExp(currentVersion)}${semverBoundary}`, "g"),
        `v${targetVersion}`,
        `${readme} release tag`
      );
      return replaceAtLeastOne(
        updated,
        new RegExp(`${escapeRegExp(packageName)}@${escapeRegExp(currentVersion)}${semverBoundary}`, "g"),
        `${packageName}@${targetVersion}`,
        `${readme} package pin`
      );
    });
  }

  await plan("CHANGELOG.md", (text) => promoteUnreleased(text, {
    currentVersion,
    targetVersion,
    releaseDate
  }));

  for (const [file, contents] of [...planned].sort(([left], [right]) => left.localeCompare(right))) {
    await writeFile(path.join(root, file), contents, "utf8");
  }

  return {
    currentVersion,
    targetVersion,
    releaseDate,
    filesChanged: planned.size,
    manifestsChanged: manifestFiles.length,
    packageReadmesChanged: packageNames.size
  };
}

function promoteUnreleased(contents, { currentVersion, targetVersion, releaseDate }) {
  const unreleasedMatches = [...contents.matchAll(/^## \[Unreleased\]\s*$/gm)];
  if (unreleasedMatches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one ## [Unreleased] section; found ${unreleasedMatches.length}.`);
  }
  const targetHeader = new RegExp(`^## \\[${escapeRegExp(targetVersion)}\\](?:\\s+-|\\s*$)`, "m");
  if (targetHeader.test(contents)) throw new Error(`CHANGELOG.md already contains a ${targetVersion} release section.`);
  const currentHeader = new RegExp(`^## \\[${escapeRegExp(currentVersion)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  if (!currentHeader.test(contents)) {
    throw new Error(`CHANGELOG.md has no dated section for current version ${currentVersion}.`);
  }

  const match = unreleasedMatches[0];
  const contentStart = match.index + match[0].length;
  const remainder = contents.slice(contentStart);
  const nextHeader = remainder.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}\s*$/m);
  if (!nextHeader || nextHeader.index === undefined) {
    throw new Error("CHANGELOG.md has no dated release section after ## [Unreleased].");
  }
  if (nextHeader[1] !== currentVersion) {
    throw new Error(
      `CHANGELOG.md first release after ## [Unreleased] is ${nextHeader[1]}; expected current version ${currentVersion}.`
    );
  }
  const unreleased = remainder.slice(0, nextHeader.index).trim();
  if (!unreleased) throw new Error("CHANGELOG.md ## [Unreleased] must contain release notes before preparation.");

  const before = contents.slice(0, contentStart).trimEnd();
  const after = remainder.slice(nextHeader.index).trimStart();
  return `${before}\n\n## [${targetVersion}] - ${releaseDate}\n\n${unreleased}\n\n${after}`;
}

function replaceExactlyOne(contents, pattern, replacement, label) {
  const matches = [...contents.matchAll(asGlobal(pattern))];
  if (matches.length !== 1) throw new Error(`${label} must appear exactly once; found ${matches.length}.`);
  return contents.replace(pattern, replacement);
}

function replaceAtLeastOne(contents, pattern, replacement, label) {
  const matches = [...contents.matchAll(asGlobal(pattern))];
  if (matches.length === 0) throw new Error(`${label} is missing.`);
  return contents.replace(pattern, replacement);
}

function asGlobal(pattern) {
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

function parseJson(contents, file) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseSemver(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be exact SemVer without a leading v.`);
  const match = value.match(exactSemver);
  if (!match) throw new Error(`${label} must be exact SemVer without a leading v.`);
  return {
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".") ?? []
  };
}

function compareSemver(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function assertReleaseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Release date must use YYYY-MM-DD.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("Release date must be a real UTC calendar date in YYYY-MM-DD form.");
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArguments(argumentsList) {
  const argumentsCopy = [...argumentsList];
  const targetVersion = argumentsCopy.shift();
  let releaseDate;
  while (argumentsCopy.length > 0) {
    const option = argumentsCopy.shift();
    if (option !== "--date" || releaseDate !== undefined || argumentsCopy.length === 0) {
      throw new Error("Usage: node scripts/prepare-release.mjs <version> [--date YYYY-MM-DD]");
    }
    releaseDate = argumentsCopy.shift();
  }
  if (!targetVersion) throw new Error("Usage: node scripts/prepare-release.mjs <version> [--date YYYY-MM-DD]");
  return { targetVersion, releaseDate };
}

async function main() {
  const { targetVersion, releaseDate } = parseArguments(process.argv.slice(2));
  const result = await prepareRelease(targetVersion, { releaseDate });
  console.log(
    `Prepared ${result.targetVersion} from ${result.currentVersion} for ${result.releaseDate}: `
      + `${result.filesChanged} files (${result.manifestsChanged} manifests and `
      + `${result.packageReadmesChanged} generated package READMEs).`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) await main();
