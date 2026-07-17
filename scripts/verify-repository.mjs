import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveExternalTool } from "./resolve-external-tool.mjs";

const root = process.cwd();
const execFileAsync = promisify(execFile);
const failures = [];
const requiredFiles = [
  ".editorconfig",
  ".env.example",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/documentation.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/labeler.yml",
  ".github/pull_request_template.md",
  ".github/release.yml",
  ".github/workflows/browser-tests.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/labeler.yml",
  ".github/workflows/preflight-scout-self-check.yml",
  ".github/workflows/publish.yml",
  ".github/workflows/release-candidate.yml",
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "apps/site/jsconfig.json",
  "apps/site/next.config.mjs",
  "apps/site/package.json",
  "apps/site/public/_headers",
  "apps/site/public/brand/instrument-frame.webp",
  "apps/site/public/brand/instrument-texture.webp",
  "apps/site/public/brand/preflight-scout-mark.png",
  "apps/site/public/favicon.ico",
  "apps/site/public/licenses/fonts-OFL.txt",
  "apps/site/public/licenses/phosphor-MIT.txt",
  "apps/site/public/opengraph-image.png",
  "apps/site/public/site.js",
  "apps/site/scripts/check-static-export.mjs",
  "apps/site/scripts/strip-next-runtime.mjs",
  "apps/site/scripts/sync-sample-report.mjs",
  "apps/site/src/app/example-report/page.jsx",
  "apps/site/src/app/globals.css",
  "apps/site/src/app/install/page.jsx",
  "apps/site/src/app/layout.jsx",
  "apps/site/src/app/manifest.js",
  "apps/site/src/app/not-found.jsx",
  "apps/site/src/app/page.jsx",
  "apps/site/src/app/robots.js",
  "apps/site/src/app/security/page.jsx",
  "apps/site/src/app/sitemap.js",
  "apps/site/src/components/CopyCommand.jsx",
  "apps/site/src/components/InstrumentReport.jsx",
  "apps/site/src/components/SiteFooter.jsx",
  "apps/site/src/components/SiteHeader.jsx",
  "apps/site/src/components/WorkflowSteps.jsx",
  "apps/site/src/lib/sample-report.js",
  "apps/site/src/lib/site.js",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "COMMERCIAL-LICENSE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "OUTPUT-LICENSE.md",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/maintainer-guide.md",
  "scripts/install-source-cli.mjs",
  "scripts/npm-global-install-smoke-lib.mjs",
  "scripts/npm-global-install-smoke.mjs",
  "scripts/package-build-integrity.mjs",
  "scripts/package-build-paths.mjs",
  "scripts/publication-artifact.mjs",
  "scripts/resolve-external-tool.mjs",
  "scripts/run-test-suite.mjs",
  "scripts/source-cli-wrapper.mjs",
  "scripts/test-repository-boundary.mjs",
  "scripts/test-npm-global-install-smoke.mjs",
  "scripts/test-package-build-integrity.mjs",
  "scripts/test-publication-artifact.mjs",
  "scripts/test-publication-gates.mjs",
  "scripts/test-source-cli-wrapper.mjs",
  "scripts/verify-packed-packages.mjs",
  "scripts/verify-cloudflare-pages.mjs",
  "scripts/verify-repository-boundary.mjs",
  "scripts/verify-publication-gates.mjs",
  "skills/preflight-scout/SKILL.md",
  "skills/preflight-scout/references/cli-installation.md",
  "skills/scripts/build-skill-archive.py",
  "skills/scripts/test-skill-tooling.py",
  "skills/scripts/verify-skill-package.py",
  "wrangler.json"
];

for (const file of requiredFiles) {
  try {
    await access(path.join(root, file));
  } catch {
    failures.push(`Missing required repository file: ${file}`);
  }
}

