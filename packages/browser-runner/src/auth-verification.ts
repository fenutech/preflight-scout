import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { redactText } from "@preflight-scout/core";
import { BrowserNavigationBoundary } from "./navigation.js";
import { loadStorageStateInput } from "./storage-state.js";

export interface StoredAuthenticationVerificationOptions {
  baseUrl: string;
  startPath: string;
  signedInTarget: string;
  storageState: string;
  headless?: boolean;
}

export async function verifyStoredAuthentication(
  options: StoredAuthenticationVerificationOptions
): Promise<string | undefined> {
  const loaded = await loadStorageStateInput(options.storageState);
  if (loaded.problem) return loaded.problem;
  if (!loaded.state) return "Authenticated storage state could not be loaded safely.";

  let navigation: BrowserNavigationBoundary;
  try {
    navigation = new BrowserNavigationBoundary(options.baseUrl);
  } catch (error) {
    return boundedProblem(`Authenticated state verification rejected the app URL. ${(error as Error).message}`);
  }
  const startUrl = navigation.resolve(options.startPath, "reviewed auth verification startPath");
  if (!startUrl) return boundedProblem(navigation.violation?.message ?? "Authenticated state verification startPath was rejected.");

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: options.headless ?? true });
    context = await browser.newContext({ storageState: loaded.state as never, serviceWorkers: "block" });
    await navigation.install(context);
    const page = await context.newPage();
    await navigation.attach(page);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    if (navigation.checkPage(page, "authenticated state verification")) {
      return boundedProblem(navigation.violation!.message);
    }
    const locator = locatorFor(page, options.signedInTarget);
    await locator.first().waitFor({ state: "attached", timeout: 8_000 });
    const count = await locator.count();
    if (count !== 1) {
      return `Authenticated state verification expected exactly one reviewed signed-in marker, but matched ${count}.`;
    }
    if (!await locator.isVisible()) {
      return "Authenticated state verification found the reviewed signed-in marker, but it was not visible.";
    }
    return undefined;
  } catch (error) {
    return boundedProblem(`Authenticated state verification failed: ${(error as Error).message}`);
  } finally {
    await Promise.allSettled([context?.close(), browser?.close()]);
  }
}

function locatorFor(page: Page, target: string): Locator {
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
  throw new Error(`Signed-in marker must use explicit prefix css=, text=, label=, testid=, or role=: ${target}`);
}

function boundedProblem(message: string): string {
  return redactText(message).slice(0, 2_000);
}
