export const DEFAULT_SETTINGS = Object.freeze({
  llmMode: "auto",
  openaiApiKey: null,
  defaultReadingMode: "flow",
  autoOpenPdf: false
});

const VALID_LLM_MODES = new Set(["auto", "mock", "openai"]);
const VALID_READING_MODES = new Set(["flow", "structure"]);

function normalizeApiKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSettings(obj) {
  const source = obj && typeof obj === "object" ? obj : {};

  const llmMode = VALID_LLM_MODES.has(source.llmMode) ? source.llmMode : DEFAULT_SETTINGS.llmMode;
  const defaultReadingMode = VALID_READING_MODES.has(source.defaultReadingMode)
    ? source.defaultReadingMode
    : DEFAULT_SETTINGS.defaultReadingMode;

  return {
    llmMode,
    openaiApiKey: normalizeApiKey(source.openaiApiKey),
    defaultReadingMode,
    autoOpenPdf: Boolean(source.autoOpenPdf)
  };
}
