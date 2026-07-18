// @preflight-scout-requires-browser
import { createServer, type Server } from "node:http";
import { readFile, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveAction, createTrustedGit, type LLMClient, type LLMMessage, type QAContract, type QAFlowMission, type StructuredJsonOptions } from "@preflight-scout/core";
import { runBrowserMission } from "./index.js";

class ScriptedLLM implements LLMClient {
  private turn = 0;

  async completeJson<T>(_messages: LLMMessage[], _options: StructuredJsonOptions<T>): Promise<T> {
    this.turn += 1;
    const decisions = [
      {
        thought: "Need to apply the valid promo code.",
        action: "fill",
        missionStepId: "enter-valid-code",
        target: "testid=promo-code",
        value: "SAVE10",
        reason: "Fill the promo field with the configured valid coupon."
      },
      {
        thought: "Need to apply the promo.",
        action: "click",
        missionStepId: "apply-valid-code",
        target: "testid=apply-promo",
        reason: "Click apply to trigger checkout total update."
      },
      {
        thought: "Need to verify the discounted total.",
        action: "assert",
        missionStepId: "verify-discounted-total",
        target: "text=Total: $90.00",
        reason: "The checkout total reflects the SAVE10 discount."
      },
      {
        thought: "Evidence is sufficient.",
        action: "finish_pass",
        reason: "Valid coupon flow passed in the browser."
      }
    ];
    return decisions[this.turn - 1] as T;
  }
}

class ScriptedAuthLLM implements LLMClient {
  private turn = 0;

  async completeJson<T>(_messages: LLMMessage[], _options: StructuredJsonOptions<T>): Promise<T> {
    this.turn += 1;
    const decisions = [
      {
        thought: "Need to enter the configured email.",
        action: "fill",
        missionStepId: "login-and-confirm-session",
        target: "label=Email",
        value: "env:PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL",
        reason: "Use the configured test email without exposing its value."
      },
      {
        thought: "Need to enter the configured password.",
        action: "fill",
        missionStepId: "login-and-confirm-session",
        target: "label=Password",
        value: "env:PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD",
        reason: "Use the configured test password without exposing its value."
      },
      {
        thought: "Submit the login form.",
        action: "click",
        missionStepId: "login-and-confirm-session",
        target: "role=button|name=Sign in",
        reason: "Click the sign-in button."
      },
      {
        thought: "Verify the reviewed signed-in marker.",
        action: "assert",
        missionStepId: "confirm-signed-in-marker",
        target: "testid=signed-in-marker",
        reason: "The deterministic signed-in marker is visible."
      },
      {
        thought: "The session is ready to save.",
        action: "finish_pass",
        reason: "Authenticated session was observed and can be reused."
      }
    ];
    return decisions[this.turn - 1] as T;
  }
}

class BlockedLLM implements LLMClient {
  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in blocked LLM: ${options.schemaName}`);
    return {
      thought: "Cannot proceed.",
      action: "blocked",
      reason: "Signed-in state could not be verified."
    } as T;
  }
}

class UnexpectedDecisionLLM implements LLMClient {
  calls = 0;

  async completeJson<T>(_messages: LLMMessage[], _options: StructuredJsonOptions<T>): Promise<T> {
    this.calls += 1;
    throw new Error("The browser LLM must not run for an invalid mission.");
  }
}

class CapturingBlockedLLM implements LLMClient {
  lastPrompt = "";
  lastPayload?: { currentObservation?: { interactive?: Array<{ testid?: string; text?: string }> } };

  async completeJson<T>(messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in capture LLM: ${options.schemaName}`);
    this.lastPrompt = messages.map((message) => message.content).join("\n");
    const payload = messages.at(-1)?.content.split("\n\nThe current browser screenshot")[0] ?? "{}";
    this.lastPayload = JSON.parse(payload) as typeof this.lastPayload;
    return {
      thought: "Stop after bounded observation.",
      action: "blocked",
      reason: "Observation bound captured."
    } as T;
  }
}

class ObservationVisibilityLLM implements LLMClient {
  prompts: string[] = [];

  async completeJson<T>(messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in observation visibility LLM: ${options.schemaName}`);
    this.prompts.push(messages.map((message) => message.content).join("\n"));
    if (this.prompts.length === 1) {
      return {
        thought: "Reveal the reviewed alert.",
        action: "click",
        missionStepId: "reveal-alert",
        target: "testid=reveal-alert",
        reason: "Exercise the reviewed visibility transition."
      } as T;
    }
    return {
      thought: "Stop after capturing the visible alert.",
      action: "blocked",
      reason: "Observation visibility captured."
    } as T;
  }
}

class InventoryFailureFinishPassLLM implements LLMClient {
  calls = 0;

  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in inventory failure LLM: ${options.schemaName}`);
    this.calls += 1;
    if (this.calls === 1) {
      return {
        thought: "The reviewed text is visible.",
        action: "assert",
        missionStepId: "verify-inventory-page",
        reason: "Verify the reviewed page text."
      } as T;
    }
    return {
      thought: "The reviewed assertion passed.",
      action: "finish_pass",
      reason: "The mission has enough evidence to pass."
    } as T;
  }
}

class ApprovalAwareLLM implements LLMClient {
  private turn = 0;
  lastPayload?: { approvedActions?: string[] };
  lastPrompt = "";

  async completeJson<T>(messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in approval-aware LLM: ${options.schemaName}`);
    this.turn += 1;
    this.lastPrompt = messages.map((message) => message.content).join("\n");
    const payload = messages.at(-1)?.content.split("\n\nThe current browser screenshot")[0] ?? "{}";
    this.lastPayload = JSON.parse(payload) as { approvedActions?: string[] };
    const approved = this.lastPayload.approvedActions?.includes("apply_promo") ?? false;
    if (approved && this.turn === 1) {
      return {
        thought: "The promo action is approved.",
        action: "click",
        missionStepId: "apply_promo",
        target: "role=button|name=Apply promo",
        reason: "Exercise the approved browser action."
      } as T;
    }
    if (approved && this.turn === 2) {
      return {
        thought: "Verify the reviewed control remains visible.",
        action: "assert",
        missionStepId: "verify_promo_control",
        target: "role=button|name=Apply promo",
        reason: "The reviewed promo control remains visible."
      } as T;
    }
    return {
      thought: approved ? "The required action is approved." : "The required action is not approved.",
      action: approved ? "finish_pass" : "blocked",
      reason: approved ? "The approved browser action completed." : "Approval for apply_promo is missing."
    } as T;
  }
}

class SpacedApprovalTargetLLM implements LLMClient {
  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in spaced-target LLM: ${options.schemaName}`);
    return {
      thought: "Attempt the email action.",
      action: "click",
      missionStepId: "send_email",
      target: "role=button|name=Send email",
      reason: "Send the email."
    } as T;
  }
}

class DecisionSequenceLLM implements LLMClient {
  private turn = 0;

  constructor(
    private readonly decisions: Array<Record<string, unknown>>,
    private readonly beforeDecision?: (turn: number) => void | Promise<void>
  ) {}

  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in decision sequence: ${options.schemaName}`);
    const turn = this.turn++;
    await this.beforeDecision?.(turn);
    const decision = this.decisions[turn];
    if (!decision) throw new Error("Decision sequence exhausted");
    return decision as T;
  }
}

class ResultMessageCaptureLLM implements LLMClient {
  private turn = 0;
  lastPrompt = "";

  constructor(private readonly secret: string) {}

  async completeJson<T>(messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in result capture: ${options.schemaName}`);
    this.turn += 1;
    this.lastPrompt = messages.map((message) => message.content).join("\n");
    if (this.turn === 1) {
      return {
        thought: "Trigger a bounded runner error.",
        action: "set_viewport",
        value: "99999x99999",
        reason: `${"x".repeat(1_900)}${this.secret}`
      } as T;
    }
    return {
      thought: "Stop after inspecting the prior error.",
      action: "blocked",
      reason: "The bounded failure was captured."
    } as T;
  }
}

