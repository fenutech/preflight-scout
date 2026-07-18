import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_PACKAGES,
  buildIsolatedSmokeEnvironment,
  isPathWithin,
  loadRuntimeReleasePlan,
  parseSmokeArguments,
  renderWindowsCommandInvocation,
  resolveTrustedNpmInvocation,
  resolveTrustedWindowsCommandProcessor,
  validatePosixGlobalCommand,
  validateWindowsGlobalCommand
} from "./npm-global-install-smoke-lib.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parsed = parseSmokeArguments(process.argv.slice(2));
if (parsed.mode === "help") {
  console.log("Usage: pnpm smoke:npm-global [-- --registry @preflight-scout/cli@X.Y.Z]");
  process.exit(0);
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-npm-global-"));
const prefix = path.join(tempRoot, "prefix");

try {
  const plan = await loadRuntimeReleasePlan(root, parsed, {
    stagingDirectory: path.join(tempRoot, "runtime-tarballs")
  });
  const npm = await resolveTrustedNpmInvocation({ repoRoot: root });
  const isolated = await buildIsolatedSmokeEnvironment({ repoRoot: root, tempRoot, prefix });
  await Promise.all([
    mkdir(prefix, { recursive: true }),
    mkdir(isolated.isolatedHome, { recursive: true }),
    mkdir(isolated.isolatedCache, { recursive: true }),
    mkdir(isolated.isolatedTemp, { recursive: true }),
    writeFile(isolated.userConfig, "", { flag: "wx", mode: 0o600 }),
    writeFile(isolated.globalConfig, "", { flag: "wx", mode: 0o600 })
  ]);

  const npmArgs = [
    ...npm.args,
    "install", "--global", "--prefix", prefix,
    "--no-audit", "--no-fund", "--package-lock=false",
    ...(plan.mode === "registry" ? ["--registry=https://registry.npmjs.org/"] : []),
    ...plan.installSpecifiers
  ];
  await runChecked(npm.command, npmArgs, { cwd: tempRoot, env: isolated.env, timeout: 300000 }, "isolated npm global install");

  const rootResult = await runChecked(
    npm.command,
    [...npm.args, "root", "--global", "--prefix", prefix],
    { cwd: tempRoot, env: isolated.env, timeout: 60000 },
    "npm global root discovery"
  );
  const globalRoot = path.resolve(rootResult.stdout.trim());
  const resolvedPrefix = await realpath(prefix);
  const resolvedGlobalRoot = await realpath(globalRoot);
  if (!rootResult.stdout.trim() || !isPathWithin(resolvedPrefix, resolvedGlobalRoot)) {
    throw new Error("npm reported a global package root outside the isolated prefix.");
  }

  const installed = await validateInstalledRuntime(globalRoot, resolvedPrefix, plan.version);
  const commandPath = process.platform === "win32"
    ? path.join(prefix, "preflight-scout.cmd")
    : path.join(prefix, "bin", "preflight-scout");
  const runGlobalCommand = await createGlobalCommandRunner({ commandPath, cliEntry: installed.cliEntry, prefix, env: isolated.env });

  const version = await runGlobalCommand(["--version"], 60000);
  if (version.stdout.trim() !== plan.version) {
    throw new Error(`npm global preflight-scout reported ${version.stdout.trim()} instead of ${plan.version}.`);
  }
  const help = await runGlobalCommand(["--help"], 60000);
  if (!help.stdout.includes("Release QA for pull requests")) {
    throw new Error("npm global preflight-scout did not print the expected help text.");
  }

  const directVersion = await runChecked(
    process.execPath,
    [installed.cliEntry, "--version"],
    { cwd: tempRoot, env: isolated.env, timeout: 60000 },
    "installed CLI entry verification"
  );
  if (directVersion.stdout.trim() !== plan.version) {
    throw new Error("The installed CLI entry point disagrees with the generated global command version.");
  }

  if (process.env.PREFLIGHT_SCOUT_NPM_SMOKE_INSTALL_BROWSER === "1") {
    await runGlobalCommand(["install-browser"], 600000);
  }

  console.log(
    `npm global smoke installed the ${plan.mode === "registry" ? "exact registry release" : "five runtime RC tarballs"}, `
    + `executed the generated preflight-scout command, and validated version/help`
    + `${process.env.PREFLIGHT_SCOUT_NPM_SMOKE_INSTALL_BROWSER === "1" ? " plus Chromium installation" : ""}.`
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function validateInstalledRuntime(globalRoot, prefix, expectedVersion) {
  const cliRoot = path.join(globalRoot, "@preflight-scout", "cli");
  const cliManifestPath = path.join(cliRoot, "package.json");
  const cliManifest = JSON.parse(await readFile(cliManifestPath, "utf8"));
  if (cliManifest.name !== "@preflight-scout/cli" || cliManifest.version !== expectedVersion) {
    throw new Error("npm global installation did not install the exact CLI release.");
  }
  if (JSON.stringify(cliManifest.bin) !== JSON.stringify({ "preflight-scout": "dist/index.js" })) {
    throw new Error("The installed CLI must expose only preflight-scout -> dist/index.js.");
  }

  const resolvedPackages = new Map();
  for (const expected of RUNTIME_PACKAGES) {
    const packageRoot = await findInstalledPackageRoot(globalRoot, cliRoot, expected.name, prefix);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== expected.name || manifest.version !== expectedVersion) {
      throw new Error(`npm global installation resolved ${manifest.name}@${manifest.version} instead of ${expected.name}@${expectedVersion}.`);
    }
    const stamp = JSON.parse(await readFile(path.join(packageRoot, "dist", ".preflight-scout-build.json"), "utf8"));
    if (stamp.schemaVersion !== 3 || stamp.packageName !== expected.name || stamp.packageVersion !== expectedVersion || !/^sha256:[0-9a-f]{64}$/.test(stamp.packageRuntimeHash) || !/^sha256:[0-9a-f]{64}$/.test(stamp.sourceHash)) {
      throw new Error(`npm global installation found an invalid build stamp for ${expected.name}.`);
    }
    resolvedPackages.set(expected.name, packageRoot);
  }

  for (const actionRoot of packageRootCandidates(globalRoot, cliRoot, "@preflight-scout/github-action")) {
    try {
      await lstat(actionRoot);
      throw new Error("npm global installation unexpectedly included @preflight-scout/github-action.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const cliEntry = await realpath(path.join(resolvedPackages.get("@preflight-scout/cli"), "dist", "index.js"));
  if (!isPathWithin(prefix, cliEntry)) throw new Error("Installed CLI entry point resolves outside the isolated prefix.");
  return { cliEntry };
}

async function findInstalledPackageRoot(globalRoot, cliRoot, expectedName, boundary) {
  const resolvedBoundary = await realpath(boundary);
  for (const candidate of packageRootCandidates(globalRoot, cliRoot, expectedName)) {
    try {
      const resolved = await realpath(candidate);
      if (!isPathWithin(resolvedBoundary, resolved)) continue;
      const manifest = JSON.parse(await readFile(path.join(resolved, "package.json"), "utf8"));
      if (manifest.name === expectedName) return resolved;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error(`Could not find installed package root for ${expectedName}.`);
}

function packageRootCandidates(globalRoot, cliRoot, packageName) {
  const segments = packageName.split("/");
  return [
    path.join(globalRoot, ...segments),
    path.join(cliRoot, "node_modules", ...segments)
  ];
}

async function createGlobalCommandRunner({ commandPath, cliEntry, prefix, env }) {
  if (process.platform === "win32") {
    const wrapper = await validateWindowsGlobalCommand(commandPath, prefix);
    const commandProcessor = await resolveTrustedWindowsCommandProcessor({ repoRoot: root, sourceEnv: env });
    const commandEnvironment = { ...env, ComSpec: commandProcessor, COMSPEC: commandProcessor };
    const driverDirectory = path.dirname(prefix);
    return async (args, timeout) => {
      const invocation = renderWindowsCommandInvocation(wrapper, args);
      const driverName = `run-${args.join("-").replaceAll("--", "")}.cmd`;
      const driverPath = path.join(driverDirectory, driverName);
      await writeFile(
        driverPath,
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${invocation}\r\nexit /b %errorlevel%\r\n`,
        { flag: "wx", mode: 0o600 }
      );
      try {
        return await runChecked(
          commandProcessor,
          ["/d", "/s", "/c", driverName],
          { cwd: driverDirectory, env: commandEnvironment, timeout, windowsHide: true },
          "generated npm global preflight-scout.cmd"
        );
      } finally {
        await rm(driverPath, { force: true });
      }
    };
  }
  await validatePosixGlobalCommand(commandPath, cliEntry, prefix);
  return async (args, timeout) => runChecked(
    commandPath,
    args,
    { cwd: path.dirname(prefix), env, timeout },
    "generated npm global preflight-scout command"
  );
}

async function runChecked(command, args, options, label) {
  try {
    return await execFileAsync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
  } catch (error) {
    const exit = error?.code ?? error?.signal ?? "unknown";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim().slice(-2000) : "";
    throw new Error(`${label} failed (${exit})${stderr ? `: ${stderr}` : "."}`);
  }
}
