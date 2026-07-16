import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_PACKAGES = Object.freeze([
  Object.freeze({ directory: "core", name: "@preflight-scout/core" }),
  Object.freeze({ directory: "agent-exec", name: "@preflight-scout/agent-exec" }),
  Object.freeze({ directory: "browser-runner", name: "@preflight-scout/browser-runner" }),
  Object.freeze({ directory: "mcp", name: "@preflight-scout/mcp" }),
  Object.freeze({ directory: "cli", name: "@preflight-scout/cli" })
]);

const EXACT_VERSION = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const REGISTRY_SPECIFIER = new RegExp(`^@preflight-scout/cli@(${EXACT_VERSION})$`);
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

export function parseSmokeArguments(args) {
  if (!Array.isArray(args)) throw new Error("Smoke arguments must be an array.");
  if (!args.length) return { mode: "tarballs" };
  if (args.length === 1 && args[0] === "--help") return { mode: "help" };
  if (args.length === 2 && args[0] === "--registry") {
    const match = REGISTRY_SPECIFIER.exec(args[1]);
    if (!match) {
      throw new Error("--registry requires an exact @preflight-scout/cli@X.Y.Z package specifier; tags and ranges are refused.");
    }
    return { mode: "registry", specifier: args[1], version: match[1] };
  }
  throw new Error("Usage: node scripts/npm-global-install-smoke.mjs [--registry @preflight-scout/cli@X.Y.Z]");
}

export async function loadRuntimeReleasePlan(repoRoot, parsed, options = {}) {
  const resolvedRepo = await realpath(path.resolve(repoRoot));
  const packages = [];
  for (const expected of RUNTIME_PACKAGES) {
    const manifestPath = path.join(resolvedRepo, "packages", expected.directory, "package.json");
    const manifest = JSON.parse((await readStableSingleLinkFile(
      manifestPath,
      resolvedRepo,
      `Source manifest ${expected.name}`,
      1024 * 1024
    )).toString("utf8"));
    if (manifest.name !== expected.name || !new RegExp(`^${EXACT_VERSION}$`).test(manifest.version)) {
      throw new Error(`${manifestPath} must identify the expected exact package ${expected.name}.`);
    }
    packages.push({ ...expected, version: manifest.version, manifest });
  }

  const versions = new Set(packages.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error("The five npm runtime packages must share one release version.");
  const [version] = versions;
  if (parsed.mode === "registry") {
    if (parsed.version !== version) {
      throw new Error(`Registry smoke version ${parsed.version} does not match the source release version ${version}.`);
    }
    return { mode: "registry", version, packages, installSpecifiers: [parsed.specifier] };
  }
  if (parsed.mode !== "tarballs") throw new Error(`Cannot create an install plan for mode ${parsed.mode}.`);

  const packageCheck = path.join(resolvedRepo, ".preflight-scout", "package-check");
  const packageCheckStats = await lstat(packageCheck);
  if (!packageCheckStats.isDirectory() || packageCheckStats.isSymbolicLink()) {
    throw new Error("The package-check source must be a real directory, not a symlink.");
  }
  const resolvedPackageCheck = await realpath(packageCheck);
  if (!isPathWithin(resolvedRepo, resolvedPackageCheck)) {
    throw new Error("The package-check source resolves outside the repository.");
  }

  if (!options.stagingDirectory || !path.isAbsolute(options.stagingDirectory)) {
    throw new Error("Tarball smoke requires an absolute isolated staging directory.");
  }
  await mkdir(options.stagingDirectory, { mode: 0o700 });
  const stagingStats = await lstat(options.stagingDirectory);
  const resolvedStaging = await realpath(options.stagingDirectory);
  if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink() || isPathWithin(resolvedRepo, resolvedStaging)) {
    throw new Error("Tarball staging must be a real directory outside the repository.");
  }

  const installSpecifiers = [];
  for (const runtimePackage of packages) {
    const filename = tarballName(runtimePackage.name, runtimePackage.version);
    const candidate = path.join(packageCheck, filename);
    const content = await readStableSingleLinkFile(
      candidate,
      resolvedPackageCheck,
      `Runtime tarball ${filename}`,
      20 * 1024 * 1024
    );
    const staged = path.join(resolvedStaging, filename);
    await writeFile(staged, content, { flag: "wx", mode: 0o600 });
    const stagedStats = await lstat(staged, { bigint: true });
    const resolvedStaged = await realpath(staged);
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink() || stagedStats.nlink !== 1n || !isPathWithin(resolvedStaging, resolvedStaged)) {
      throw new Error(`Staged runtime tarball ${filename} is not a private single-link regular file.`);
    }
    installSpecifiers.push(resolvedStaged);
  }

  return { mode: "tarballs", version, packages, installSpecifiers };
}

