export const DEFAULT_SETTINGS = Object.freeze({
  llmMode: "auto",
  openaiApiKey: null,
  openaiModel: "gpt-4.1-mini",
  googleClientId: null,
  googleApiKey: null,
  theme: "light",
  debugMode: false,
  contextScope: "selection",
  wholePdfUpload: "session",
  promptCacheRetention: "default",
  maxQuoteChars: 240,
  maxCitations: 3,
  defaultReadingMode: "viewer",
  autoOpenPdf: false,
  homeLayout: "workspace_workflow_insights",
  homeDensity: "compact",
  homeAccentPreset: "ocean",
  homeShowAdvancedCollapsedByDefault: true,
  homeChecklistEnabled: true,
  homeDefaultWorkflowStage: "discover",
  homeDefaultInsightsStage: "compare"
});

const VALID_LLM_MODES = new Set(["auto", "mock", "openai"]);
const VALID_THEMES = new Set(["light", "dark"]);
const VALID_CONTEXT_SCOPES = new Set(["selection", "page", "whole_pdf"]);
const VALID_WHOLE_PDF_UPLOAD = new Set(["off", "session", "remember"]);
const VALID_PROMPT_CACHE_RETENTION = new Set(["default", "24h"]);
const VALID_READING_MODES = new Set(["viewer", "flow", "structure", "worksheet"]);
const VALID_HOME_LAYOUTS = new Set(["workspace_workflow_insights"]);
const VALID_HOME_DENSITIES = new Set(["compact", "comfortable"]);
const VALID_HOME_ACCENTS = new Set(["ocean", "forest", "sunset"]);
const VALID_HOME_WORKFLOW_STAGES = new Set(["discover", "screen", "matrix"]);
const VALID_HOME_INSIGHTS_STAGES = new Set(["compare", "synthesis", "contribution"]);
const VALID_OPENAI_MODEL_PRESETS = new Set(["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"]);
const MIN_QUOTE_CHARS = 80;
const MAX_QUOTE_CHARS = 480;
const MIN_CITATIONS = 1;
const MAX_CITATIONS = 6;
const MAX_API_KEY_LENGTH = 512;
const MAX_GOOGLE_FIELD_LENGTH = 1024;
const MAX_MODEL_NAME_LENGTH = 120;

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

function normalizeOptionalCredential(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_GOOGLE_FIELD_LENGTH) {
    return null;
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeOpenAIModel(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.openaiModel;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MODEL_NAME_LENGTH) {
    return DEFAULT_SETTINGS.openaiModel;
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return DEFAULT_SETTINGS.openaiModel;
  }
  if (VALID_OPENAI_MODEL_PRESETS.has(trimmed)) {
    return trimmed;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    return DEFAULT_SETTINGS.openaiModel;
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
  const homeLayout = VALID_HOME_LAYOUTS.has(source.homeLayout)
    ? source.homeLayout
    : DEFAULT_SETTINGS.homeLayout;
  const homeDensity = VALID_HOME_DENSITIES.has(source.homeDensity)
    ? source.homeDensity
    : DEFAULT_SETTINGS.homeDensity;
  const homeAccentPreset = VALID_HOME_ACCENTS.has(source.homeAccentPreset)
    ? source.homeAccentPreset
    : DEFAULT_SETTINGS.homeAccentPreset;
  const homeDefaultWorkflowStage = VALID_HOME_WORKFLOW_STAGES.has(source.homeDefaultWorkflowStage)
    ? source.homeDefaultWorkflowStage
    : DEFAULT_SETTINGS.homeDefaultWorkflowStage;
  const homeDefaultInsightsStage = VALID_HOME_INSIGHTS_STAGES.has(source.homeDefaultInsightsStage)
    ? source.homeDefaultInsightsStage
    : DEFAULT_SETTINGS.homeDefaultInsightsStage;
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
    openaiModel: normalizeOpenAIModel(source.openaiModel),
    googleClientId: normalizeOptionalCredential(source.googleClientId),
    googleApiKey: normalizeOptionalCredential(source.googleApiKey),
    theme,
    debugMode: Boolean(source.debugMode),
    contextScope,
    wholePdfUpload,
    promptCacheRetention,
    maxQuoteChars,
    maxCitations,
    defaultReadingMode,
    autoOpenPdf: Boolean(source.autoOpenPdf),
    homeLayout,
    homeDensity,
    homeAccentPreset,
    homeShowAdvancedCollapsedByDefault: source.homeShowAdvancedCollapsedByDefault !== false,
    homeChecklistEnabled: source.homeChecklistEnabled !== false,
    homeDefaultWorkflowStage,
    homeDefaultInsightsStage
  };
}
