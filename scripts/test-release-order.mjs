import assert from "node:assert/strict";
import {
  MAX_RESPONSE_BYTES,
  NPM_PACKAGES,
  PUBLIC_REPOSITORY,
  REQUIRED_CHECK_APP_ID,
  parseCliArguments,
  verifyReleaseOrder
} from "./verify-release-order.mjs";

const targetVersion = "0.1.1";
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const targetTag = `v${targetVersion}`;
const npmUrls = NPM_PACKAGES.map((packageName) =>
  `https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/dist-tags`
);
const latestReleaseUrl = `https://api.github.com/repos/${PUBLIC_REPOSITORY}/releases/latest`;
const targetReleaseUrl = `https://api.github.com/repos/${PUBLIC_REPOSITORY}/releases/tags/${targetTag}`;
const checkRunsUrl = `https://api.github.com/repos/${PUBLIC_REPOSITORY}/commits/${commitSha}/check-runs?per_page=100`;

const calls = [];
const success = await verifyReleaseOrder(input({ fetchImpl: fixtureFetch(new Map([
  [npmUrls[0], missing()],
  [npmUrls[1], json({ latest: targetVersion })]
]), calls) }));
assert.equal(success.repository, PUBLIC_REPOSITORY);
assert.equal(success.targetVersion, targetVersion);
assert.equal(success.commitSha, commitSha);
assert.deepEqual(success.npm[0], { packageName: NPM_PACKAGES[0], latest: null, missing: true });
assert.deepEqual(success.npm[1], { packageName: NPM_PACKAGES[1], latest: targetVersion, missing: false });
assert.equal(success.latestRelease, "v0.1.0");
assert.equal(success.targetRelease, null);
assert.deepEqual(success.requiredCheck, {
  name: "Required",
  status: "completed",
  conclusion: "success",
  appId: REQUIRED_CHECK_APP_ID,
  headSha: commitSha
});
assert.deepEqual(calls.map(({ url }) => url), [...npmUrls, latestReleaseUrl, targetReleaseUrl, checkRunsUrl]);
for (const { url, options } of calls) {
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers["user-agent"], "preflight-scout-release-order-gate");
  if (url.startsWith("https://api.github.com/")) {
    assert.equal(options.headers.authorization, "Bearer test-token");
  } else {
    assert.equal(Object.hasOwn(options.headers, "authorization"), false);
  }
}

const exactExistingRelease = await verifyReleaseOrder(input({ fetchImpl: fixtureFetch(new Map([
  [latestReleaseUrl, json({ tag_name: targetTag })],
  [targetReleaseUrl, json(validTargetRelease())]
])) }));
assert.deepEqual(exactExistingRelease.targetRelease, {
  tag: targetTag,
  name: `Preflight Scout ${targetVersion} — public alpha`,
  url: `https://github.com/${PUBLIC_REPOSITORY}/releases/tag/${targetTag}`
});
await rejectsWith(
  new Map([[targetReleaseUrl, json(validTargetRelease())]]),
  /already exists as an immutable release but GitHub latest is v0\.1\.0/
);

for (const invalidVersion of [undefined, "", "v0.1.1", "01.1.1", "0.1", "0.1.1-beta.1", "0.1.1+build"]) {
  await assert.rejects(verifyReleaseOrder(input({ targetVersion: invalidVersion })), /exact stable SemVer/);
}
for (const invalidSha of [undefined, "", "abc", "A".repeat(40), `${commitSha}0`]) {
  await assert.rejects(verifyReleaseOrder(input({ commitSha: invalidSha })), /exactly 40 lowercase hexadecimal/);
}
await assert.rejects(verifyReleaseOrder(input({ token: "" })), /GITHUB_TOKEN is required/);
await assert.rejects(verifyReleaseOrder(input({ repository: "fork/preflight-scout" })), /restricted to fenutech\/preflight-scout/);
await assert.rejects(verifyReleaseOrder(input({ repository: undefined })), /an empty repository/);
await assert.rejects(verifyReleaseOrder(input({ timeoutMs: 0 })), /between 1 and 60000/);
assert.deepEqual(
  parseCliArguments(["--version", targetVersion, "--commit", commitSha]),
  { targetVersion, commitSha }
);
for (const invalidArguments of [
  [],
  [targetVersion, commitSha],
  ["--commit", commitSha, "--version", targetVersion],
  ["--version", targetVersion, "--commit", ""]
]) {
  assert.throws(() => parseCliArguments(invalidArguments), /Usage: node scripts\/verify-release-order\.mjs --version/);
}

