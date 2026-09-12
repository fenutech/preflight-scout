import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PUBLISH_ORDER,
  checkPublicationRegistry,
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

  const registryRequests = [];
  const existingFetch = registryFetch(
    new Map(manifest.packages.map((item) => [item.name, item.integrity])),
    registryRequests
  );
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
  assert.equal(registryRequests.length, PUBLISH_ORDER.length);
  assert.ok(
    registryRequests.every((request) => request.options.headers.accept === "application/json"),
    "exact-version registry lookups must request the representation npm serves"
  );

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
  assert.ok(published[0].includes("--registry=https://registry.npmjs.org/"));

  const oldWindow = delayedRegistry(manifest, new Map([[PUBLISH_ORDER[0], 100_000]]));
  await assert.rejects(publishWithDelay(oldWindow, { verificationAttempts: 6 }), /bounded registry propagation wait/);
  assert.equal(oldWindow.publishes.length, 1);
  assert.equal(oldWindow.elapsed(), 25_000, "six attempts still fail before a registry processing delay of 100 seconds");

  const processingDelay = delayedRegistry(manifest, new Map([[PUBLISH_ORDER[0], 100_000]]));
  await publishWithDelay(processingDelay);
  assert.equal(processingDelay.elapsed(), 100_000, "default verification must cover npm processing delays beyond the former window");
  assert.equal(processingDelay.publishes.length, 1, "poll visibility without resubmitting the accepted package");
  assert.ok(processingDelay.requests.length > PUBLISH_ORDER.length + 6);
  assert.ok(processingDelay.requests.every(({ options }) => options.signal instanceof AbortSignal && options.redirect === "error"));

  const sharedBudget = delayedRegistry(manifest, new Map([
    [PUBLISH_ORDER[0], 20_000], [PUBLISH_ORDER[1], 20_000], [PUBLISH_ORDER[2], 0]
  ]));
  await assert.rejects(publishWithDelay(sharedBudget, { verificationTimeoutMs: 25_000 }), /bounded registry propagation wait/);
  assert.equal(sharedBudget.elapsed(), 25_000, "one propagation budget is shared across every package");
  assert.equal(sharedBudget.publishes.length, 2, "stop after the timed-out package instead of publishing subsequent packages");

  const exhaustedAfterMatch = delayedRegistry(manifest, new Map([[PUBLISH_ORDER[0], 0], [PUBLISH_ORDER[1], 0]]));
  const matchingFetch = exhaustedAfterMatch.fetchImpl;
  await assert.rejects(publishWithDelay(exhaustedAfterMatch, {
    verificationTimeoutMs: 25_000,
    fetchImpl: async (...args) => {
      const response = await matchingFetch(...args);
      if (exhaustedAfterMatch.publishes.length === 1) await exhaustedAfterMatch.retryDelay(25_000);
      return response;
    }
  }), /budget is exhausted/);
  assert.equal(exhaustedAfterMatch.publishes.length, 1, "do not publish another package after a matching lookup consumes the last budget");

  const postPublishMismatch = delayedRegistry(manifest, new Map([[PUBLISH_ORDER[0], 15_000]]), "sha512-ZGlmZmVyZW50");
  await assert.rejects(publishWithDelay(postPublishMismatch), /different registry integrity after publication/);
  assert.equal(postPublishMismatch.elapsed(), 15_000, "a visible mismatch fails immediately instead of being retried");
  assert.equal(postPublishMismatch.publishes.length, 1);

  let timedOut = false;
  await assert.rejects(checkPublicationRegistry({
    directory: artifact, version, commit, registryRequestTimeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { timedOut = true; reject(signal.reason); }, { once: true });
    })
  }), /timed out after 10 ms/);
  assert.equal(timedOut, true, "a stalled registry request must receive cancellation");

  let bodyTimedOut = false;
  await assert.rejects(checkPublicationRegistry({
    directory: artifact, version, commit, registryRequestTimeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"dist":'));
        signal.addEventListener("abort", () => {
          bodyTimedOut = true;
          controller.error(signal.reason);
        }, { once: true });
      }
    }))
  }), /timed out after 10 ms/);
  assert.equal(bodyTimedOut, true, "the same request deadline must cover a body that stalls after headers arrive");

  const statusFailure = delayedRegistry(manifest, new Map([[PUBLISH_ORDER[0], 0]]));
  await assert.rejects(publishWithDelay(statusFailure, {
    fetchImpl: async () => new Response("unavailable", { status: 503 })
  }), /failed with HTTP 503/);
  assert.equal(statusFailure.publishes.length, 0, "processing retries must not hide other registry failures");

  let oversizedCancelled = false;
  await assert.rejects(checkPublicationRegistry({
    directory: artifact, version, commit,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { oversizedCancelled = true; }
    }))
  }), /exceeded 1 MiB/);
  assert.equal(oversizedCancelled, true, "unbounded chunked bodies must be cancelled without reading their remainder");

  for (const [option, invalid] of [["verificationAttempts", 62], ["verificationTimeoutMs", 300_001], ["registryRequestTimeoutMs", 10_001]]) {
    const bounded = delayedRegistry(manifest, new Map());
    await assert.rejects(publishWithDelay(bounded, { [option]: invalid }), /must be an integer between/);
    assert.equal(bounded.requests.length, 0);
    assert.equal(bounded.publishes.length, 0);
  }

  const mismatch = new Map(manifest.packages.map((item) => [item.name, item.integrity]));
  mismatch.delete(PUBLISH_ORDER[0]);
  mismatch.set(PUBLISH_ORDER.at(-1), `sha512-${Buffer.from("different").toString("base64")}`);
  const mismatchPublishCalls = [];
  await assert.rejects(
    publishPublicationArtifact({
      directory: artifact,
      version,
      commit,
      mode: "trusted-publishing",
      env: {},
      fetchImpl: registryFetch(mismatch),
      npmCommand: "/trusted/npm",
      spawnImpl: fakeNpm(mismatchPublishCalls)
    }),
    /different registry integrity/
  );
  assert.deepEqual(mismatchPublishCalls, [], "all registry versions must pass integrity preflight before any publish");
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

  console.log("Publication artifact tests passed exact packing, bounded registry processing delays and HTTP reads, all-package integrity preflight, safe retry, token-mode separation, and mismatch rejection.");
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

