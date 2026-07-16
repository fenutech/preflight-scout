import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

export async function resolveExternalTool(name, options) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid external tool name: ${name}`);
  const repoRoot = await realpath(path.resolve(options.repoRoot));
  const searchPath = options.searchPath ?? process.env.PATH ?? "";
  const candidateNames = executableNames(name, process.platform, process.env.PATHEXT);
  const searchDirectories = externalToolSearchDirectories({
    platform: process.platform,
    searchPath,
    windowsSystemRoot: process.env.SystemRoot,
    windowsSystem32Only: options.windowsSystem32Only === true
  });

  for (const entry of searchDirectories) {
    if (!entry || !path.isAbsolute(entry)) continue;
    let directory;
    try {
      directory = await realpath(entry);
      if (isPathWithin(repoRoot, directory)) continue;
      if (!(await lstat(directory)).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const candidateName of candidateNames) {
      try {
        const candidate = await realpath(path.join(directory, candidateName));
        if (isPathWithin(repoRoot, candidate)) continue;
        const stats = await lstat(candidate);
        if (!stats.isFile()) continue;
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through the sanitized PATH until a real executable is found.
      }
    }
  }

  if (options.windowsSystem32Only && process.platform === "win32") {
    throw new Error(`Could not resolve trusted Windows system executable ${name}.`);
  }
  throw new Error(`Could not resolve executable ${name} outside the repository.`);
}

export function externalToolSearchDirectories({
  platform,
  searchPath,
  windowsSystemRoot,
  windowsSystem32Only
}) {
  if (windowsSystem32Only && platform === "win32") {
    const system32 = windowsSystem32Directory(windowsSystemRoot);
    if (!system32) {
      throw new Error("Refusing Windows system-tool resolution without a canonical drive-root Windows directory.");
    }
    return [system32];
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return searchPath.split(pathApi.delimiter);
}

export function windowsSystem32Directory(systemRoot) {
  if (typeof systemRoot !== "string" || !systemRoot.trim()) return undefined;
  const normalized = path.win32.resolve(systemRoot);
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) return undefined;
  if (path.win32.dirname(normalized).toLowerCase() !== parsed.root.toLowerCase()) return undefined;
  if (path.win32.basename(normalized).toLowerCase() !== "windows") return undefined;
  return path.win32.join(normalized, "System32");
}

export function splitExternalToolLines(output) {
  if (typeof output !== "string") throw new TypeError("External tool output must be a string.");
  const normalized = output.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw new Error("External tool output contains a stray carriage return.");
  }
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0)) {
    throw new Error("External tool output contains an empty record.");
  }
  return lines;
}

function executableNames(name, platform, pathExt) {
  if (platform !== "win32") return [name];
  const extensions = (pathExt ?? ".COM;.EXE")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.(?:com|exe)$/i.test(extension));
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