const retiredProductSlug = ["preflight", "qa"].join("-");
for (const legacySkill of ["skills/chatgpt", "skills/claude", `skills/${retiredProductSlug}`]) {
  try {
    await access(path.join(root, legacySkill));
    failures.push(`Legacy skill copy must not exist: ${legacySkill}`);
  } catch {
    // Expected: skills/preflight-scout is the single source of truth.
  }
}

for (const privateOnlyPath of [
  ".github/workflows/preflight-self-check.yml",
  ".github/workflows/preflight-scout-dogfood.yml",
  "docs/enterprise-roadmap.md",
  "docs/product-plan.md",
  "examples/nextjs-saas/.preflight/config.yml",
  "packages/core/src/memory.ts"
]) {
  try {
    await access(path.join(root, privateOnlyPath));
    failures.push(`Private or retired path must not exist in the release tree: ${privateOnlyPath}`);
  } catch {
    // Expected: publication starts from the reviewed current tree only.
  }
}

for (const retiredStagingPath of [
  "apps/site/AGENTS.md",
  "design-qa.md",
  "docs/publication.md",
  "scripts/public-snapshot-staging-only-files.txt"
]) {
  try {
    await access(path.join(root, retiredStagingPath));
    failures.push(`Retired private-staging path must not exist in the canonical repository: ${retiredStagingPath}`);
  } catch {
    // Expected: historical staging material remains only in the archived private repository.
  }
}

const rootManifest = await readJson("package.json");
if (rootManifest.name !== "preflight-scout") failures.push("The workspace root name must be preflight-scout.");
if (rootManifest.private !== true) failures.push("The workspace root must remain private.");
if (rootManifest.license !== "AGPL-3.0-only") failures.push("The workspace root license must be AGPL-3.0-only.");
if (rootManifest.scripts?.preflight !== undefined || rootManifest.scripts?.["preflight-scout"] !== "tsx packages/cli/src/index.ts") {
  failures.push("The workspace must expose only the preflight-scout development command.");
}
if (!rootManifest.scripts?.["pack:check"]?.includes("verify-packed-packages.mjs")) {
  failures.push("pack:check must verify packed contents and workspace dependency conversion.");
}
if (rootManifest.scripts?.["test:publication"] !== "node scripts/test-publication-gates.mjs && node scripts/test-publication-artifact.mjs") {
  failures.push("test:publication must exercise live-gate and immutable-artifact publication safeguards.");
}
if (rootManifest.scripts?.["test:ci"] !== "node scripts/run-test-suite.mjs unit") {
  failures.push("test:ci must enforce the no-browser-cache unit-suite boundary.");
}
if (rootManifest.scripts?.["test:browser"] !== "node scripts/run-test-suite.mjs browser") {
  failures.push("test:browser must run the explicitly classified browser suite.");
}
if (rootManifest.scripts?.["test:repo-boundary"] !== "node scripts/test-repository-boundary.mjs") {
  failures.push("test:repo-boundary must exercise the canonical tracked-repository boundary.");
}
if (rootManifest.scripts?.["check:repo"] !== "node scripts/verify-repository-boundary.mjs && node scripts/verify-repository.mjs") {
  failures.push("check:repo must verify the tracked-repository boundary before repository policy.");
}
if (rootManifest.scripts?.["export:public"] !== undefined || rootManifest.scripts?.["test:public-export"] !== undefined) {
  failures.push("The canonical public repository must not retain private-to-public snapshot scripts.");
}
if (rootManifest.scripts?.["smoke:npm-global"] !== "node scripts/npm-global-install-smoke.mjs") {
  failures.push("smoke:npm-global must exercise the isolated npm global CLI installation.");
}
if (rootManifest.scripts?.["test:npm-global-smoke"] !== "node scripts/test-npm-global-install-smoke.mjs") {
  failures.push("test:npm-global-smoke must exercise npm smoke security and package-selection helpers.");
}
if (rootManifest.scripts?.["check:site"] !== "pnpm --filter @preflight-scout/site check && node scripts/verify-cloudflare-pages.mjs") {
  failures.push("check:site must verify the static website export and its Cloudflare Pages contract.");
}

