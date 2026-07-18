import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BuildIdentityReadError,
  buildIdentityOpenFlags,
  type BuildIdentityFileOperations,
  type BuildIdentityStats,
  readBuildIdentityFileSync,
  resolvePackageRuntimePaths
} from "./build-identity-file.js";

describe("build identity file safety", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("resolves a Windows drive module URL to its package manifest on every host", () => {
    expect(resolvePackageRuntimePaths(
      "file:///D:/a/preflight-scout/preflight-scout/packages/core/dist/provenance.js",
      "win32"
    )).toEqual({
      modulePath: String.raw`D:\a\preflight-scout\preflight-scout\packages\core\dist\provenance.js`,
      packageRoot: String.raw`D:\a\preflight-scout\preflight-scout\packages\core`,
      packageManifestPath: String.raw`D:\a\preflight-scout\preflight-scout\packages\core\package.json`
    });
  });

  it("never passes the unsupported no-follow flag to Windows open", () => {
    expect(buildIdentityOpenFlags("win32", 0x20000)).toBe(buildIdentityOpenFlags("win32", undefined));
    expect(buildIdentityOpenFlags("linux", 0x20000) & 0x20000).toBe(0x20000);
  });

  it("rejects a symlink leaf before opening it", async () => {
    const directory = await fixtureDirectory(directories);
    const target = path.join(directory, "target.json");
    const link = path.join(directory, "package.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);

    expectFailure(() => readBuildIdentityFileSync(link, 1024), "unsafe");
  });

  it("rejects an oversized leaf before opening it", async () => {
    const directory = await fixtureDirectory(directories);
    const file = path.join(directory, "package.json");
    await writeFile(file, "12345");

    expectFailure(() => readBuildIdentityFileSync(file, 4), "oversized");
  });

  it("rejects a copied-metadata A/B swap instead of treating metadata as identity", () => {
    const a = identityStats({ dev: 1n, ino: 10n, size: 3n });
    const b = identityStats({ dev: 2n, ino: 20n, size: 3n });
    const operations = fakeOperations({
      lstat: () => a,
      stat: () => a,
      fstat: () => b
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "device-identity-mismatch-before-read"
    );
  });

  it("binds the Windows following stat target to the guarded non-following leaf", () => {
    const guardedLeaf = identityStats({ dev: 1n, ino: 10n, size: 3n });
    const followedTarget = identityStats({ dev: 2n, ino: 20n, size: 3n });
    const operations = fakeOperations({
      lstat: () => guardedLeaf,
      stat: () => followedTarget,
      fstat: () => followedTarget,
      read: (_descriptor, buffer) => {
        buffer.write("bad");
        return 3;
      }
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "device-identity-mismatch-before-read"
    );
  });

  it("uses the exact Windows file ID when the platform reports a zero device identity", () => {
    const degenerate = identityStats({ dev: 0n, ino: 10n, size: 3n });
    let read = false;
    const operations = fakeOperations({
      lstat: () => degenerate,
      stat: () => degenerate,
      fstat: () => degenerate,
      read: (_descriptor, buffer) => {
        if (read) return 0;
        read = true;
        buffer.write("ok\n");
        return 3;
      }
    });

    expect(readBuildIdentityFileSync(
      "C:\\fixture\\package.json",
      16,
      { platform: "win32", operations }
    ).toString("utf8")).toBe("ok\n");
  });

  it("still requires a nonzero device identity on POSIX", () => {
    const degenerate = identityStats({ dev: 0n, ino: 10n, size: 3n });
    const operations = fakeOperations({
      lstat: () => degenerate,
      fstat: () => degenerate
    });

    expectFailure(
      () => readBuildIdentityFileSync("/fixture/package.json", 16, { platform: "linux", operations }),
      "device-identity-unavailable-before-read"
    );
  });

  it("rejects a Windows device identity change even when one observation is zero", () => {
    const withoutVolumeIdentity = identityStats({ dev: 0n, ino: 10n, size: 3n });
    const withVolumeIdentity = identityStats({ dev: 1n, ino: 10n, size: 3n });
    const operations = fakeOperations({
      lstat: () => withoutVolumeIdentity,
      stat: () => withVolumeIdentity,
      fstat: () => withVolumeIdentity
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "device-identity-mismatch-before-read"
    );
  });

  it("fails closed when Windows does not expose a comparable file ID", () => {
    const degenerate = identityStats({ dev: 1n, ino: 0n, size: 3n });
    const operations = fakeOperations({
      lstat: () => degenerate,
      stat: () => degenerate,
      fstat: () => degenerate
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "file-id-unavailable-before-read"
    );
  });

  it("distinguishes a path-versus-handle file-ID mismatch", () => {
    const pathStats = identityStats({ dev: 1n, ino: 10n, size: 3n });
    const handleStats = identityStats({ dev: 1n, ino: 20n, size: 3n });
    const operations = fakeOperations({
      lstat: () => pathStats,
      stat: () => pathStats,
      fstat: () => handleStats
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "file-id-mismatch-before-read"
    );
  });

  it("rejects a Windows A/B swap by file ID when both device identities are zero", () => {
    const pathStats = identityStats({ dev: 0n, ino: 10n, size: 3n });
    const handleStats = identityStats({ dev: 0n, ino: 20n, size: 3n });
    const operations = fakeOperations({
      lstat: () => pathStats,
      stat: () => pathStats,
      fstat: () => handleStats
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "file-id-mismatch-before-read"
    );
  });

  it("distinguishes a path-versus-handle snapshot mismatch", () => {
    const pathStats = identityStats({ size: 3n });
    const handleStats = identityStats({ size: 3n, ctimeNs: 99n });
    const operations = fakeOperations({
      lstat: () => pathStats,
      stat: () => pathStats,
      fstat: () => handleStats
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "snapshot-mismatch-before-read"
    );
  });

  it("rejects path replacement while the opened descriptor still names the reviewed file", () => {
    const a = identityStats({ dev: 1n, ino: 10n, size: 3n });
    const b = identityStats({ dev: 2n, ino: 20n, size: 3n });
    let replaced = false;
    let read = false;
    const operations = fakeOperations({
      lstat: () => replaced ? b : a,
      stat: () => replaced ? b : a,
      fstat: () => a,
      read: (_descriptor, buffer) => {
        if (read) return 0;
        read = true;
        buffer.write("old");
        replaced = true;
        return 3;
      }
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "device-identity-mismatch-while-read"
    );
  });

  it("classifies concurrent growth beyond the read bound without an unbounded allocation", () => {
    const before = identityStats({ size: 3n });
    let read = false;
    const operations = fakeOperations({
      lstat: () => before,
      stat: () => before,
      fstat: () => before,
      read: (_descriptor, buffer) => {
        if (read) return 0;
        read = true;
        buffer.write("grow");
        return 4;
      }
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 3, { platform: "win32", operations }),
      "changed-while-read"
    );
  });

  it("rejects concurrent same-file growth even when it remains below the bound", () => {
    const before = identityStats({ size: 3n });
    const after = identityStats({ size: 4n });
    let grown = false;
    let read = false;
    const operations = fakeOperations({
      lstat: () => grown ? after : before,
      stat: () => grown ? after : before,
      fstat: () => grown ? after : before,
      read: (_descriptor, buffer) => {
        if (read) return 0;
        read = true;
        buffer.write("grow");
        grown = true;
        return 4;
      }
    });

    expectFailure(
      () => readBuildIdentityFileSync("C:\\fixture\\package.json", 16, { platform: "win32", operations }),
      "changed-while-read"
    );
  });

  it("converts descriptor read errors to a path-free failure", () => {
    const stable = identityStats({ size: 3n });
    const operations = fakeOperations({
      lstat: () => stable,
      stat: () => stable,
      fstat: () => stable,
      read: () => {
        throw new Error("C:\\private\\package.json");
      }
    });

    const error = captureFailure(() => readBuildIdentityFileSync(
      "C:\\private\\package.json",
      16,
      { platform: "win32", operations }
    ));
    expect(error.failure).toBe("changed-while-read");
    expect(error.message).not.toContain("private");
  });
});

async function fixtureDirectory(directories: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "preflight-scout-build-identity-"));
  directories.push(directory);
  return directory;
}

function expectFailure(operation: () => unknown, failure: BuildIdentityReadError["failure"]): void {
  expect(captureFailure(operation).failure).toBe(failure);
}

function captureFailure(operation: () => unknown): BuildIdentityReadError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BuildIdentityReadError);
    return error as BuildIdentityReadError;
  }
  throw new Error("Expected build identity read to fail.");
}

function fakeOperations(
  overrides: Partial<BuildIdentityFileOperations>
): BuildIdentityFileOperations {
  return {
    lstat: () => identityStats({ size: 3n }),
    stat: () => identityStats({ size: 3n }),
    open: () => 7,
    fstat: () => identityStats({ size: 3n }),
    read: () => 0,
    close: () => undefined,
    ...overrides
  };
}

function identityStats(overrides: Partial<BuildIdentityStats> = {}): BuildIdentityStats {
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100644n,
    nlink: 1n,
    size: 100n,
    mtimeNs: 10n,
    ctimeNs: 11n,
    birthtimeNs: 12n,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides
  };
}
