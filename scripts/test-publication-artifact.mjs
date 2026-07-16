import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PUBLISH_ORDER,
  preparePublicationArtifact,
  publishPublicationArtifact,
  verifyPublicationArtifact
} from "./publication-artifact.mjs";

const version = "0.1.0";
const commit = "0123456789abcdef0123456789abcdef01234567";
const root = await mkdtemp(path.join(tmpdir(), "preflight-scout-publication-artifact-"));
const source = path.join(root, "source");
const artifact = path.join(root, "artifact");

try {
  await mkdir(source);
  for (const name of PUBLISH_ORDER) await writeTarball(source, name, version);
  const prepared = await preparePublicationArtifact({ sourceDirectory: source, outputDirectory: artifact, version, commit });
  assert.equal(prepared.packageCount, 6);
  assert.match(prepared.checksumsSha256, /^sha256:[0-9a-f]{64}$/);

  const manifest = await verifyPublicationArtifact({ directory: artifact, version, commit });
  assert.deepEqual(manifest.publishOrder, PUBLISH_ORDER);
  assert.equal(manifest.packages.length, 6);

  const existingFetch = registryFetch(new Map(manifest.packages.map((item) => [item.name, item.integrity])));
  const calls = [];
  await publishPublicationArtifact({
    directory: artifact,
    version,
    commit,
    mode: "trusted-publishing",
    env: {},
    fetchImpl: existingFetch,
    npmCommand: "/trusted/npm",
    spawnImpl: fakeNpm(calls)
  });
  assert.deepEqual(calls, [], "matching registry versions must not be republished");

  const registry = new Map(manifest.packages.map((item) => [item.name, item.integrity]));
  registry.delete(PUBLISH_ORDER[0]);
  const published = [];
  await publishPublicationArtifact({
    directory: artifact,
    version,
    commit,
    mode: "bootstrap-token",
    env: { NODE_AUTH_TOKEN: "fixture-token" },
    fetchImpl: registryFetch(registry),
    npmCommand: "/trusted/npm",
    spawnImpl: fakeNpm(published, () => registry.set(PUBLISH_ORDER[0], manifest.packages[0].integrity)),
    retryDelay: async () => {}
  });
  assert.equal(published.length, 1);
  assert.equal(published[0][0], "publish");
  assert.equal(published[0][1], `./${manifest.packages[0].file}`);
  assert.ok(published[0].includes("--provenance"));

  const mismatch = new Map(manifest.packages.map((item) => [item.name, item.integrity]));
  mismatch.set(PUBLISH_ORDER[0], `sha512-${Buffer.from("different").toString("base64")}`);
  await assert.rejects(
    publishPublicationArtifact({
      directory: artifact,
      version,
      commit,
      mode: "trusted-publishing",
      env: {},
      fetchImpl: registryFetch(mismatch),
      npmCommand: "/trusted/npm",
      spawnImpl: fakeNpm([])
    }),
    /different registry integrity/
  );
  await assert.rejects(
    publishPublicationArtifact({
      directory: artifact,
      version,
      commit,
      mode: "trusted-publishing",
      env: { NODE_AUTH_TOKEN: "must-not-be-used" },
      fetchImpl: existingFetch,
      npmCommand: "/trusted/npm",
      spawnImpl: fakeNpm([])
    }),
    /refuses NODE_AUTH_TOKEN/
  );

  const checksumsPath = path.join(artifact, "SHA256SUMS");
  const originalChecksums = await readFile(checksumsPath, "utf8");
  await writeFile(checksumsPath, `${originalChecksums[0] === "0" ? "1" : "0"}${originalChecksums.slice(1)}`);
  await assert.rejects(verifyPublicationArtifact({ directory: artifact, version, commit }), /checksum mismatch|malformed/);

  console.log("Publication artifact tests passed exact packing, integrity verification, safe retry, token-mode separation, and mismatch rejection.");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function writeTarball(directory, name, packageVersion) {
  const fixture = path.join(root, name.replaceAll("/", "-").replace("@", ""));
  const packageRoot = path.join(fixture, "package");
  await mkdir(packageRoot, { recursive: true });
  const dependencies = name === "@preflight-scout/core" ? { zod: "^4.4.3" } : { "@preflight-scout/core": "^0.1.0" };
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name,
    version: packageVersion,
    license: "AGPL-3.0-only",
    repository: { type: "git", url: "git+https://github.com/fenutech/preflight-scout.git" },
    publishConfig: { access: "public", provenance: true },
    scripts: { build: "tsc" },
    dependencies
  })}\n`);
  const file = `${name.replace(/^@/, "").replaceAll("/", "-")}-${packageVersion}.tgz`;
  const result = spawnSync("tar", ["-czf", path.join(directory, file), "-C", fixture, "package"], { shell: false });
  if (result.status !== 0) throw new Error(`Could not create fixture tarball ${file}.`);
}

function registryFetch(registry) {
  return async (url) => {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const name = decodeURIComponent(segments[0]);
    const integrity = registry.get(name);
    if (!integrity) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ dist: { integrity } }), { status: 200 });
  };
}

function fakeNpm(publishCalls, onPublish = () => {}) {
  return (_command, args) => {
    if (args[0] === "--version") return { status: 0, stdout: "11.18.0\n" };
    publishCalls.push(args);
    onPublish(args);
    return { status: 0, stdout: "" };
  };
}
