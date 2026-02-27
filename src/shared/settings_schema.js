export const DEFAULT_SETTINGS = Object.freeze({
  llmMode: "auto",
  openaiApiKey: null,
  theme: "light",
  debugMode: false,
  contextScope: "selection",
  wholePdfUpload: "session",
  promptCacheRetention: "default",
  maxQuoteChars: 240,
  maxCitations: 3,
  defaultReadingMode: "viewer",
  autoOpenPdf: false
});

const VALID_LLM_MODES = new Set(["auto", "mock", "openai"]);
const VALID_THEMES = new Set(["light", "dark"]);
const VALID_CONTEXT_SCOPES = new Set(["selection", "page", "whole_pdf"]);
const VALID_WHOLE_PDF_UPLOAD = new Set(["off", "session", "remember"]);
const VALID_PROMPT_CACHE_RETENTION = new Set(["default", "24h"]);
const VALID_READING_MODES = new Set(["viewer", "flow", "structure", "worksheet"]);
const MIN_QUOTE_CHARS = 80;
const MAX_QUOTE_CHARS = 480;
const MIN_CITATIONS = 1;
const MAX_CITATIONS = 6;
const MAX_API_KEY_LENGTH = 512;

function normalizeApiKey(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_API_KEY_LENGTH) {
    return null;
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.round(numeric);
  return Math.min(max, Math.max(min, rounded));
}

export function normalizeSettings(obj) {
  const source = obj && typeof obj === "object" ? obj : {};

  const llmMode = VALID_LLM_MODES.has(source.llmMode) ? source.llmMode : DEFAULT_SETTINGS.llmMode;
  const theme = VALID_THEMES.has(source.theme) ? source.theme : DEFAULT_SETTINGS.theme;
  const contextScope = VALID_CONTEXT_SCOPES.has(source.contextScope)
    ? source.contextScope
    : DEFAULT_SETTINGS.contextScope;
  const wholePdfUpload = VALID_WHOLE_PDF_UPLOAD.has(source.wholePdfUpload)
    ? source.wholePdfUpload
    : DEFAULT_SETTINGS.wholePdfUpload;
  const promptCacheRetention = VALID_PROMPT_CACHE_RETENTION.has(source.promptCacheRetention)
    ? source.promptCacheRetention
    : DEFAULT_SETTINGS.promptCacheRetention;
  const defaultReadingMode = VALID_READING_MODES.has(source.defaultReadingMode)
    ? source.defaultReadingMode
    : DEFAULT_SETTINGS.defaultReadingMode;
  const maxQuoteChars = normalizeNumber(
    source.maxQuoteChars,
    DEFAULT_SETTINGS.maxQuoteChars,
    MIN_QUOTE_CHARS,
    MAX_QUOTE_CHARS
  );
  const maxCitations = normalizeNumber(
    source.maxCitations,
    DEFAULT_SETTINGS.maxCitations,
    MIN_CITATIONS,
    MAX_CITATIONS
  );

  return {
    llmMode,
    openaiApiKey: normalizeApiKey(source.openaiApiKey),
    theme,
    debugMode: Boolean(source.debugMode),
    contextScope,
    wholePdfUpload,
    promptCacheRetention,
    maxQuoteChars,
    maxCitations,
    defaultReadingMode,
    autoOpenPdf: Boolean(source.autoOpenPdf)
  };
}
