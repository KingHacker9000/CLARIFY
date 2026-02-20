export const TASKS = Object.freeze(["definition", "explanation", "quant"])

const TASK_SET = new Set(TASKS)
const MAX_SHORT_ANSWER_WORDS = 35
const DEFAULT_MAX_QUOTE_CHARS = 240
const DEFAULT_MAX_CITATIONS = 3

function normalizeText(value) {
  if (typeof value !== "string") {
    return ""
  }
  return value.replace(/\s+/g, " ").trim()
}

function truncateText(value, maxLength) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(maxLength - 3, 1)).trim()}...`
}

function normalizeStringList(value, { maxItems = 8, maxLength = 180 } = {}) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return source
    .map((item) => truncateText(item, maxLength))
    .filter(Boolean)
    .slice(0, Math.max(maxItems, 0))
}

function normalizeNumber(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  const rounded = Math.round(numeric)
  return Math.min(max, Math.max(min, rounded))
}

function normalizeGroundingPages(value, maxItems) {
  const source = Array.isArray(value) ? value : typeof value === "number" ? [value] : []
  return source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .map((item) => Math.floor(item))
    .slice(0, maxItems)
}

function normalizeGroundingQuotes(value, maxItems, maxLength) {
  return normalizeStringList(value, { maxItems, maxLength })
}

function normalizeLimits(options) {
  const source = options && typeof options === "object" ? options : {}
  return {
    maxQuoteChars: normalizeNumber(source.maxQuoteChars, DEFAULT_MAX_QUOTE_CHARS, 80, 480),
    maxCitations: normalizeNumber(source.maxCitations, DEFAULT_MAX_CITATIONS, 1, 6)
  }
}

export function clampWords(text, maxWords) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return ""
  }
  const words = normalized.split(" ")
  if (!Number.isFinite(maxWords) || maxWords < 1 || words.length <= maxWords) {
    return normalized
  }
  return `${words.slice(0, maxWords).join(" ")}...`
}

function normalizeTask(task) {
  return TASK_SET.has(task) ? task : "explanation"
}

function normalizeDefinitionOrExplanation(resp, limits) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    shortAnswer: truncateText(clampWords(source.shortAnswer, MAX_SHORT_ANSWER_WORDS), 320),
    eli5: truncateText(source.eli5, 320),
    steps: normalizeStringList(source.steps, { maxItems: 8, maxLength: 180 }),
    paperUsage: normalizeStringList(source.paperUsage, { maxItems: 8, maxLength: 180 }),
    groundingPages: normalizeGroundingPages(source.groundingPages, limits.maxCitations),
    groundingQuotes: normalizeGroundingQuotes(
      source.groundingQuotes,
      limits.maxCitations,
      limits.maxQuoteChars
    )
  }
}

function normalizeQuant(resp, limits) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    shortAnswer: truncateText(clampWords(source.shortAnswer, MAX_SHORT_ANSWER_WORDS), 320),
    whatItShows: truncateText(source.whatItShows, 240),
    takeaway: truncateText(source.takeaway, 240),
    supportsClaim: normalizeStringList(source.supportsClaim, { maxItems: 8, maxLength: 180 }),
    whatToLookAt: normalizeStringList(source.whatToLookAt, { maxItems: 8, maxLength: 180 }),
    groundingPages: normalizeGroundingPages(source.groundingPages, limits.maxCitations),
    groundingQuotes: normalizeGroundingQuotes(
      source.groundingQuotes,
      limits.maxCitations,
      limits.maxQuoteChars
    )
  }
}

export function normalizeLLMResponse(task, resp, options = {}) {
  const normalizedTask = normalizeTask(task)
  const limits = normalizeLimits(options)
  if (normalizedTask === "quant") {
    return normalizeQuant(resp, limits)
  }
  return normalizeDefinitionOrExplanation(resp, limits)
}
