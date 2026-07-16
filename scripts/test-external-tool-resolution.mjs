import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  externalToolSearchDirectories,
  resolveExternalTool,
  splitExternalToolLines,
  windowsSystem32Directory
} from "./resolve-external-tool.mjs";

const execFileAsync = promisify(execFile);
const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-external-tool-"));

try {
  assert.equal(windowsSystem32Directory("C:\\Windows"), "C:\\Windows\\System32");
  assert.equal(windowsSystem32Directory("c:\\WINDOWS\\"), "c:\\WINDOWS\\System32");
  assert.equal(windowsSystem32Directory("C:\\runner\\Windows"), undefined);
  assert.equal(windowsSystem32Directory("\\\\runner\\share\\Windows"), undefined);
  assert.equal(windowsSystem32Directory(undefined), undefined);
  assert.deepEqual(externalToolSearchDirectories({
    platform: "win32",
    searchPath: "D:\\Program Files\\Git\\usr\\bin;C:\\Tools",
    windowsSystemRoot: "C:\\Windows",
    windowsSystem32Only: true
  }), ["C:\\Windows\\System32"]);
  assert.deepEqual(externalToolSearchDirectories({
    platform: "linux",
    searchPath: "/usr/local/bin:/usr/bin",
    windowsSystemRoot: undefined,
    windowsSystem32Only: true
  }), ["/usr/local/bin", "/usr/bin"]);
  assert.throws(() => externalToolSearchDirectories({
    platform: "win32",
    searchPath: "D:\\Program Files\\Git\\usr\\bin",
    windowsSystemRoot: "D:\\workspace\\Windows",
    windowsSystem32Only: true
  }), /canonical drive-root Windows directory/);
  assert.deepEqual(splitExternalToolLines("package/a\npackage/b\n"), ["package/a", "package/b"]);
  assert.deepEqual(splitExternalToolLines("package/a\r\npackage/b\r\n"), ["package/a", "package/b"]);
  assert.deepEqual(splitExternalToolLines(" package/a \r\n"), [" package/a "]);
  assert.throws(() => splitExternalToolLines("package/a\rpackage/b\n"), /stray carriage return/);
  assert.throws(() => splitExternalToolLines("package/a\n\npackage/b\n"), /empty record/);

  const poisonBin = path.join(tempRoot, "node_modules", ".bin");
  const poisonTar = path.join(poisonBin, process.platform === "win32" ? "tar.exe" : "tar");
  const marker = path.join(tempRoot, "poison-marker.txt");
  await mkdir(poisonBin, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(poisonTar, "not an executable tar", "utf8");
  } else {
    await writeFile(poisonTar, `#!/bin/sh\nprintf poison > ${shellQuote(marker)}\nexit 97\n`, { encoding: "utf8", mode: 0o755 });
    await chmod(poisonTar, 0o755);
  }

  const resolved = await resolveExternalTool("tar", {
    repoRoot: tempRoot,
    searchPath: `${poisonBin}${path.delimiter}${process.env.PATH ?? ""}`
  });
  const relative = path.relative(tempRoot, resolved);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new Error(`Resolved repository-controlled tar shim: ${resolved}`);
  }
  await execFileAsync(resolved, ["--version"], { maxBuffer: 1024 * 1024 });
  try {
    await readFile(marker);
    throw new Error("Repository-controlled tar shim was executed.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  console.log(`External tar resolution ignored the repository PATH shim and selected ${resolved}; Windows system-only resolution is drive-root constrained.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
