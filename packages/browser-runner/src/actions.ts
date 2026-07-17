import type { Locator, Page } from "playwright";
import { browserCredentialEnvName, browserCredentialKindForEnvName, isActionApproved, type ApprovalState, type MissionStep, type QAContract, type QAFlowMission, type StepResult } from "@preflight-scout/core";
import type { BrowserNavigationBoundary } from "./navigation.js";
import type { BrowserDecision, BrowserRunOptions } from "./types.js";

class ActionBoundaryError extends Error {}
class CredentialBoundaryError extends ActionBoundaryError {}

export async function executeDecision(
  page: Page,
  decision: BrowserDecision,
  options: BrowserRunOptions,
  approvals: ApprovalState,
  stepId: string,
  execution: { mission: QAFlowMission; missionRole?: string; navigation?: BrowserNavigationBoundary }
): Promise<StepResult> {
  try {
    const safety = checkActionSafety(decision, options.contract, approvals, execution.mission);
    if (safety) return blocked(stepId, safety);
    const reviewedStep = decision.missionStepId
      ? execution.mission.steps.find((candidate) => candidate.id === decision.missionStepId)
      : undefined;
    const existingNavigationProblem = execution.navigation?.checkPage(page, decision.action);
    if (existingNavigationProblem) return blocked(stepId, existingNavigationProblem.message);

    switch (decision.action) {
      case "goto":
        if (!decision.target) return blocked(stepId, "goto requires target");
        {
          const target = execution.navigation?.resolve(decision.target, "goto")
            ?? (execution.navigation ? undefined : new URL(decision.target, normalizeBaseUrl(options.baseUrl)).toString());
          if (!target) return blocked(stepId, execution.navigation?.violation?.message ?? "Navigation was blocked.");
          await page.goto(target, { waitUntil: "domcontentloaded" });
        }
        if (execution.navigation?.checkPage(page, "goto")) return blocked(stepId, execution.navigation.violation!.message);
        return passed(stepId, decision.reason);
      case "click":
        {
          const locator = locatorFor(page, decision.target);
          await assertUniqueVisibleTarget(locator, "click");
          if (reviewedStep?.action === "login") {
            await assertSafeLoginSubmit(locator, options.contract, execution.missionRole, "click");
          }
          await locator.click();
        }
        await page.waitForTimeout(0);
        if (execution.navigation?.checkPage(page, "click")) return blocked(stepId, execution.navigation.violation!.message);
        return passed(stepId, decision.reason);
      case "fill":
        {
          const locator = locatorFor(page, decision.target);
          await assertUniqueVisibleTarget(locator, "fill");
          if (reviewedStep?.action === "login") {
            await assertSafeLoginFill(locator, decision.value, options.contract, execution.missionRole);
          }
          await locator.fill(resolveValue(decision.value, options.contract, execution.missionRole));
        }
        return passed(stepId, decision.reason);
      case "press":
        if (!decision.target) return blocked(stepId, "press requires a target bound to its reviewed mission step");
        {
          const locator = locatorFor(page, decision.target);
          await assertUniqueVisibleTarget(locator, "press");
          if (reviewedStep?.action === "login") {
            if ((decision.value ?? "Enter").toLowerCase() !== "enter") {
              throw new CredentialBoundaryError("Blocked login key press: dynamic login steps may press only Enter on a credential input");
            }
            await assertSafeLoginSubmit(locator, options.contract, execution.missionRole, "press");
          }
          await locator.press(decision.value ?? "Enter");
        }
        await page.waitForTimeout(0);
        if (execution.navigation?.checkPage(page, "key press")) return blocked(stepId, execution.navigation.violation!.message);
        return passed(stepId, decision.reason);
      case "assert":
        if (!reviewedStep?.target || (reviewedStep.action !== "assert_visible" && reviewedStep.action !== "assert_text")) {
          return blocked(stepId, "assert requires an exact reviewed assert_visible/assert_text mission step");
        }
        {
          const locator = locatorFor(page, reviewedStep.target);
          await locator.first().waitFor({ state: "attached", timeout: 8000 });
          await assertUniqueVisibleTarget(locator, "assert");
          if (reviewedStep.action === "assert_text") {
            if (!reviewedStep.expected) return blocked(stepId, `Reviewed assert_text step "${reviewedStep.id}" has no expected text.`);
            const actual = await locator.textContent();
            if (!actual?.includes(reviewedStep.expected)) {
              return { stepId, status: "failed", message: `${decision.reason}: reviewed text assertion did not find ${JSON.stringify(reviewedStep.expected)}` };
            }
          }
        }
        return passed(stepId, decision.reason);
      case "screenshot":
        return passed(stepId, decision.reason);
      case "wait":
        await page.waitForTimeout(parseWaitMs(decision.value));
        return passed(stepId, decision.reason);
      case "scroll":
        await scrollPage(page, decision.value);
        return passed(stepId, decision.reason);
      case "set_viewport":
        await page.setViewportSize(parseViewportSize(decision.value));
        return passed(stepId, decision.reason);
      default:
        return blocked(stepId, `Unsupported intermediate action ${decision.action}`);
    }
  } catch (error) {
    if (execution.navigation?.violation) return blocked(stepId, execution.navigation.violation.message);
    if (error instanceof ActionBoundaryError) return blocked(stepId, error.message);
    return { stepId, status: "failed", message: `${decision.reason}: ${(error as Error).message}` };
  }
}

