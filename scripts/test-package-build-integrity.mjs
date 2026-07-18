import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { manifestPathLabel, relativePathLabel } from "./package-build-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-package-guard-"));
const packageDir = path.join(tempRoot, "packages", "fixture");
const scriptPath = path.join(tempRoot, "scripts", "package-build-integrity.mjs");
const rootManifestPath = path.join(tempRoot, "package.json");
const lockfilePath = path.join(tempRoot, "pnpm-lock.yaml");
const toolchainDir = path.join(tempRoot, "node_modules", "typescript");
const toolchainCompilerPath = path.join(toolchainDir, "lib", "tsc.js");

try {
  assertWindowsLabelsArePortable();
  await mkdir(path.join(packageDir, "src"), { recursive: true });
  await mkdir(path.join(packageDir, "dist"), { recursive: true });
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await mkdir(path.join(toolchainDir, "bin"), { recursive: true });
  await mkdir(path.join(toolchainDir, "lib"), { recursive: true });
  await cp(path.join(root, "scripts", "package-build-integrity.mjs"), scriptPath);
  await cp(path.join(root, "scripts", "package-build-paths.mjs"), path.join(tempRoot, "scripts", "package-build-paths.mjs"));
  await writeFile(rootManifestPath, `${JSON.stringify({ name: "package-guard-root", private: true, devDependencies: { typescript: "0.0.0-fixture" } }, null, 2)}\n`);
  await writeFile(lockfilePath, "lockfileVersion: '9.0'\n");
  await writeFile(path.join(tempRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(path.join(tempRoot, "tsconfig.base.json"), "{}\n");
  await writeFile(path.join(toolchainDir, "package.json"), `${JSON.stringify({
    name: "typescript",
    version: "0.0.0-fixture",
    bin: { tsc: "./bin/tsc" }
  }, null, 2)}\n`);
  await writeFile(path.join(toolchainDir, "bin", "tsc"), "#!/usr/bin/env node\n");
  await writeFile(toolchainCompilerPath, "export const compilerFixture = 1;\n");
  await writeFile(path.join(packageDir, "tsconfig.json"), "{}\n");
  await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({
    name: "@preflight-scout/package-guard-fixture",
    version: "0.0.0",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    files: ["dist"],
    scripts: {
      prepack: "node ../../scripts/package-build-integrity.mjs verify",
      prepublishOnly: "node ../../scripts/package-build-integrity.mjs verify"
    }
  }, null, 2)}\n`);
  await writeFile(path.join(packageDir, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(path.join(packageDir, "dist", "index.js"), "export const value = 1;\n");
  await writeFile(path.join(packageDir, "dist", "index.d.ts"), "export declare const value = 1;\n");

  run("write", true);
  run("verify", true);
  await mkdir(path.join(tempRoot, "tarballs"));
  runPnpm(["pack", "--pack-destination", path.join(tempRoot, "tarballs")], true);

  await assertMutationRejected(
    path.join(packageDir, "src", "index.ts"),
    "export const value = 2;\n",
    "package source"
  );
  await assertMutationRejected(
    rootManifestPath,
    `${JSON.stringify({ name: "package-guard-root", private: true, devDependencies: { typescript: "0.0.1-fixture" } }, null, 2)}\n`,
    "root package manifest"
  );
  await assertMutationRejected(lockfilePath, "lockfileVersion: '9.0'\n# changed resolution\n", "lockfile");
  await assertMutationRejected(toolchainCompilerPath, "export const compilerFixture = 2;\n", "resolved TypeScript compiler");

  await unlink(path.join(packageDir, "dist", "index.js"));
  const missing = run("verify", false);
  assertIncludes(missing.stderr, "missing declared build entrypoint");

  const stamp = JSON.parse(await readFile(path.join(packageDir, "dist", ".preflight-scout-build.json"), "utf8"));
  if (stamp.builtAt) throw new Error("Build integrity stamp must remain deterministic.");
  if (!/^sha256:[0-9a-f]{64}$/.test(stamp.sourceHash)) {
    throw new Error("Build integrity stamp must contain a deterministic source hash.");
  }
  if (stamp.schemaVersion !== 3 || !/^sha256:[0-9a-f]{64}$/.test(stamp.packageRuntimeHash)) {
    throw new Error("Build integrity stamp must bind the runtime package metadata.");
  }

  console.log("Package build integrity guard rejects source, root manifest, lockfile, toolchain, and incomplete dist changes.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function run(mode, shouldPass) {
  const result = spawnSync(process.execPath, [scriptPath, mode], {
    cwd: packageDir,
    encoding: "utf8"
  });
  if (shouldPass && result.status !== 0) {
    throw new Error(`Expected ${mode} to pass:\n${result.stderr || result.stdout}`);
  }
  if (!shouldPass && result.status === 0) {
    throw new Error(`Expected ${mode} to fail.`);
  }
  return result;
}

function runPnpm(args, shouldPass) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, args, {
    cwd: packageDir,
    encoding: "utf8"
  });
  if (shouldPass && result.status !== 0) {
    throw new Error(`Expected pnpm ${args.join(" ")} to pass:\n${result.stderr || result.stdout}`);
  }
  if (!shouldPass && result.status === 0) {
    throw new Error(`Expected pnpm ${args.join(" ")} to fail.`);
  }
  return result;
}

async function assertMutationRejected(file, changedContents, label) {
  const original = await readFile(file);
  await writeFile(file, changedContents);
  try {
    const stale = run("verify", false);
    assertIncludes(stale.stderr, "missing, changed, or stale");
    const stalePack = runPnpm(["pack", "--pack-destination", path.join(tempRoot, "tarballs")], false);
    assertIncludes(`${stalePack.stdout}\n${stalePack.stderr}`, "missing, changed, or stale");
    const stalePublish = runPnpm(["publish", "--dry-run", "--no-git-checks"], false);
    assertIncludes(`${stalePublish.stdout}\n${stalePublish.stderr}`, "missing, changed, or stale");
  } finally {
    await writeFile(file, original);
  }
  run("verify", true);
  console.log(`Rejected stale dist after changing ${label}.`);
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`Expected output to contain ${JSON.stringify(expected)}:\n${value}`);
  }
}

function assertWindowsLabelsArePortable() {
  const packageRoot = "C:\\repo\\packages\\fixture";
  const output = "C:\\repo\\packages\\fixture\\dist\\index.js";
  const source = "C:\\repo\\packages\\fixture\\src\\index.ts";
  const outputLabel = relativePathLabel(packageRoot, output, path.win32);
  const sourceLabel = relativePathLabel("C:\\repo", source, path.win32);
  if (outputLabel !== "dist/index.js" || sourceLabel !== "packages/fixture/src/index.ts") {
    throw new Error(`Windows build labels are not portable: ${JSON.stringify({ outputLabel, sourceLabel })}`);
  }
  if (manifestPathLabel(".\\dist\\index.js") !== outputLabel || manifestPathLabel("./dist/index.js") !== outputLabel) {
    throw new Error("Windows and POSIX manifest entrypoints must resolve to the same portable build label.");
  }
}
