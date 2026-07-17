#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PUBLIC_REPOSITORY = "fenutech/preflight-scout";
export const REQUIRED_CHECK_NAME = "Required";
export const REQUIRED_CHECK_APP_ID = 15368;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

export const NPM_PACKAGES = Object.freeze([
  "@preflight-scout/core",
  "@preflight-scout/agent-exec",
  "@preflight-scout/browser-runner",
  "@preflight-scout/cli",
  "@preflight-scout/github-action",
  "@preflight-scout/mcp"
]);

const NPM_API_ROOT = "https://registry.npmjs.org";
const GITHUB_API_ROOT = "https://api.github.com";
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[0-9a-f]{40}$/;

export async function verifyReleaseOrder({
  targetVersion,
  commitSha,
  token,
  repository,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const targetParts = parseStableVersion(targetVersion, "Target version");
  if (!commitPattern.test(commitSha ?? "")) {
    throw new Error("Commit SHA must be exactly 40 lowercase hexadecimal characters.");
  }
  if (repository !== PUBLIC_REPOSITORY) {
    throw new Error(`Release publication is restricted to ${PUBLIC_REPOSITORY}; received ${repository || "an empty repository"}.`);
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GITHUB_TOKEN is required to verify release order.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required to verify release order.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("Release-order request timeout must be an integer between 1 and 60000 milliseconds.");
  }

  const npmHeaders = {
    accept: "application/json",
    "user-agent": "preflight-scout-release-order-gate"
  };
  const githubHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "preflight-scout-release-order-gate",
    "x-github-api-version": "2026-03-10"
  };

  const npm = [];
  for (const packageName of NPM_PACKAGES) {
    const endpoint = `${NPM_API_ROOT}/-/package/${packageName.replace("/", "%2F")}/dist-tags`;
    const response = await getJson(fetchImpl, endpoint, npmHeaders, `npm dist-tags for ${packageName}`, {
      allowMissing: true,
      timeoutMs
    });
    if (response.missing) {
      npm.push({ packageName, latest: null, missing: true });
      continue;
    }
    assertObject(response.data, `npm dist-tags for ${packageName}`);
    if (!Object.hasOwn(response.data, "latest")) {
      throw new Error(`npm dist-tags for ${packageName} did not contain a latest tag.`);
    }
    const latestParts = parseStableVersion(response.data.latest, `npm latest tag for ${packageName}`);
    if (compareVersions(latestParts, targetParts) > 0) {
      throw new Error(`npm latest for ${packageName} is ${response.data.latest}, which is newer than target ${targetVersion}.`);
    }
    npm.push({ packageName, latest: response.data.latest, missing: false });
  }

  const latestReleaseResponse = await getJson(
    fetchImpl,
    `${GITHUB_API_ROOT}/repos/${PUBLIC_REPOSITORY}/releases/latest`,
    githubHeaders,
    "latest GitHub release",
    { allowMissing: true, timeoutMs }
  );
  let latestRelease = null;
  if (!latestReleaseResponse.missing) {
    assertObject(latestReleaseResponse.data, "latest GitHub release");
    const latestTag = parseStableTag(latestReleaseResponse.data.tag_name, "Latest GitHub release tag");
    if (compareVersions(latestTag.parts, targetParts) > 0) {
      throw new Error(`Latest GitHub release ${latestTag.tag} is newer than target v${targetVersion}.`);
    }
    latestRelease = latestTag.tag;
  }

  const targetTag = `v${targetVersion}`;
  const expectedReleaseName = `Preflight Scout ${targetVersion} — public alpha`;
  const expectedReleaseUrl = `https://github.com/${PUBLIC_REPOSITORY}/releases/tag/${targetTag}`;
  const targetReleaseResponse = await getJson(
    fetchImpl,
    `${GITHUB_API_ROOT}/repos/${PUBLIC_REPOSITORY}/releases/tags/${targetTag}`,
    githubHeaders,
    `${targetTag} GitHub release`,
    { allowMissing: true, timeoutMs }
  );
  let targetRelease = null;
  if (!targetReleaseResponse.missing) {
    assertObject(targetReleaseResponse.data, `${targetTag} GitHub release`);
    const release = targetReleaseResponse.data;
    if (release.tag_name !== targetTag) {
      throw new Error(`${targetTag} GitHub release has tag ${describe(release.tag_name)}; expected ${targetTag}.`);
    }
    if (release.name !== expectedReleaseName) {
      throw new Error(`${targetTag} GitHub release has name ${describe(release.name)}; expected ${describe(expectedReleaseName)}.`);
    }
    if (release.draft !== false) {
      throw new Error(`${targetTag} GitHub release must have draft=false.`);
    }
    if (release.prerelease !== false) {
      throw new Error(`${targetTag} GitHub release must have prerelease=false.`);
    }
    if (release.immutable !== true) {
      throw new Error(`${targetTag} GitHub release must have immutable=true.`);
    }
    if (release.html_url !== expectedReleaseUrl) {
      throw new Error(`${targetTag} GitHub release has html_url ${describe(release.html_url)}; expected ${expectedReleaseUrl}.`);
    }
    targetRelease = {
      tag: release.tag_name,
      name: release.name,
      url: release.html_url
    };
  }
  if (targetRelease && latestRelease !== targetTag) {
    throw new Error(
      `${targetTag} already exists as an immutable release but GitHub latest is ${latestRelease ?? "missing"}; `
        + "refusing npm publication because the existing immutable release cannot be promoted safely by this workflow."
    );
  }

  const checkRunsResponse = await getJson(
    fetchImpl,
    `${GITHUB_API_ROOT}/repos/${PUBLIC_REPOSITORY}/commits/${commitSha}/check-runs?per_page=100`,
    githubHeaders,
    `check runs for ${commitSha}`,
    { allowMissing: false, timeoutMs }
  );
  assertObject(checkRunsResponse.data, `check runs for ${commitSha}`);
  if (!Array.isArray(checkRunsResponse.data.check_runs)) {
    throw new Error(`GitHub check runs for ${commitSha} did not contain a check_runs array.`);
  }
  const requiredCheck = checkRunsResponse.data.check_runs.find((check) =>
    check?.name === REQUIRED_CHECK_NAME
    && check?.status === "completed"
    && check?.conclusion === "success"
    && check?.app?.id === REQUIRED_CHECK_APP_ID
    && check?.head_sha === commitSha
  );
  if (!requiredCheck) {
    throw new Error(
      `Commit ${commitSha} must have a completed successful ${REQUIRED_CHECK_NAME} check `
        + `from GitHub Actions app ${REQUIRED_CHECK_APP_ID} with the exact head SHA.`
    );
  }

  return {
    repository,
    targetVersion,
    commitSha,
    npm,
    latestRelease,
    targetRelease,
    requiredCheck: {
      name: requiredCheck.name,
      status: requiredCheck.status,
      conclusion: requiredCheck.conclusion,
      appId: requiredCheck.app.id,
      headSha: requiredCheck.head_sha
    }
  };
}