export function bindReviewedAssertionDecision(
  decision: BrowserDecision,
  mission: QAFlowMission
): BrowserDecision {
  if (decision.action !== "assert" || !decision.missionStepId) return decision;
  const reviewedStep = mission.steps.find((candidate) => candidate.id === decision.missionStepId);
  if (
    !reviewedStep?.target
    || (reviewedStep.action !== "assert_visible" && reviewedStep.action !== "assert_text")
  ) {
    return decision;
  }

  // The live model chooses which reviewed assertion is ready to run, but it
  // does not choose or weaken the assertion itself. Bind the locator and text
  // to the human-reviewed mission before safety validation and execution.
  const { value: _unreviewedValue, ...boundDecision } = decision;
  return {
    ...boundDecision,
    target: reviewedStep.target,
    ...(reviewedStep.action === "assert_text" ? { value: reviewedStep.expected } : {})
  };
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

export function checkActionSafety(
  decision: BrowserDecision,
  contract: QAContract,
  approvals: ApprovalState,
  mission: QAFlowMission
): string | undefined {
  if (!requiresReviewedStep(decision.action)) return undefined;
  if (!decision.missionStepId) {
    return `Blocked ${decision.action}: mutating and navigation decisions must name an exact reviewed missionStepId.`;
  }
  const step = mission.steps.find((candidate) => candidate.id === decision.missionStepId);
  if (!step) {
    return `Blocked ${decision.action}: missionStepId "${decision.missionStepId}" is not present in the reviewed mission.`;
  }
  if (!isCompatibleReviewedAction(step, decision.action)) {
    return `Blocked ${decision.action}: reviewed mission step "${step.id}" has incompatible action "${step.action}".`;
  }
  if (decision.action === "assert") {
    if (step.action !== "assert_visible" && step.action !== "assert_text") {
      return `Blocked assert: reviewed mission step "${step.id}" has incompatible action "${step.action}".`;
    }
    if (!step.target) return `Blocked assert: reviewed mission step "${step.id}" has no explicit target.`;
    if (!decision.target || !targetsEquivalent(step.target, decision.target)) {
      return `Blocked assert: target is not the exact reviewed target for mission step "${step.id}".`;
    }
    if (step.action === "assert_text" && decision.value !== undefined && decision.value !== step.expected) {
      return `Blocked assert: expected value is not the exact reviewed value for mission step "${step.id}".`;
    }
    return undefined;
  }
  if (step.action !== "login") {
    if (!step.target) {
      return `Blocked ${decision.action}: reviewed mission step "${step.id}" has no explicit target.`;
    }
    if (!decision.target || !targetsEquivalent(step.target, decision.target)) {
      return `Blocked ${decision.action}: target is not the exact reviewed target for mission step "${step.id}".`;
    }
    if (decision.action === "fill") {
      const reviewedValue = step.valueEnv ? `env:${step.valueEnv}` : step.value ?? "";
      if ((decision.value ?? "") !== reviewedValue) {
        return `Blocked fill: value is not the exact reviewed value/valueEnv for mission step "${step.id}".`;
      }
    }
    if (decision.action === "press" && (decision.value ?? "Enter") !== (step.value ?? "Enter")) {
      return `Blocked press: key is not the exact reviewed value for mission step "${step.id}".`;
    }
  } else if ((decision.action === "click" || decision.action === "press") && !decision.target) {
    return `Blocked ${decision.action}: login decisions still require an explicit live target.`;
  }

  // Policy labels come only from reviewed mission data. Never infer approval
  // from a substring in an LLM-selected locator such as "Pay now".
  if (!step.policyLabel) {
    return `Blocked ${decision.action}: reviewed step "${step.id}" has no explicit policyLabel.`;
  }
  if (contract.dangerousActions.forbidden.includes(step.policyLabel)) {
    return `Forbidden action blocked by QA contract: ${step.policyLabel}`;
  }
  if (contract.dangerousActions.requireApproval.includes(step.policyLabel)) {
    if (!isActionApproved(approvals, step.policyLabel)) {
      return `Approval required for action "${step.policyLabel}". Run preflight-scout approve --action "${step.policyLabel}" after human review.`;
    }
    return undefined;
  }
  if (step.requiresApproval) {
    return `Blocked ${decision.action}: reviewed step "${step.id}" requires approval but policyLabel "${step.policyLabel}" is not an exact dangerousActions.requireApproval label.`;
  }
  if (!contract.dangerousActions.allowed.includes(step.policyLabel)) {
    return `Blocked ${decision.action}: policyLabel "${step.policyLabel}" is not exactly authorized by dangerousActions.allowed.`;
  }
  return undefined;
}

function requiresReviewedStep(action: BrowserDecision["action"]): boolean {
  return action === "goto" || action === "click" || action === "fill" || action === "press" || action === "assert";
}

function isCompatibleReviewedAction(step: MissionStep, action: BrowserDecision["action"]): boolean {
  if (action === "assert") return step.action === "assert_visible" || step.action === "assert_text";
  if (step.action === "login") return action === "click" || action === "fill" || action === "press";
  return step.action === action;
}

function targetsEquivalent(reviewed: string, live: string): boolean {
  return reviewed.trim() === live.trim();
}

function locatorFor(page: Page, target?: string): Locator {
  if (!target) throw new Error("Action is missing an explicit target");
  if (target.startsWith("css=")) return page.locator(target.slice(4));
  if (target.startsWith("text=")) return page.getByText(target.slice(5), { exact: true });
  if (target.startsWith("label=")) return page.getByLabel(target.slice(6), { exact: true });
  if (target.startsWith("testid=")) return page.getByTestId(target.slice(7));
  if (target.startsWith("role=")) {
    const params = Object.fromEntries(target.split("|").map((part) => {
      const [key, ...rest] = part.split("=");
      return [key, rest.join("=")];
    }));
    if (!params.role) throw new Error(`Invalid role target: ${target}`);
    return page.getByRole(params.role as Parameters<Page["getByRole"]>[0], params.name ? { name: params.name, exact: true } : undefined);
  }
  throw new Error(`Target must use explicit prefix css=, text=, label=, testid=, or role=: ${target}`);
}

async function assertUniqueVisibleTarget(locator: Locator, action: string): Promise<void> {
  const count = await locator.count();
  if (count !== 1) {
    throw new ActionBoundaryError(`Blocked ${action}: reviewed locator must resolve to exactly one element, but matched ${count}.`);
  }
  if (!await locator.isVisible()) {
    throw new ActionBoundaryError(`Blocked ${action}: the single reviewed target is not visible.`);
  }
}

async function assertSafeLoginFill(
  locator: Locator,
  value: string | undefined,
  contract: QAContract,
  missionRole: string | undefined
): Promise<void> {
  const envName = value?.startsWith("env:") ? value.slice(4) : undefined;
  const credentialKind = browserCredentialKindForEnvName(envName);
  if (!credentialKind) {
    throw new CredentialBoundaryError("Blocked login fill: dynamic login steps may fill only dedicated env-backed username/password credentials");
  }
  // resolveValue performs the exact role ownership check. Do it before DOM
  // inspection so a cross-role env reference cannot influence the page.
  resolveValue(value, contract, missionRole);
  const compatible = await locator.evaluate((node, kind) => {
    if (!(node instanceof HTMLInputElement)) return false;
    if (!node.form) return false;
    const inputType = (node.type || "text").toLowerCase();
    if (kind === "password") return inputType === "password";
    if (!["text", "email", "tel"].includes(inputType)) return false;
    const identity = [node.name, node.id, node.autocomplete, node.getAttribute("aria-label"), node.placeholder]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /(user|email|login|account)/.test(identity);
  }, credentialKind);
  if (!compatible) {
    throw new CredentialBoundaryError(`Blocked login fill: target is not a compatible ${credentialKind} input inside a login form`);
  }
}

async function assertSafeLoginSubmit(
  locator: Locator,
  contract: QAContract,
  missionRole: string | undefined,
  mechanism: "click" | "press"
): Promise<void> {
  const credentials = configuredLoginCredentialValues(contract, missionRole);
  if (!credentials.username && !credentials.password) {
    throw new CredentialBoundaryError("Blocked login submit: no dedicated credentials are configured for the reviewed mission role");
  }
  const safe = await locator.evaluate((node, input) => {
    const element = node as HTMLElement;
    const form = node instanceof HTMLInputElement || node instanceof HTMLButtonElement
      ? node.form
      : element.closest("form");
    if (!form) return false;

    const fields = [...form.querySelectorAll("input")];
    const fieldIdentity = (field: HTMLInputElement): string => [
      field.name,
      field.id,
      field.autocomplete,
      field.getAttribute("aria-label"),
      field.placeholder
    ].filter(Boolean).join(" ").toLowerCase();
    const usernameFields = fields.filter((field) => {
      const type = (field.type || "text").toLowerCase();
      return ["text", "email", "tel"].includes(type) && /(user|email|login|account)/.test(fieldIdentity(field));
    });
    const passwordFields = fields.filter((field) => (field.type || "").toLowerCase() === "password");
    const configuredFields = [
      input.username ? { expected: input.username, fields: usernameFields } : undefined,
      input.password ? { expected: input.password, fields: passwordFields } : undefined
    ].filter((item): item is { expected: string; fields: HTMLInputElement[] } => Boolean(item));
    const presentFields = configuredFields.filter((item) => item.fields.length > 0);
    const credentialsReady = presentFields.length > 0
      && presentFields.every((item) => item.fields.some((field) => field.value === item.expected));
    if (!credentialsReady) return false;

    if (input.mechanism === "press") {
      return node instanceof HTMLInputElement
        && [...usernameFields, ...passwordFields].includes(node)
        && Boolean(node.value);
    }

    const type = node instanceof HTMLButtonElement
      ? (node.type || "submit").toLowerCase()
      : node instanceof HTMLInputElement
        ? (node.type || "").toLowerCase()
        : "";
    if (type !== "submit") return false;
    const labels = [
      element.innerText,
      element.getAttribute("aria-label"),
      node instanceof HTMLInputElement ? node.value : undefined,
      element.getAttribute("data-testid")
    ].filter((label): label is string => Boolean(label))
      .map((label) => label.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    return labels.some((label) => ["login", "loginnow", "signin", "continue", "next", "submit", "verify"].includes(label));
  }, { ...credentials, mechanism });
  if (!safe) {
    throw new CredentialBoundaryError(
      mechanism === "click"
        ? "Blocked login click: target must be the credential form's recognized submit control after configured credentials are filled"
        : "Blocked login key press: target must be a filled credential input inside its credential form"
    );
  }
}

function configuredLoginCredentialValues(
  contract: QAContract,
  missionRole: string | undefined
): { username?: string; password?: string } {
  if (!missionRole) return {};
  const roles = contract.auth?.roles;
  if (!roles || !Object.prototype.hasOwnProperty.call(roles, missionRole)) return {};
  const role = roles[missionRole]!;
  const usernameEnv = browserCredentialEnvName(role.usernameEnv, "username");
  const passwordEnv = browserCredentialEnvName(role.passwordEnv, "password");
  return {
    ...(usernameEnv && process.env[usernameEnv] ? { username: process.env[usernameEnv] } : {}),
    ...(passwordEnv && process.env[passwordEnv] ? { password: process.env[passwordEnv] } : {})
  };
}

function resolveValue(value: string | undefined, contract: QAContract, missionRole: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("env:")) {
    const envName = value.slice(4);
    if (!missionRole) {
      throw new CredentialBoundaryError("Blocked environment-backed fill: the mission has no explicit role configured in the QA contract");
    }
    const roles = contract.auth?.roles;
    if (!roles || !Object.prototype.hasOwnProperty.call(roles, missionRole)) {
      throw new CredentialBoundaryError(`Blocked environment-backed fill: mission role ${missionRole} does not have configured QA credentials`);
    }
    const credentials = roles[missionRole]!;
    const authorizedNames = [
      browserCredentialEnvName(credentials.usernameEnv, "username"),
      browserCredentialEnvName(credentials.passwordEnv, "password")
    ].filter((candidate): candidate is string => Boolean(candidate));
    if (!authorizedNames.includes(envName)) {
      throw new CredentialBoundaryError(`Blocked environment-backed fill: ${envName || "(empty)"} is not an authorized dedicated browser credential for mission role ${missionRole}`);
    }
    const envValue = process.env[envName];
    if (!envValue) throw new Error(`Required environment variable ${envName} is not set`);
    return envValue;
  }
  return value;
}

function parseWaitMs(value?: string): number {
  if (!value) return 1000;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 30000) throw new Error("wait value must be between 0 and 30000 milliseconds");
  return parsed;
}

