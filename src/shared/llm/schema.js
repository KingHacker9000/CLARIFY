export const TASKS = Object.freeze([
  "definition",
  "explanation",
  "quant",
  "orientation",
  "section_intents",
  "section_intent",
  "worksheet_questions",
  "worksheet_answer"
])

const TASK_SET = new Set(TASKS)
const MAX_SHORT_ANSWER_WORDS = 35
const DEFAULT_MAX_QUOTE_CHARS = 240
const DEFAULT_MAX_CITATIONS = 3
const WORKSHEET_QUESTION_MAX_ITEMS = 180

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

function normalizeWorksheetAnswerText(value, maxLength = 1200) {
  if (typeof value !== "string") {
    return ""
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!normalized) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(maxLength - 3, 1)).trim()}...`
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

function normalizeSectionIntents(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  const intents = Array.isArray(source.intents)
    ? source.intents
        .map((item) => ({
          sectionKey: truncateText(item?.sectionKey, 220),
          intent: truncateText(clampWords(item?.intent, 25), 220)
        }))
        .filter((item) => item.sectionKey && item.intent)
        .slice(0, 48)
    : []
  return { intents }
}

function normalizeSectionIntent(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    intent: truncateText(clampWords(source.intent, 25), 220)
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

function normalizeWorksheetQuestions(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  const validKinds = new Set(["question", "part", "item", "term", "prompt"])
  const validQuestionTypes = new Set([
    "mcq",
    "short_answer",
    "long_answer",
    "multi_select",
    "fill_blank",
    "true_false",
    "table_definition",
    "unknown"
  ])
  const questions = Array.isArray(source.questions)
    ? source.questions
        .map((item) => {
          const questionText = truncateText(
            item?.questionText || item?.question || item?.text || item?.prompt,
            360
          )
          const gradeLevel = truncateText(item?.gradeLevel || item?.grade || item?.points || "", 80)
          const numericPage = Number(item?.pageIndex)
          const pageIndex = Number.isFinite(numericPage) && numericPage >= 0 ? Math.floor(numericPage) : 0
          const kindRaw = normalizeText(item?.kind).toLowerCase()
          const kind = validKinds.has(kindRaw) ? kindRaw : ""
          const sourceKey = truncateText(item?.sourceKey || item?.id || "", 220)
          const parentSourceKey = truncateText(item?.parentSourceKey || item?.parentKey || item?.parentId || "", 220)
          const label = truncateText(item?.label || item?.title || "", 120)
          const anchorText = truncateText(item?.anchorText || item?.anchor || "", 240)
          const questionTypeRaw = normalizeText(item?.questionType || item?.responseType || item?.primaryResponseType).toLowerCase()
          const questionType = validQuestionTypes.has(questionTypeRaw) ? questionTypeRaw : "unknown"
          const responseTypes = Array.isArray(item?.responseTypes)
            ? item.responseTypes
                .map((entry) => normalizeText(entry).toLowerCase())
                .filter((entry) => validQuestionTypes.has(entry))
                .slice(0, 6)
            : []
          const marksRaw = truncateText(item?.marksRaw || item?.marks || item?.pointsLabel || "", 80)
          const marksValueRaw = Number(item?.marksValue ?? item?.marks?.value)
          const marksValue = Number.isFinite(marksValueRaw) && marksValueRaw > 0 ? marksValueRaw : null
          const marksEach = Boolean(item?.marksEach || item?.marks?.each)
          const options = Array.isArray(item?.options)
            ? item.options.map((entry) => truncateText(entry, 120)).filter(Boolean).slice(0, 12)
            : []
          const contextWindow = truncateText(item?.contextWindow || item?.context || "", 900)
          return {
            questionText,
            gradeLevel,
            pageIndex,
            kind,
            sourceKey,
            parentSourceKey,
            label,
            anchorText,
            questionType,
            responseTypes,
            marksRaw,
            marksValue,
            marksEach,
            options,
            contextWindow
          }
        })
        .filter((item) => item.questionText)
        .slice(0, WORKSHEET_QUESTION_MAX_ITEMS)
    : []
  return { questions }
}

function normalizeWorksheetAnswer(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  const answerLengthRaw = normalizeText(source.answerLength).toLowerCase()
  return {
    answer: normalizeWorksheetAnswerText(source.answer || source.shortAnswer || source.response || "", 1200),
    answerLength: answerLengthRaw === "long" || answerLengthRaw === "short" ? answerLengthRaw : ""
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
  if (normalizedTask === "worksheet_questions") {
    return normalizeWorksheetQuestions(resp)
  }
  if (normalizedTask === "worksheet_answer") {
    return normalizeWorksheetAnswer(resp)
  }
  if (normalizedTask === "section_intents") {
    return normalizeSectionIntents(resp)
  }
  if (normalizedTask === "section_intent") {
    return normalizeSectionIntent(resp)
  }
  if (normalizedTask === "quant") {
    return enforceGroundingLimits(normalizeQuant(resp, limits), limits)
  }
  if (normalizedTask === "orientation") {
    return normalizeOrientation(resp)
  }
  return enforceGroundingLimits(normalizeDefinitionOrExplanation(resp, limits), limits)
}