async function getJson(fetchImpl, url, headers, label, { allowMissing, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new GateError(`Could not verify ${label}: request timed out.`);
      throw new GateError(`Could not verify ${label}: request failed.`);
    }
    if (!response || !Number.isInteger(response.status) || !response.headers || typeof response.headers.get !== "function") {
      throw new GateError(`Could not verify ${label}: fetch returned an invalid response.`);
    }
    if (response.redirected === true) {
      throw new GateError(`Could not verify ${label}: redirected responses are not allowed.`);
    }

    const text = await readBoundedBody(response, label);
    if (response.status === 404 && allowMissing) return { missing: true, data: null };
    if (response.status !== 200) {
      throw new GateError(`Could not verify ${label}: endpoint returned HTTP ${response.status}.`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new GateError(`Could not verify ${label}: endpoint returned invalid JSON.`);
    }
    return { missing: false, data };
  } catch (error) {
    if (error instanceof GateError) throw error;
    if (controller.signal.aborted) throw new GateError(`Could not verify ${label}: request timed out.`);
    throw new GateError(`Could not verify ${label}: response could not be read.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(response, label) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new GateError(`Could not verify ${label}: response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
  }
  if (response.body == null) return "";
  if (typeof response.body.getReader !== "function") {
    throw new GateError(`Could not verify ${label}: response body was not a readable web stream.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      throw new GateError(`Could not verify ${label}: response body returned an invalid chunk.`);
    }
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size violation is authoritative even if cancellation also fails.
      }
      throw new GateError(`Could not verify ${label}: response exceeded ${MAX_RESPONSE_BYTES} bytes.`);
    }
    try {
      text += decoder.decode(value, { stream: true });
    } catch {
      throw new GateError(`Could not verify ${label}: endpoint returned invalid UTF-8.`);
    }
  }
  try {
    text += decoder.decode();
  } catch {
    throw new GateError(`Could not verify ${label}: endpoint returned invalid UTF-8.`);
  }
  return text;
}

function parseStableTag(value, label) {
  if (typeof value !== "string" || !value.startsWith("v")) {
    throw new Error(`${label} must be an exact stable tag in the form vX.Y.Z.`);
  }
  return { tag: value, parts: parseStableVersion(value.slice(1), label) };
}

function parseStableVersion(value, label) {
  if (typeof value !== "string" || value.length > 128) {
    throw new Error(`${label} must be exact stable SemVer in the form X.Y.Z.`);
  }
  const match = value.match(stableVersionPattern);
  if (!match) throw new Error(`${label} must be exact stable SemVer in the form X.Y.Z.`);
  return match.slice(1);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index].length !== right[index].length) return left[index].length < right[index].length ? -1 : 1;
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must return a JSON object.`);
  }
}

function describe(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

class GateError extends Error {}

async function main() {
  const { targetVersion, commitSha } = parseCliArguments(process.argv.slice(2));
  const result = await verifyReleaseOrder({
    targetVersion,
    commitSha,
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY
  });
  const publishedPackages = result.npm.filter((entry) => !entry.missing).length;
  console.log(
    `Verified release order for v${result.targetVersion} at ${result.commitSha}: `
      + `${publishedPackages}/${result.npm.length} npm package latest tags are not newer, `
      + `${result.latestRelease ?? "no latest GitHub release"} is not newer, `
      + `${result.targetRelease ? "the existing target release is exact" : "the target release is not yet present"}, `
      + `and ${result.requiredCheck.name} passed on the exact commit.`
  );
}

export function parseCliArguments(arguments_) {
  if (
    arguments_.length !== 4
    || arguments_[0] !== "--version"
    || arguments_[2] !== "--commit"
    || !arguments_[1]
    || !arguments_[3]
  ) {
    throw new Error(
      "Usage: node scripts/verify-release-order.mjs --version <X.Y.Z> --commit <40-hex-commit-sha>"
    );
  }
  return { targetVersion: arguments_[1], commitSha: arguments_[3] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