const siteManifest = await readJson("apps/site/package.json");
if (siteManifest.name !== "@preflight-scout/site" || siteManifest.private !== true || siteManifest.version !== rootManifest.version) {
  failures.push("The private website workspace must match the Preflight Scout release identity and version.");
}
if (siteManifest.scripts?.build !== "next build" || siteManifest.scripts?.check !== "node scripts/check-static-export.mjs") {
  failures.push("The website must build as a static Next.js export and run its export verifier.");
}
if (siteManifest.dependencies?.next !== "16.2.10") {
  failures.push("The website must pin the reviewed Next.js release.");
}

const wranglerConfig = await readJson("wrangler.json");
const expectedWranglerKeys = ["compatibility_date", "name", "pages_build_output_dir", "send_metrics"];
if (JSON.stringify(Object.keys(wranglerConfig).sort()) !== JSON.stringify(expectedWranglerKeys)) {
  failures.push(`wrangler.json must contain only: ${expectedWranglerKeys.join(", ")}.`);
}
if (wranglerConfig.name !== "preflight-scout" || wranglerConfig.pages_build_output_dir !== "./apps/site/out") {
  failures.push("wrangler.json must deploy only the Preflight Scout static export at apps/site/out.");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(wranglerConfig.compatibility_date ?? "") || wranglerConfig.send_metrics !== false) {
  failures.push("wrangler.json must pin a compatibility date and keep Wrangler telemetry disabled.");
}
for (const forbiddenKey of ["account_id", "zone_id", "api_token", "secret", "token"]) {
  if (JSON.stringify(wranglerConfig).toLowerCase().includes(forbiddenKey)) {
    failures.push(`wrangler.json must not contain Cloudflare account wiring or credentials: ${forbiddenKey}.`);
  }
}

