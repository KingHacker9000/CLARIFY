export const LLM_RUNTIME_STATUS_EVENT = "clarify:llm-runtime-status";

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clampText(value, maxLength = 180) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(maxLength - 3, 1)).trim()}...`;
}

function extractFallbackReason(warnings) {
  const source = Array.isArray(warnings) ? warnings : [];
  const warning = source.find((item) => normalizeText(item).toLowerCase().includes("openai")) || source[0];
  return clampText(warning || "", 180);
}

export function classifyOpenAIProblem(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (
    normalized.includes("insufficient_quota") ||
    normalized.includes("quota") ||
    normalized.includes("billing") ||
    normalized.includes("credit") ||
    normalized.includes("exceeded your current")
  ) {
    return "quota";
  }
  if (normalized.includes("rate limit") || normalized.includes("rate-limited") || normalized.includes("429")) {
    return "rate_limit";
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("api key") || normalized.includes("unauthorized") || normalized.includes("401")) {
    return "auth";
  }
  return "error";
}

export function buildLlmRuntimeStatus({
  settings,
  providerUsed = "",
  warnings = [],
  task = "",
  errorMessage = ""
} = {}) {
  const mode = settings?.llmMode || "auto";
  const hasApiKey = Boolean(settings?.openaiApiKey);
  const provider = normalizeText(providerUsed).toLowerCase();
  const reason = extractFallbackReason(warnings);
  const problem = classifyOpenAIProblem(reason);
  const normalizedError = clampText(errorMessage, 220);
  const errorProblem = classifyOpenAIProblem(normalizedError);

  if (normalizedError) {
    if (!hasApiKey) {
      return {
        state: "missing_key",
        label: "No API key",
        detail: "OpenAI API key is not set. Add one in settings to run OpenAI tasks.",
        providerUsed: provider || "",
        task,
        reason: normalizedError
      };
    }
    if (errorProblem === "quota") {
      return {
        state: "quota",
        label: "API quota issue",
        detail: normalizedError || "OpenAI reported a quota, billing, or credits issue.",
        providerUsed: "openai",
        task,
        reason: normalizedError
      };
    }
    if (errorProblem === "rate_limit") {
      return {
        state: "rate_limit",
        label: "API rate limited",
        detail: normalizedError || "OpenAI rate limited this request.",
        providerUsed: "openai",
        task,
        reason: normalizedError
      };
    }
    if (errorProblem === "auth") {
      return {
        state: "auth",
        label: "API key rejected",
        detail: normalizedError || "OpenAI rejected the saved API key.",
        providerUsed: "openai",
        task,
        reason: normalizedError
      };
    }
    if (errorProblem === "timeout") {
      return {
        state: "timeout",
        label: "API timeout",
        detail: normalizedError || "OpenAI request timed out.",
        providerUsed: "openai",
        task,
        reason: normalizedError
      };
    }
    return {
      state: "error",
      label: "OpenAI error",
      detail: normalizedError || "OpenAI request failed.",
      providerUsed: "openai",
      task,
      reason: normalizedError
    };
  }

  if (provider === "openai") {
    return {
      state: "openai",
      label: "OpenAI API",
      detail: `Last AI call used OpenAI${task ? ` for ${task}` : ""}. API credits were used.`,
      providerUsed: "openai",
      task,
      reason: ""
    };
  }

  if (provider === "mock" && problem === "quota") {
    return {
      state: "quota",
      label: "API quota issue",
      detail: reason || "OpenAI reported a quota, billing, or credits issue.",
      providerUsed: "mock",
      task,
      reason
    };
  }

  if (provider === "mock" && problem === "rate_limit") {
    return {
      state: "rate_limit",
      label: "API rate limited",
      detail: reason || "OpenAI was rate limited.",
      providerUsed: "mock",
      task,
      reason
    };
  }

  if (provider === "mock" && problem === "auth") {
    return {
      state: "auth",
      label: "API key rejected",
      detail: reason || "OpenAI rejected the saved API key.",
      providerUsed: "mock",
      task,
      reason
    };
  }

  if (provider === "mock" && problem === "timeout") {
    return {
      state: "timeout",
      label: "API timeout",
      detail: reason || "OpenAI response timed out.",
      providerUsed: "mock",
      task,
      reason
    };
  }

  if (provider === "mock" && reason) {
    return {
      state: "fallback",
      label: "Mock fallback",
      detail: reason,
      providerUsed: "mock",
      task,
      reason
    };
  }

  if (mode === "mock") {
    return {
      state: "mock",
      label: "Mock mode",
      detail: "LLM mode is set to Mock. No OpenAI API credits are being used.",
      providerUsed: provider || "mock",
      task,
      reason: ""
    };
  }

  if (!hasApiKey) {
    return {
      state: "missing_key",
      label: "No API key",
      detail: "OpenAI API key is not set. Auto mode uses mock responses, so no API credits are being used.",
      providerUsed: provider || "mock",
      task,
      reason: ""
    };
  }

  return {
    state: "ready",
    label: "OpenAI ready",
    detail: "OpenAI key is set. The next AI call should use OpenAI.",
    providerUsed: provider || "",
    task,
    reason: ""
  };
}

export function publishLlmRuntimeStatus(detail) {
  if (typeof globalThis?.dispatchEvent !== "function" || typeof globalThis?.CustomEvent !== "function") {
    return;
  }
  globalThis.dispatchEvent(new CustomEvent(LLM_RUNTIME_STATUS_EVENT, { detail }));
}