export async function resolveTrustedNpmInvocation({ repoRoot }) {
  const resolvedRepo = await realpath(path.resolve(repoRoot));
  const resolvedNode = await trustedRegularFile(process.execPath, resolvedRepo, "Node.js runtime", true);
  const nodeDirectory = path.dirname(resolvedNode);
  const candidates = [
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];

  const seen = new Set();
  for (const candidate of candidates) {
    let resolvedCandidate;
    try {
      resolvedCandidate = await realpath(candidate);
    } catch {
      continue;
    }
    const key = normalizeForComparison(resolvedCandidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isPathWithin(resolvedRepo, resolvedCandidate)) continue;
    try {
      await assertNpmCli(resolvedCandidate);
      return { command: resolvedNode, args: [resolvedCandidate], npmCliPath: resolvedCandidate };
    } catch {
      // Keep looking only within known layouts owned by this Node installation.
    }
  }
  throw new Error("Could not resolve a trusted npm CLI entry point outside the repository.");
}

export async function buildIsolatedSmokeEnvironment({ repoRoot, tempRoot, prefix, sourceEnv = process.env }) {
  const resolvedRepo = await realpath(path.resolve(repoRoot));
  const resolvedNode = await trustedRegularFile(process.execPath, resolvedRepo, "Node.js runtime", true);
  const directories = await trustedPathDirectories(sourceEnv.PATH ?? "", resolvedRepo);
  const safePath = uniquePaths([path.dirname(resolvedNode), ...directories]).join(path.delimiter);
  const isolatedHome = path.join(tempRoot, "home");
  const isolatedCache = path.join(tempRoot, "npm-cache");
  const isolatedTemp = path.join(tempRoot, "tmp");
  const userConfig = path.join(tempRoot, "user.npmrc");
  const globalConfig = path.join(tempRoot, "global.npmrc");
  const env = {};

  for (const name of [
    "SystemRoot", "SYSTEMROOT", "WINDIR", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"
  ]) {
    if (typeof sourceEnv[name] === "string" && sourceEnv[name]) env[name] = sourceEnv[name];
  }

  Object.assign(env, {
    PATH: safePath,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
    TMPDIR: isolatedTemp,
    TMP: isolatedTemp,
    TEMP: isolatedTemp,
    PLAYWRIGHT_BROWSERS_PATH: path.join(tempRoot, "playwright-browsers"),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: isolatedCache,
    npm_config_prefix: prefix,
    npm_config_registry: OFFICIAL_REGISTRY,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_package_lock: "false",
    npm_config_loglevel: "error"
  });
  return { env, isolatedHome, isolatedCache, isolatedTemp, userConfig, globalConfig };
}

export async function validatePosixGlobalCommand(commandPath, cliEntryPath, boundary) {
  const commandStats = await lstat(commandPath);
  if (!commandStats.isSymbolicLink()) {
    throw new Error("npm must expose the POSIX global preflight-scout command as a symlink.");
  }
  const [resolvedCommand, resolvedEntry, resolvedBoundary] = await Promise.all([
    realpath(commandPath),
    realpath(cliEntryPath),
    realpath(boundary)
  ]);
  if (!isPathWithin(resolvedBoundary, resolvedCommand) || !pathsEqual(resolvedCommand, resolvedEntry)) {
    throw new Error("The npm global preflight-scout command does not target the installed CLI entry point.");
  }
  return resolvedCommand;
}

export async function validateWindowsGlobalCommand(commandPath, boundary) {
  const stats = await lstat(commandPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 32 * 1024) {
    throw new Error("npm must expose a small regular preflight-scout.cmd wrapper on Windows.");
  }
  const [resolvedCommand, resolvedBoundary] = await Promise.all([realpath(commandPath), realpath(boundary)]);
  if (!isPathWithin(resolvedBoundary, resolvedCommand)) {
    throw new Error("The npm global preflight-scout.cmd wrapper resolves outside the isolated prefix.");
  }
  const normalized = (await readFile(resolvedCommand, "utf8")).replaceAll("\\", "/").toLowerCase();
  if (!normalized.includes("node_modules/@preflight-scout/cli/dist/index.js")) {
    throw new Error("The npm global preflight-scout.cmd wrapper does not reference the installed CLI entry point.");
  }
  return resolvedCommand;
}

export function renderWindowsCommandInvocation(commandPath, args) {
  if (typeof commandPath !== "string" || !/^[A-Za-z]:[A-Za-z0-9 _.:~\\/-]+$/.test(commandPath)) {
    throw new Error("Refusing a Windows command-wrapper path containing shell metacharacters.");
  }
  if (!Array.isArray(args) || args.length !== 1 || !new Set(["--version", "--help", "install-browser"]).has(args[0])) {
    throw new Error("Refusing unsafe Windows command-wrapper arguments.");
  }
  return `call "${commandPath}" ${args.join(" ")}`;
}