const publishWorkflow = await readFile(path.join(root, ".github/workflows/publish.yml"), "utf8");
const requiredPublishWorkflowMarkers = [
  "workflow_dispatch:",
  "permissions: {}",
  "GITHUB_REF_TYPE",
  "refs/tags/v${VERSION}",
  "git merge-base --is-ancestor",
  "node scripts/verify-publication-gates.mjs",
  "environment:\n      name: npm-production",
  "id-token: write",
  "Publish with package-specific npm trusted publishers",
  "--mode trusted-publishing",
  "verify-live-install:",
  "packages=(core agent-exec browser-runner mcp github-action cli)",
  "for _attempt in {1..60}; do",
  "npm install --global --prefix",
  '"@preflight-scout/cli@${VERSION}"',
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
];
for (const marker of requiredPublishWorkflowMarkers) {
  if (!publishWorkflow.includes(marker)) failures.push(`publish.yml is missing safety gate: ${marker}`);
}
for (const forbiddenAuthenticationPath of ["secrets.NPM_TOKEN", "NODE_AUTH_TOKEN", "bootstrap-token", "inputs.authentication", "authentication:"]) {
  if (publishWorkflow.includes(forbiddenAuthenticationPath)) {
    failures.push(`publish.yml must use trusted publishing only and must not contain ${forbiddenAuthenticationPath}.`);
  }
}
const publishTriggerBlock = publishWorkflow.slice(publishWorkflow.indexOf("on:"), publishWorkflow.indexOf("concurrency:"));
for (const forbiddenTrigger of ["push:", "pull_request:", "release:", "schedule:", "workflow_call:"]) {
  if (publishTriggerBlock.includes(forbiddenTrigger)) failures.push(`publish.yml must not use trigger ${forbiddenTrigger}`);
}
const publishJobIndex = publishWorkflow.indexOf("\n  publish:\n");
const liveInstallJobIndex = publishWorkflow.indexOf("\n  verify-live-install:\n");
const validateJob = publishWorkflow.slice(publishWorkflow.indexOf("\n  validate:\n"), publishJobIndex);
const publishJob = publishWorkflow.slice(publishJobIndex, liveInstallJobIndex > publishJobIndex ? liveInstallJobIndex : undefined);
const liveInstallJob = liveInstallJobIndex >= 0 ? publishWorkflow.slice(liveInstallJobIndex) : "";
if (publishJobIndex < 0) failures.push("publish.yml must contain a distinct environment-gated publish job.");
if (liveInstallJobIndex < 0) failures.push("publish.yml must verify the exact live npm install after publication.");
if (validateJob.includes("id-token:") || validateJob.includes("secrets.NPM_TOKEN")) {
  failures.push("publish.yml validation job must not receive OIDC or npm publication credentials.");
}
if ((publishWorkflow.match(/id-token:\s*write/g) ?? []).length !== 1) {
  failures.push("publish.yml must grant id-token: write exactly once.");
}
for (const forbiddenPublishJobCode of ["actions/checkout@", "./.github/actions/setup-pnpm", "pnpm ", "npm ci", "npm run"]) {
  if (publishJob.includes(forbiddenPublishJobCode)) {
    failures.push(`publish.yml privileged job must not run repository install/build code: ${forbiddenPublishJobCode}`);
  }
}
if (!liveInstallJob.includes("needs: publish") || !liveInstallJob.includes('"@preflight-scout/cli@${VERSION}"')) {
  failures.push("publish.yml live-install verification must depend on publication and pin the exact CLI version.");
}
for (const forbiddenLiveInstallCapability of ["id-token: write", "secrets.NPM_TOKEN", "NODE_AUTH_TOKEN", "actions/checkout@", "pnpm "]) {
  if (liveInstallJob.includes(forbiddenLiveInstallCapability)) {
    failures.push(`publish.yml live-install verification must not receive or run ${forbiddenLiveInstallCapability}.`);
  }
}
const trustedStepIndex = publishJob.indexOf("Publish with package-specific npm trusted publishers");
const trustedStep = trustedStepIndex >= 0 ? publishJob.slice(trustedStepIndex) : "";
if (trustedStepIndex < 0) {
  failures.push("publish.yml must contain one package-specific trusted-publishing step.");
} else if (trustedStep.includes("NODE_AUTH_TOKEN") || trustedStep.includes("secrets.NPM_TOKEN")) {
  failures.push("publish.yml trusted-publishing step must not receive an npm token.");
}
if ((publishWorkflow.match(/--mode trusted-publishing/g) ?? []).length !== 1 || trustedStep.includes("\n        if:")) {
  failures.push("publish.yml must run exactly one unconditional trusted-publishing step.");
}
for (const forbiddenPermission of ["contents: write", "actions: write", "packages: write"]) {
  if (publishWorkflow.includes(forbiddenPermission)) failures.push(`publish.yml must not grant ${forbiddenPermission}.`);
}

const envExample = await readFile(path.join(root, ".env.example"), "utf8");
const allowedEnvExampleKey = /^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|PREFLIGHT_SCOUT_APP_URL|PREFLIGHT_SCOUT_BROWSER_[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:EMAIL|USERNAME|PASSWORD))$/;
for (const line of envExample.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  if (match && !allowedEnvExampleKey.test(match[1])) {
    failures.push(`.env.example contains a non-copy-safe active key: ${match[1]}`);
  }
}

const codexPlugin = await readJson(".codex-plugin/plugin.json");
if (codexPlugin.name !== "preflight-scout" || codexPlugin.skills !== "./skills/") {
  failures.push("The Codex plugin must expose the canonical skills directory.");
}

const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
const codexMarketplaceEntry = codexMarketplace.plugins?.find((plugin) => plugin.name === "preflight-scout");
if (codexMarketplaceEntry?.source?.source !== "local" || codexMarketplaceEntry.source.path !== "./") {
  failures.push("The Codex marketplace must install the local preflight-scout plugin root.");
}

const claudePlugin = await readJson(".claude-plugin/plugin.json");
if (claudePlugin.name !== "preflight-scout" || claudePlugin.version !== rootManifest.version) {
  failures.push("The Claude plugin name and version must match the workspace release.");
}