async function scrollPage(page: Page, value?: string): Promise<void> {
  const amount = value ? Number.parseInt(value, 10) : Number.NaN;
  if (value === "top") await page.evaluate(() => window.scrollTo(0, 0));
  else if (value === "bottom") await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  else if (value === "up") await page.evaluate(() => window.scrollBy(0, -Math.round(window.innerHeight * 0.8)));
  else if (value === "down" || !value) await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)));
  else if (Number.isSafeInteger(amount)) await page.evaluate((pixels) => window.scrollBy(0, pixels), amount);
  else throw new Error("scroll value must be top, bottom, up, down, or a pixel amount");
}

export function parseViewportSize(value?: string): { width: number; height: number } {
  const match = value?.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) throw new Error("set_viewport value must be WIDTHxHEIGHT, for example 390x844");
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width < 100 || height < 100) throw new Error("viewport dimensions must be at least 100x100");
  if (width > 4_096 || height > 4_096 || width * height > 8_000_000) {
    throw new Error("set_viewport dimensions must not exceed 4096px per side or 8,000,000 total pixels");
  }
  return { width, height };
}

function passed(stepId: string, message: string): StepResult {
  return { stepId, status: "passed", message };
}

function blocked(stepId: string, message: string): StepResult {
  return { stepId, status: "blocked", message };
}
