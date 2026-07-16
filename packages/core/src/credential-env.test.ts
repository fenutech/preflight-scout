import { describe, expect, it } from "vitest";
import { browserCredentialEnvName, browserCredentialKindForEnvName } from "./credential-env.js";

describe("browser credential environment names", () => {
  it("accepts only the dedicated browser namespace and expected credential kind", () => {
    expect(browserCredentialEnvName("PREFLIGHT_SCOUT_BROWSER_QA_USER_EMAIL", "username")).toBe("PREFLIGHT_SCOUT_BROWSER_QA_USER_EMAIL");
    expect(browserCredentialEnvName("PREFLIGHT_SCOUT_BROWSER_QA_USER_USERNAME", "username")).toBe("PREFLIGHT_SCOUT_BROWSER_QA_USER_USERNAME");
    expect(browserCredentialEnvName("PREFLIGHT_SCOUT_BROWSER_QA_USER_PASSWORD", "password")).toBe("PREFLIGHT_SCOUT_BROWSER_QA_USER_PASSWORD");
    expect(browserCredentialKindForEnvName("PREFLIGHT_SCOUT_BROWSER_QA_USER_PASSWORD")).toBe("password");
    expect(browserCredentialEnvName("PREFLIGHT_SCOUT_BROWSER_QA_USER_PASSWORD", "username")).toBeUndefined();
  });

  it.each([
    "OPENAI_API_KEY",
    "PREFLIGHT_SCOUT_DATABASE_PASSWORD",
    "PREFLIGHT_SCOUT_POSTGRES_PASSWORD",
    "PREFLIGHT_SCOUT_STRIPE_PASSWORD",
    "PREFLIGHT_SCOUT_QA_USER_EMAIL",
    "PREFLIGHT_SCOUT_BROWSER_PASSWORD",
    "PREFLIGHT_SCOUT_BROWSER_QA_USER_TOKEN",
    "preflight_scout_browser_qa_user_password"
  ])("rejects non-browser and ambiguous credential name %s", (name) => {
    expect(browserCredentialKindForEnvName(name)).toBeUndefined();
  });
});