const claudeMarketplace = await readJson(".claude-plugin/marketplace.json");
const claudeMarketplaceEntry = claudeMarketplace.plugins?.find((plugin) => plugin.name === "preflight-scout");
if (claudeMarketplaceEntry?.source !== "./") {
  failures.push("The Claude marketplace must install the local preflight-scout plugin root.");
}

for (const file of ["README.md", "docs/skills.md"]) {
  const contents = await readFile(path.join(root, file), "utf8");
  if (!contents.includes("$preflight-scout:preflight-scout")) {
    failures.push(`${file} must document the namespaced Codex plugin invocation.`);
  }
}

for (const file of ["README.md", "docs/public-alpha.md", "docs/skills.md", "skills/preflight-scout/references/cli-installation.md"]) {
  const contents = await readFile(path.join(root, file), "utf8");
  const pinnedRegistryInstall = `npm install --global @preflight-scout/cli@${rootManifest.version}`;
  if (!contents.includes(pinnedRegistryInstall) || !contents.includes("--registry=https://registry.npmjs.org/") || !contents.includes("preflight-scout install-browser")) {
    failures.push(`${file} must document the pinned official-registry npm CLI install and explicit browser setup.`);
  }
  if (!contents.includes("pnpm install:source-cli")) {
    failures.push(`${file} must document the durable source CLI installer.`);
  }
  if (/(?:preflight|preflight-scout)\(\)\s*\{/.test(contents)) {
    failures.push(`${file} must not use a current-shell-only CLI function.`);
  }
}

const packageEntries = await readdir(path.join(root, "packages"), { withFileTypes: true });
const requiredPackageAssetPaths = [];
for (const entry of packageEntries.filter((item) => item.isDirectory())) {
  const manifest = await readJson(path.join("packages", entry.name, "package.json"));
  if (!manifest.name?.startsWith("@preflight-scout/")) failures.push(`${manifest.name ?? entry.name} is outside the @preflight-scout scope.`);
  if (manifest.license !== "AGPL-3.0-only") failures.push(`${manifest.name} has the wrong license.`);
  if (manifest.private === true) failures.push(`${manifest.name} is unexpectedly private.`);
  for (const file of ["README.md", "LICENSE", "NOTICE", "OUTPUT-LICENSE.md", "THIRD_PARTY_NOTICES.md"]) {
    if (!manifest.files?.includes(file)) failures.push(`${manifest.name} does not package ${file}.`);
    if (file !== "README.md") {
      const assetPath = path.join("packages", entry.name, file).split(path.sep).join("/");
      requiredPackageAssetPaths.push(assetPath);
      try {
        const assetStat = await lstat(path.join(root, assetPath));
        if (!assetStat.isFile()) failures.push(`Required package asset must be a regular file: ${assetPath}`);
      } catch {
        failures.push(`Required package asset is missing: ${assetPath}`);
      }
    }
  }
  if (manifest.publishConfig?.access !== "public") failures.push(`${manifest.name} must declare public package access.`);
  if (manifest.publishConfig?.provenance !== true) failures.push(`${manifest.name} must request npm provenance.`);
  if (manifest.homepage !== "https://github.com/fenutech/preflight-scout#readme") failures.push(`${manifest.name} has the wrong homepage.`);
  if (manifest.bugs?.url !== "https://github.com/fenutech/preflight-scout/issues") failures.push(`${manifest.name} has the wrong issue tracker.`);
  if (manifest.author !== "Andrea Fenu") failures.push(`${manifest.name} has the wrong author metadata.`);
  for (const keyword of ["preflight-scout", "release-qa", "pull-request", "playwright", "agent-skill"]) {
    if (!manifest.keywords?.includes(keyword)) failures.push(`${manifest.name} is missing keyword ${keyword}.`);
  }
  if (manifest.scripts?.prepack !== "node ../../scripts/package-build-integrity.mjs verify") {
    failures.push(`${manifest.name} must verify dist integrity before packing.`);
  }
  if (manifest.scripts?.prepublishOnly !== "node ../../scripts/package-build-integrity.mjs verify") {
    failures.push(`${manifest.name} must verify dist integrity before publishing.`);
  }
  if (!manifest.scripts?.build?.endsWith("node ../../scripts/package-build-integrity.mjs write")) {
    failures.push(`${manifest.name} must record dist integrity after building.`);
  }
  if (!manifest.scripts?.build?.startsWith("node ../../scripts/package-build-integrity.mjs clean &&")) {
    failures.push(`${manifest.name} must clean old dist output before building.`);
  }
  if (manifest.name === "@preflight-scout/cli") {
    if (JSON.stringify(manifest.bin) !== JSON.stringify({ "preflight-scout": "dist/index.js" })) {
      failures.push("@preflight-scout/cli must expose only the preflight-scout executable.");
    }
  } else if (manifest.bin !== undefined) {
    failures.push(`${manifest.name} must not expose an executable.`);
  }
}

let hasGitMetadata = false;
let trustedGitCommand;
let trackedRepositoryPaths = [];
try {
  hasGitMetadata = await hasGitMetadataInAncestors(root);
  if (!hasGitMetadata) {
    failures.push("Repository verification requires the canonical Git checkout; no Git metadata was found.");
  } else {
    trustedGitCommand = await resolveExternalTool("git", { repoRoot: root });
    const { stdout } = await execFileAsync(trustedGitCommand, [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z"
    ], {
      cwd: root,
      encoding: "utf8",
      env: trustedGitEnvironment(trustedGitCommand),
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true
    });
    trackedRepositoryPaths = stdout.split("\0").filter(Boolean);
    if (trackedRepositoryPaths.length === 0) failures.push("Canonical repository has no tracked files.");
    if (new Set(trackedRepositoryPaths).size !== trackedRepositoryPaths.length) {
      failures.push("Canonical repository contains duplicate tracked paths.");
    }
  }
} catch (error) {
  failures.push(`Could not enumerate canonical tracked files with trusted Git: ${error instanceof Error ? error.message : String(error)}`);
}

const forbiddenPublicIdentityFragments = [
  ["Preflight", "QA"].join(" "),
  `@${retiredProductSlug}`,
  `fenutech/${retiredProductSlug}`,
  retiredProductSlug
];
const legacyPathSecurityFiles = new Set([
  "packages/core/src/fs.ts",
  "packages/core/src/fs.test.ts",
  "packages/core/src/redaction.test.ts"
]);
const legacyEnvSecurityFiles = new Set([
  "packages/core/src/redaction.ts",
  "packages/core/src/redaction.test.ts"
]);
for (const relativePath of trackedRepositoryPaths) {
  if (relativePath === "scripts/verify-repository.mjs") continue;
  let buffer;
  try {
    buffer = await readFile(path.join(root, relativePath));
  } catch (error) {
    failures.push(`Could not read tracked repository file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (buffer.includes(0)) continue;
  const contents = buffer.toString("utf8");
  for (const fragment of forbiddenPublicIdentityFragments) {
    if (contents.includes(fragment)) failures.push(`${relativePath} contains retired public identity: ${fragment}`);
  }
  if (!legacyEnvSecurityFiles.has(relativePath) && /\bPREFLIGHT_(?!SCOUT_)/.test(contents)) {
    failures.push(`${relativePath} contains a retired PREFLIGHT_ environment name.`);
  }
  if (relativePath !== ".gitignore" && !legacyPathSecurityFiles.has(relativePath) && /\.preflight(?!-scout)(?:\/|-)/.test(contents)) {
    failures.push(`${relativePath} contains a retired .preflight path.`);
  }
}

if (hasGitMetadata) {
  try {
    const gitCommand = trustedGitCommand ?? await resolveExternalTool("git", { repoRoot: root });
    const { stdout } = await execFileAsync(gitCommand, [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z",
      "--",
      ...requiredPackageAssetPaths
    ], {
      cwd: root,
      encoding: "utf8",
      env: trustedGitEnvironment(gitCommand),
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true
    });
    const tracked = new Set(stdout.split("\0").filter(Boolean));
    for (const assetPath of requiredPackageAssetPaths) {
      if (!tracked.has(assetPath)) failures.push(`Required package asset must be tracked by Git: ${assetPath}`);
    }
  } catch (error) {
    failures.push(`Could not verify package asset tracking with trusted Git: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const workflowFiles = await collectFiles(path.join(root, ".github", "workflows"), (file) => /\.ya?ml$/.test(file));
const actionFiles = [path.join(root, "action.yml"), path.join(root, ".github", "actions", "setup-pnpm", "action.yml")];
for (const file of [...workflowFiles, ...actionFiles]) {
  const contents = await readFile(file, "utf8");
  for (const match of contents.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    const separator = reference.lastIndexOf("@");
    const revision = separator >= 0 ? reference.slice(separator + 1) : "";
    if (!/^[0-9a-f]{40}$/.test(revision)) failures.push(`${path.relative(root, file)} uses a mutable Action reference: ${reference}`);
  }
}

const localStateDirectories = new Set([
  ".git",
  ".preflight",
  ".preflight-scout",
  ".preflight-trusted-action",
  ".preflight-scout-trusted-action",
  "dist",
  "node_modules"
]);
const documentationFiles = await collectFiles(root, (file) => /\.(?:md|ya?ml)$/.test(file), localStateDirectories);
for (const file of documentationFiles) {
  const contents = await readFile(file, "utf8");
  for (const match of contents.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split(/\s+["']/)[0];
    if (/^(?:https?:|mailto:|#|data:)/i.test(target)) continue;
    target = target.split("#")[0].split("?")[0];
    if (!target || target.includes("${{")) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // Keep the literal target so the existence check reports it.
    }
    try {
      await access(path.resolve(path.dirname(file), target));
    } catch {
      failures.push(`${path.relative(root, file)} has a broken local link: ${target}`);
    }
  }
}

const publicTextFiles = await collectFiles(root, (file) => /\.(?:md|json|mjs|ts|ya?ml)$/.test(file), localStateDirectories);
const mutablePlaywrightMcpReference = ["@playwright/mcp@", "latest"].join("");
const discouragedLanguage = [
  { pattern: /\bagentic\b/i, label: "agentic" },
  { pattern: /\bdogfood(?:ing)?\b/i, label: "dogfood" },
  { pattern: /No Heuristics For The Magic/i, label: "internal slogan" }
];
for (const file of publicTextFiles) {
  if (path.relative(root, file) === "scripts/verify-repository.mjs") continue;
  const contents = await readFile(file, "utf8");
  if (contents.includes(mutablePlaywrightMcpReference)) {
    failures.push(`${path.relative(root, file)} uses a mutable Playwright MCP package reference.`);
  }
  for (const term of discouragedLanguage) {
    if (term.pattern.test(contents)) {
      failures.push(`${path.relative(root, file)} contains discouraged public wording: ${term.label}`);
    }
  }
}

if (failures.length) {
  throw new Error(`Repository verification failed:\n- ${failures.join("\n- ")}`);
}

console.log(`Repository verification passed: ${requiredFiles.length} required files, ${packageEntries.length} packages, ${workflowFiles.length} workflows, and ${documentationFiles.length} documentation/config files.`);

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

async function collectFiles(directory, include, skipped = new Set()) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(file, include, skipped));
    else if (include(file)) files.push(file);
  }
  return files;
}

async function hasGitMetadataInAncestors(directory) {
  let current = path.resolve(directory);
  for (;;) {
    try {
      await lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function trustedGitEnvironment(gitCommand) {
  const env = {
    PATH: path.dirname(gitCommand),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "SYSTEMROOT", "WINDIR", "USERPROFILE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
