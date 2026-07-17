import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getInput } = vi.hoisted(() => ({ getInput: vi.fn() }));

vi.mock("@actions/core", () => ({ getInput }));

import { readInputs } from "./inputs.js";

describe("readInputs", () => {
  const names = [
    "PREFLIGHT_SCOUT_GITHUB_TOKEN",
    "PREFLIGHT_SCOUT_TARGET_ENV",
    "PREFLIGHT_SCOUT_APP_URL",
    "PREFLIGHT_SCOUT_ACTION_APP_URL_INPUT"
  ] as const;
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    getInput.mockReset();
    getInput.mockReturnValue("");
    for (const name of names) previous.set(name, process.env[name]);
    process.env.PREFLIGHT_SCOUT_GITHUB_TOKEN = "test-token";
    process.env.PREFLIGHT_SCOUT_TARGET_ENV = "staging";
    process.env.PREFLIGHT_SCOUT_APP_URL = "https://generic.example.com";
    delete process.env.PREFLIGHT_SCOUT_ACTION_APP_URL_INPUT;
  });

  afterEach(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previous.clear();
  });

  it("does not reinterpret the generic app URL environment variable as an explicit Action input", () => {
    expect(readInputs()).toMatchObject({
      appUrl: undefined,
      targetEnv: "staging"
    });
  });

  it("reads the composite Action's dedicated app-url input channel", () => {
    process.env.PREFLIGHT_SCOUT_ACTION_APP_URL_INPUT = "https://explicit.example.com";

    expect(readInputs()).toMatchObject({
      appUrl: "https://explicit.example.com",
      targetEnv: "staging"
    });
  });
});