function registryFetch(registry, requests = []) {
  return async (url, options = {}) => {
    requests.push({ url, options });
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

function delayedRegistry(manifest, delays, publishedIntegrity) {
  let clock = 0;
  const acceptedAt = new Map();
  const requests = [];
  const publishes = [];
  return {
    requests,
    publishes,
    elapsed: () => clock,
    retryDelay: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[0]);
      const item = manifest.packages.find((entry) => entry.name === name);
      if (delays.has(name) && (!acceptedAt.has(name) || clock - acceptedAt.get(name) < delays.get(name))) {
        return new Response("being processed", { status: 404 });
      }
      return new Response(JSON.stringify({ dist: { integrity: delays.has(name) ? publishedIntegrity ?? item.integrity : item.integrity } }));
    },
    spawnImpl: fakeNpm(publishes, (args) => {
      const item = manifest.packages.find((entry) => `./${entry.file}` === args[1]);
      acceptedAt.set(item.name, clock);
    })
  };
}

function publishWithDelay(fixture, overrides = {}) {
  return publishPublicationArtifact({
    directory: artifact, version, commit, mode: "trusted-publishing", env: {},
    npmCommand: "/trusted/npm", fetchImpl: fixture.fetchImpl, spawnImpl: fixture.spawnImpl,
    retryDelay: fixture.retryDelay, now: fixture.elapsed, ...overrides
  });
}
