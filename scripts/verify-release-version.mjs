import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionArguments = process.argv.slice(2).filter((argument) => argument !== "--");
const requested = versionArguments.length === 1 ? versionArguments[0].trim().replace(/^v/, "") : undefined;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

if (!requested || !semverPattern.test(requested)) {
  throw new Error("Usage: node scripts/verify-release-version.mjs <semver>");
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

const sourceVersions = [
  await readSourceVersion("packages/cli/src/index.ts", /\.version\(["']([^"']+)["']\)/, "CLI --version"),
  await readSourceVersion("packages/mcp/src/index.ts", /name:\s*["']preflight-scout["'][\s\S]*?version:\s*["']([^"']+)["']/, "MCP client version"),
  await readWorkflowInputDefault(".github/workflows/release-candidate.yml", "version", "release-candidate default")
];
for (const item of sourceVersions) {
  if (item.version !== requested) mismatches.push(`${item.file} (${item.label}): ${item.version}`);
}

if (mismatches.length) {
  throw new Error(`Release version ${requested} does not match:\n${mismatches.join("\n")}`);
}

const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
const changelogHeader = new RegExp(`^## \\[${escapeRegExp(requested)}\\] - (?:Unreleased|\\d{4}-\\d{2}-\\d{2})\\s*$`, "m");
if (!changelogHeader.test(changelog)) {
  throw new Error(`CHANGELOG.md has no section for ${requested}.`);
}

console.log(`Release version ${requested} matches ${manifests.length} manifests, ${sourceVersions.length} runtime/release constants, and CHANGELOG.md.`);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readSourceVersion(file, pattern, label) {
  const source = await readFile(path.join(root, file), "utf8");
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Could not locate ${label} in ${file}.`);
  return { file, label, version: match[1] };
}

async function readWorkflowInputDefault(file, inputName, label) {
  const lines = (await readFile(path.join(root, file), "utf8")).split(/\r?\n/);
  const inputsIndex = lines.findIndex((line) => line.trim() === "inputs:");
  if (inputsIndex < 0) throw new Error(`Could not locate workflow inputs in ${file}.`);
  const inputsIndent = indentation(lines[inputsIndex]);

  for (let index = inputsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = indentation(line);
    if (indent <= inputsIndent) break;
    if (line.trim() !== `${inputName}:`) continue;

    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      const nestedLine = lines[nestedIndex];
      if (!nestedLine.trim() || nestedLine.trimStart().startsWith("#")) continue;
      const nestedIndent = indentation(nestedLine);
      if (nestedIndent <= indent) break;
      const match = nestedLine.trim().match(/^default:\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))\s*(?:#.*)?$/);
      const version = match?.[1] ?? match?.[2] ?? match?.[3];
      if (version !== undefined) return { file, label, version };
    }
    break;
  }
  throw new Error(`Could not locate ${label} in ${file}.`);
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
