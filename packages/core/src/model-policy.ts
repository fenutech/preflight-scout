/** Model settings are operator controls, never repository-derived recommendations. */
export const DEFAULT_OPENAI_MODEL = "gpt-6-astra";
export const DEFAULT_OPENAI_REASONING_EFFORT = "max";

export interface ModelSettings {
  model?: string;
  reasoningEffort?: string;
}

export function resolveExecModelSettings(
  kind: "codex" | "claude" | "gemini",
  env: NodeJS.ProcessEnv = process.env
): ModelSettings {
  const modelValue = nonempty(env.PREFLIGHT_SCOUT_EXEC_MODEL) ?? nonempty(env.PREFLIGHT_SCOUT_MODEL);
  const model = modelValue === "default" ? undefined : modelValue ?? (kind === "codex" ? DEFAULT_OPENAI_MODEL : undefined);
  if (model !== undefined && (model.length > 256 || /["'\0\r\n]/.test(model))) {
    throw new Error("Local agent model identifier must be a non-empty 256-character value without quotes or newlines.");
  }
  const effort = nonempty(env.PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT) ?? nonempty(env.PREFLIGHT_SCOUT_REASONING_EFFORT);
  return {
    model,
    reasoningEffort: resolveReasoningEffort(effort, kind === "codex" && model === DEFAULT_OPENAI_MODEL)
  };
}

export function resolveReasoningEffort(value: string | undefined, useAstraDefault = false): string | undefined {
  const effort = nonempty(value);
  if (effort === "default") return undefined;
  if (effort && !/^[A-Za-z0-9_-]{1,32}$/.test(effort)) {
    throw new Error("Reasoning effort must contain 1–32 letters, numbers, underscores, or hyphens, or be default.");
  }
  return effort ?? (useAstraDefault ? DEFAULT_OPENAI_REASONING_EFFORT : undefined);
}

function nonempty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
