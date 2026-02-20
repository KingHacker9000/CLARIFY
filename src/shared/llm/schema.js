export const TASKS = Object.freeze(["definition", "explanation", "quant", "orientation"])

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

function normalizeSectionIntentItem(item) {
  const source = item && typeof item === "object" ? item : {}
  return {
    title: truncateText(source.title, 140),
    intent: truncateText(source.intent, 220)
  }
}

function normalizeOrientation(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  const intents = Array.isArray(source.sectionIntents)
    ? source.sectionIntents.map((item) => normalizeSectionIntentItem(item)).filter((item) => item.title)
    : []
  return {
    purpose: truncateText(source.purpose, 360),
    contribution: truncateText(source.contribution, 360),
    focusBullets: normalizeStringList(source.focusBullets, { maxItems: 5, maxLength: 220 }),
    keyTerms: normalizeStringList(source.keyTerms, { maxItems: 8, maxLength: 48 }),
    sectionIntents: intents.slice(0, 24)
  }
}

function enforceGroundingLimits(response, limits) {
  const source = response && typeof response === "object" ? response : {}
  const groundingPages = normalizeGroundingPages(source.groundingPages, limits.maxCitations)
  const groundingQuotes = normalizeGroundingQuotes(
    source.groundingQuotes,
    limits.maxCitations,
    limits.maxQuoteChars
  )
  return {
    ...source,
    groundingPages,
    groundingQuotes
  }
}

export function normalizeLLMResponse(task, resp, options = {}) {
  const normalizedTask = normalizeTask(task)
  const limits = normalizeLimits(options)
  if (normalizedTask === "quant") {
    return enforceGroundingLimits(normalizeQuant(resp, limits), limits)
  }
  if (normalizedTask === "orientation") {
    return normalizeOrientation(resp)
  }
  return enforceGroundingLimits(normalizeDefinitionOrExplanation(resp, limits), limits)
}
