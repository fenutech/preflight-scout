import { describe, expect, it } from "vitest";
import { resolveExecModelSettings } from "./model-policy.js";

describe("execution model policy", () => {
  it("uses Astra Max for Codex without imposing it on other providers", () => {
    expect(resolveExecModelSettings("codex", {})).toEqual({ model: "gpt-6-astra", reasoningEffort: "max" });
    expect(resolveExecModelSettings("claude", {})).toEqual({ model: undefined, reasoningEffort: undefined });
    expect(resolveExecModelSettings("gemini", {})).toEqual({ model: undefined, reasoningEffort: undefined });
  });

  it("honors exec overrides before shared controls and treats blank values as absent", () => {
    expect(resolveExecModelSettings("codex", {
      PREFLIGHT_SCOUT_MODEL: "shared-model", PREFLIGHT_SCOUT_REASONING_EFFORT: "high",
      PREFLIGHT_SCOUT_EXEC_MODEL: " chosen-model ", PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT: " low "
    })).toEqual({ model: "chosen-model", reasoningEffort: "low" });
    expect(resolveExecModelSettings("codex", {
      PREFLIGHT_SCOUT_EXEC_MODEL: " ", PREFLIGHT_SCOUT_MODEL: "other-model"
    })).toEqual({ model: "other-model", reasoningEffort: undefined });
  });

  it("can inherit CLI model and effort without sending the sentinel as a model", () => {
    expect(resolveExecModelSettings("codex", {
      PREFLIGHT_SCOUT_EXEC_MODEL: "default", PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT: "default",
      PREFLIGHT_SCOUT_MODEL: "shared-model", PREFLIGHT_SCOUT_REASONING_EFFORT: "high"
    })).toEqual({ model: undefined, reasoningEffort: undefined });
    expect(resolveExecModelSettings("codex", { PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT: "default" }))
      .toEqual({ model: "gpt-6-astra", reasoningEffort: undefined });
  });

  it.each(["x".repeat(257), "bad\nmodel", "bad\rmodel", "bad\u0000model", 'bad"model', "bad'model"])("rejects invalid local model identifiers before diagnostics or execution", (model) => {
    expect(() => resolveExecModelSettings("codex", { PREFLIGHT_SCOUT_EXEC_MODEL: model }))
      .toThrow("Local agent model identifier");
    expect(() => resolveExecModelSettings("claude", { PREFLIGHT_SCOUT_MODEL: model }))
      .toThrow("Local agent model identifier");
  });

  it("accepts the same exact identifier boundary as built-in CLI execution", () => {
    expect(resolveExecModelSettings("codex", { PREFLIGHT_SCOUT_EXEC_MODEL: "x".repeat(256) }).model).toHaveLength(256);
  });

  it("rejects malformed effort controls before constructing a command", () => {
    expect(() => resolveExecModelSettings("codex", { PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT: "max'\nother=true" }))
      .toThrow("Reasoning effort must contain");
  });
});
