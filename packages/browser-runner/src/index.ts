import path from "node:path";
import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { BrowserDecisionSchema, browserCredentialEnvName, isActionApproved, loadApprovals, redactContract, redactText, resolvePackageRuntimeIdentity, writeTextEnsuringDir, type ApprovalState, type LLMClient, type MissionRunResult, type QAContract, type QAFlowMission, type RoleCredential, type StepResult } from "@preflight-scout/core";
import { bindReviewedAssertionDecision, executeDecision } from "./actions.js";
import { BrowserNavigationBoundary } from "./navigation.js";
import { observe, screenshot } from "./observe.js";
import { canonicalizeStorageStatePath, loadStorageStateInput, validateStorageStateInput, writeStorageStateMetadata } from "./storage-state.js";
import type { BrowserDecision, BrowserObservation, BrowserRunOptions } from "./types.js";

export type { BrowserRunOptions } from "./types.js";
export { printHtmlReportToPdf } from "./pdf.js";
export { canonicalizeStorageStatePath, validateStorageStateInput, writeStorageStateMetadata } from "./storage-state.js";
export { verifyStoredAuthentication, type StoredAuthenticationVerificationOptions } from "./auth-verification.js";

const MAX_RUNTIME_ERROR_ENTRIES = 100;
const MAX_RUNTIME_ERROR_SOURCE_CHARS = 2_000;
const MAX_TRACE_BYTES = 100 * 1024 * 1024;
const MAX_JSON_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_STORAGE_STATE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_BROWSER_TURNS = 100;
const MAX_STEP_RESULT_MESSAGE_CHARS = 2_000;

export const PREFLIGHT_SCOUT_BROWSER_RUNNER_RUNTIME_DIGEST = resolvePackageRuntimeIdentity(
  import.meta.url,
  "@preflight-scout/browser-runner"
);

export async function checkBrowserAvailability(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
}