describe("runBrowserMission", () => {
  let server: Server;
  let outsideServer: Server;
  let baseUrl: string;
  let outsideBaseUrl: string;
  let outsideRequests = 0;
  let dangerousMutations = 0;
  let lateAssertionShouldChange = false;
  let outputDir: string;

  beforeAll(async () => {
    outsideServer = createServer((_req, res) => {
      outsideRequests += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Outside origin</title><p>OFF_ORIGIN_CONTENT_MUST_NOT_BE_CAPTURED</p>");
    });
    await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));
    const outsideAddress = outsideServer.address();
    if (!outsideAddress || typeof outsideAddress === "string") throw new Error("Could not start outside-origin test server");
    outsideBaseUrl = `http://127.0.0.1:${outsideAddress.port}`;

    server = createServer(async (req, res) => {
      if (req.url === "/dangerous-mutation") {
        dangerousMutations += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === "/hostile-large") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><head><title>Hostile observation</title></head><body style="min-height:100000px">
          <button id="large-control">Safe</button>
          <script>
            document.title = "T".repeat(100000);
            document.body.append(document.createTextNode("BODY_SENTINEL_" + "x".repeat(2000000)));
            const control = document.querySelector("#large-control");
            control.setAttribute("aria-label", "LABEL_SENTINEL_" + "y".repeat(100000));
            control.setAttribute("data-testid", "TESTID_SENTINEL_" + "z".repeat(100000));
            for (let index = 0; index < 500; index += 1) console.error("hostile-console-" + index + "-" + "e".repeat(2000));
          </script>
        </body></html>`);
        return;
      }
      if (req.url === "/observation-visibility") {
        const hiddenCrowd = Array.from({ length: 85 }, (_, index) =>
          `<p hidden role="status" data-testid="hidden-crowd-${index}">HIDDEN_CROWD_SENTINEL_${index}</p>`
        ).join("");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          ${hiddenCrowd}
          <div hidden><button data-testid="hidden-by-ancestor">HIDDEN_ANCESTOR_SENTINEL</button></div>
          <button style="display:none" data-testid="hidden-by-display">HIDDEN_DISPLAY_SENTINEL</button>
          <button style="visibility:hidden" data-testid="hidden-by-visibility">HIDDEN_VISIBILITY_SENTINEL</button>
          <input type="hidden" data-testid="hidden-input-sentinel" />
          <p data-testid="promo-error" role="alert" hidden>HIDDEN_ALERT_SENTINEL</p>
          <button data-testid="reveal-alert">VISIBLE_CONTROL_SENTINEL</button>
          <script>
            document.querySelector('[data-testid="reveal-alert"]').addEventListener("click", () => {
              document.querySelector('[data-testid="promo-error"]').hidden = false;
            });
          </script>
        </body>`);
        return;
      }
      if (req.url === "/observation-layout-bound") {
        // Stay above the 1,000-candidate visibility-check budget without
        // making fixture HTML generation dominate the bounded-layout test.
        const hiddenFlood = Array.from({ length: 1_250 }, (_, index) =>
          `<span role="status" data-testid="layout-flood-${index}" style="display:block;width:0;height:0;overflow:hidden"></span>`
        ).join("");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          ${hiddenFlood}
          <button data-testid="beyond-layout-flood">Control beyond the hostile layout flood</button>
          <output data-testid="layout-check-count">MAX_LAYOUT_CHECKS:0</output>
          <script>
            let layoutChecks = 0;
            let maxLayoutChecks = 0;
            let resetPending = false;
            const counter = document.querySelector('[data-testid="layout-check-count"]');
            const recordLayoutCheck = () => {
              if (!resetPending) {
                resetPending = true;
                setTimeout(() => {
                  layoutChecks = 0;
                  resetPending = false;
                }, 0);
              }
              layoutChecks += 1;
              maxLayoutChecks = Math.max(maxLayoutChecks, layoutChecks);
              counter.textContent = 'MAX_LAYOUT_CHECKS:' + maxLayoutChecks;
            };
            const getComputedStyle = window.getComputedStyle.bind(window);
            window.getComputedStyle = (...args) => {
              recordLayoutCheck();
              return getComputedStyle(...args);
            };
            const getBoundingClientRect = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function () {
              recordLayoutCheck();
              return getBoundingClientRect.call(this);
            };
          </script>
        </body>`);
        return;
      }
      if (req.url === "/observation-hostile-visibility-api") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          <button data-testid="style-throw">Untrusted style control</button>
          <button data-testid="bounds-throw">Untrusted bounds control</button>
          <button data-testid="safe-visibility-control">Safe visibility control</button>
          <script>
            const getComputedStyle = window.getComputedStyle.bind(window);
            window.getComputedStyle = (element, ...args) => {
              if (element.dataset?.testid === 'style-throw') throw new Error('PAGE_STYLE_OVERRIDE');
              return getComputedStyle(element, ...args);
            };
            const getBoundingClientRect = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function () {
              if (this.dataset?.testid === 'bounds-throw') throw new Error('PAGE_BOUNDS_OVERRIDE');
              return getBoundingClientRect.call(this);
            };
          </script>
        </body>`);
        return;
      }
      if (req.url === "/observation-hostile-inventory-api") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          <main>SAFE_INVENTORY_PAGE</main>
          <script>
            document.querySelectorAll = () => {
              throw new Error('PAGE_INVENTORY_OVERRIDE');
            };
          </script>
        </body>`);
        return;
      }
      if (req.url === "/observation-output-reservation") {
        const nativeControls = Array.from({ length: 100 }, (_, index) =>
          `<button data-testid="native-control-${index}">Native control ${index}</button>`
        ).join("");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          <p role="status" data-testid="generic-status-marker">GENERIC_STATUS_SENTINEL</p>
          ${nativeControls}
        </body>`);
        return;
      }
      if (req.url === "/duplicate-control") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          <button onclick="fetch('/dangerous-mutation')">Apply</button>
          <button>Apply</button>
        </body>`);
        return;
      }
      if (req.url === "/hostile-login") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          <form>
            <label>Email <input aria-label="Email" name="email" type="email"></label>
            <label>Password <input aria-label="Password" name="password" type="password"></label>
            <button type="submit">Sign in</button>
            <button type="submit" onclick="event.preventDefault(); fetch('/dangerous-mutation')">Delete account</button>
          </form>
        </body>`);
        return;
      }
      if (req.url === "/false-positive-login") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body>
          <form id="login-form">
            <label>Email <input aria-label="Email" name="email" type="email"></label>
            <label>Password <input aria-label="Password" name="password" type="password"></label>
            <button type="submit">Sign in</button>
          </form>
          <p data-testid="signed-in-marker" hidden>Signed in</p>
          <p data-testid="login-error" hidden>Analytics service unavailable</p>
          <script>
            document.querySelector("#login-form").addEventListener("submit", (event) => {
              event.preventDefault();
              localStorage.setItem("analytics-error-id", "transient-error");
              event.currentTarget.hidden = true;
              document.querySelector('[data-testid="login-error"]').hidden = false;
            });
          </script>
        </body>`);
        return;
      }
      if (req.url === "/boundary/redirect") {
        res.writeHead(302, { location: `${outsideBaseUrl}/redirect-target` });
        res.end();
        return;
      }
      if (req.url === "/late-boundary") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html>
<html lang="en"><head><title>Late boundary fixture</title></head><body>
  <p>The first observation is safe. The final observation attempts to leave the app.</p>
  <script>
    const querySelectorAll = document.querySelectorAll.bind(document);
    let observationQueries = 0;
    document.querySelectorAll = (...args) => {
      observationQueries += 1;
      if (observationQueries === 3) window.location.assign(${JSON.stringify(`${outsideBaseUrl}/late-finalization`)});
      return querySelectorAll(...args);
    };
  </script>
</body></html>`);
        return;
      }
      if (req.url === "/late-assertion-change") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html>
<html lang="en"><head><title>Late assertion fixture</title></head><body>
  <p data-testid="final-state">Stable final state</p>
  <script>
    const target = document.querySelector('[data-testid="final-state"]');
    const timer = setInterval(async () => {
      const state = await fetch('/late-assertion-state').then((response) => response.text());
      if (state === 'changed') {
        target.textContent = 'Changed final state';
        clearInterval(timer);
      }
    }, 5);
  </script>
</body></html>`);
        return;
      }
      if (req.url === "/late-observation-failure") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html>
<html lang="en"><head><title>Late observation failure fixture</title></head><body>
  <p>Stable reviewed state</p>
  <script>
    const querySelectorAll = document.querySelectorAll.bind(document);
    let observationQueries = 0;
    document.querySelectorAll = (...args) => {
      observationQueries += 1;
      if (observationQueries === 3) throw new Error('Final DOM inventory failed');
      return querySelectorAll(...args);
    };
  </script>
</body></html>`);
        return;
      }
      if (req.url === "/late-assertion-state") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end(lateAssertionShouldChange ? "changed" : "stable");
        return;
      }
      if (req.url === "/boundary") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html>
<html lang="en"><head><title>Boundary fixture</title></head><body>
  <a id="off-origin-link" href="${outsideBaseUrl}/clicked">Off origin</a>
  <a id="redirect-link" href="/boundary/redirect">Redirect off origin</a>
  <a id="file-link" href="file:///etc/passwd">File URL</a>
  <a id="data-link" href="data:text/html,UNSAFE_DATA_CONTENT">Data URL</a>
  <a id="blank-link" href="${outsideBaseUrl}/blank" target="_blank">Off-origin popup link</a>
  <button id="window-open" type="button" onclick="window.open('${outsideBaseUrl}/window-open', '_blank')">Script popup</button>
  <button id="detached-popup" type="button" onclick="{ const link = document.createElement('a'); link.href = '${outsideBaseUrl}/detached-popup'; link.target = '_blank'; link.click(); }">Detached popup</button>
  <form action="${outsideBaseUrl}/pressed" method="get"><label>Search <input id="press-target" name="q" /></label></form>
