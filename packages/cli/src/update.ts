export const OFFICIAL_NPM_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/@preflight-scout%2Fcli/dist-tags";
export const UPDATE_CHECK_TIMEOUT_MS = 3000;
export const MAX_UPDATE_RESPONSE_BYTES = 16 * 1024;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export type RegistryUpdateStatus = "current" | "update-available" | "newer-than-registry" | "unavailable";
export type SkillCompatibility = "not-provided" | "compatible" | "incompatible";

export interface UpdateInstructions {
  targetVersion: string;
  cli?: string[];
  codex?: string[];
  claude?: string[];
  restart?: string;
}

export interface UpdateCheckResult {
  cliVersion: string;
  skillVersion?: string;
  skillCompatibility: SkillCompatibility;
  compatible: boolean;
  registry: {
    status: RegistryUpdateStatus;
    latestVersion?: string;
    message: string;
  };
  instructions?: UpdateInstructions;
  mutated: false;
}

export interface CheckForUpdatesOptions {
  cliVersion: string;
  skillVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkForUpdates(options: CheckForUpdatesOptions): Promise<UpdateCheckResult> {
  const cliVersion = requireSemver(options.cliVersion, "CLI version");
  const skillVersion = options.skillVersion;
  const skillIsValid = skillVersion === undefined || SEMVER_PATTERN.test(skillVersion);
  const reportedSkillVersion = skillVersion === undefined ? undefined : skillIsValid ? skillVersion : "invalid";
  const skillCompatibility: SkillCompatibility = skillVersion === undefined
    ? "not-provided"
    : skillIsValid && skillVersion === cliVersion
      ? "compatible"
      : "incompatible";
  const registry = await checkOfficialRegistry(
    cliVersion,
    options.fetchImpl ?? fetch,
    options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS
  );
  const instructions = recommendedUpdateInstructions({
    cliVersion,
    skillVersion: reportedSkillVersion,
    skillIsValid,
    registry
  });

  return {
    cliVersion,
    ...(reportedSkillVersion === undefined ? {} : { skillVersion: reportedSkillVersion }),
    skillCompatibility,
    compatible: skillCompatibility !== "incompatible",
    registry,
    ...(instructions ? { instructions } : {}),
    mutated: false
  };
}

export function renderUpdateCheck(result: UpdateCheckResult): string {
  const lines = [
    "Preflight Scout update check",
    "",
    `CLI: ${result.cliVersion}`
  ];
  if (result.skillVersion !== undefined) {
    lines.push(
      result.skillCompatibility === "compatible"
        ? `Agent Skill: ${result.skillVersion} (compatible)`
        : `Agent Skill: ${result.skillVersion} (incompatible; exact CLI match required during alpha)`
    );
  } else {
    lines.push("Agent Skill: not supplied (pass --skill-version to verify compatibility)");
  }
  lines.push(`Registry: ${result.registry.message}`, "", "No changes were made.");

  if (result.instructions) {
    appendRecommendedUpdateInstructions(lines, result.instructions);
  } else if (!result.compatible) {
    const skillIsAheadOfPublishedRelease = result.skillVersion !== undefined
      && SEMVER_PATTERN.test(result.skillVersion)
      && result.registry.latestVersion !== undefined
      && compareSemver(result.skillVersion, result.registry.latestVersion) > 0;
    lines.push(
      "",
      "The CLI and Agent Skill must be aligned before the full workflow runs.",
      skillIsAheadOfPublishedRelease
        ? "The Agent Skill is newer than the latest published CLI. No matching published release is available; use CLI and skill artifacts from one trusted source release, or wait for the matching npm release."
        : result.registry.status === "unavailable"
        ? "Retry the registry check before choosing a release version."
        : "Use matching artifacts from one published release or one trusted source checkout."
    );
  }

  return lines.join("\n");
}

export function buildUpdateInstructions(
  version: string,
  include: { cli?: boolean; plugins?: boolean } = { cli: true, plugins: true }
): UpdateInstructions {
  const targetVersion = requireSemver(version, "target version");
  return {
    targetVersion,
    ...(include.cli ? { cli: [
      `npm install --global @preflight-scout/cli@${targetVersion} --registry=https://registry.npmjs.org/`,
      "preflight-scout install-browser",
      "preflight-scout --version"
    ] } : {}),
    ...(include.plugins ? { codex: [
      "codex plugin marketplace upgrade preflight-scout",
      "codex plugin list --marketplace preflight-scout"
    ] } : {}),
    ...(include.plugins ? { claude: [
      "claude plugin marketplace update preflight-scout",
      "claude plugin update preflight-scout@preflight-scout",
      "claude plugin list"
    ] } : {}),
    ...(include.plugins ? {
      restart: "Restart the client and start a new task or session, then run preflight-scout update-check again from the installed Agent Skill."
    } : {})
  };
}

async function checkOfficialRegistry(
  cliVersion: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<UpdateCheckResult["registry"]> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Update-check timeout must be a positive safe integer.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    let response: Response;
    try {
      response = await fetchImpl(OFFICIAL_NPM_DIST_TAGS_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal
      });
    } catch {
      return unavailableRegistry(
        controller.signal.aborted
          ? `unavailable (official npm registry check timed out after ${timeoutMs}ms)`
          : "unavailable (could not reach the official npm registry)"
      );
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return unavailableRegistry(`unavailable (official npm registry returned HTTP ${response.status})`);
    }

