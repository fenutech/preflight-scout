import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderSourceCliWrapper } from "./source-cli-wrapper.mjs";

const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-source-wrapper-"));

try {
  const isWindows = process.platform === "win32";
  const trickyDir = path.join(tempRoot, "space ; dollar$ percent% amp& and quote'");
  const poisonBin = path.join(tempRoot, "poison-bin");
  const nodePath = path.join(trickyDir, `node exact ; '$%&${isWindows ? ".exe" : ""}`);
  const cliPath = path.join(trickyDir, "cli exact ; '$.mjs");
  const wrapperPath = path.join(trickyDir, `preflight-scout wrapper ; '$%&${isWindows ? ".cmd" : ""}`);
  const markerPath = path.join(tempRoot, "wrapper-result.json");
  const expectedArgs = ["argument with spaces", "semi;dollar$quote' percent% amp&"];

  await mkdir(trickyDir, { recursive: true });
  await mkdir(poisonBin, { recursive: true });
  if (isWindows) await copyFile(process.execPath, nodePath);
  else await symlink(process.execPath, nodePath);
  await writeFile(
    path.join(poisonBin, isWindows ? "node.cmd" : "node"),
    isWindows ? "@exit /b 97\r\n" : "#!/bin/sh\nexit 97\n",
    { mode: 0o755 }
  );
  await writeFile(cliPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PREFLIGHT_SCOUT_WRAPPER_MARKER, JSON.stringify(process.argv.slice(2)));\n`);
  await writeFile(wrapperPath, renderSourceCliWrapper({ nodePath, cliPath }), { mode: 0o755 });
  if (!isWindows) await chmod(wrapperPath, 0o755);

  const testEnv = {
    ...process.env,
    PATH: poisonBin,
    PREFLIGHT_SCOUT_WRAPPER_MARKER: markerPath
  };
  const result = isWindows
    ? await runWindowsWrapper(wrapperPath, expectedArgs, testEnv)
    : spawnSync(wrapperPath, expectedArgs, { encoding: "utf8", env: testEnv });
  if (result.status !== 0) {
    throw new Error(`POSIX source wrapper failed with ${result.status}:\n${result.stderr || result.stdout}`);
  }
  const actualArgs = JSON.parse(await readFile(markerPath, "utf8"));
  if (JSON.stringify(actualArgs) !== JSON.stringify(expectedArgs)) {
    throw new Error(`POSIX source wrapper changed arguments: ${JSON.stringify(actualArgs)}`);
  }

  const windows = renderSourceCliWrapper({
    nodePath: "C:\\Node % special\\node.exe",
    cliPath: "C:\\Preflight Scout & QA\\cli.js",
    platform: "win32"
  });
  if (!windows.includes('"C:\\Node %% special\\node.exe" "C:\\Preflight Scout & QA\\cli.js" %*')) {
    throw new Error(`Windows source wrapper did not quote executable paths safely:\n${windows}`);
  }
  if (!windows.includes("setlocal DisableDelayedExpansion")) {
    throw new Error("Windows source wrapper must disable delayed expansion.");
  }

  console.log(`Source CLI ${isWindows ? "Windows" : "POSIX"} wrapper pins the install-time Node executable and preserves shell-significant paths and arguments.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runWindowsWrapper(wrapperPath, args, env) {
  const commandProcessor = process.env.ComSpec;
  if (!commandProcessor) throw new Error("Windows wrapper test requires ComSpec.");
  const driverName = "invoke-wrapper.cmd";
  const driver = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quoteBatchValue(wrapperPath)} ${args.map(quoteBatchValue).join(" ")}\r\n`;
  await writeFile(path.join(tempRoot, driverName), driver);
  return spawnSync(commandProcessor, ["/d", "/s", "/c", driverName], {
    cwd: tempRoot,
    encoding: "utf8",
    env
  });
}

function quoteBatchValue(value) {
  if (value.includes('"')) throw new Error("Windows paths and test arguments cannot contain a double quote.");
  return `"${value.replaceAll("%", "%%")}"`;
}