await rejectsWith(
  new Map([[npmUrls[0], json({ latest: "0.1.2" })]]),
  /npm latest for @preflight-scout\/core is 0\.1\.2, which is newer than target 0\.1\.1/
);
await rejectsWith(new Map([[npmUrls[0], json({ latest: "0.1.1-beta.1" })]]), /npm latest tag.*exact stable SemVer/);
await rejectsWith(new Map([[npmUrls[0], json({ next: "0.1.1" })]]), /did not contain a latest tag/);
await rejectsWith(new Map([[npmUrls[0], json(["0.1.0"])]]), /npm dist-tags.*must return a JSON object/);
await rejectsWith(new Map([[npmUrls[0], raw("{not-json")]]), /endpoint returned invalid JSON/);
await rejectsWith(new Map([[npmUrls[0], raw("failure", 500)]]), /endpoint returned HTTP 500/);
await rejectsWith(new Map([[npmUrls[0], raw("x", 200, { redirected: true })]]), /redirected responses are not allowed/);
await rejectsWith(
  new Map([[npmUrls[0], raw("{}", 200, { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })]]),
  /response exceeded 524288 bytes/
);
await rejectsWith(
  new Map([[npmUrls[0], raw("x".repeat(MAX_RESPONSE_BYTES + 1))]]),
  /response exceeded 524288 bytes/
);
await rejectsWith(new Map([[npmUrls[0], () => { throw new Error("offline"); }]]), /request failed/);
await assert.rejects(
  verifyReleaseOrder(input({
    timeoutMs: 5,
    fetchImpl: fixtureFetch(new Map([[
      npmUrls[0],
      (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    ]]))
  })),
  /request timed out/
);

await verifyReleaseOrder(input({ fetchImpl: fixtureFetch(new Map([[latestReleaseUrl, missing()]])) }));
await rejectsWith(new Map([[latestReleaseUrl, json({ tag_name: "v0.1.2" })]]), /Latest GitHub release v0\.1\.2 is newer/);
await rejectsWith(new Map([[latestReleaseUrl, json({ tag_name: "0.1.0" })]]), /exact stable tag in the form vX\.Y\.Z/);
await rejectsWith(new Map([[latestReleaseUrl, json({ tag_name: "v0.1.0-beta.1" })]]), /exact stable SemVer/);
await rejectsWith(new Map([[latestReleaseUrl, raw("nope")]]), /invalid JSON/);

for (const [field, value, expected] of [
  ["tag_name", "v0.1.0", /has tag "v0\.1\.0"/],
  ["name", "Preflight Scout 0.1.1", /has name/],
  ["draft", true, /draft=false/],
  ["draft", undefined, /draft=false/],
  ["prerelease", true, /prerelease=false/],
  ["prerelease", undefined, /prerelease=false/],
  ["immutable", false, /immutable=true/],
  ["immutable", undefined, /immutable=true/],
  ["html_url", "https://example.test/release", /has html_url/]
]) {
  const release = validTargetRelease();
  if (value === undefined) delete release[field];
  else release[field] = value;
  await rejectsWith(new Map([[targetReleaseUrl, json(release)]]), expected);
}

await rejectsWith(new Map([[checkRunsUrl, json({ check_runs: {} })]]), /did not contain a check_runs array/);
for (const mutate of [
  (check) => { check.name = "Build"; },
  (check) => { check.status = "in_progress"; },
  (check) => { check.conclusion = "failure"; },
  (check) => { check.app.id = 1; },
  (check) => { check.head_sha = "f".repeat(40); }
]) {
  const check = validRequiredCheck();
  mutate(check);
  await rejectsWith(
    new Map([[checkRunsUrl, json({ check_runs: [check] })]]),
    /must have a completed successful Required check/
  );
}
await rejectsWith(new Map([[checkRunsUrl, missing()]]), /endpoint returned HTTP 404/);

console.log(
  "Release-order gate tests passed exact endpoint, stable ordering, existing-release, required-check provenance, timeout, redirect, size, JSON, and input validation cases."
);

function input(overrides = {}) {
  return {
    targetVersion,
    commitSha,
    token: "test-token",
    repository: PUBLIC_REPOSITORY,
    fetchImpl: fixtureFetch(),
    ...overrides
  };
}

async function rejectsWith(overrides, expected) {
  await assert.rejects(
    verifyReleaseOrder(input({ fetchImpl: fixtureFetch(overrides) })),
    expected
  );
}

function fixtureFetch(overrides = new Map(), observedCalls = []) {
  return async (url, options) => {
    observedCalls.push({ url, options });
    const override = overrides.get(url);
    if (override) return typeof override === "function" ? override(url, options) : makeResponse(override);
    if (npmUrls.includes(url)) return makeResponse(json({ latest: "0.1.0" }));
    if (url === latestReleaseUrl) return makeResponse(json({ tag_name: "v0.1.0" }));
    if (url === targetReleaseUrl) return makeResponse(missing());
    if (url === checkRunsUrl) return makeResponse(json({ check_runs: [
      { ...validRequiredCheck(), name: "Other check" },
      validRequiredCheck()
    ] }));
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function validTargetRelease() {
  return {
    tag_name: targetTag,
    name: `Preflight Scout ${targetVersion} — public alpha`,
    draft: false,
    prerelease: false,
    immutable: true,
    html_url: `https://github.com/${PUBLIC_REPOSITORY}/releases/tag/${targetTag}`
  };
}

function validRequiredCheck() {
  return {
    name: "Required",
    status: "completed",
    conclusion: "success",
    app: { id: REQUIRED_CHECK_APP_ID },
    head_sha: commitSha
  };
}

function json(body, status = 200, options = {}) {
  return raw(JSON.stringify(body), status, options);
}

function missing() {
  return raw("{}", 404);
}

function raw(body, status = 200, { headers = {}, redirected = false } = {}) {
  return { body, status, headers, redirected };
}

function makeResponse(fixture) {
  const source = new Response(fixture.body, { status: fixture.status, headers: fixture.headers });
  if (!fixture.redirected) return source;
  return {
    status: source.status,
    headers: source.headers,
    body: source.body,
    redirected: true
  };
}
