import type { BrowserContext, CDPSession, Page } from "playwright";

const BOUNDARY_BINDING = "__preflightScoutReportBlockedMainFrameNavigation";

export interface NavigationViolation {
  message: string;
}

/**
 * Browser missions are intentionally confined to the HTTP(S) origin selected by
 * the caller. The QA contract currently has no trusted representation for SSO
 * origins, so cross-origin navigation stays fail-closed.
 */
export class BrowserNavigationBoundary {
  readonly baseUrl: string;
  readonly allowedOrigin: string;
  private currentViolation?: NavigationViolation;
  private mainPage?: Page;

  constructor(baseUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("The base app URL must be an absolute HTTP(S) URL.");
    }
    if (!isHttpProtocol(parsed.protocol)) {
      throw new Error("The base app URL must use http: or https:.");
    }
    if (parsed.username || parsed.password) {
      throw new Error("The base app URL must not contain embedded credentials.");
    }
    this.baseUrl = parsed.toString();
    this.allowedOrigin = parsed.origin;
  }

  get violation(): NavigationViolation | undefined {
    return this.currentViolation;
  }

  resolve(target: string, source: string): string | undefined {
    let parsed: URL;
    try {
      parsed = new URL(target, normalizeBaseUrl(this.baseUrl));
    } catch {
      this.block(`Blocked invalid main-frame navigation during ${source}. Browser missions may only navigate within ${this.allowedOrigin}.`);
      return undefined;
    }
    const problem = this.problemFor(parsed, source);
    if (problem) {
      this.block(problem);
      return undefined;
    }
    return parsed.toString();
  }

  checkPage(page: Page, source: string): NavigationViolation | undefined {
    if (this.currentViolation) return this.currentViolation;
    const current = page.url();
    if (current === "about:blank") return undefined;
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      this.block(`Blocked invalid main-frame navigation during ${source}. Browser missions may only navigate within ${this.allowedOrigin}.`);
      return this.currentViolation;
    }
    const problem = this.problemFor(parsed, source);
    if (problem) this.block(problem);
    return this.currentViolation;
  }

  async install(context: BrowserContext): Promise<void> {
    context.on("page", (candidate) => {
      if (!this.mainPage || candidate === this.mainPage) return;
      this.block("Blocked popup navigation. Browser missions are confined to one guarded main frame; open the destination in the current tab or review the popup manually.");
      void candidate.close({ runBeforeUnload: false }).catch(() => {
        // The boundary remains violated even if Chromium already closed it.
      });
    });

    await context.exposeBinding(BOUNDARY_BINDING, (_source, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const candidate = payload as { target?: unknown; source?: unknown; popup?: unknown };
      if (typeof candidate.target !== "string" || candidate.target.length > 8192) return;
      const source = typeof candidate.source === "string" && candidate.source.length <= 80
        ? candidate.source
        : "page interaction";
      if (candidate.popup === true) {
        this.block("Blocked popup navigation. Browser missions are confined to one guarded main frame; open the destination in the current tab or review the popup manually.");
        return;
      }
      this.inspectAndBlock(candidate.target, source);
    });

    await context.addInitScript(({ allowedOrigin, bindingName }) => {
      const report = (payload: unknown): void => {
        const binding = (globalThis as unknown as Record<string, unknown>)[bindingName];
        if (typeof binding === "function") void (binding as (value: unknown) => Promise<void>)(payload);
      };
      const blockedTarget = (rawTarget: string, source: string): boolean => {
        let target: URL;
        try {
          target = new URL(rawTarget, window.location.href);
        } catch {
          report({ target: rawTarget, source });
          return true;
        }
        if ((target.protocol !== "http:" && target.protocol !== "https:") || target.origin !== allowedOrigin) {
          report({ target: target.toString(), source });
          return true;
        }
        return false;
      };
      const blockEvent = (event: Event): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement)) return;
        if (opensNewBrowsingContext(anchor.target)) {
          blockEvent(event);
          report({ target: anchor.href, source: "link popup", popup: true });
          return;
        }
        if (blockedTarget(anchor.href, "click")) blockEvent(event);
      }, true);

      document.addEventListener("submit", (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const submitter = event.submitter;
        const target = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
          ? submitter.formAction || form.action
          : form.action;
        const targetFrame = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement
          ? submitter.formTarget || form.target
          : form.target;
        if (opensNewBrowsingContext(targetFrame)) {
          blockEvent(event);
          report({ target, source: "form popup", popup: true });
          return;
        }
        if (blockedTarget(target, "form submission or key press")) blockEvent(event);
      }, true);

      const blockedWindowOpen = (): null => {
        report({ target: "about:blank", source: "window.open", popup: true });
        return null;
      };
      Object.defineProperty(window, "open", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: blockedWindowOpen
      });

      const nativeAnchorClick = HTMLAnchorElement.prototype.click;
      Object.defineProperty(HTMLAnchorElement.prototype, "click", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: function guardedAnchorClick(this: HTMLAnchorElement): void {
          if (opensNewBrowsingContext(this.target)) {
            report({ target: this.href, source: "programmatic link popup", popup: true });
            return;
          }
          if (blockedTarget(this.href, "programmatic click")) return;
          nativeAnchorClick.call(this);
        }
      });

      const nativeFormSubmit = HTMLFormElement.prototype.submit;
      Object.defineProperty(HTMLFormElement.prototype, "submit", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: function guardedFormSubmit(this: HTMLFormElement): void {
          if (opensNewBrowsingContext(this.target)) {
            report({ target: this.action, source: "programmatic form popup", popup: true });
            return;
          }
          if (blockedTarget(this.action, "programmatic form submission")) return;
          nativeFormSubmit.call(this);
        }
      });

      function opensNewBrowsingContext(target: string): boolean {
        const normalized = target.trim().toLowerCase();
        return Boolean(normalized) && !["_self", "_top", "_parent"].includes(normalized);
      }
    }, { allowedOrigin: this.allowedOrigin, bindingName: BOUNDARY_BINDING });

  }

  async attach(page: Page): Promise<void> {
    this.mainPage = page;
    page.on("popup", (popup) => {
      this.block("Blocked popup navigation. Browser missions are confined to one guarded main frame; open the destination in the current tab or review the popup manually.");
      void popup.close({ runBeforeUnload: false }).catch(() => {
        // The boundary remains violated even if Chromium already closed it.
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url !== "about:blank") this.inspectAndBlock(url, "main-frame navigation");
    });

    // Playwright routing does not re-intercept every hop in a redirect chain.
    // Chromium Fetch interception does, so an off-origin Location target is
    // failed before the browser sends that redirected request.
    const session = await page.context().newCDPSession(page);
    await session.send("Page.enable");
    const frameTree = await session.send("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
    const mainFrameId = frameTree.frameTree.frame.id;
    session.on("Page.frameRequestedNavigation", (event: FrameRequestedNavigation) => {
      if (event.frameId !== mainFrameId || !this.inspectAndBlock(event.url, "requested navigation")) return;
      void session.send("Page.stopLoading").catch(() => {
        // The Fetch request guard or frame-navigation fallback will keep the
        // boundary violated even if the page already stopped on its own.
      });
    });
    session.on("Fetch.requestPaused", (event: FetchRequestPaused) => {
      void this.handlePausedRequest(session, event, mainFrameId);
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }]
    });
  }

  private async handlePausedRequest(session: CDPSession, event: FetchRequestPaused, mainFrameId: string): Promise<void> {
    try {
      if (event.frameId === mainFrameId && this.inspectAndBlock(event.request.url, "request or redirect")) {
        await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
        return;
      }
      await session.send("Fetch.continueRequest", { requestId: event.requestId });
    } catch (error) {
      this.block(`Blocked main-frame navigation because the browser navigation guard failed closed: ${(error as Error).message}`);
      try {
        await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      } catch {
        // The page or request may already have closed. The boundary remains
        // violated, so no post-navigation evidence will be retained.
      }
    }
  }

  private inspectAndBlock(target: string, source: string): boolean {
    if (this.currentViolation) return true;
    let parsed: URL;
    try {
      parsed = new URL(target, normalizeBaseUrl(this.baseUrl));
    } catch {
      this.block(`Blocked invalid main-frame navigation during ${source}. Browser missions may only navigate within ${this.allowedOrigin}.`);
      return true;
    }
    const problem = this.problemFor(parsed, source);
    if (!problem) return false;
    this.block(problem);
    return true;
  }

  private problemFor(target: URL, source: string): string | undefined {
    if (!isHttpProtocol(target.protocol)) {
      return `Blocked unsafe main-frame navigation during ${source}: ${target.protocol || "non-HTTP"} URLs are not allowed. Browser missions may only navigate within ${this.allowedOrigin}.`;
    }
    if (target.username || target.password) {
      return `Blocked unsafe main-frame navigation during ${source}: URLs with embedded credentials are not allowed.`;
    }
    if (target.origin !== this.allowedOrigin) {
      return `Blocked off-origin main-frame navigation during ${source}. Browser missions are restricted to ${this.allowedOrigin}; cross-origin and SSO navigation require manual review because this QA contract has no trusted SSO-origin allowlist.`;
    }
    return undefined;
  }

  private block(message: string): void {
    this.currentViolation ??= { message };
  }
}

interface FetchRequestPaused {
  requestId: string;
  frameId?: string;
  request: { url: string };
}

interface FrameRequestedNavigation {
  frameId: string;
  url: string;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
