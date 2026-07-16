import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RUNTIME_PACKAGES,
  buildIsolatedSmokeEnvironment,
  loadRuntimeReleasePlan,
  parseSmokeArguments,
  renderWindowsCommandInvocation,
  resolveTrustedNpmInvocation,
  resolveTrustedWindowsCommandProcessor,
  samePathAndHandleIdentity,
  tarballName
} from "./npm-global-install-smoke-lib.mjs";

const tempRoot = await mkdtemp(path.join(tmpdir(), "preflight-scout-test-npm-global-"));

try {
  assert.deepEqual(parseSmokeArguments([]), { mode: "tarballs" });
  assert.deepEqual(parseSmokeArguments(["--registry", "@preflight-scout/cli@0.1.0"]), {
    mode: "registry",
    specifier: "@preflight-scout/cli@0.1.0",
    version: "0.1.0"
  });
  for (const refused of [
    ["--registry", "@preflight-scout/cli@latest"],
    ["--registry", "@preflight-scout/cli@^0.1.0"],
    ["--registry", "@preflight-scout/github-action@0.1.0"],
    ["--registry"]
  ]) {
    assert.throws(() => parseSmokeArguments(refused));
  }

  const stableIdentity = { dev: 37n, ino: 41n, size: 43n };
  assert.equal(samePathAndHandleIdentity(stableIdentity, { ...stableIdentity }, "linux"), true);
  assert.equal(samePathAndHandleIdentity(
    { ...stableIdentity, dev: 0n },
    stableIdentity,
    "win32"
  ), true);
  assert.equal(samePathAndHandleIdentity(
    { ...stableIdentity, dev: 0n },
    stableIdentity,
    "linux"
  ), false);
  assert.equal(samePathAndHandleIdentity(
    stableIdentity,
    { ...stableIdentity, dev: 0n },
    "win32"
  ), false);
  assert.equal(samePathAndHandleIdentity(
    { ...stableIdentity, dev: 38n },
    stableIdentity,
    "win32"
  ), false);
  assert.equal(samePathAndHandleIdentity(
    { ...stableIdentity, dev: 0n },
    { ...stableIdentity, dev: 0n },
    "win32"
  ), false);
  assert.equal(samePathAndHandleIdentity(
    { ...stableIdentity, ino: 0n },
    { ...stableIdentity, ino: 0n },
    "win32"
  ), false);
  assert.equal(samePathAndHandleIdentity(
    stableIdentity,
    { ...stableIdentity, ino: 42n },
    "win32"
  ), false);
  assert.equal(samePathAndHandleIdentity(
    stableIdentity,
    { ...stableIdentity, size: 44n },
    "win32"
  ), false);

  const repo = path.join(tempRoot, "repo");
  const packageCheck = path.join(repo, ".preflight-scout", "package-check");
  await mkdir(packageCheck, { recursive: true });
  for (const runtimePackage of RUNTIME_PACKAGES) {
    const packageRoot = path.join(repo, "packages", runtimePackage.directory);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
      name: runtimePackage.name,
      version: "0.1.0"
    })}\n`);
    await writeFile(path.join(packageCheck, tarballName(runtimePackage.name, "0.1.0")), "fixture");
  }

  const localPlan = await loadRuntimeReleasePlan(repo, parseSmokeArguments([]), {
    stagingDirectory: path.join(tempRoot, "staged-local")
  });
  assert.equal(localPlan.installSpecifiers.length, 5);
  assert.deepEqual(localPlan.packages.map((entry) => entry.name), RUNTIME_PACKAGES.map((entry) => entry.name));
  assert.ok(localPlan.installSpecifiers.every((entry) => !entry.includes("github-action")));
  await assert.rejects(
    loadRuntimeReleasePlan(repo, parseSmokeArguments(["--registry", "@preflight-scout/cli@0.1.1"])),
    /does not match the source release version/
  );

  const external = path.join(tempRoot, "external");
  const fakeBin = path.join(external, "bin");
  const fakeNpmCli = path.join(external, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.dirname(fakeNpmCli), { recursive: true });
  await writeFile(fakeNpmCli, "fake npm\n");
  await writeFile(path.resolve(path.dirname(fakeNpmCli), "..", "package.json"), `${JSON.stringify({
    name: "npm",
    bin: { npm: "bin/npm-cli.js" }
  })}\n`);

  const poisonBin = path.join(repo, "node_modules", ".bin");
  await mkdir(poisonBin, { recursive: true });
  const poisonNpm = path.join(poisonBin, "npm-cli.js");
  await writeFile(poisonNpm, "poison\n");
  const npmInvocation = await resolveTrustedNpmInvocation({
    repoRoot: repo,
    sourceEnv: { PATH: `${fakeBin}${path.delimiter}${poisonBin}`, npm_execpath: fakeNpmCli }
  });
  assert.equal(npmInvocation.command, await realpath(process.execPath));
  assert.notEqual(npmInvocation.npmCliPath, fakeNpmCli);
  assert.ok(!npmInvocation.npmCliPath.startsWith(external));

  const isolated = await buildIsolatedSmokeEnvironment({
    repoRoot: repo,
    tempRoot: path.join(tempRoot, "isolated"),
    prefix: path.join(tempRoot, "isolated", "prefix"),
    sourceEnv: {
      PATH: `${poisonBin}${path.delimiter}${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: "--require poison.js",
      NODE_AUTH_TOKEN: "npm-secret",
      npm_config_registry: "https://attacker.invalid/",
      ComSpec: path.join(fakeBin, "cmd.exe"),
      HTTPS_PROXY: "http://proxy.example"
    }
  });
  assert.ok(!isolated.env.PATH.split(path.delimiter).includes(poisonBin));
  assert.equal(isolated.env.PATH.split(path.delimiter)[0], path.dirname(await realpath(process.execPath)));
  assert.equal(isolated.env.NODE_OPTIONS, undefined);
  assert.equal(isolated.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(isolated.env.ComSpec, undefined);
  assert.equal(isolated.env.npm_config_registry, "https://registry.npmjs.org/");
  assert.equal(isolated.env.npm_config_ignore_scripts, undefined);
  assert.equal(isolated.env.HTTPS_PROXY, "http://proxy.example");

  assert.equal(
    renderWindowsCommandInvocation("C:\\safe temp\\preflight-scout.cmd", ["--version"]),
    'call "C:\\safe temp\\preflight-scout.cmd" --version'
  );
  assert.equal(
    renderWindowsCommandInvocation("C:\\Users\\RUNNER~1\\preflight-scout.cmd", ["install-browser"]),
    'call "C:\\Users\\RUNNER~1\\preflight-scout.cmd" install-browser'
  );
  assert.throws(() => renderWindowsCommandInvocation("C:\\unsafe&path\\preflight-scout.cmd", ["--version"]));
  assert.throws(() => renderWindowsCommandInvocation("C:\\safe\\preflight-scout.cmd", ["--version", "& whoami"]));

  const fakeComSpec = path.join(external, "fake-comspec", "cmd.exe");
  await mkdir(path.dirname(fakeComSpec), { recursive: true });
  await writeFile(fakeComSpec, "forged ComSpec\n");
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.ok(systemRoot);
    const systemCmd = path.join(systemRoot, "System32", "cmd.exe");
    assert.equal(await resolveTrustedWindowsCommandProcessor({
      repoRoot: repo,
      sourceEnv: { SystemRoot: systemRoot, ComSpec: fakeComSpec }
    }), await realpath(systemCmd));
    await assert.rejects(
      resolveTrustedWindowsCommandProcessor({ repoRoot: repo, sourceEnv: { SystemRoot: path.dirname(systemRoot), ComSpec: fakeComSpec } }),
      /drive-level Windows directory|Windows command processor|ENOENT/
    );
  } else {
    const systemRoot = path.join(external, "fake-windows");
    const systemCmd = path.join(systemRoot, "System32", "cmd.exe");
    await mkdir(path.dirname(systemCmd), { recursive: true });
    await writeFile(systemCmd, "system cmd\n");
    assert.equal(await resolveTrustedWindowsCommandProcessor({
      repoRoot: repo,
      sourceEnv: { SystemRoot: systemRoot, ComSpec: fakeComSpec }
    }), await realpath(systemCmd));
    await rm(systemCmd);
    await assert.rejects(
      resolveTrustedWindowsCommandProcessor({ repoRoot: repo, sourceEnv: { SystemRoot: systemRoot, ComSpec: fakeComSpec } }),
      /Windows command processor|ENOENT/
    );
  }

  const coreTarball = path.join(packageCheck, tarballName("@preflight-scout/core", "0.1.0"));
  const tarballHardlink = path.join(packageCheck, "core-hardlink.tgz");
  await link(coreTarball, tarballHardlink);
  await assert.rejects(
    loadRuntimeReleasePlan(repo, parseSmokeArguments([]), { stagingDirectory: path.join(tempRoot, "staged-hardlink-tarball") }),
    /single-link regular file/
  );
  await rm(tarballHardlink);

  const coreManifest = path.join(repo, "packages", "core", "package.json");
  const manifestHardlink = path.join(repo, "packages", "core", "package-hardlink.json");
  await link(coreManifest, manifestHardlink);
  await assert.rejects(
    loadRuntimeReleasePlan(repo, parseSmokeArguments([]), { stagingDirectory: path.join(tempRoot, "staged-hardlink-manifest") }),
    /single-link regular file/
  );
  await rm(manifestHardlink);

  if (process.platform !== "win32") {
    const symlinkRepo = path.join(tempRoot, "symlink-repo");
    await mkdir(path.join(symlinkRepo, "packages"), { recursive: true });
    for (const runtimePackage of RUNTIME_PACKAGES) {
      const source = path.join(repo, "packages", runtimePackage.directory);
      await symlink(source, path.join(symlinkRepo, "packages", runtimePackage.directory), "dir");
    }
    await mkdir(path.join(symlinkRepo, ".preflight-scout"), { recursive: true });
    await symlink(packageCheck, path.join(symlinkRepo, ".preflight-scout", "package-check"), "dir");
    await assert.rejects(
      loadRuntimeReleasePlan(symlinkRepo, parseSmokeArguments([]), { stagingDirectory: path.join(tempRoot, "staged-symlink") }),
      /single-link regular file|real directory, not a symlink|resolves outside/
    );
  }

  console.log("npm global smoke helpers passed exact-spec, staged five-package, trusted-Node npm, hardlink, isolated-env, and canonical-command tests.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