export async function installChromium(options: { withDeps?: boolean } = {}): Promise<void> {
  const require = createRequire(import.meta.url);
  const playwrightRoot = path.dirname(require.resolve("playwright/package.json"));
  const args = [path.join(playwrightRoot, "cli.js"), "install"];
  if (options.withDeps) args.push("--with-deps");
  args.push("chromium");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Playwright Chromium installation failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`));
    });
  });
}

export async function runBrowserMission(mission: QAFlowMission, options: BrowserRunOptions): Promise<MissionRunResult> {
  const maxTurns = options.maxTurns ?? 15;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > MAX_BROWSER_TURNS) {
    return blockedResult(mission.id, "browser-config", `maxTurns must be an integer between 1 and ${MAX_BROWSER_TURNS}.`);
  }
  const missionConfigurationProblem = validateBrowserMissionConfiguration(mission, options.contract, options.saveStorageState);
  if (missionConfigurationProblem) {
    return blockedResult(mission.id, "mission-config", missionConfigurationProblem);
  }
  const outputDir = options.outputDir ?? ".preflight-scout/runs/latest";
  await prepareBrowserOutputDirectory(outputDir, options.root);
  const canonicalOutputDir = await realpath(path.resolve(outputDir));
  let loadedStorageState: Awaited<ReturnType<typeof loadStorageStateInput>> | undefined;
  if (options.storageState) {
    options.progress?.(`Validating storage state ${options.storageState}`);
    loadedStorageState = await loadStorageStateInput(options.storageState);
    if (loadedStorageState.problem) return blockedResult(mission.id, "storage-state", loadedStorageState.problem);
  }
  let saveStorageStatePath: string | undefined;
  if (options.saveStorageState) {
    try {
      saveStorageStatePath = await canonicalizeStorageStatePath(options.saveStorageState);
    } catch (error) {
      return blockedResult(mission.id, "storage-state", `Storage-state output path could not be canonicalized safely. ${(error as Error).message}`);
    }
    if (isPathWithin(canonicalOutputDir, saveStorageStatePath)) {
      return blockedResult(mission.id, "storage-state", "Authenticated storage state must be saved outside the browser evidence output directory.");
    }
  }
  let navigation: BrowserNavigationBoundary;
  try {
    navigation = new BrowserNavigationBoundary(options.baseUrl);
  } catch (error) {
    return navigationBlockedResult(mission.id, (error as Error).message);
  }
  const startUrl = navigation.resolve(mission.startPath ?? "/", "mission startPath");
  if (!startUrl) return navigationBlockedResult(mission.id, navigation.violation!.message);
  const approvals = options.approvals ?? (options.root ? await loadApprovals(options.root) : { approvals: [] });
  const approvalProblem = checkMissionApprovalGates(mission, options.contract, approvals);
  if (approvalProblem) {
    return blockedResult(mission.id, approvalProblem.stepId, approvalProblem.message);
  }
  options.progress?.(`Launching browser for mission ${mission.id}`);
  const browser = await chromium.launch({ headless: options.headless ?? true });
  options.progress?.(`Creating browser context for mission ${mission.id}`);
  const traceEnabled = options.trace ?? true;
  let context!: BrowserContext;
  let page!: Page;
  try {
    context = await browser.newContext({
      ...(loadedStorageState?.state ? { storageState: loadedStorageState.state as BrowserContextOptions["storageState"] } : {}),
      serviceWorkers: "block"
    });
    await navigation.install(context);
    if (traceEnabled) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
    await navigation.attach(page);
  } catch (error) {
    await closeBrowserResources(context, browser);
    throw error;
  }
  const results: StepResult[] = [];
  const artifacts: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const coveredStepIds = new Set<string>();
  const freshCompletionAssertionStepIds = new Set<string>();
  const completionAssertionStepIds = new Set(completionAssertionsAfterFinalStateChange(mission).map((step) => step.id));
  let loginSubmissionObserved = false;
  let initialSessionFingerprint: string | undefined;
  let finalResult: MissionRunResult | undefined;
  page.on("console", (message) => {
    if (message.type() === "error") {
      pushBounded(consoleErrors, redactText(message.text().slice(0, MAX_RUNTIME_ERROR_SOURCE_CHARS)).slice(0, 1000));
    }
  });
  page.on("requestfailed", (request) => {
    const requestSummary = `${request.method().slice(0, 32)} ${request.url().slice(0, MAX_RUNTIME_ERROR_SOURCE_CHARS)} ${(request.failure()?.errorText ?? "").slice(0, 512)}`;
    pushBounded(networkErrors, redactText(requestSummary).slice(0, 1000));
  });

  try {
    options.progress?.(`Opening ${mission.startPath ?? "/"} for mission ${mission.id}`);
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    } catch (error) {
      if (!navigation.violation) throw error;
      results.push({ stepId: "navigation-boundary", status: "blocked", message: navigation.violation.message });
      finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
      return finalResult;
    }
    if (navigation.checkPage(page, "mission startPath")) {
      results.push({ stepId: "navigation-boundary", status: "blocked", message: navigation.violation!.message });
      finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
      return finalResult;
    }
    if (mission.steps.some((step) => step.action === "login")) {
      initialSessionFingerprint = await sessionFingerprint(context);
    }

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (navigation.checkPage(page, `browser turn ${turn}`)) {
        results.push({ stepId: `turn-${turn}`, status: "blocked", message: navigation.violation!.message });
        finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
        return finalResult;
      }
      options.progress?.(`Mission ${mission.id}: observing browser turn ${turn}/${maxTurns}`);
      const observation = await observe(page, consoleErrors, networkErrors);
      if (navigation.checkPage(page, `browser observation ${turn}`)) {
        results.push({ stepId: `turn-${turn}`, status: "blocked", message: navigation.violation!.message });
        finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
        return finalResult;
      }
      const observationScreenshot = await captureSafeScreenshot(page, outputDir, `turn-${turn}-observation`, navigation);
      if (!observationScreenshot) {
        results.push({ stepId: `turn-${turn}`, status: "blocked", message: navigation.violation!.message });
        finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
        return finalResult;
      }
      artifacts.push(observationScreenshot);
      options.progress?.(`Mission ${mission.id}: waiting for LLM browser decision ${turn}/${maxTurns}`);
      const decision = bindReviewedAssertionDecision(
        await decideNextAction(options.llm, mission, options.contract, approvals, observation, observationScreenshot, results),
        mission
      );
      const stepId = `turn-${turn}`;
      options.progress?.(`Mission ${mission.id}: ${decision.action}${decision.target ? ` ${decision.target}` : ""}`);

      if (navigation.checkPage(page, `browser decision ${turn}`)) {
        results.push({ stepId, status: "blocked", message: navigation.violation!.message });
        finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
        return finalResult;
      }

      if (decision.action === "finish_pass") {
        const completionProblem = await validateMissionCompletion({
          mission,
          context,
          page,
          coveredStepIds,
          freshCompletionAssertionStepIds,
          loginSubmissionObserved,
          initialSessionFingerprint
        });
        if (completionProblem) {
          const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
          if (screenshotPath) artifacts.push(screenshotPath);
          results.push({ stepId, status: "blocked", message: completionProblem, ...(screenshotPath ? { screenshotPath } : {}) });
          finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
          return finalResult;
        }
        const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
        if (!screenshotPath) {
          results.push({ stepId, status: "blocked", message: navigation.violation!.message });
          finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
          return finalResult;
        }
        artifacts.push(screenshotPath);
        results.push({ stepId, status: "passed", message: decision.reason, screenshotPath });
        finalResult = { missionId: mission.id, status: "passed", results, artifacts };
        return finalResult;
      }
      if (decision.action === "finish_fail") {
        const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
        if (!screenshotPath) {
          results.push({ stepId, status: "blocked", message: navigation.violation!.message });
          finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
          return finalResult;
        }
        artifacts.push(screenshotPath);
        results.push({ stepId, status: "failed", message: decision.reason, screenshotPath });
        finalResult = { missionId: mission.id, status: "failed", results, artifacts };
        return finalResult;
      }
      if (decision.action === "blocked") {
        const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
        if (!screenshotPath) {
          results.push({ stepId, status: "blocked", message: navigation.violation!.message });
          finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
          return finalResult;
        }
        artifacts.push(screenshotPath);
        results.push({ stepId, status: "blocked", message: decision.reason, screenshotPath });
        finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
        return finalResult;
      }

      const result = await executeDecision(page, decision, options, approvals, stepId, {
        mission,
        missionRole: mission.role,
        navigation
      });
      results.push(result);
      if (result.status === "passed") {
        const reviewedStep = decision.missionStepId
          ? mission.steps.find((candidate) => candidate.id === decision.missionStepId)
          : undefined;
        if (invalidatesCompletionEvidence(decision.action)) freshCompletionAssertionStepIds.clear();
        if (decision.missionStepId) coveredStepIds.add(decision.missionStepId);
        if (reviewedStep && decision.action === "assert" && completionAssertionStepIds.has(reviewedStep.id)) {
          freshCompletionAssertionStepIds.add(reviewedStep.id);
        }
        if (reviewedStep?.action === "login" && (decision.action === "click" || decision.action === "press")) {
          loginSubmissionObserved = true;
        }
        const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
        if (!screenshotPath) {
          result.status = "blocked";
          result.message = navigation.violation!.message;
          finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
          return finalResult;
        }
        result.screenshotPath = screenshotPath;
        artifacts.push(screenshotPath);
      }
      if (result.status === "blocked") {
        if (!navigation.violation) {
          const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
          if (screenshotPath) {
            result.screenshotPath = screenshotPath;
            artifacts.push(screenshotPath);
          } else {
            result.message = navigation.violation!.message;
          }
        }
        finalResult = { missionId: mission.id, status: result.status, results, artifacts };
        return finalResult;
      }
      if (result.status === "failed") {
        const screenshotPath = await captureSafeScreenshot(page, outputDir, stepId, navigation);
        if (!screenshotPath) {
          result.status = "blocked";
          result.message = navigation.violation!.message;
          finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
          return finalResult;
        }
        result.screenshotPath = screenshotPath;
        artifacts.push(screenshotPath);
        continue;
      }
    }

    const screenshotPath = await captureSafeScreenshot(page, outputDir, "max-turns", navigation);
    if (!screenshotPath) {
      results.push({ stepId: "max-turns", status: "blocked", message: navigation.violation!.message });
      finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
      return finalResult;
    }
    artifacts.push(screenshotPath);
    results.push({ stepId: "max-turns", status: "blocked", message: `Mission did not finish within ${maxTurns} LLM browser turns.`, screenshotPath });
    finalResult = { missionId: mission.id, status: "blocked", results, artifacts };
    return finalResult;
  } finally {
    try {
      options.progress?.(`Writing browser evidence for mission ${mission.id}`);
    let finalObservation: BrowserObservation | undefined;
    let finalizationProblem: string | undefined;
    if (finalResult && !navigation.violation) {
      try {
        finalObservation = await observe(page, consoleErrors, networkErrors);
        if (navigation.checkPage(page, "final observation")) finalObservation = undefined;
      } catch {
        finalObservation = undefined;
        if (!navigation.violation) {
          finalizationProblem = "Browser finalization failed closed because the final same-origin state could not be observed safely.";
        }
      }
    }
    if (finalResult?.status === "passed" && !navigation.violation && !page.isClosed()) {
      try {
        const assertionProblem = await revalidateCompletionAssertionsAtFinalization({
          mission,
          page,
          options,
          approvals,
          navigation
        });
        finalizationProblem ??= assertionProblem;
      } catch {
        finalizationProblem ??= "Browser finalization failed closed because reviewed completion assertions could not be re-evaluated safely.";
      }
    }
    if (!page.isClosed()) {
      try {
        // Freeze the only guarded page before evidence or authenticated state is
        // persisted. This removes the race where a timer-driven navigation can
        // happen after the final action but before context.storageState().
        await page.close({ runBeforeUnload: false });
      } catch {
        finalizationProblem ??= "Browser finalization failed closed because the guarded page could not be frozen before state persistence.";
      }
    }
    const finalizationBlock = navigation.violation?.message ?? finalizationProblem;
    if (finalResult && finalizationBlock) {
      finalObservation = undefined;
      finalResult.status = "blocked";
      if (!results.some((result) => result.stepId === "browser-finalization" && result.message === finalizationBlock)) {
        results.push({ stepId: "browser-finalization", status: "blocked", message: finalizationBlock });
      }
    }
    const evidence = await writeEvidenceArtifacts({
      outputDir,
      context,
      traceEnabled,
      consoleErrors,
      networkErrors,
      discardUnsafeEvidence: Boolean(finalizationBlock),
      finalObservation
    });
    if (finalResult) {
      finalResult.evidence = evidence;
      for (const artifact of Object.values(evidence)) {
        if (artifact && !finalResult.artifacts.includes(artifact)) finalResult.artifacts.push(artifact);
      }
    }
    sanitizeStepResultsInPlace(results);
    if (saveStorageStatePath) {
      if (finalResult?.status === "passed" && !finalizationBlock) {
        options.progress?.(`Saving authenticated storage state ${saveStorageStatePath}`);
        const storageState = await context.storageState();
        const serializedState = `${JSON.stringify(storageState, null, 2)}\n`;
        if (Buffer.byteLength(serializedState) > MAX_STORAGE_STATE_OUTPUT_BYTES) {
          const reason = `Authenticated storage state exceeded the ${MAX_STORAGE_STATE_OUTPUT_BYTES}-byte safety limit.`;
          finalResult.status = "blocked";
          results.push({ stepId: "storage-state", status: "blocked", message: reason });
          await rm(saveStorageStatePath, { force: true });
          await writeStorageStateMetadata(saveStorageStatePath, {
            status: "invalid",
            missionId: mission.id,
            savedAt: new Date().toISOString(),
            reason,
            evidenceDir: outputDir,
            evidence
          });
        } else {
          await writeTextEnsuringDir(saveStorageStatePath, serializedState, { mode: 0o600 });
          await writeStorageStateMetadata(saveStorageStatePath, {
            status: "valid",
            missionId: mission.id,
            savedAt: new Date().toISOString(),
            evidenceDir: outputDir,
            evidence
          });
        }
      } else {
        options.progress?.(`Marking storage state invalid because mission ${mission.id} did not pass`);
        await rm(saveStorageStatePath, { force: true });
        await writeStorageStateMetadata(saveStorageStatePath, {
          status: "invalid",
          missionId: mission.id,
          savedAt: new Date().toISOString(),
          reason: finalResult?.results.at(-1)?.message ?? "Mission did not finish with a passed authenticated state.",
          evidenceDir: outputDir,
          evidence
        });
      }
    }
      sanitizeStepResultsInPlace(results);
    } finally {
      sanitizeStepResultsInPlace(results);
      await closeBrowserResources(context, browser);
    }
  }
}

async function captureSafeScreenshot(
  page: Parameters<typeof screenshot>[0],
  outputDir: string,
  name: string,
  navigation: BrowserNavigationBoundary
): Promise<string | undefined> {
  if (navigation.checkPage(page, `screenshot ${name}`)) return undefined;
  let screenshotPath: string;
  try {
    screenshotPath = await screenshot(page, outputDir, name, {
      beforeRetry: () => !navigation.checkPage(page, `screenshot retry ${name}`)
    });
  } catch (error) {
    if (navigation.violation) return undefined;
    throw error;
  }
  if (!navigation.checkPage(page, `screenshot ${name}`)) return screenshotPath;
  await rm(screenshotPath, { force: true });
  return undefined;
}

async function writeEvidenceArtifacts(input: {
  outputDir: string;
  context: BrowserContext;
  traceEnabled: boolean;
  consoleErrors: string[];
  networkErrors: string[];
  discardUnsafeEvidence: boolean;
  finalObservation?: BrowserObservation;
}): Promise<NonNullable<MissionRunResult["evidence"]>> {
  const evidence: NonNullable<MissionRunResult["evidence"]> = {};
  if (input.discardUnsafeEvidence) {
    if (input.traceEnabled) await input.context.tracing.stop();
    await Promise.all([
      "trace.zip",
      "console-errors.json",
      "network-errors.json",
      "final-observation.json"
    ].map((name) => rm(path.join(input.outputDir, name), { force: true })));
    return evidence;
  }
  if (input.traceEnabled) {
    const tracePath = path.join(input.outputDir, "trace.zip");
    await rm(tracePath, { force: true });
    await input.context.tracing.stop({ path: tracePath });
    const stats = await lstat(tracePath);
    if (stats.isFile() && !stats.isSymbolicLink() && stats.size <= MAX_TRACE_BYTES) {
      evidence.tracePath = tracePath;
    } else {
      await rm(tracePath, { force: true });
    }
  }
  evidence.consolePath = await writeJson(input.outputDir, "console-errors.json", input.consoleErrors);
  evidence.networkPath = await writeJson(input.outputDir, "network-errors.json", input.networkErrors);
  if (input.finalObservation) evidence.finalObservationPath = await writeJson(input.outputDir, "final-observation.json", input.finalObservation);
  return evidence;
}

async function writeJson(outputDir: string, name: string, value: unknown): Promise<string> {
  const filePath = path.join(outputDir, name);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_JSON_EVIDENCE_BYTES) {
    throw new Error(`Browser JSON evidence exceeded the ${MAX_JSON_EVIDENCE_BYTES}-byte limit: ${name}`);
  }
  await rm(filePath, { force: true });
  await writeTextEnsuringDir(filePath, serialized);
  return filePath;
}

async function prepareBrowserOutputDirectory(outputDir: string, root: string | undefined): Promise<void> {
  const boundary = path.resolve(root ?? process.cwd());
  const resolvedOutput = path.resolve(outputDir);
  if (isPathWithin(boundary, resolvedOutput)) {
    await assertNoSymlinkComponents(boundary, resolvedOutput);
    await mkdir(resolvedOutput, { recursive: true });
    await assertNoSymlinkComponents(boundary, resolvedOutput);
    return;
  }
  // Paths outside the target repository are accepted only through an explicit
  // caller choice; per-file writes still unlink stale symlinks/hardlinks first.
  await mkdir(resolvedOutput, { recursive: true });
}

async function assertNoSymlinkComponents(boundary: string, target: string): Promise<void> {
  const relative = path.relative(boundary, target);
  if (relative === "") return;
  let cursor = boundary;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing browser artifact output through symbolic link ${cursor}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Refusing browser artifact output because ${cursor} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function decideNextAction(
  llm: LLMClient,
  mission: QAFlowMission,
  contract: QAContract,
  approvals: ApprovalState,
  observation: BrowserObservation,
  observationScreenshot: string,
  results: StepResult[]
): Promise<BrowserDecision> {
  return llm.completeJson<BrowserDecision>([
    {
      role: "system",
      content: `You are Preflight Scout's live browser agent.

You are controlling a real browser on the fly. Figure out the next action from the current observation, the QA mission, and the safety contract.
Credentials, when configured, are available only through environment variable names in the safety contract. For fill actions, use "value": "env:ENV_VAR_NAME" so the runner injects the value without exposing it to the LLM transcript. Never print or guess credential values.
Credential use through configured auth-role env vars is allowed for QA login missions. If credentialAvailability says an env var is present, do not block by claiming credentials are unavailable or approval-gated. If login fails after filling present credentials, report that the credentials were attempted and rejected by the app or that the signed-in state could not be verified.

Return only valid JSON:
{
  "thought": "brief decision rationale grounded in observable evidence; do not expose hidden chain-of-thought",
  "action": "goto|click|fill|press|assert|screenshot|wait|scroll|set_viewport|finish_pass|finish_fail|blocked",
  "missionStepId": "exact reviewed mission step id; required for goto, click, fill, and press",
  "target": "explicit target optional",
  "value": "value optional",
  "reason": "why this action is right",
  "evidence_needed_next": "what you need to observe next optional"
}

Target formats:
- css=<selector>
- text=<visible text>
- label=<accessible label>
- testid=<data-testid>
- role=<role>|name=<accessible name>

Generic browser controls:
- wait: value is milliseconds, default 1000
- scroll: value is top|bottom|up|down or a pixel amount like 600
- set_viewport: value is WIDTHxHEIGHT, for example 390x844

Do not guess destructive actions.
If credentials, data, permissions, or safe action approval are missing, return blocked.
Approval gates must name an exact contract action label. The approvedActions input lists labels already approved by a human, and mission approval gates are validated before the browser starts. Continue through a matching approved gate. A missing locator is not an approval gate: discover safe controls from the live observation instead.
If a previous browser action failed, recover like a human tester: use the screenshot, observation, and error to choose another action or explicitly finish_fail/blocked.
If a previous fill action passed and the same field is still visibly filled, move to the next required credential or assertion instead of filling the same field again.
For login missions, authenticate the configured existing user only from the reviewed mission startPath. Do not discover or substitute another login URL. After entering a credential field successfully, use the observed page state to move toward the next required credential, safe submit action, and exact reviewed signed-in assertion instead of repeating the same completed action.
Every goto, click, fill, or press must name the exact reviewed missionStepId it implements. For non-login steps, its target must match the reviewed target; do not substitute an unrelated live control. Login steps may discover live login controls, but remain bound to the exact reviewed login step id and contract login permission.
Assert actions must name an exact reviewed assert_visible/assert_text missionStepId. Omit target and value for assert actions: the runner binds and executes the reviewed target and expected text, not an LLM substitute. finish_pass is refused until every executable reviewed step is covered and every declared completion assertion after the mission's final reviewed state-changing step has passed since the latest goto, click, fill, press, wait, scroll, or viewport change. If a completion assertion ran early, rerun it after the last browser-state change. Intermediate assertions remain useful evidence but cannot finish the mission. Login missions additionally require the exact configured signed-in marker, a safe credential-form submission, a changed cookie/storage session, and disappearance of the credential form.
currentObservation.interactive is a bounded DOM locator inventory from the rendered document, not an accessibility-tree dump. Presence means an element was rendered for locator use at capture time, but does not prove accessibility-tree exposure; omission cannot prove absence from the accessibility tree. If the mission requires accessibility-tree evidence that an exact reviewed assertion cannot establish, return blocked and leave that check for manual assistive-technology review.
Before returning finish_fail because an expected action is missing, carefully inspect currentObservation.text, currentObservation.interactive, and the screenshot. Do not claim an element is absent when it appears in the observation, and do not infer accessibility-tree absence from omission alone.
If a relevant action may be below the fold, scroll or use another visible navigation action before failing. Fail only when the live app clearly contradicts the mission goal or a required assertion remains false after a reasonable browser attempt.
Do not use hardcoded scripts. Navigate like a human tester using the live page observation and attached screenshot.`
    },
    {
      role: "user",
      content: `${redactText(JSON.stringify(
        {
          mission,
          safetyContract: redactContract(browserSafetyContract(contract, mission.role)),
          approvedActions: contract.dangerousActions.requireApproval.filter((action) => isActionApproved(approvals, action)),
          currentObservation: observation,
          attachedScreenshot: observationScreenshot,
          previousResults: sanitizedStepResults(results),
          credentialAvailability: credentialAvailability(contract, mission.role)
        },
        null,
        2
      ))}

The current browser screenshot is attached. Use it for visual/layout decisions, visible labels, and recovery from locator failures.`,
      attachments: [{ type: "image", path: observationScreenshot }]
    }
  ], {
    schema: BrowserDecisionSchema,
    schemaName: "browser_decision"
  });
}

function pushBounded(values: string[], value: string): void {
  if (values.length >= MAX_RUNTIME_ERROR_ENTRIES) values.shift();
  values.push(value);
}

function sanitizedStepResults(results: readonly StepResult[]): StepResult[] {
  return results.slice(-MAX_BROWSER_TURNS).map((result) => ({
    ...result,
    message: sanitizeStepResultMessage(result.message)
  }));
}

function sanitizeStepResultsInPlace(results: StepResult[]): void {
  for (const result of results) result.message = sanitizeStepResultMessage(result.message);
}

function sanitizeStepResultMessage(message: string): string {
  return redactText(String(message)).slice(0, MAX_STEP_RESULT_MESSAGE_CHARS);
}

function completionAssertionsAfterFinalStateChange(mission: QAFlowMission): QAFlowMission["steps"] {
  let finalStateChangeIndex = -1;
  mission.steps.forEach((step, index) => {
    if (isReviewedStateChange(step.action)) finalStateChangeIndex = index;
  });
  return mission.steps.filter((step, index) =>
    index > finalStateChangeIndex
    && Boolean(step.target?.trim())
    && (step.action === "assert_visible" || (step.action === "assert_text" && Boolean(step.expected?.trim())))
  );
}

async function revalidateCompletionAssertionsAtFinalization(input: {
  mission: QAFlowMission;
  page: Page;
  options: BrowserRunOptions;
  approvals: ApprovalState;
  navigation: BrowserNavigationBoundary;
}): Promise<string | undefined> {
  const failures: string[] = [];
  for (const step of completionAssertionsAfterFinalStateChange(input.mission)) {
    const navigationProblem = input.navigation.checkPage(input.page, `final assertion ${step.id}`);
    if (navigationProblem) return navigationProblem.message;

    // Final verification is derived only from the reviewed mission. The live
    // model cannot substitute a locator or weaken expected text at this
    // boundary. Reuse the same executor as the interactive assertion path so
    // attachment, uniqueness, visibility, and text semantics stay identical.
    const decision = bindReviewedAssertionDecision({
      thought: "Re-check the reviewed completion assertion on the final page.",
      action: "assert",
      missionStepId: step.id,
      reason: `Final reviewed assertion ${step.id}`
    }, input.mission);
    const result = await executeDecision(input.page, decision, input.options, input.approvals, `final-assertion-${step.id}`, {
      mission: input.mission,
      missionRole: input.mission.role,
      navigation: input.navigation
    });

    const postAssertionNavigationProblem = input.navigation.checkPage(input.page, `final assertion ${step.id}`);
    if (postAssertionNavigationProblem) return postAssertionNavigationProblem.message;
    if (result.status !== "passed") {
      failures.push(`${step.id}: ${sanitizeStepResultMessage(result.message)}`);
    }
  }
  if (!failures.length) return undefined;
  return sanitizeStepResultMessage(
    `Browser finalization blocked because reviewed completion assertions did not pass on the final page: ${failures.join("; ")}`
  );
}

function isReviewedStateChange(action: QAFlowMission["steps"][number]["action"]): boolean {
  return action === "goto" || action === "login" || action === "click" || action === "fill" || action === "press";
}

function invalidatesCompletionEvidence(action: BrowserDecision["action"]): boolean {
  return action === "goto"
    || action === "click"
    || action === "fill"
    || action === "press"
    || action === "wait"
    || action === "scroll"
    || action === "set_viewport";
}

function validateBrowserMissionConfiguration(
  mission: QAFlowMission,
  contract: QAContract,
  saveStorageState: string | undefined
): string | undefined {
  const invalidTextAssertion = mission.steps.find((step) => step.action === "assert_text" && !step.expected?.trim());
  if (invalidTextAssertion) {
    return `Reviewed assert_text step "${invalidTextAssertion.id}" must include nonblank expected text.`;
  }
  const completionAssertions = completionAssertionsAfterFinalStateChange(mission);
  if (!completionAssertions.length) {
    return "Browser missions must include at least one valid reviewed assert_visible/assert_text completion step after the final reviewed goto/login/click/fill/press step; observe and earlier assertions cannot support the final pass claim.";
  }
  const loginSteps = mission.steps.filter((step) => step.action === "login");
  if (!loginSteps.length) return undefined;
  if (!mission.role) return "Login missions must declare the exact configured auth role.";
  const role = ownRoleCredentials(contract, mission.role);
  const signedInTarget = role?.signedInTarget?.trim();
  if (!signedInTarget) {
    return `Login mission role ${mission.role} must configure signedInTarget with an exact deterministic signed-in locator.`;
  }
  const reviewedMarker = mission.steps.find((step) =>
    (step.action === "assert_visible" || step.action === "assert_text")
    && step.target?.trim() === signedInTarget
  );
  if (!reviewedMarker) {
    return `Login missions must include a reviewed assert_visible/assert_text step for the configured signedInTarget ${JSON.stringify(signedInTarget)}.`;
  }
  if (saveStorageState && loginSteps.length !== 1) {
    return "Authenticated state may be saved only from a mission with one reviewed login step and its deterministic signed-in assertion.";
  }
  return undefined;
}

async function closeBrowserResources(context: BrowserContext | undefined, browser: Browser | undefined): Promise<void> {
  await Promise.allSettled([
    context?.close(),
    browser?.close()
  ]);
}

async function validateMissionCompletion(input: {
  mission: QAFlowMission;
  context: BrowserContext;
  page: Page;
  coveredStepIds: ReadonlySet<string>;
  freshCompletionAssertionStepIds: ReadonlySet<string>;
  loginSubmissionObserved: boolean;
  initialSessionFingerprint?: string;
}): Promise<string | undefined> {
  const loginSteps = input.mission.steps.filter((step) => step.action === "login");
  const executableSteps = input.mission.steps.filter((step) => step.action !== "approval_gate" && step.action !== "observe" && step.action !== "login");
  if (loginSteps.length === 0 && executableSteps.length === 0) {
    return "finish_pass blocked: the reviewed mission has no executable steps and cannot support a pass claim.";
  }
  const uncovered = executableSteps.filter((step) => !input.coveredStepIds.has(step.id));
  if (uncovered.length) {
    return `finish_pass blocked: reviewed mission steps were not successfully covered: ${uncovered.map((step) => step.id).join(", ")}.`;
  }

  if (loginSteps.length === 0) {
    const completionAssertions = completionAssertionsAfterFinalStateChange(input.mission);
    const staleCompletionAssertions = completionAssertions.filter((step) => !input.freshCompletionAssertionStepIds.has(step.id));
    if (staleCompletionAssertions.length) {
      return `finish_pass blocked: every reviewed completion assertion must pass after the latest browser state change; rerun: ${staleCompletionAssertions.map((step) => step.id).join(", ")}.`;
    }
    return undefined;
  }

  const reviewedLoginAssertions = completionAssertionsAfterFinalStateChange(input.mission);
  const staleLoginAssertions = reviewedLoginAssertions.filter((step) => !input.freshCompletionAssertionStepIds.has(step.id));
  if (staleLoginAssertions.length) {
    return `finish_pass blocked: every reviewed signed-in completion assertion must pass after the latest browser state change; rerun: ${staleLoginAssertions.map((step) => step.id).join(", ")}.`;
  }

  if (!input.loginSubmissionObserved) {
    return "finish_pass blocked: no safe credential-form submission was completed for the reviewed login step.";
  }
  if (!input.initialSessionFingerprint) {
    return "finish_pass blocked: the pre-login session baseline was unavailable.";
  }
  let currentFingerprint: string;
  try {
    currentFingerprint = await sessionFingerprint(input.context);
  } catch {
    return "finish_pass blocked: authenticated cookie/storage state could not be inspected safely.";
  }
  if (currentFingerprint === input.initialSessionFingerprint) {
    return "finish_pass blocked: the credential-form submission did not create or change reusable cookie/storage state.";
  }
  const credentialFormVisible = await input.page.evaluate(() => [...document.querySelectorAll("form")].some((form) => {
    const visible = (element: Element): boolean => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      return !html.hidden && style.display !== "none" && style.visibility !== "hidden" && html.getClientRects().length > 0;
    };
    if (!visible(form)) return false;
    return [...form.querySelectorAll("input")].some((field) => {
      if (!visible(field)) return false;
      const type = (field.type || "text").toLowerCase();
      if (type === "password") return true;
      const identity = [field.name, field.id, field.autocomplete, field.getAttribute("aria-label"), field.placeholder]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return ["text", "email", "tel"].includes(type) && /(user|email|login|account)/.test(identity);
    });
  })).catch(() => true);
  if (credentialFormVisible) {
    return "finish_pass blocked: the credential form is still visible after submission, so signed-in state was not established deterministically.";
  }
  return undefined;
}

async function sessionFingerprint(context: BrowserContext): Promise<string> {
  const state = await context.storageState();
  const cookies = state.cookies
    .map((cookie) => ({
      name: cookie.name.slice(0, 256),
      domain: cookie.domain.slice(0, 256),
      path: cookie.path.slice(0, 256),
      value: cookie.value.slice(0, 512),
      expires: cookie.expires
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .slice(0, 200);
  const origins = state.origins
    .map((origin) => ({
      origin: origin.origin.slice(0, 2_048),
      localStorage: origin.localStorage
        .map((item) => ({ name: item.name.slice(0, 256), value: item.value.slice(0, 512) }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 200)
    }))
    .sort((left, right) => left.origin.localeCompare(right.origin))
    .slice(0, 50);
  return JSON.stringify({ cookies, origins });
}

function checkMissionApprovalGates(mission: QAFlowMission, contract: QAContract, approvals: ApprovalState): { stepId: string; message: string } | undefined {
  for (const step of mission.steps.filter((candidate) => candidate.action === "approval_gate")) {
    if (!step.target || !contract.dangerousActions.requireApproval.includes(step.target)) {
      return {
        stepId: step.id,
        message: `Mission approval gate must target an exact dangerousActions.requireApproval label: ${step.target ?? "missing target"}. Regenerate the analysis before running this mission.`
      };
    }
    if (!isActionApproved(approvals, step.target)) {
      return {
        stepId: step.id,
        message: `Approval required for action "${step.target}". Run preflight-scout approve --action "${step.target}" after human review.`
      };
    }
  }
  return undefined;
}

function credentialAvailability(contract: QAContract, missionRole: string | undefined): Record<string, unknown> {
  if (!missionRole) return {};
  const credentials = ownRoleCredentials(contract, missionRole);
  if (!credentials) return {};
  const usernameEnv = browserCredentialEnvName(credentials.usernameEnv, "username");
  const passwordEnv = browserCredentialEnvName(credentials.passwordEnv, "password");
  return {
    [missionRole]: {
      usernameEnv,
      usernameEnvPresent: usernameEnv ? Boolean(process.env[usernameEnv]) : false,
      passwordEnv,
      passwordEnvPresent: passwordEnv ? Boolean(process.env[passwordEnv]) : false,
      storageState: credentials.storageState
    }
  };
}

function browserSafetyContract(contract: QAContract, missionRole: string | undefined): QAContract {
  if (!contract.auth) return contract;
  const credentials = missionRole ? ownRoleCredentials(contract, missionRole) : undefined;
  const usernameEnv = browserCredentialEnvName(credentials?.usernameEnv, "username");
  const passwordEnv = browserCredentialEnvName(credentials?.passwordEnv, "password");
  return {
    ...contract,
    auth: {
      ...contract.auth,
      roles: missionRole && credentials
        ? {
            [missionRole]: {
              ...(usernameEnv ? { usernameEnv } : {}),
              ...(passwordEnv ? { passwordEnv } : {}),
              ...(credentials.storageState ? { storageState: credentials.storageState } : {}),
              ...(credentials.signedInTarget ? { signedInTarget: credentials.signedInTarget } : {}),
              ...(credentials.notes ? { notes: credentials.notes } : {})
            }
          }
        : {}
    }
  };
}

function ownRoleCredentials(contract: QAContract, missionRole: string): RoleCredential | undefined {
  const roles = contract.auth?.roles;
  if (!roles || !Object.prototype.hasOwnProperty.call(roles, missionRole)) return undefined;
  return roles[missionRole];
}

function navigationBlockedResult(missionId: string, message: string): MissionRunResult {
  return blockedResult(missionId, "navigation-boundary", message);
}

function blockedResult(missionId: string, stepId: string, message: string): MissionRunResult {
  return {
    missionId,
    status: "blocked",
    results: [{ stepId, status: "blocked", message: sanitizeStepResultMessage(message) }],
    artifacts: []
  };
}