    let body: string;
    try {
      body = await readBoundedResponseText(response, MAX_UPDATE_RESPONSE_BYTES);
    } catch (error) {
      if (controller.signal.aborted) {
        return unavailableRegistry(`unavailable (official npm registry check timed out after ${timeoutMs}ms)`);
      }
      return unavailableRegistry(error instanceof SafeUpdateError
        ? `unavailable (${error.message})`
        : "unavailable (official npm registry response could not be read safely)");
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(body) as unknown;
    } catch {
      return unavailableRegistry("unavailable (official npm registry returned invalid JSON)");
    }
    const latestVersion = isRecord(metadata) && typeof metadata.latest === "string" && SEMVER_PATTERN.test(metadata.latest)
      ? metadata.latest
      : undefined;
    if (!latestVersion) {
      return unavailableRegistry("unavailable (official npm registry returned invalid dist-tag metadata)");
    }

    const comparison = compareSemver(cliVersion, latestVersion);
    if (comparison < 0) {
      return {
        status: "update-available",
        latestVersion,
        message: `${latestVersion} (update available)`
      };
    }
    if (comparison > 0) {
      return {
        status: "newer-than-registry",
        latestVersion,
        message: `${latestVersion} (installed CLI is newer; no downgrade suggested)`
      };
    }
    return {
      status: "current",
      latestVersion,
      message: `${latestVersion} (current)`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeUpdateError(`official npm registry response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (total + chunk.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SafeUpdateError(`official npm registry response exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function appendRecommendedUpdateInstructions(lines: string[], instructions: UpdateInstructions): void {
  if (instructions.cli) {
    lines.push("", `Update the CLI to ${instructions.targetVersion}:`);
    appendCommands(lines, instructions.cli);
  }
  if (instructions.codex && instructions.claude) {
    lines.push("", "Refresh the Agent Skill marketplace, then rerun this check:", "", "Codex Agent Skill:");
    appendCommands(lines, instructions.codex);
    lines.push("", "Claude Code Agent Skill:");
    appendCommands(lines, instructions.claude);
  }
  if (instructions.restart) lines.push("", instructions.restart);
}

function appendCommands(lines: string[], commands: string[]): void {
  lines.push(...commands.map((command) => `  ${command}`));
}

function unavailableRegistry(message: string): UpdateCheckResult["registry"] {
  return { status: "unavailable", message };
}

function recommendedUpdateInstructions(options: {
  cliVersion: string;
  skillVersion?: string;
  skillIsValid: boolean;
  registry: UpdateCheckResult["registry"];
}): UpdateInstructions | undefined {
  const latestVersion = options.registry.latestVersion;
  if (!latestVersion) return undefined;
  if (compareSemver(options.cliVersion, latestVersion) > 0) return undefined;
  if (options.skillVersion !== undefined && !options.skillIsValid) return undefined;
  if (options.skillVersion !== undefined && compareSemver(options.skillVersion, latestVersion) > 0) return undefined;

  const updateCli = compareSemver(options.cliVersion, latestVersion) < 0;
  const updatePlugins = options.skillVersion !== undefined
    && compareSemver(options.skillVersion, latestVersion) < 0;
  return updateCli || updatePlugins
    ? buildUpdateInstructions(latestVersion, { cli: updateCli, plugins: updatePlugins })
    : undefined;
}

function requireSemver(version: string, label: string): string {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`${label} must be an exact semantic version.`);
  return version;
}

function compareSemver(left: string, right: string): number {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  for (const field of ["major", "minor", "patch"] as const) {
    if (leftVersion[field] < rightVersion[field]) return -1;
    if (leftVersion[field] > rightVersion[field]) return 1;
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function parseSemver(version: string): {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease?: string[];
} {
  const match = version.match(SEMVER_PATTERN);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    ...(match[4] ? { prerelease: match[4].split(".") } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class SafeUpdateError extends Error {}
