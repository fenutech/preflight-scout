#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSourceCliWrapper } from "./source-cli-wrapper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const binDir = path.resolve(options.binDir ?? process.env.PREFLIGHT_SCOUT_BIN_DIR ?? process.env.XDG_BIN_HOME ?? path.join(os.homedir(), ".local", "bin"));
const commandName = "preflight-scout";
const destination = path.join(binDir, process.platform === "win32" ? `${commandName}.cmd` : commandName);
const cliPath = path.join(root, "packages", "cli", "dist", "index.js");

assertSupportedNode();
console.log(`Building Preflight Scout from ${root}`);
const pnpm = packageManagerInvocation();
run(pnpm.command, [...pnpm.args, "build"], root);
run(process.execPath, [path.join(root, "scripts", "package-build-integrity.mjs"), "verify", "packages/cli"], root);

console.log("Installing Chromium for Preflight Scout");
run(process.execPath, [cliPath, "install-browser"], root);

await mkdir(binDir, { recursive: true });
const wrapper = renderSourceCliWrapper({ nodePath: process.execPath, cliPath });

let existing;
try {
  const stat = await lstat(destination);
  if (stat.isDirectory()) throw new Error(`Refusing to replace directory ${destination}.`);
  if (stat.isFile()) existing = await readFile(destination, "utf8");
  if (existing !== wrapper && !options.force) {
    throw new Error(`Refusing to replace existing ${destination}. Re-run with --force to preserve it as a timestamped backup.`);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (existing !== wrapper) {
  if (options.force) {
    try {
      await lstat(destination);
      const backup = `${destination}.backup-${new Date().toISOString().replaceAll(":", "-")}`;
      await rename(destination, backup);
      console.log(`Preserved the previous command at ${backup}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const temporary = `${destination}.tmp-${process.pid}`;
  await writeFile(temporary, wrapper, { flag: "wx", mode: 0o755 });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
if (process.platform !== "win32") await chmod(destination, 0o755);

if (process.platform === "win32") {
  // Node cannot spawn a .cmd file directly with shell:false. Validate the exact
  // pinned runtime target here; Windows CI executes the generated wrapper.
  run(process.execPath, [cliPath, "--version"], root);
} else {
  run(destination, ["--version"], root);
}
console.log(`Installed durable source command: ${destination}`);
console.log(`The command points to this checkout; keep it at ${root}`);
if (!pathEntries().some((entry) => pathsEqual(entry, binDir))) {
  console.log(`${binDir} is not on PATH in this shell. Invoke ${destination} directly or add that directory to PATH before starting a new agent task.`);
} else {
  const resolvedCommand = await firstCommandOnPath(commandName);
  if (resolvedCommand && !pathsEqual(resolvedCommand, destination)) {
    console.log(`PATH currently resolves ${commandName} to ${resolvedCommand} before ${destination}. Use the installed absolute path or choose an earlier user-owned PATH directory.`);
  }
}

function parseArguments(args) {
  const parsed = { binDir: undefined, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--bin-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--bin-dir requires a path.");
      parsed.binDir = value;
      index += 1;
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help") {
      console.log("Usage: pnpm install:source-cli -- [--bin-dir <path>] [--force]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node.js 22.13.0 or newer is required; found ${process.versions.node}.`);
  }
}

function packageManagerInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && path.isAbsolute(npmExecPath) && /pnpm/i.test(path.basename(npmExecPath))) {
    return { command: process.execPath, args: [npmExecPath] };
  }
  if (process.platform === "win32") {
    throw new Error(
      "On Windows, run this installer through `pnpm install:source-cli` so Preflight Scout can invoke pnpm through its JavaScript entry point without an unsafe command shell."
    );
  }
  return { command: "pnpm", args: [] };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(" ")} failed with exit code ${result.status}.`);
}

function pathEntries() {
  return (process.env.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry));
}

async function firstCommandOnPath(name) {
  const candidateNames = process.platform === "win32" && !path.extname(name)
    ? [name, ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim())
        .filter(Boolean)
        .map((extension) => `${name}${extension.startsWith(".") ? extension : `.${extension}`}`)]
    : [name];
  for (const directory of pathEntries()) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(directory, candidateName);
      try {
        const stat = await lstat(candidate);
        if (!stat.isDirectory()) return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return undefined;
}

function pathsEqual(left, right) {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
