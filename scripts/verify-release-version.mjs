import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), "..");
const semverSource = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?`;
const semverPattern = new RegExp(`^${semverSource}$`);
const cliPackageReferencePattern = new RegExp(
  String.raw`@preflight-scout\/cli@(${semverSource})(?![0-9A-Za-z.+-])`,
  "g"
);
const releaseTagReferencePattern = new RegExp(
  String.raw`(?:^|[^0-9A-Za-z.+-])v(${semverSource})(?![0-9A-Za-z.+-])`,
  "gm"
);
const skillCompatibilityPattern = new RegExp(
  String.raw`preflight-scout update-check --skill-version\s+(${semverSource})(?![0-9A-Za-z.+-])`,
  "g"
);

const releaseInstallDocuments = [
  "README.md",
  "docs/public-alpha.md",
  "docs/skills.md",
  "skills/preflight-scout/references/cli-installation.md"
];

const skillCompatibilityDocuments = [
  ...releaseInstallDocuments,
  "skills/preflight-scout/SKILL.md"
];

export async function verifyReleaseVersion(requested, root = defaultRoot) {
  if (!requested || !semverPattern.test(requested)) {
    throw new Error("Release version must be exact SemVer without a leading v.");
  }

  const manifests = [
    { file: "package.json", manifest: await readJson(path.join(root, "package.json")) },
    { file: "apps/site/package.json", manifest: await readJson(path.join(root, "apps/site/package.json")) }
  ];
  const packageEntries = await readdir(path.join(root, "packages"), { withFileTypes: true });

  for (const entry of packageEntries.filter((item) => item.isDirectory())) {
    const file = path.join("packages", entry.name, "package.json");
    manifests.push({ file, manifest: await readJson(path.join(root, file)) });
  }

  for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    manifests.push({ file, manifest: await readJson(path.join(root, file)) });
  }

  const mismatches = manifests
    .filter(({ manifest }) => manifest.version !== requested)
    .map(({ file, manifest }) => `${file} (${manifest.name}): ${manifest.version}`);

  const internalPackages = new Set(
    manifests
      .filter(({ file }) => file.startsWith("packages/"))
      .map(({ manifest }) => manifest.name)
  );
  for (const { file, manifest } of manifests.filter(({ file }) => file.startsWith("packages/"))) {
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (internalPackages.has(name) && range !== "workspace:*") {
          mismatches.push(`${file} (${section} ${name}): ${range}; expected workspace:*`);
        }
      }
    }
  }

  const sourceVersions = [
    await readSourceVersion(root, "packages/cli/src/index.ts", /\.version\(["']([^"']+)["']\)/, "CLI --version"),
    await readSourceVersion(root, "packages/mcp/src/index.ts", /name:\s*["']preflight-scout["'][\s\S]*?version:\s*["']([^"']+)["']/, "MCP client version")
  ];
  for (const item of sourceVersions) {
    if (item.version !== requested) mismatches.push(`${item.file} (${item.label}): ${item.version}`);
  }

  for (const file of releaseInstallDocuments) {
    const contents = await readFile(path.join(root, file), "utf8");
    collectVersionReferences(mismatches, file, "release tag", contents, releaseTagReferencePattern, requested);
    collectVersionReferences(mismatches, file, "CLI package pin", contents, cliPackageReferencePattern, requested);
  }

  for (const file of skillCompatibilityDocuments) {
    const contents = await readFile(path.join(root, file), "utf8");
    collectVersionReferences(mismatches, file, "skill compatibility pin", contents, skillCompatibilityPattern, requested);
  }

  for (const { file, manifest } of manifests.filter(({ file }) => file.startsWith("packages/"))) {
    const readmeFile = path.join(path.dirname(file), "README.md");
    const contents = await readFile(path.join(root, readmeFile), "utf8");
    const packageReferencePattern = new RegExp(
      `${escapeRegExp(manifest.name)}@(${semverSource})(?=$|[\\s\`"',;)\\]]|\\.(?:\\s|$))`,
      "g"
    );
    collectVersionReferences(mismatches, readmeFile, `${manifest.name} package pin`, contents, packageReferencePattern, requested);
    collectVersionReferences(mismatches, readmeFile, "release tag", contents, releaseTagReferencePattern, requested);
  }

  if (mismatches.length) {
    throw new Error(`Release version ${requested} does not match:\n${mismatches.join("\n")}`);
  }

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const changelogHeader = new RegExp(`^## \\[${escapeRegExp(requested)}\\] - (?:Unreleased|\\d{4}-\\d{2}-\\d{2})\\s*$`, "m");
  if (!changelogHeader.test(changelog)) {
    throw new Error(`CHANGELOG.md has no section for ${requested}.`);
  }

  return {
    manifests: manifests.length,
    sourceVersions: sourceVersions.length,
    releaseDocuments: new Set([...releaseInstallDocuments, ...skillCompatibilityDocuments]).size,
    packageReadmes: manifests.filter(({ file }) => file.startsWith("packages/")).length
  };
}

function collectVersionReferences(mismatches, file, label, contents, pattern, requested) {
  const versions = [...contents.matchAll(pattern)].map((match) => match[1]);
  if (versions.length === 0) {
    mismatches.push(`${file} (${label}): missing`);
    return;
  }
  for (const version of new Set(versions)) {
    if (version !== requested) mismatches.push(`${file} (${label}): ${version}`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readSourceVersion(root, file, pattern, label) {
  const source = await readFile(path.join(root, file), "utf8");
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Could not locate ${label} in ${file}.`);
  return { file, label, version: match[1] };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const versionArguments = process.argv.slice(2).filter((argument) => argument !== "--");
  const requested = versionArguments.length === 1 ? versionArguments[0].trim().replace(/^v/, "") : undefined;
  if (!requested) throw new Error("Usage: node scripts/verify-release-version.mjs <semver>");
  const result = await verifyReleaseVersion(requested);
  console.log(
    `Release version ${requested} matches ${result.manifests} manifests, ${result.sourceVersions} runtime/release constants, `
      + `${result.releaseDocuments} release/skill documents, ${result.packageReadmes} package READMEs, and CHANGELOG.md.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  await main();
}
