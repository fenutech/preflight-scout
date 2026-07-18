import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAnalysisProvenance,
  createCompositeRuntimeDigest,
  PREFLIGHT_SCOUT_VERSION,
  resolvePackageRuntimeIdentity,
  sha256Text,
  verifyPackageDistBuildIdentity
} from "./provenance.js";
import type { QAContract, RepoIndex } from "./types.js";

const execFileAsync = promisify(execFile);

describe("analysis provenance", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("normalizes equivalent origin URLs without persisting a remote or checkout path", async () => {
    const httpsRepo = await gitRepository(directories, "https://build-user:build-password@example.com/fenutech/product.git");
    const sshRepo = await gitRepository(directories, "git@example.com:fenutech/product.git");
    const httpsProvenance = await provenanceFor(httpsRepo);
    const sshProvenance = await provenanceFor(sshRepo);

    expect(httpsProvenance.repositoryDigest).toBe(sshProvenance.repositoryDigest);
    expect(httpsProvenance.repositoryContextDigest).toBe(sshProvenance.repositoryContextDigest);
    const serialized = JSON.stringify(httpsProvenance);
    expect(serialized).not.toContain(httpsRepo);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("build-user");
    expect(serialized).not.toContain("build-password");
  });

  it("changes the repository and indexed-context bindings independently", async () => {
    const first = await gitRepository(directories, "https://example.com/fenutech/first.git");
    const second = await gitRepository(directories, "https://example.com/fenutech/second.git");
    const original = await provenanceFor(first);
    const foreign = await provenanceFor(second);
    const changedContext = await createAnalysisProvenance({
      root: first,
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
      contract,
      repoIndex: repositoryIndex(first, ["src/index.ts", "src/new-file.ts"])
    });

    expect(foreign.repositoryDigest).not.toBe(original.repositoryDigest);
    expect(foreign.repositoryContextDigest).toBe(original.repositoryContextDigest);
    expect(changedContext.repositoryDigest).toBe(original.repositoryDigest);
    expect(changedContext.repositoryContextDigest).not.toBe(original.repositoryContextDigest);
  });

  it("keeps Windows drive letters and UNC hosts in local-origin identities", async () => {
    const driveC = await gitRepository(directories, String.raw`C:\repos\product.git`);
    const driveD = await gitRepository(directories, String.raw`D:\repos\product.git`);
    const driveFileUrl = await gitRepository(directories, "file:///C:/repos/product.git");
    const uncOne = await gitRepository(directories, String.raw`\\server-one\share\product.git`);
    const uncTwo = await gitRepository(directories, String.raw`\\server-two\share\product.git`);

    const [cIdentity, dIdentity, fileUrlIdentity, uncOneIdentity, uncTwoIdentity] = await Promise.all([
      provenanceFor(driveC),
      provenanceFor(driveD),
      provenanceFor(driveFileUrl),
      provenanceFor(uncOne),
      provenanceFor(uncTwo)
    ]);
    expect(cIdentity.repositoryDigest).not.toBe(dIdentity.repositoryDigest);
    expect(cIdentity.repositoryDigest).toBe(fileUrlIdentity.repositoryDigest);
    expect(uncOneIdentity.repositoryDigest).not.toBe(uncTwoIdentity.repositoryDigest);
  });

  it.each([
    "@preflight-scout/core",
    "@preflight-scout/cli",
    "@preflight-scout/browser-runner",
    "@preflight-scout/github-action"
  ])("binds the %s package-code/build identity to every declared packed output", async (packageName) => {
    const packageDirectory = await mkdtemp(path.join(tmpdir(), "preflight-scout-package-build-"));
    directories.push(packageDirectory);
    const distDirectory = path.join(packageDirectory, "dist");
    await mkdir(distDirectory);
    const packageManifest = `${JSON.stringify({
      name: packageName,
      version: PREFLIGHT_SCOUT_VERSION,
      type: "module"
    }, null, 2)}\n`;
    const moduleContents = "export const runtime = 'reviewed';\n";
    const modulePath = path.join(distDirectory, "index.js");
    await writeFile(path.join(packageDirectory, "package.json"), packageManifest);
    await writeFile(modulePath, moduleContents);
    await writeFile(path.join(distDirectory, ".preflight-scout-build.json"), `${JSON.stringify({
      schemaVersion: 3,
      packageName,
      packageVersion: PREFLIGHT_SCOUT_VERSION,
      packageRuntimeHash: sha256Text(JSON.stringify({
        name: packageName,
        type: "module",
        version: PREFLIGHT_SCOUT_VERSION
      })),
      sourceHash: sha256Text("reviewed source"),
      inputHash: sha256Text("reviewed inputs"),
      outputs: { "dist/index.js": sha256Text(moduleContents) }
    }, null, 2)}\n`);

    expect(verifyPackageDistBuildIdentity(
      packageDirectory,
      modulePath,
      packageName,
      PREFLIGHT_SCOUT_VERSION
    )).toMatch(/^sha256:[0-9a-f]{64}$/);
    await writeFile(modulePath, "export const runtime = 'patched';\n");
    expect(() => verifyPackageDistBuildIdentity(
      packageDirectory,
      modulePath,
      packageName,
      PREFLIGHT_SCOUT_VERSION
    )).toThrow("a packed output changed after build");
    if (process.platform !== "win32") {
      const linkedOutput = path.join(packageDirectory, "linked-output.js");
      await writeFile(linkedOutput, moduleContents);
      await rm(modulePath);
      await symlink(linkedOutput, modulePath);
      expect(() => verifyPackageDistBuildIdentity(
        packageDirectory,
        modulePath,
        packageName,
        PREFLIGHT_SCOUT_VERSION
      )).toThrow("a declared output is missing or unsafe");
    }
  });

  it("changes source package identity when same-version CLI source changes", async () => {
    const packageDirectory = await mkdtemp(path.join(tmpdir(), "preflight-scout-cli-source-"));
    directories.push(packageDirectory);
    const sourceDirectory = path.join(packageDirectory, "src");
    const modulePath = path.join(sourceDirectory, "index.ts");
    await mkdir(sourceDirectory);
    await writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify({
      name: "@preflight-scout/cli",
      version: PREFLIGHT_SCOUT_VERSION,
      type: "module"
    })}\n`);
    await writeFile(modulePath, "export const runtime = 'first';\n");

    const first = resolvePackageRuntimeIdentity(pathToFileURL(modulePath).href, "@preflight-scout/cli");
    await writeFile(modulePath, "export const runtime = 'second';\n");
    const second = resolvePackageRuntimeIdentity(pathToFileURL(modulePath).href, "@preflight-scout/cli");

    expect(second).not.toBe(first);
  });

  it("keeps analysis and browser execution identities phase-specific", () => {
    const core = sha256Text("core");
    const cliA = sha256Text("cli-a");
    const cliB = sha256Text("cli-b");
    const browserA = sha256Text("browser-a");
    const browserB = sha256Text("browser-b");
    const analysisA = createCompositeRuntimeDigest("analysis:cli", { core, cli: cliA });
    const analysisB = createCompositeRuntimeDigest("analysis:cli", { core, cli: cliB });
    const executionA = createCompositeRuntimeDigest("execution:cli-browser", { core, cli: cliA, browser: browserA });
    const executionB = createCompositeRuntimeDigest("execution:cli-browser", { core, cli: cliA, browser: browserB });

    expect(analysisB).not.toBe(analysisA);
    expect(executionB).not.toBe(executionA);
    expect(createCompositeRuntimeDigest("analysis:cli", { core, cli: cliA })).toBe(analysisA);
  });
});

async function gitRepository(directories: string[], remote: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "preflight-scout-provenance-"));
  directories.push(directory);
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
  await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: directory });
  return directory;
}

async function provenanceFor(root: string) {
  return createAnalysisProvenance({
    root,
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    contract,
    repoIndex: repositoryIndex(root, ["src/index.ts"])
  });
}

function repositoryIndex(root: string, files: string[]): RepoIndex {
  return {
    root,
    files,
    manifests: {},
    frameworks: [],
    routes: [],
    components: [],
    tests: [],
    configFiles: [],
    integrationHints: []
  };
}

const contract: QAContract = {
  app: { name: "Provenance fixture" },
  criticalFlows: [],
  sensitiveAreas: [],
  dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
  testData: {},
  unknowns: []
};
