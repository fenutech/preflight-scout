import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");
const sharedAssets = ["LICENSE", "NOTICE", "OUTPUT-LICENSE.md", "THIRD_PARTY_NOTICES.md"];
const checkOnly = process.argv.includes("--check");
const drift = [];

const packageDirs = await fs.readdir(packagesDir, { withFileTypes: true });

for (const entry of packageDirs) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(packagesDir, entry.name);
  const manifestPath = path.join(dir, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const asset of sharedAssets) {
    await synchronize(path.join(root, asset), path.join(dir, asset));
  }
  await synchronizeText(path.join(dir, "README.md"), packageReadme(manifest));
}

if (drift.length) {
  throw new Error(`Generated package assets are stale:\n${drift.map((file) => `- ${path.relative(root, file)}`).join("\n")}\nRun pnpm prepare:packages and commit the result.`);
}

console.log(`${checkOnly ? "Verified" : "Synchronized"} generated package assets for ${packageDirs.filter((entry) => entry.isDirectory()).length} packages.`);

async function synchronize(source, destination) {
  const expected = await fs.readFile(source);
  if (checkOnly) {
    const actual = await fs.readFile(destination).catch(() => undefined);
    if (!actual?.equals(expected)) drift.push(destination);
    return;
  }
  await fs.writeFile(destination, expected);
}

async function synchronizeText(destination, expected) {
  if (checkOnly) {
    const actual = await fs.readFile(destination, "utf8").catch(() => undefined);
    if (actual === undefined || normalizeLineEndings(actual) !== normalizeLineEndings(expected)) drift.push(destination);
    return;
  }
  await fs.writeFile(destination, expected, "utf8");
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

function packageReadme(manifest) {
  const isCli = manifest.name === "@preflight-scout/cli";
  const install = isCli
    ? `Requirements: Node.js 22.13 or newer. For users and agents, the
recommended release installation uses npm. This README can exist in source
before publication, so first confirm that the official v${manifest.version}
release and the live registry both list ${manifest.name}@${manifest.version}.
After both checks pass:

\`\`\`bash
npm view ${manifest.name}@${manifest.version} version --registry=https://registry.npmjs.org/
npm install --global ${manifest.name}@${manifest.version} --registry=https://registry.npmjs.org/
preflight-scout install-browser
preflight-scout --version
\`\`\`

Keep the exact version pin. For a quick, non-durable trial after the same
release checks:

\`\`\`bash
npm exec --yes --registry=https://registry.npmjs.org/ --package=${manifest.name}@${manifest.version} -- preflight-scout --help
\`\`\`

For an existing installation, check npm without changing the machine:

\`\`\`bash
preflight-scout update-check
\`\`\`

When a newer release exists, the command prints the exact pinned npm install
command. It never updates itself.

Until that exact release is live—or when contributing—use a stable trusted
checkout of the monorepo. The source installer builds and verifies the CLI,
installs a durable wrapper, and installs Chromium:

\`\`\`bash
corepack enable
pnpm install --frozen-lockfile
pnpm install:source-cli
preflight-scout --version
\`\`\``
    : `After the official v${manifest.version} release and the live npm registry
both list this exact package version:

\`\`\`bash
npm install ${manifest.name}@${manifest.version} --registry=https://registry.npmjs.org/
\`\`\``;
  const cliDemo = isCli
    ? `
Create a repo-agnostic demo target:

\`\`\`bash
preflight-scout demo --output /tmp/preflight-scout-generic-shop --force
\`\`\`
`.trim()
    : "";
  return `# ${manifest.name}

${manifest.description}

This package is part of [Preflight Scout](https://github.com/fenutech/preflight-scout), which maps pull-request changes, runs focused checks and bounded browser missions, and records release evidence.

## Install

Confirm the currently supported installation paths in the root README and the
npm registry. A package README may also be present in an unreleased source
archive, so do not treat this file alone as proof that a registry release exists.

${install}${cliDemo ? `\n\n${cliDemo}` : ""}

## License

AGPL-3.0-only. See \`LICENSE\`. Generated reports and promoted tests are covered by the separate terms in \`OUTPUT-LICENSE.md\`.
`;
}