export async function resolveTrustedWindowsCommandProcessor({ repoRoot, sourceEnv = process.env }) {
  const resolvedRepo = await realpath(path.resolve(repoRoot));
  const systemRoot = sourceEnv.SystemRoot ?? sourceEnv.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) {
    throw new Error("Could not resolve canonical SystemRoot for the Windows command processor.");
  }
  const resolvedSystemRoot = await realpath(systemRoot);
  if (isPathWithin(resolvedRepo, resolvedSystemRoot)) {
    throw new Error("Canonical SystemRoot resolves inside the repository.");
  }
  if (process.platform === "win32") {
    const driveRoot = path.parse(resolvedSystemRoot).root;
    if (!pathsEqual(path.dirname(resolvedSystemRoot), driveRoot) || path.basename(resolvedSystemRoot).toLowerCase() !== "windows") {
      throw new Error("Canonical SystemRoot must be the drive-level Windows directory.");
    }
  }
  const resolvedSystem32 = await realpath(path.join(resolvedSystemRoot, "System32"));
  const commandProcessor = await trustedRegularFile(
    path.join(resolvedSystem32, "cmd.exe"),
    resolvedRepo,
    "Windows command processor",
    false
  );
  if (path.basename(commandProcessor).toLowerCase() !== "cmd.exe" || !pathsEqual(path.dirname(commandProcessor), resolvedSystem32)) {
    throw new Error("Windows command processor is not canonical SystemRoot/System32/cmd.exe.");
  }
  return commandProcessor;
}

export function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

export function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertNpmCli(candidate) {
  const stats = await lstat(candidate);
  if (!stats.isFile() || path.basename(candidate) !== "npm-cli.js") throw new Error("not the npm JavaScript CLI");
  const npmRoot = path.resolve(path.dirname(candidate), "..");
  const manifest = JSON.parse(await readFile(path.join(npmRoot, "package.json"), "utf8"));
  const declaredBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.npm;
  if (manifest.name !== "npm" || declaredBin !== "bin/npm-cli.js") throw new Error("invalid npm package metadata");
}

async function readStableSingleLinkFile(candidate, boundary, label, maxBytes) {
  const resolvedBoundary = await realpath(boundary);
  const before = await lstat(candidate, { bigint: true });
  const resolvedBefore = await realpath(candidate);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !isPathWithin(resolvedBoundary, resolvedBefore)) {
    throw new Error(`${label} must be a single-link regular file inside its trusted boundary.`);
  }
  if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds the ${maxBytes}-byte read limit.`);

  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(candidate, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!samePathAndHandleIdentity(before, opened) || !opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maxBytes)) {
      throw new Error(`${label} changed before it could be opened safely.`);
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStableFile(opened, after) || BigInt(content.length) !== after.size) {
      throw new Error(`${label} changed while it was being copied.`);
    }
    const pathAfter = await lstat(candidate, { bigint: true });
    const resolvedAfter = await realpath(candidate);
    if (!samePathAndHandleIdentity(pathAfter, after) || pathAfter.nlink !== 1n || !pathsEqual(resolvedBefore, resolvedAfter)) {
      throw new Error(`${label} was replaced while it was being copied.`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export function samePathAndHandleIdentity(pathStats, handleStats, platform = process.platform) {
  const deviceMatches = (pathStats.dev !== 0n && pathStats.dev === handleStats.dev)
    || (platform === "win32" && pathStats.dev === 0n && handleStats.dev !== 0n);
  return deviceMatches
    && pathStats.ino !== 0n
    && handleStats.ino !== 0n
    && pathStats.ino === handleStats.ino
    && pathStats.size === handleStats.size;
}

function sameStableFile(left, right) {
  return left.dev !== 0n
    && right.dev !== 0n
    && left.dev === right.dev
    && left.ino !== 0n
    && right.ino !== 0n
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === 1n
    && right.nlink === 1n
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function trustedRegularFile(candidate, repoRoot, label, requireExecutable) {
  if (!path.isAbsolute(candidate)) throw new Error(`${label} path must be absolute.`);
  const resolved = await realpath(candidate);
  if (isPathWithin(repoRoot, resolved)) throw new Error(`${label} resolves inside the repository.`);
  const stats = await lstat(resolved);
  if (!stats.isFile()) throw new Error(`${label} is not a regular file.`);
  if (requireExecutable) await access(resolved, constants.X_OK);
  return resolved;
}

async function trustedPathDirectories(searchPath, repoRoot) {
  const directories = [];
  for (const entry of searchPath.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    try {
      const resolved = await realpath(entry);
      if (isPathWithin(repoRoot, resolved) || !(await lstat(resolved)).isDirectory()) continue;
      directories.push(resolved);
    } catch {
      // Ignore missing, relative, and inaccessible PATH entries.
    }
  }
  return uniquePaths(directories);
}

function uniquePaths(values) {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = normalizeForComparison(value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function pathsEqual(left, right) {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