</body></html>`);
        return;
      }
      const html = await readFile(path.resolve("examples/static-checkout/index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start test server");
    baseUrl = `http://127.0.0.1:${address.port}`;
    outputDir = await mkdtemp(path.join(tmpdir(), "preflight-scout-browser-runner-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => outsideServer.close((error) => (error ? reject(error) : resolve())));
    await rm(outputDir, { recursive: true, force: true });
  });

  it("executes a browser mission with decisions made by the LLM client", async () => {
    const contract: QAContract = {
      app: { name: "Static Checkout", previewUrlSource: "manual" },
      criticalFlows: ["checkout"],
      sensitiveAreas: ["payments"],
      dangerousActions: { allowed: ["fill", "click"], requireApproval: [], forbidden: [] },
      testData: { valid_coupon: "SAVE10" },
      unknowns: []
    };
    const mission: QAFlowMission = {
      id: "valid-coupon",
      title: "Validate valid coupon",
      risk: "high",
      startPath: "/",
      reason: ["Checkout promo behavior changed."],
      steps: [{
        id: "enter-valid-code",
        instruction: "Enter the reviewed coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "SAVE10"
      }, {
        id: "apply-valid-code",
        instruction: "Apply the reviewed coupon.",
        action: "click",
        policyLabel: "click",
        target: "testid=apply-promo"
      }, {
        id: "verify-discounted-total",
        instruction: "Verify the reviewed total.",
        action: "assert_text",
        target: "text=Total: $90.00",
        expected: "Total: $90.00"
      }]
    };

    const result = await runBrowserMission(mission, {
      baseUrl,
      contract,
      llm: new ScriptedLLM(),
      outputDir,
      headless: true,
      maxTurns: 6
    });

    expect(result.status).toBe("passed");
    expect(result.results.map((item) => item.status)).toContain("passed");
    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.evidence?.tracePath).toContain("trace.zip");
    expect(result.evidence?.consolePath).toContain("console-errors.json");
    expect(result.evidence?.networkPath).toContain("network-errors.json");
    expect(result.evidence?.finalObservationPath).toContain("final-observation.json");
    expect(result.results.every((item) => item.screenshotPath)).toBe(true);
  });

  it("bounds hostile DOM observations, screenshots, runtime errors, and redacts prompt secrets", async () => {
    const llm = new CapturingBlockedLLM();
    const embeddedSecret = ["sk", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const runOutput = path.join(outputDir, "hostile-observation-bounds");
    const result = await runBrowserMission({
      id: "hostile-observation-bounds",
      title: "Bound hostile observation",
      risk: "high",
      startPath: "/hostile-large",
      reason: ["Exercise hostile page bounds."],
      steps: [{
        id: "verify-safe-control",
        instruction: "Verify the bounded fixture control.",
        action: "assert_visible",
        target: "css=#large-control"
      }]
    }, {
      baseUrl,
      contract: {
        app: { name: "Hostile fixture" },
        criticalFlows: [],
        sensitiveAreas: [],
        dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
        testData: { accidental_secret: embeddedSecret },
        unknowns: []
      },
      llm,
      outputDir: runOutput,
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(llm.lastPrompt).not.toContain(embeddedSecret);
    expect(llm.lastPrompt).toContain("[REDACTED_SECRET]");
    expect(llm.lastPrompt).toContain("bounded DOM locator inventory from the rendered document");
    expect(llm.lastPrompt).toContain("not an accessibility-tree dump");
    expect(llm.lastPrompt).toContain("omission cannot prove absence from the accessibility tree");
    expect(llm.lastPrompt.length).toBeLessThan(50_000);
    expect(llm.lastPrompt).not.toContain("z".repeat(1_000));
    const screenshotPath = result.artifacts.find((artifact) => artifact.endsWith(".png"));
    expect(screenshotPath).toBeTruthy();
    expect((await stat(screenshotPath!)).size).toBeLessThanOrEqual(20 * 1024 * 1024);
    const consoleErrors = JSON.parse(await readFile(result.evidence!.consolePath!, "utf8")) as string[];
    expect(consoleErrors.length).toBeLessThanOrEqual(100);
    expect(consoleErrors.at(-1)?.length).toBeLessThanOrEqual(1_000);
  });

  it("excludes hidden DOM from observations before bounding visible controls", async () => {
    const llm = new ObservationVisibilityLLM();
    const result = await runBrowserMission({
      id: "observation-visibility",
      title: "Observe a reviewed visibility transition",
      risk: "low",
      startPath: "/observation-visibility",
      reason: ["Exercise rendered observation filtering."],
      steps: [{
        id: "reveal-alert",
        instruction: "Reveal the reviewed alert.",
        action: "click",
        policyLabel: "click",
        target: "testid=reveal-alert"
      }]
    }, {
      baseUrl,
      contract: {
        app: { name: "Observation fixture" },
        criticalFlows: [],
        sensitiveAreas: [],
        dangerousActions: { allowed: ["click"], requireApproval: [], forbidden: [] },
        testData: {},
        unknowns: []
      },
      llm,
      outputDir: path.join(outputDir, "observation-visibility"),
      headless: true,
      maxTurns: 2
    });

    expect(result.status).toBe("blocked");
    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[0]).toContain("VISIBLE_CONTROL_SENTINEL");
    expect(llm.prompts[0]).not.toContain("HIDDEN_CROWD_SENTINEL");
    expect(llm.prompts[0]).not.toContain("HIDDEN_ANCESTOR_SENTINEL");
    expect(llm.prompts[0]).not.toContain("HIDDEN_DISPLAY_SENTINEL");
    expect(llm.prompts[0]).not.toContain("HIDDEN_VISIBILITY_SENTINEL");
    expect(llm.prompts[0]).not.toContain("hidden-input-sentinel");
    expect(llm.prompts[0]).not.toContain("HIDDEN_ALERT_SENTINEL");
    expect(llm.prompts[1]).toContain("HIDDEN_ALERT_SENTINEL");

    const finalObservation = JSON.parse(await readFile(result.evidence!.finalObservationPath!, "utf8")) as {
      interactive: Array<{ testid?: string; text?: string }>;
    };
    expect(finalObservation.interactive).toContainEqual(expect.objectContaining({
      testid: "promo-error",
      text: "HIDDEN_ALERT_SENTINEL"
    }));
    expect(finalObservation.interactive).toContainEqual(expect.objectContaining({
      testid: "reveal-alert",
      text: "VISIBLE_CONTROL_SENTINEL"
    }));
    expect(JSON.stringify(finalObservation)).not.toContain("HIDDEN_CROWD_SENTINEL");
  });

  it("bounds rendered candidate layout checks under a large hidden-node flood", async () => {
    const llm = new CapturingBlockedLLM();
    const result = await runBrowserMission({
      id: "observation-layout-bound",
      title: "Bound rendered candidate checks",
      risk: "high",
      startPath: "/observation-layout-bound",
      reason: ["Exercise hostile DOM observation bounds."],
      steps: [{
        id: "verify-beyond-layout-flood",
        instruction: "Verify the visible control after the hostile candidate flood.",
        action: "assert_visible",
        target: "testid=beyond-layout-flood"
      }]
    }, {
      baseUrl,
      contract: {
        app: { name: "Observation bound fixture" },
        criticalFlows: [],
        sensitiveAreas: [],
        dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
        testData: {},
        unknowns: []
      },
      llm,
      outputDir: path.join(outputDir, "observation-layout-bound"),
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(llm.lastPayload?.currentObservation?.interactive).toContainEqual(expect.objectContaining({
      testid: "beyond-layout-flood",
      text: "Control beyond the hostile layout flood"
    }));
    expect(result.evidence?.finalObservationPath).toContain("final-observation.json");
    const finalObservation = JSON.parse(await readFile(result.evidence!.finalObservationPath!, "utf8")) as { text: string };
    const observedMaximum = Number(finalObservation.text.match(/MAX_LAYOUT_CHECKS:(\d+)/)?.[1]);
    expect(observedMaximum).toBeGreaterThan(0);
    expect(observedMaximum).toBeLessThanOrEqual(2100);
  });

  it("treats page-overridden visibility APIs as untrusted candidate evidence", async () => {
    const llm = new CapturingBlockedLLM();
    const result = await runBrowserMission({
      id: "observation-hostile-visibility-api",
      title: "Contain page-owned visibility failures",
      risk: "high",
      startPath: "/observation-hostile-visibility-api",
      reason: ["Page-controlled DOM APIs must not abort browser QA."],
      steps: [{
        id: "verify-safe-visibility-control",
        instruction: "Verify the safe control that remains usable.",
        action: "assert_visible",
        target: "testid=safe-visibility-control"
      }]
    }, {
      baseUrl,
      contract: {
        app: { name: "Hostile visibility fixture" },
        criticalFlows: [],
        sensitiveAreas: [],
        dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
        testData: {},
        unknowns: []
      },
      llm,
      outputDir: path.join(outputDir, "observation-hostile-visibility-api"),
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(llm.lastPayload?.currentObservation?.interactive).toContainEqual(expect.objectContaining({
      testid: "safe-visibility-control",
      text: "Safe visibility control"
    }));
    expect(JSON.stringify(llm.lastPayload?.currentObservation?.interactive)).not.toContain("style-throw");
    expect(JSON.stringify(llm.lastPayload?.currentObservation?.interactive)).not.toContain("bounds-throw");
  });

  it("fails closed when the page prevents interactive inventory collection", async () => {
    const llm = new InventoryFailureFinishPassLLM();
    const runOutputDir = path.join(outputDir, "observation-hostile-inventory-api");
    const result = await runBrowserMission({
      id: "observation-hostile-inventory-api",
      title: "Contain page-owned inventory failures",
      risk: "high",
      startPath: "/observation-hostile-inventory-api",
      reason: ["Inventory-wide observation failures must block evidence persistence."],
      steps: [{
        id: "verify-inventory-page",
        instruction: "Verify the reviewed page text.",
        action: "assert_text",
        target: "css=body",
        expected: "SAFE_INVENTORY_PAGE"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm,
      outputDir: runOutputDir,
      headless: true,
      maxTurns: 2
    });

    expect(result.status).toBe("blocked");
    expect(llm.calls).toBe(0);
    expect(result.results.at(-1)).toMatchObject({ stepId: "browser-finalization", status: "blocked" });
    expect(JSON.stringify(result)).not.toContain("PAGE_INVENTORY_OVERRIDE");
    expect(result.artifacts).toEqual([]);
    expect(result.evidence).toEqual({});
    await expect(stat(path.join(runOutputDir, "trace.zip"))).rejects.toThrow();
    await expect(stat(path.join(runOutputDir, "final-observation.json"))).rejects.toThrow();
  });

  it("reserves observation output for generic semantic markers", async () => {
    const llm = new CapturingBlockedLLM();
    const result = await runBrowserMission({
      id: "observation-output-reservation",
      title: "Retain generic semantic observations",
      risk: "medium",
      startPath: "/observation-output-reservation",
      reason: ["Exercise bounded evidence selection across candidate lanes."],
      steps: [{
        id: "verify-generic-status",
        instruction: "Verify the reviewed generic status marker.",
        action: "assert_visible",
        target: "testid=generic-status-marker"
      }]
    }, {
      baseUrl,
      contract: {
        app: { name: "Observation selection fixture" },
        criticalFlows: [],
        sensitiveAreas: [],
        dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
        testData: {},
        unknowns: []
      },
      llm,
      outputDir: path.join(outputDir, "observation-output-reservation"),
      headless: true,
      maxTurns: 1
    });

    const interactive = llm.lastPayload?.currentObservation?.interactive;
    expect(result.status).toBe("blocked");
    expect(interactive).toHaveLength(80);
    expect(interactive).toContainEqual(expect.objectContaining({
      testid: "generic-status-marker",
      role: "status",
      text: "GENERIC_STATUS_SENTINEL"
    }));
    expect(interactive).toContainEqual(expect.objectContaining({
      testid: "native-control-0",
      text: "Native control 0"
    }));
    expect(interactive?.[0]).toEqual(expect.objectContaining({ testid: "generic-status-marker" }));
  });

  it("refuses immediate finish_pass before the reviewed assertion is covered", async () => {
    const reviewedMission: QAFlowMission = {
      id: "reviewed-assertion",
      title: "Reviewed assertion",
      risk: "high",
      startPath: "/",
      reason: ["Require reviewed evidence."],
      steps: [{
        id: "verify-total",
        instruction: "Verify the checkout total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $100.00"
      }]
    };
    const immediate = await runBrowserMission(reviewedMission, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([{ thought: "Skip checks.", action: "finish_pass", reason: "Looks fine." }]),
      outputDir: path.join(outputDir, "immediate-finish"),
      headless: true,
      maxTurns: 1
    });
    expect(immediate.status).toBe("blocked");
    expect(immediate.results.at(-1)?.message).toContain("not successfully covered");
  });

  it("invalidates an early completion assertion after a later reviewed state change", async () => {
    const result = await runBrowserMission({
      id: "stale-completion-assertion",
      title: "Do not reuse stale completion evidence",
      risk: "high",
      startPath: "/",
      reason: ["The final assertion must describe the post-action state."],
      steps: [{
        id: "enter-valid-code",
        instruction: "Enter the reviewed coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "SAVE10"
      }, {
        id: "apply-valid-code",
        instruction: "Apply the reviewed coupon.",
        action: "click",
        policyLabel: "click",
        target: "testid=apply-promo"
      }, {
        id: "verify-final-total",
        instruction: "Verify the reviewed final total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $100.00"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Assert too early.", action: "assert", missionStepId: "verify-final-total", reason: "The initial total matches." },
        { thought: "Enter the coupon.", action: "fill", missionStepId: "enter-valid-code", target: "testid=promo-code", value: "SAVE10", reason: "Use the reviewed code." },
        { thought: "Apply the coupon.", action: "click", missionStepId: "apply-valid-code", target: "testid=apply-promo", reason: "Run the reviewed mutation." },
        { thought: "Finish without reasserting.", action: "finish_pass", reason: "All step ids ran." }
      ]),
      outputDir: path.join(outputDir, "stale-completion-assertion"),
      headless: true,
      maxTurns: 4
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)?.message).toContain("must pass after the latest browser state change");
  });

  it("preserves intermediate assertion coverage while requiring fresh final-state evidence", async () => {
    const result = await runBrowserMission({
      id: "intermediate-and-final-assertions",
      title: "Keep intermediate and final evidence",
      risk: "high",
      startPath: "/",
      reason: ["Prove both the initial and post-action totals."],
      steps: [{
        id: "verify-initial-total",
        instruction: "Verify the reviewed initial total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $100.00"
      }, {
        id: "enter-valid-code",
        instruction: "Enter the reviewed coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "SAVE10"
      }, {
        id: "apply-valid-code",
        instruction: "Apply the reviewed coupon.",
        action: "click",
        policyLabel: "click",
        target: "testid=apply-promo"
      }, {
        id: "verify-final-total",
        instruction: "Verify the reviewed discounted total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $90.00"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Record the initial state.", action: "assert", missionStepId: "verify-initial-total", reason: "The initial total matches." },
        { thought: "Enter the coupon.", action: "fill", missionStepId: "enter-valid-code", target: "testid=promo-code", value: "SAVE10", reason: "Use the reviewed code." },
        { thought: "Apply the coupon.", action: "click", missionStepId: "apply-valid-code", target: "testid=apply-promo", reason: "Run the reviewed mutation." },
        { thought: "Verify the final state.", action: "assert", missionStepId: "verify-final-total", reason: "The discounted total matches." },
        { thought: "Finish with fresh evidence.", action: "finish_pass", reason: "Both reviewed states passed." }
      ]),
      outputDir: path.join(outputDir, "intermediate-and-final-assertions"),
      headless: true,
      maxTurns: 5
    });

    expect(result.status).toBe("passed");
    expect(result.results.filter((step) => step.status === "passed")).toHaveLength(5);
  });

  it("requires every final completion assertion to be fresh after a later state change", async () => {
    const result = await runBrowserMission({
      id: "all-final-assertions-fresh",
      title: "Refresh every final claim",
      risk: "high",
      startPath: "/",
      reason: ["Independent final claims must all describe the current state."],
      steps: [{
        id: "enter-valid-code",
        instruction: "Enter the reviewed coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "SAVE10"
      }, {
        id: "apply-valid-code",
        instruction: "Apply the reviewed coupon.",
        action: "click",
        policyLabel: "click",
        target: "testid=apply-promo"
      }, {
        id: "verify-final-total",
        instruction: "Verify the reviewed discounted total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $90.00"
      }, {
        id: "verify-final-heading",
        instruction: "Verify the reviewed checkout heading.",
        action: "assert_visible",
        target: "text=Checkout"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Assert the heading too early.", action: "assert", missionStepId: "verify-final-heading", reason: "The heading is initially visible." },
        { thought: "Enter the coupon.", action: "fill", missionStepId: "enter-valid-code", target: "testid=promo-code", value: "SAVE10", reason: "Use the reviewed code." },
        { thought: "Apply the coupon.", action: "click", missionStepId: "apply-valid-code", target: "testid=apply-promo", reason: "Run the reviewed mutation." },
        { thought: "Refresh only the total.", action: "assert", missionStepId: "verify-final-total", reason: "The discounted total matches." },
        { thought: "Finish with one stale final claim.", action: "finish_pass", reason: "All step ids ran once." }
      ]),
      outputDir: path.join(outputDir, "all-final-assertions-fresh"),
      headless: true,
      maxTurns: 5
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)?.message).toContain("rerun: verify-final-heading");
    expect(result.results.at(-1)?.message).not.toContain("rerun: verify-final-total");
  });

  it("re-evaluates reviewed completion assertions against timer-driven final DOM changes", async () => {
    lateAssertionShouldChange = false;
    const storagePath = path.join(outputDir, "late-final-assertion-state.json");
    const result = await runBrowserMission({
      id: "late-final-assertion-change",
      title: "Reject a stale final text claim",
      risk: "high",
      startPath: "/late-assertion-change",
      reason: ["The final DOM must still satisfy the reviewed assertion."],
      steps: [{
        id: "verify-final-state",
        instruction: "Verify the stable final state.",
        action: "assert_text",
        target: "testid=final-state",
        expected: "Stable final state"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Verify the reviewed state.", action: "assert", missionStepId: "verify-final-state", reason: "The stable final state is present." },
        { thought: "Finish without another browser action.", action: "finish_pass", reason: "The reviewed assertion passed." }
      ], async (turn) => {
        if (turn !== 1) return;
        lateAssertionShouldChange = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }),
      outputDir: path.join(outputDir, "late-final-assertion-change"),
      headless: true,
      maxTurns: 2,
      saveStorageState: storagePath
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)).toMatchObject({ stepId: "browser-finalization", status: "blocked" });
    expect(result.results.at(-1)?.message).toContain("verify-final-state");
    expect(result.results.at(-1)?.message).toContain("reviewed text assertion did not find");
    expect(result.evidence?.tracePath).toBeUndefined();
    expect(result.evidence?.finalObservationPath).toBeUndefined();
    await expect(readFile(storagePath, "utf8")).rejects.toThrow();
    await expect(readFile(`${storagePath}.preflight-scout.json`, "utf8")).resolves.toContain('"status": "invalid"');
  });

  it("preserves a failed final observation when completion assertions still pass", async () => {
    const result = await runBrowserMission({
      id: "late-observation-failure",
      title: "Fail closed when final observation cannot be captured",
      risk: "high",
      startPath: "/late-observation-failure",
      reason: ["The final DOM inventory must remain observable."],
      steps: [{
        id: "verify-stable-state",
        instruction: "Verify the reviewed stable state.",
        action: "assert_visible",
        target: "text=Stable reviewed state"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Verify the reviewed state.", action: "assert", missionStepId: "verify-stable-state", reason: "The stable state is visible." },
        { thought: "Finish after the reviewed assertion.", action: "finish_pass", reason: "The reviewed assertion passed." }
      ]),
      outputDir: path.join(outputDir, "late-observation-failure"),
      headless: true,
      maxTurns: 2
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)).toMatchObject({
      stepId: "browser-finalization",
      status: "blocked",
      message: "Browser finalization failed closed because the final same-origin state could not be observed safely."
    });
    expect(result.evidence?.tracePath).toBeUndefined();
    expect(result.evidence?.finalObservationPath).toBeUndefined();
  });

  it.each([
    ["wait", "0"],
    ["scroll", "down"],
    ["set_viewport", "390x844"]
  ] as const)("invalidates completion evidence after a later %s browser-state action", async (action, value) => {
    const result = await runBrowserMission({
      id: `stale-after-${action}`,
      title: "Require fresh browser-state evidence",
      risk: "medium",
      startPath: "/",
      reason: ["A later browser-state operation can invalidate visible evidence."],
      steps: [{
        id: "verify-checkout",
        instruction: "Verify the checkout heading.",
        action: "assert_visible",
        target: "text=Checkout"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Capture completion evidence.", action: "assert", missionStepId: "verify-checkout", reason: "Checkout is visible." },
        { thought: "Change browser state.", action, value, reason: "Exercise a browser-state operation." },
        { thought: "Finish without reasserting.", action: "finish_pass", reason: "The earlier assertion passed." }
      ]),
      outputDir: path.join(outputDir, `stale-after-${action}`),
      headless: true,
      maxTurns: 3
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)?.message).toContain("must pass after the latest browser state change");
  });

  it("rejects an assertionless reviewed mission before browser launch or an LLM decision", async () => {
    const llm = new UnexpectedDecisionLLM();
    const runOutput = path.join(outputDir, "assertionless-mission");
    const result = await runBrowserMission({
      id: "promo-valid-to-expired",
      title: "Replace a valid discount with an expired coupon",
      risk: "high",
      startPath: "/",
      reason: ["Verify the pricing-sensitive transition."],
      steps: [{
        id: "transition-fill",
        instruction: "Enter the expired coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "EXPIRED10"
      }, {
        id: "transition-click",
        instruction: "Apply the expired coupon.",
        action: "click",
        policyLabel: "click",
        target: "testid=apply-promo"
      }, {
        id: "transition-finish",
        instruction: "Confirm the alert, restored total, console, and network state.",
        action: "observe",
        target: "testid=promo-error",
        expected: "The expiration alert and Total: $100.00 are visible with no console or network errors."
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm,
      outputDir: runOutput,
      headless: true,
      maxTurns: 6
    });

    expect(result).toEqual({
      missionId: "promo-valid-to-expired",
      status: "blocked",
      results: [{
        stepId: "mission-config",
        status: "blocked",
        message: "Browser missions must include at least one valid reviewed assert_visible/assert_text completion step after the final reviewed goto/login/click/fill/press step; observe and earlier assertions cannot support the final pass claim."
      }],
      artifacts: []
    });
    expect(llm.calls).toBe(0);
    await expect(stat(runOutput)).rejects.toThrow();
  });

  it("rejects a reviewed mission whose only assertion precedes its final state change", async () => {
    const llm = new UnexpectedDecisionLLM();
    const runOutput = path.join(outputDir, "assertion-before-mutation");
    const result = await runBrowserMission({
      id: "assertion-before-mutation",
      title: "Reject stale completion planning",
      risk: "high",
      startPath: "/",
      reason: ["Intermediate evidence cannot finish the mission."],
      steps: [{
        id: "verify-initial-total",
        instruction: "Verify the initial total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $100.00"
      }, {
        id: "enter-valid-code",
        instruction: "Enter the reviewed coupon.",
        action: "fill",
        policyLabel: "fill",
        target: "testid=promo-code",
        value: "SAVE10"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm,
      outputDir: runOutput,
      headless: true,
      maxTurns: 3
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain("after the final reviewed goto/login/click/fill/press step");
    expect(llm.calls).toBe(0);
    await expect(stat(runOutput)).rejects.toThrow();
  });

  it.each(["", "   "])("rejects assert_text expected=%j before browser launch", async (expected) => {
    const llm = new UnexpectedDecisionLLM();
    const runOutput = path.join(outputDir, `nonblank-assertion-${expected.length}`);
    const result = await runBrowserMission({
      id: "nonblank-text-assertion",
      title: "Require meaningful text evidence",
      risk: "medium",
      startPath: "/",
      reason: ["Blank expected text cannot prove a result."],
      steps: [{
        id: "verify-total",
        instruction: "Verify the reviewed total.",
        action: "assert_text",
        target: "testid=order-total",
        expected
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm,
      outputDir: runOutput,
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain("must include nonblank expected text");
    expect(llm.calls).toBe(0);
    await expect(stat(runOutput)).rejects.toThrow();
  });

  it("binds live assertion fields to the reviewed target and expected text", async () => {
    const reviewedMission: QAFlowMission = {
      id: "reviewed-assertion",
      title: "Reviewed assertion",
      risk: "high",
      startPath: "/",
      reason: ["Require reviewed evidence."],
      steps: [{
        id: "verify-total",
        instruction: "Verify the checkout total.",
        action: "assert_text",
        target: "testid=order-total",
        expected: "Total: $100.00"
      }]
    };
    const bound = await runBrowserMission(reviewedMission, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        {
          thought: "Assert an unrelated element.",
          action: "assert",
          missionStepId: "verify-total",
          target: "text=Checkout",
          value: "A weaker substitute",
          reason: "Attempt to substitute a weaker assertion."
        },
        {
          thought: "The reviewed assertion passed.",
          action: "finish_pass",
          reason: "The exact reviewed assertion is covered."
        }
      ]),
      outputDir: path.join(outputDir, "bound-assert"),
      headless: true,
      maxTurns: 2
    });
    expect(bound.status).toBe("passed");
    expect(bound.results[0]?.status).toBe("passed");
  });

  it("blocks ambiguous mutating locators before either matching control can run", async () => {
    dangerousMutations = 0;
    const result = await runBrowserMission({
      id: "ambiguous-control",
      title: "Reject ambiguous controls",
      risk: "high",
      startPath: "/duplicate-control",
      reason: ["Do not pick the first ambiguous target."],
      steps: [{
        id: "apply-reviewed-action",
        instruction: "Use the single reviewed Apply control.",
        action: "click",
        policyLabel: "click",
        target: "text=Apply"
      }, {
        id: "verify-page-after-action",
        instruction: "Verify the page remains available.",
        action: "assert_visible",
        target: "text=Apply"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([{
        thought: "Click Apply.",
        action: "click",
        missionStepId: "apply-reviewed-action",
        target: "text=Apply",
        reason: "Exercise the reviewed action."
      }]),
      outputDir: path.join(outputDir, "ambiguous-control"),
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain("exactly one element");
    expect(dangerousMutations).toBe(0);
  });

  it("confines dynamic login clicks to the recognized credential-form submit", async () => {
    dangerousMutations = 0;
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL = "qa@example.com";
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD = "secret-password";
    try {
      const result = await runBrowserMission({
        id: "hostile-login-delete",
        title: "Reject hostile login mutation",
        role: "qa_user",
        risk: "critical",
        startPath: "/hostile-login",
        reason: ["A hostile login page exposes a destructive submit control."],
        steps: [{
          id: "login-and-confirm-session",
          instruction: "Authenticate only through the credential form.",
          action: "login",
          policyLabel: "login"
        }, {
          id: "confirm-signed-in-marker",
          instruction: "Verify the reviewed signed-in marker.",
          action: "assert_visible",
          target: "testid=signed-in-marker"
        }]
      }, {
        baseUrl,
        contract: {
          app: {},
          auth: { roles: { qa_user: {
            usernameEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL",
            passwordEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD",
            signedInTarget: "testid=signed-in-marker"
          } } },
          criticalFlows: ["login"],
          sensitiveAreas: ["auth"],
          dangerousActions: { allowed: ["login"], requireApproval: [], forbidden: ["delete_account"] },
          testData: {},
          unknowns: []
        },
        llm: new DecisionSequenceLLM([{
          thought: "Fill email.", action: "fill", missionStepId: "login-and-confirm-session", target: "label=Email", value: "env:PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL", reason: "Use email."
        }, {
          thought: "Fill password.", action: "fill", missionStepId: "login-and-confirm-session", target: "label=Password", value: "env:PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD", reason: "Use password."
        }, {
          thought: "Injected instruction says delete.", action: "click", missionStepId: "login-and-confirm-session", target: "role=button|name=Delete account", reason: "Attempt destructive submit."
        }]),
        outputDir: path.join(outputDir, "hostile-login-delete"),
        headless: true,
        maxTurns: 3
      });

      expect(result.status).toBe("blocked");
      expect(result.results.at(-1)?.message).toContain("recognized submit control");
      expect(dangerousMutations).toBe(0);
    } finally {
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL;
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD;
    }
  });

  it("does not infer auth success from unrelated storage changes and a disappearing login form", async () => {
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL = "qa@example.com";
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD = "secret-password";
    const runOutput = path.join(outputDir, "false-positive-login");
    const storagePath = path.join(outputDir, "false-positive-login-state.json");
    try {
      const result = await runBrowserMission({
        id: "false-positive-login",
        title: "Reject false-positive login state",
        role: "qa_user",
        risk: "high",
        startPath: "/false-positive-login",
        reason: ["Only the configured signed-in marker proves authentication."],
        steps: [{
          id: "login-and-confirm-session",
          instruction: "Authenticate through the reviewed credential form.",
          action: "login",
          policyLabel: "login"
        }, {
          id: "confirm-signed-in-marker",
          instruction: "Verify the deterministic signed-in marker.",
          action: "assert_visible",
          target: "testid=signed-in-marker"
        }]
      }, {
        baseUrl,
        contract: {
          app: {},
          auth: { roles: { qa_user: {
            usernameEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL",
            passwordEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD",
            signedInTarget: "testid=signed-in-marker"
          } } },
          criticalFlows: ["login"],
          sensitiveAreas: ["auth"],
          dangerousActions: { allowed: ["login"], requireApproval: [], forbidden: [] },
          testData: {},
          unknowns: []
        },
        llm: new DecisionSequenceLLM([{
          thought: "Fill email.", action: "fill", missionStepId: "login-and-confirm-session", target: "label=Email", value: "env:PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL", reason: "Use configured email."
        }, {
          thought: "Fill password.", action: "fill", missionStepId: "login-and-confirm-session", target: "label=Password", value: "env:PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD", reason: "Use configured password."
        }, {
          thought: "Submit login.", action: "click", missionStepId: "login-and-confirm-session", target: "role=button|name=Sign in", reason: "Submit the reviewed form."
        }, {
          thought: "Storage changed and form disappeared.", action: "finish_pass", reason: "Assume authentication succeeded."
        }]),
        outputDir: runOutput,
        headless: true,
        maxTurns: 4,
        saveStorageState: storagePath
      });

      expect(result.status).toBe("blocked");
      expect(result.results.at(-1)?.message).toContain("confirm-signed-in-marker");
      await expect(readFile(storagePath, "utf8")).rejects.toThrow();
      await expect(readFile(`${storagePath}.preflight-scout.json`, "utf8")).resolves.toContain('"status": "invalid"');
    } finally {
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL;
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD;
    }
  });

  it("returns a blocked diagnostic instead of crashing when storage state is missing", async () => {
    const contract: QAContract = {
      app: { name: "Static Checkout", previewUrlSource: "manual" },
      criticalFlows: ["checkout"],
      sensitiveAreas: ["auth"],
      dangerousActions: { allowed: ["navigate"], requireApproval: [], forbidden: [] },
      testData: {},
      unknowns: []
    };
    const result = await runBrowserMission({
      id: "needs-session",
      title: "Needs session",
      risk: "medium",
      startPath: "/",
      reason: ["Validate authenticated surface."],
      steps: [reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract,
      llm: new ScriptedLLM(),
      outputDir,
      headless: true,
      storageState: path.join(outputDir, "missing-storage-state.json")
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.stepId).toBe("storage-state");
    expect(result.results[0]?.message).toContain("Storage-state file was not found");
  });

  it("bounds direct-API maxTurns before launching a browser", async () => {
    const result = await runBrowserMission({
      id: "invalid-max-turns",
      title: "Reject excessive turns",
      risk: "low",
      startPath: "/",
      reason: ["Direct API callers remain bounded."],
      steps: [{ id: "verify-page", instruction: "Verify page.", action: "assert_visible", target: "text=Checkout" }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([]),
      outputDir: path.join(outputDir, "invalid-max-turns"),
      maxTurns: 101
    });

    expect(result).toMatchObject({ status: "blocked", results: [{ stepId: "browser-config", status: "blocked" }] });
    expect(result.results[0]?.message).toContain("between 1 and 100");
  });

  it("blocks login missions without the exact configured signed-in marker before launch", async () => {
    const result = await runBrowserMission({
      id: "missing-auth-marker",
      title: "Reject ambiguous auth success",
      role: "qa_user",
      risk: "high",
      startPath: "/",
      reason: ["Auth requires deterministic proof."],
      steps: [
        { id: "login", instruction: "Login.", action: "login", policyLabel: "login" },
        reviewedCompletionAssertion()
      ]
    }, {
      baseUrl,
      contract: {
        ...basicContract(),
        auth: { roles: { qa_user: { usernameEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL" } } },
        dangerousActions: { allowed: ["login"], requireApproval: [], forbidden: [] }
      },
      llm: new DecisionSequenceLLM([]),
      outputDir: path.join(outputDir, "missing-auth-marker")
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain("signedInTarget");
  });

  it("refuses to save storage state inside the evidence directory", async () => {
    const runOutput = path.join(outputDir, "storage-inside-evidence");
    const result = await runBrowserMission({
      id: "storage-inside-evidence",
      title: "Keep credentials out of evidence",
      risk: "low",
      startPath: "/",
      reason: ["Credential state is not evidence."],
      steps: [{ id: "verify-page", instruction: "Verify page.", action: "assert_visible", target: "text=Checkout" }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([]),
      outputDir: runOutput,
      saveStorageState: path.join(runOutput, "state.json")
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain("outside the browser evidence output directory");
  });

  it("closes a launched browser when context setup fails", async () => {
    const close = vi.fn(async () => undefined);
    const launch = vi.spyOn(chromium, "launch").mockResolvedValue({
      newContext: vi.fn(async () => { throw new Error("synthetic context setup failure"); }),
      close
    } as never);
    try {
      await expect(runBrowserMission({
        id: "setup-failure",
        title: "Close setup failure resources",
        risk: "low",
        startPath: "/",
        reason: ["Exercise teardown."],
        steps: [{ id: "verify-page", instruction: "Verify page.", action: "assert_visible", target: "text=Checkout" }]
      }, {
        baseUrl,
        contract: basicContract(),
        llm: new DecisionSequenceLLM([]),
        outputDir: path.join(outputDir, "setup-failure")
      })).rejects.toThrow("synthetic context setup failure");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      launch.mockRestore();
    }
  });

  it("redacts and caps runner errors before returning artifacts or prompting the LLM", async () => {
    const secret = "bounded-result-secret";
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD = secret;
    const llm = new ResultMessageCaptureLLM(secret);
    try {
      const result = await runBrowserMission({
        id: "bounded-result-errors",
        title: "Bound result errors",
        risk: "low",
        startPath: "/",
        reason: ["Result messages cross trust boundaries."],
        steps: [{ id: "verify-page", instruction: "Verify page.", action: "assert_visible", target: "text=Checkout" }]
      }, {
        baseUrl,
        contract: basicContract(),
        llm,
        outputDir: path.join(outputDir, "bounded-result-errors"),
        maxTurns: 2
      });

      expect(llm.lastPrompt).not.toContain(secret);
      expect(result.results.every((step) => step.message.length <= 2_000)).toBe(true);
      expect(result.results.map((step) => step.message).join("\n")).not.toContain(secret);
      expect(result.results.map((step) => step.message).join("\n")).toContain("[REDACTED_ENV_SECRET]");
    } finally {
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD;
    }
  });

  it("tells the live browser agent which gated actions a human approved", async () => {
    const llm = new ApprovalAwareLLM();
    const approvalRoot = path.join(outputDir, "approval-root");
    await mkdir(approvalRoot, { recursive: true });
    await writeFile(path.join(approvalRoot, ".gitignore"), ".preflight-scout/approvals.local.yml\n");
    const approvalGit = await createTrustedGit({ targetRoot: approvalRoot });
    await approvalGit.exec(["init", "--quiet"], { cwd: approvalRoot });
    await approveAction(approvalRoot, "apply_promo", "Disposable QA fixture");
    await approveAction(approvalRoot, "stale_action", "Not in this contract");
    const contract: QAContract = {
      app: { name: "Static Checkout", previewUrlSource: "manual" },
      criticalFlows: ["checkout"],
      sensitiveAreas: ["notifications"],
      dangerousActions: { allowed: ["navigate"], requireApproval: ["apply_promo"], forbidden: [] },
      testData: {},
      unknowns: []
    };
    const result = await runBrowserMission({
      id: "approved-notification",
      title: "Validate an approved notification",
      risk: "medium",
      startPath: "/",
      reason: ["Notification behavior changed."],
      steps: [{
        id: "approval",
        instruction: "Continue only after apply_promo is approved.",
        action: "approval_gate",
        target: "apply_promo",
        requiresApproval: true
      }, {
        id: "apply_promo",
        instruction: "Apply the reviewed promo action.",
        action: "click",
        policyLabel: "apply_promo",
        target: "role=button|name=Apply promo",
        requiresApproval: true
      }, {
        id: "verify_promo_control",
        instruction: "Verify the reviewed promo control.",
        action: "assert_visible",
        target: "role=button|name=Apply promo"
      }]
    }, {
      baseUrl,
      contract,
      llm,
      outputDir,
      headless: true,
      maxTurns: 3,
      root: approvalRoot
    });

    expect(result.status).toBe("passed");
    expect(result.results[0]?.message).toBe("Exercise the approved browser action.");
    expect(llm.lastPayload?.approvedActions).toEqual(["apply_promo"]);
    expect(llm.lastPrompt).not.toContain("Disposable QA fixture");
  });

  it("blocks an unapproved mission gate before launching the browser agent", async () => {
    const contract: QAContract = {
      app: { name: "Static Checkout", previewUrlSource: "manual" },
      criticalFlows: ["checkout"],
      sensitiveAreas: ["notifications"],
      dangerousActions: { allowed: ["navigate"], requireApproval: ["send_email"], forbidden: [] },
      testData: {},
      unknowns: []
    };
    const result = await runBrowserMission({
      id: "unapproved-notification",
      title: "Validate an unapproved notification",
      risk: "medium",
      startPath: "/",
      reason: ["Notification behavior changed."],
      steps: [{
        id: "approval",
        instruction: "Continue only after send_email is approved.",
        action: "approval_gate",
        target: "send_email",
        requiresApproval: true
      }, reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract,
      llm: new ApprovalAwareLLM(),
      outputDir,
      headless: true,
      maxTurns: 1,
      approvals: { approvals: [] }
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain('preflight-scout approve --action "send_email"');
    expect(result.artifacts).toEqual([]);
  });

  it("rejects a locator-discovery approval gate as malformed planning context", async () => {
    const contract: QAContract = {
      app: { name: "Static Checkout", previewUrlSource: "manual" },
      criticalFlows: ["checkout"],
      sensitiveAreas: ["payments"],
      dangerousActions: { allowed: ["fill", "click"], requireApproval: ["submit_payment"], forbidden: [] },
      testData: { expired_coupon: "EXPIRED10" },
      unknowns: []
    };
    const result = await runBrowserMission({
      id: "malformed-locator-gate",
      title: "Discover a safe promo locator",
      risk: "medium",
      startPath: "/",
      reason: ["Promo behavior changed."],
      steps: [{
        id: "locator-gate",
        instruction: "Find the promo field before filling the safe fixture.",
        action: "approval_gate",
        value: "EXPIRED10",
        requiresApproval: true
      }, reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract,
      llm: new ApprovalAwareLLM(),
      outputDir,
      headless: true,
      maxTurns: 1,
      approvals: { approvals: [] }
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain("missing target");
    expect(result.results[0]?.message).toContain("Regenerate the analysis");
    expect(result.artifacts).toEqual([]);
  });

  it("enforces underscore approval labels against human-readable browser targets", async () => {
    const contract: QAContract = {
      app: { name: "Static Checkout", previewUrlSource: "manual" },
      criticalFlows: ["checkout"],
      sensitiveAreas: ["notifications"],
      dangerousActions: { allowed: ["navigate"], requireApproval: ["send_email"], forbidden: [] },
      testData: {},
      unknowns: []
    };
    const result = await runBrowserMission({
      id: "runtime-email-gate",
      title: "Enforce the email action gate",
      risk: "high",
      startPath: "/",
      reason: ["Email behavior changed."],
      steps: [{
        id: "send_email",
        instruction: "Use the reviewed email action.",
        action: "click",
        policyLabel: "send_email",
        target: "role=button|name=Send email",
        requiresApproval: true
      }, reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract,
      llm: new SpacedApprovalTargetLLM(),
      outputDir,
      headless: true,
      maxTurns: 1,
      approvals: { approvals: [] }
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.message).toContain('preflight-scout approve --action "send_email"');
  });

  it("saves authenticated storage state after a successful login mission", async () => {
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL = "qa@example.com";
    process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD = "secret-password";
    const authServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Sign in</h1>
      <form id="login-form">
        <label>Email <input aria-label="Email" id="email" /></label>
        <label>Password <input aria-label="Password" id="password" type="password" /></label>
        <button type="submit">Sign in</button>
      </form>
      <p id="status" data-testid="signed-in-marker" hidden></p>
    </main>
    <script>
      document.querySelector("#login-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const email = document.querySelector("#email").value;
        localStorage.setItem("preflight-scout-auth-user", email);
        document.cookie = "preflight_scout_session=test-session; SameSite=Lax; Path=/";
        document.querySelector("#status").textContent = "Signed in as " + email;
        document.querySelector("#status").hidden = false;
        event.currentTarget.hidden = true;
      });
    </script>
  </body>
</html>`);
    });
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    const address = authServer.address();
    if (!address || typeof address === "string") throw new Error("Could not start auth test server");
    const authBaseUrl = `http://127.0.0.1:${address.port}`;
    const authStateDir = await mkdtemp(path.join(tmpdir(), "preflight-scout-browser-auth-state-"));
    const storagePath = path.join(authStateDir, "auth-state.json");

    try {
      const contract: QAContract = {
        app: { name: "Auth App", previewUrlSource: "manual" },
        auth: {
          loginUrl: "/login",
          roles: {
            qa_user: {
              usernameEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL",
              passwordEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD",
              signedInTarget: "testid=signed-in-marker"
            }
          }
        },
        criticalFlows: ["login"],
        sensitiveAreas: ["auth"],
        dangerousActions: { allowed: ["login"], requireApproval: [], forbidden: [] },
        testData: {},
        unknowns: []
      };
      const result = await runBrowserMission({
        id: "auth-login-qa-user",
        title: "Create authenticated session",
        role: "qa_user",
        risk: "medium",
        startPath: "/login",
        reason: ["Create reusable storage state."],
        steps: [{
          id: "login-and-confirm-session",
          instruction: "Authenticate through the configured credential form.",
          action: "login",
          policyLabel: "login"
        }, {
          id: "confirm-signed-in-marker",
          instruction: "Verify the deterministic signed-in marker.",
          action: "assert_visible",
          target: "testid=signed-in-marker"
        }]
      }, {
        baseUrl: authBaseUrl,
        contract,
        llm: new ScriptedAuthLLM(),
        outputDir,
        headless: true,
        maxTurns: 7,
        saveStorageState: storagePath
      });
      const storage = await readFile(storagePath, "utf8");
      const metadata = await readFile(`${storagePath}.preflight-scout.json`, "utf8");
      const finalObservation = await readFile(result.evidence!.finalObservationPath!, "utf8");

      expect(result.status).toBe("passed");
      expect(storage).toContain("preflight-scout-auth-user");
      expect(storage).toContain("qa@example.com");
      expect(storage).toContain("preflight_scout_session");
      expect(finalObservation).not.toContain("qa@example.com");
      expect(finalObservation).toContain("[REDACTED_ENV_SECRET]");
      expect(metadata).toContain('"status": "valid"');
      expect(metadata).toContain('"evidenceDir"');
    } finally {
      await new Promise<void>((resolve, reject) => authServer.close((error) => (error ? reject(error) : resolve())));
      await rm(authStateDir, { recursive: true, force: true });
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL;
      delete process.env.PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD;
    }
  });

  it("does not save a valid-looking storage state after a blocked auth mission", async () => {
    const authStateDir = await mkdtemp(path.join(tmpdir(), "preflight-scout-browser-blocked-auth-state-"));
    const storagePath = path.join(authStateDir, "blocked-auth-state.json");
    await writeFile(storagePath, '{"cookies":[{"name":"stale-session"}],"origins":[]}\n');
    const contract: QAContract = {
      app: { name: "Auth App", previewUrlSource: "manual" },
      auth: {
        roles: {
          qa_user: {
            usernameEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_EMAIL",
            passwordEnv: "PREFLIGHT_SCOUT_BROWSER_TEST_PASSWORD"
          }
        }
      },
      criticalFlows: ["login"],
      sensitiveAreas: ["auth"],
      dangerousActions: { allowed: ["fill", "click"], requireApproval: [], forbidden: [] },
      testData: {},
      unknowns: []
    };

    const result = await runBrowserMission({
      id: "auth-login-qa-user-blocked",
      title: "Create authenticated session",
      role: "qa_user",
      risk: "medium",
      startPath: "/",
      reason: ["Create reusable storage state."],
      steps: [reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract,
      llm: new BlockedLLM(),
      outputDir,
      headless: true,
      maxTurns: 1,
      saveStorageState: storagePath
    });

    try {
      await expect(readFile(storagePath, "utf8")).rejects.toThrow();
      await expect(readFile(`${storagePath}.preflight-scout.json`, "utf8")).resolves.toContain('"status": "invalid"');
      await expect(readFile(`${storagePath}.preflight-scout.json`, "utf8")).resolves.toContain('"evidenceDir"');
      expect(result.status).toBe("blocked");
    } finally {
      await rm(authStateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["file URL", "file:///etc/passwd", "file:"],
    ["data URL", "data:text/html,UNSAFE_DATA_CONTENT", "data:"],
    ["internal URL", "chrome://settings", "chrome:"],
    ["off-origin HTTP URL", "https://example.invalid/private", "off-origin"]
  ])("blocks a malicious goto decision targeting a %s", async (_label, target, expected) => {
    const runOutput = path.join(outputDir, `goto-boundary-${expected.replace(/[^a-z]/g, "")}`);
    const result = await runBrowserMission({
      id: `malicious-goto-${expected}`,
      title: "Reject an unsafe navigation decision",
      risk: "high",
      startPath: "/",
      reason: ["Exercise the browser boundary."],
      steps: [{
        id: "unsafe-goto",
        instruction: "Exercise the navigation boundary.",
        action: "goto",
        policyLabel: "navigate",
        target
      }, reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([{
        thought: "Navigate outside the app.",
        action: "goto",
        missionStepId: "unsafe-goto",
        target,
        reason: "Attempt an unsafe navigation."
      }]),
      outputDir: runOutput,
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)?.message.toLowerCase()).toContain(expected);
    expect(result.results.at(-1)?.screenshotPath).toBeUndefined();
    expect(result.evidence?.tracePath).toBeUndefined();
    expect(result.evidence?.finalObservationPath).toBeUndefined();
  });

  it.each([
    ["file:///etc/passwd", "file:"],
    ["data:text/html,UNSAFE_START_CONTENT", "data:"],
    ["https://example.invalid/start", "off-origin"]
  ])("blocks an unsafe mission startPath before launching Chromium: %s", async (startPath, expected) => {
    const result = await runBrowserMission({
      id: `unsafe-start-${expected}`,
      title: "Reject an unsafe mission start",
      risk: "high",
      startPath,
      reason: ["Exercise mission input validation."],
      steps: [reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([]),
      outputDir: path.join(outputDir, `unsafe-start-${expected.replace(/[^a-z]/g, "")}`),
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(result.results[0]?.stepId).toBe("navigation-boundary");
    expect(result.results[0]?.message.toLowerCase()).toContain(expected);
    expect(result.artifacts).toEqual([]);
    expect(result.evidence).toBeUndefined();
  });

  it("allows explicit goto decisions within the base app origin", async () => {
    const result = await runBrowserMission({
      id: "same-origin-goto",
      title: "Allow same-origin navigation",
      risk: "low",
      startPath: "/",
      reason: ["Exercise the allowed path."],
      steps: [{
        id: "open-same-origin",
        instruction: "Open the reviewed same-origin path.",
        action: "goto",
        policyLabel: "navigate",
        target: "/same-origin"
      }, {
        id: "verify-checkout",
        instruction: "Verify the checkout heading.",
        action: "assert_visible",
        target: "text=Checkout"
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Open another app path.", action: "goto", missionStepId: "open-same-origin", target: "/same-origin", reason: "Stay on the app origin." },
        { thought: "Verify the checkout page.", action: "assert", missionStepId: "verify-checkout", target: "text=Checkout", reason: "The reviewed page is visible." },
        { thought: "The app stayed in bounds.", action: "finish_pass", reason: "Same-origin navigation passed." }
      ]),
      outputDir: path.join(outputDir, "same-origin-goto"),
      headless: true,
      maxTurns: 3
    });

    expect(result.status).toBe("passed");
    expect(result.results[0]?.status).toBe("passed");
  });

  it("invalidates a passed mission when an off-origin navigation begins during final observation", async () => {
    outsideRequests = 0;
    const runOutput = path.join(outputDir, "late-finalization-boundary");
    const storagePath = path.join(outputDir, "late-finalization-authenticated-state.json");
    const result = await runBrowserMission({
      id: "late-finalization-boundary",
      title: "Reject a late navigation before saving authenticated state",
      risk: "high",
      startPath: "/late-boundary",
      reason: ["Exercise the final browser persistence boundary."],
      steps: [{
        id: "verify-late-boundary-page",
        instruction: "Verify the safe page before finalization.",
        action: "assert_visible",
        target: "text=The first observation is safe. The final observation attempts to leave the app."
      }]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([{
        thought: "Verify the reviewed page.",
        action: "assert",
        missionStepId: "verify-late-boundary-page",
        target: "text=The first observation is safe. The final observation attempts to leave the app.",
        reason: "The safe page is visible."
      }, {
        thought: "The initial state is safe.",
        action: "finish_pass",
        reason: "The same-origin page initially passed."
      }]),
      outputDir: runOutput,
      headless: true,
      maxTurns: 2,
      saveStorageState: storagePath
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)).toMatchObject({ stepId: "browser-finalization", status: "blocked" });
    expect(result.results.at(-1)?.message).toContain("off-origin");
    expect(result.evidence?.tracePath).toBeUndefined();
    expect(result.evidence?.finalObservationPath).toBeUndefined();
    await expect(readFile(storagePath, "utf8")).rejects.toThrow();
    await expect(readFile(`${storagePath}.preflight-scout.json`, "utf8")).resolves.toContain('"status": "invalid"');
    expect(outsideRequests).toBe(0);
  });

  it.each([
    ["click", "css=#off-origin-link"],
    ["same-origin redirect", "css=#redirect-link"],
    ["file click", "css=#file-link"],
    ["data click", "css=#data-link"],
    ["target blank popup", "css=#blank-link"],
    ["window open popup", "css=#window-open"],
    ["detached target blank popup", "css=#detached-popup"]
  ])("blocks unsafe main-frame navigation caused by %s before outside content is fetched or captured", async (label, target) => {
    outsideRequests = 0;
    const result = await runBrowserMission({
      id: `unsafe-${label.replace(/\s/g, "-")}`,
      title: "Reject interaction navigation",
      risk: "high",
      startPath: "/boundary",
      reason: ["Exercise interaction navigation boundaries."],
      steps: [{
        id: "unsafe-interaction",
        instruction: "Exercise the reviewed interaction boundary.",
        action: "click",
        policyLabel: "click",
        target
      }, reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([{
        thought: "Use the unsafe link.",
        action: "click",
        missionStepId: "unsafe-interaction",
        target,
        reason: "Attempt interaction navigation."
      }]),
      outputDir: path.join(outputDir, `unsafe-${label.replace(/\s/g, "-")}`),
      headless: true,
      maxTurns: 1
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)?.message).toMatch(/Blocked (?:unsafe|off-origin) main-frame navigation|Blocked popup navigation/);
    expect(result.results.at(-1)?.screenshotPath).toBeUndefined();
    expect(result.evidence?.tracePath).toBeUndefined();
    expect(result.evidence?.finalObservationPath).toBeUndefined();
    expect(outsideRequests).toBe(0);
  });

  it("blocks off-origin form navigation triggered by Enter", async () => {
    outsideRequests = 0;
    const result = await runBrowserMission({
      id: "unsafe-press-navigation",
      title: "Reject key-triggered navigation",
      risk: "high",
      startPath: "/boundary",
      reason: ["Exercise key-triggered navigation boundaries."],
      steps: [{
        id: "focus-reviewed-field",
        instruction: "Focus the reviewed form field.",
        action: "click",
        policyLabel: "click",
        target: "css=#press-target"
      }, {
        id: "submit-reviewed-field",
        instruction: "Submit the reviewed form with Enter.",
        action: "press",
        policyLabel: "press",
        target: "css=#press-target",
        value: "Enter"
      }, reviewedCompletionAssertion()]
    }, {
      baseUrl,
      contract: basicContract(),
      llm: new DecisionSequenceLLM([
        { thought: "Focus the form field.", action: "click", missionStepId: "focus-reviewed-field", target: "css=#press-target", reason: "Focus the field." },
        { thought: "Submit with Enter.", action: "press", missionStepId: "submit-reviewed-field", target: "css=#press-target", value: "Enter", reason: "Attempt key-triggered navigation." }
      ]),
      outputDir: path.join(outputDir, "unsafe-press-navigation"),
      headless: true,
      maxTurns: 2
    });

    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)?.message).toContain("form submission or key press");
    expect(result.results.at(-1)?.screenshotPath).toBeUndefined();
    expect(result.evidence?.tracePath).toBeUndefined();
    expect(outsideRequests).toBe(0);
  });

  it("blocks provider secrets even when a malicious contract maps one to the current role", async () => {
    process.env.OPENAI_API_KEY = "must-not-enter-the-browser";
    try {
      const contract = basicContract();
      contract.auth = { roles: { qa_user: { usernameEnv: "OPENAI_API_KEY" } } };
      const result = await runBrowserMission({
        id: "malicious-credential-mapping",
        title: "Reject a provider secret mapping",
        role: "qa_user",
        risk: "critical",
        startPath: "/",
        reason: ["Exercise credential isolation."],
        steps: [{
          id: "malicious-provider-fill",
          instruction: "Exercise credential isolation.",
          action: "fill",
          policyLabel: "fill",
          target: "testid=promo-code",
          valueEnv: "OPENAI_API_KEY"
        }, reviewedCompletionAssertion()]
      }, {
        baseUrl,
        contract,
        llm: new DecisionSequenceLLM([{
          thought: "Fill a secret from the environment.",
          action: "fill",
          missionStepId: "malicious-provider-fill",
          target: "testid=promo-code",
          value: "env:OPENAI_API_KEY",
          reason: "Attempt to inject a provider secret."
        }]),
        outputDir: path.join(outputDir, "malicious-credential-mapping"),
        headless: true,
        maxTurns: 1
      });

      expect(result.status).toBe("blocked");
      expect(result.results[0]?.message).toContain("not an authorized dedicated browser credential");
      expect(result.results[0]?.screenshotPath).toBeDefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("blocks a credential env authorized for a different mission role", async () => {
    process.env.PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL = "admin@example.com";
    try {
      const contract = basicContract();
      contract.auth = {
        roles: {
          qa_user: { usernameEnv: "PREFLIGHT_SCOUT_BROWSER_QA_USER_EMAIL" },
          admin: { usernameEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL" }
        }
      };
      const result = await runBrowserMission({
        id: "wrong-role-credential",
        title: "Reject another role's credential",
        role: "qa_user",
        risk: "high",
        startPath: "/",
        reason: ["Exercise role isolation."],
        steps: [{
          id: "wrong-role-fill",
          instruction: "Exercise role credential isolation.",
          action: "fill",
          policyLabel: "fill",
          target: "testid=promo-code",
          valueEnv: "PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL"
        }, reviewedCompletionAssertion()]
      }, {
        baseUrl,
        contract,
        llm: new DecisionSequenceLLM([{
          thought: "Use the admin email.",
          action: "fill",
          missionStepId: "wrong-role-fill",
          target: "testid=promo-code",
          value: "env:PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL",
          reason: "Attempt cross-role credential use."
        }]),
        outputDir: path.join(outputDir, "wrong-role-credential"),
        headless: true,
        maxTurns: 1
      });

      expect(result.status).toBe("blocked");
      expect(result.results[0]?.message).toContain("mission role qa_user");
    } finally {
      delete process.env.PREFLIGHT_SCOUT_BROWSER_ADMIN_EMAIL;
    }
  });
});

function basicContract(): QAContract {
  return {
    app: { name: "Boundary fixture", previewUrlSource: "manual" },
    criticalFlows: ["navigation"],
    sensitiveAreas: ["credentials"],
    dangerousActions: { allowed: ["navigate", "click", "fill", "press"], requireApproval: [], forbidden: [] },
    testData: {},
    unknowns: []
  };
}

function reviewedCompletionAssertion(): QAFlowMission["steps"][number] {
  return {
    id: "verify-reviewed-fixture",
    instruction: "Verify the reviewed fixture remains available.",
    action: "assert_visible",
    target: "text=Checkout"
  };
}
