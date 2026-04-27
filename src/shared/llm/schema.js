export const TASKS = Object.freeze([
  "definition",
  "explanation",
  "quant",
  "orientation",
  "section_intents",
  "section_intent",
  "worksheet_questions",
  "worksheet_answer",
  "project_relevance",
  "project_compare_table",
  "literature_import",
  "project_matrix_row_fill",
  "project_screening_suggest",
  "project_contribution_map"
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

function normalizeProjectRecommendation(value) {
  const normalized = normalizeText(value).toLowerCase()
  if (normalized === "include" || normalized === "exclude" || normalized === "review") {
    return normalized
  }
  return "review"
}

function normalizeProjectRelevance(resp, limits) {
  const source = resp && typeof resp === "object" ? resp : {}
  return enforceGroundingLimits(
    {
      fitScore: normalizeNumber(source.fitScore, 0, 0, 100),
      recommendation: normalizeProjectRecommendation(source.recommendation),
      relevanceSummary: truncateText(source.relevanceSummary, 900),
      methodMatch: truncateText(source.methodMatch, 700),
      gapsOrRisks: normalizeStringList(source.gapsOrRisks, { maxItems: 12, maxLength: 260 }),
      recommendedSections: normalizeStringList(source.recommendedSections, { maxItems: 12, maxLength: 180 }),
      groundingPages: normalizeGroundingPages(source.groundingPages, limits.maxCitations),
      groundingQuotes: normalizeGroundingQuotes(
        source.groundingQuotes,
        limits.maxCitations,
        limits.maxQuoteChars
      )
    },
    limits
  )
}

function normalizeComparisonRows(rows) {
  const source = Array.isArray(rows) ? rows : []
  return source
    .map((row) => {
      const rowObj = row && typeof row === "object" ? row : {}
      const criterion = truncateText(rowObj.criterion || rowObj.title, 180)
      if (!criterion) {
        return null
      }
      const cells = Array.isArray(rowObj.cells)
        ? rowObj.cells
            .map((cell) => {
              const cellObj = cell && typeof cell === "object" ? cell : {}
              const paperId = truncateText(cellObj.paperId, 120)
              const value = truncateText(cellObj.value || cellObj.text, 420)
              const groundingPage = Number.isFinite(Number(cellObj.groundingPage))
                ? Math.max(0, Math.floor(Number(cellObj.groundingPage)))
                : null
              const groundingQuote = truncateText(cellObj.groundingQuote, 260)
              if (!paperId && !value) {
                return null
              }
              return {
                paperId,
                value,
                groundingPage,
                groundingQuote
              }
            })
            .filter(Boolean)
            .slice(0, 12)
        : []
      return { criterion, cells }
    })
    .filter(Boolean)
    .slice(0, 64)
}

function normalizeProjectCompareTable(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    columns: normalizeStringList(source.columns, { maxItems: 12, maxLength: 120 }),
    rows: normalizeComparisonRows(source.rows),
    crossPaperInsights: normalizeStringList(source.crossPaperInsights, { maxItems: 16, maxLength: 320 }),
    contradictions: normalizeStringList(source.contradictions, { maxItems: 16, maxLength: 320 }),
    evidenceGaps: normalizeStringList(source.evidenceGaps, { maxItems: 16, maxLength: 320 })
  }
}

function normalizeProjectMatrixCells(value) {
  const source = Array.isArray(value) ? value : []
  return source
    .map((cell) => {
      const entry = cell && typeof cell === "object" ? cell : {}
      const columnId = truncateText(entry.columnId, 80)
      const valueText = truncateText(entry.value, 420)
      const confidence = Math.max(0, Math.min(1, Number(entry.confidence) || 0))
      const evidenceSnippet = truncateText(entry.evidenceSnippet || entry.evidenceQuote, 320)
      const evidencePage = Number.isFinite(Number(entry.evidencePage))
        ? Math.max(0, Math.floor(Number(entry.evidencePage)))
        : null
      const insufficientReason = truncateText(entry.insufficientReason, 180)
      if (!columnId) {
        return null
      }
      return {
        columnId,
        value: valueText,
        confidence,
        evidenceSnippet,
        evidencePage,
        insufficientReason
      }
    })
    .filter(Boolean)
    .slice(0, 220)
}

function normalizeProjectMatrixHiddenFeatures(value) {
  const source = Array.isArray(value) ? value : []
  return source
    .map((item) => {
      const entry = item && typeof item === "object" ? item : {}
      const columnId = truncateText(entry.columnId, 80)
      const tags = normalizeStringList(entry.tags, { maxItems: 6, maxLength: 60 })
      if (!columnId) {
        return null
      }
      return {
        columnId,
        tags
      }
    })
    .filter(Boolean)
    .slice(0, 120)
}

function normalizeProjectMatrixRowFill(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    cells: normalizeProjectMatrixCells(source.cells),
    hiddenFeatures: normalizeProjectMatrixHiddenFeatures(source.hiddenFeatures),
    warnings: normalizeStringList(source.warnings, { maxItems: 20, maxLength: 220 })
  }
}

function normalizeScreeningDecisionSuggestion(value) {
  const normalized = normalizeText(value).toLowerCase()
  if (
    normalized === "include" ||
    normalized === "exclude" ||
    normalized === "needs_info" ||
    normalized === "review"
  ) {
    return normalized
  }
  return "review"
}

function normalizeProjectScreeningSuggest(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    decisionSuggestion: normalizeScreeningDecisionSuggestion(source.decisionSuggestion),
    confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0)),
    reasonCandidates: normalizeStringList(source.reasonCandidates, { maxItems: 12, maxLength: 80 }),
    evidenceSnippet: truncateText(source.evidenceSnippet, 360),
    evidencePage: Number.isFinite(Number(source.evidencePage))
      ? Math.max(0, Math.floor(Number(source.evidencePage)))
      : null,
    insufficientReason: truncateText(source.insufficientReason, 180)
  }
}

function normalizeContributionItem(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  const label = truncateText(source.label || source.name || source.title, 120)
  const summary = truncateText(source.summary || source.description || source.detail, 420)
  const confidence = Math.max(0, Math.min(1, Number(source.confidence) || 0))
  return {
    label,
    summary,
    confidence
  }
}

function normalizeContributionList(value, maxItems = 16) {
  const source = Array.isArray(value) ? value : []
  return source
    .map((entry) => normalizeContributionItem(entry))
    .filter((item) => item.label || item.summary)
    .slice(0, maxItems)
}

function normalizeEvidenceLinks(value) {
  const source = Array.isArray(value) ? value : []
  return source
    .map((entry) => {
      const item = entry && typeof entry === "object" ? entry : {}
      return {
        label: truncateText(item.label || item.title, 140),
        rowId: truncateText(item.rowId, 80),
        clusterId: Number.isFinite(Number(item.clusterId)) ? Math.max(0, Math.floor(Number(item.clusterId))) : null,
        columnId: truncateText(item.columnId, 80),
        value: truncateText(item.value, 220)
      }
    })
    .filter((item) => item.label || item.rowId || item.value)
    .slice(0, 36)
}

function normalizeProjectContributionMap(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  return {
    clustersSummary: normalizeContributionList(source.clustersSummary, 20),
    underexploredZones: normalizeContributionList(source.underexploredZones, 20),
    differentiationIdeas: normalizeContributionList(source.differentiationIdeas, 24),
    evidenceLinks: normalizeEvidenceLinks(source.evidenceLinks)
  }
}

const IMPORT_PAPER_STATUSES = new Set(["queued", "reading", "included", "excluded"])
const IMPORT_PAPER_CONFIDENCE = new Set(["high", "medium", "low", "unknown"])

function normalizeImportProject(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  return {
    name: truncateText(source.name, 140),
    researchQuestion: truncateText(source.researchQuestion, 900),
    objective: truncateText(source.objective, 900),
    scopeNotes: truncateText(source.scopeNotes, 2200),
    keyTerms: normalizeStringList(source.keyTerms, { maxItems: 32, maxLength: 80 }),
    rubric: normalizeStringList(source.rubric, { maxItems: 24, maxLength: 120 })
  }
}

function normalizeImportPaper(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  const statusRaw = normalizeText(source.status).toLowerCase()
  const status = IMPORT_PAPER_STATUSES.has(statusRaw) ? statusRaw : "queued"
  const priority = normalizeNumber(source.priority, 2, 1, 5)
  const yearRaw = Number(source.year)
  const year = Number.isFinite(yearRaw) && yearRaw >= 1800 && yearRaw <= 2100 ? Math.floor(yearRaw) : null
  const confidenceRaw = normalizeText(source.confidence).toLowerCase()
  const confidence = IMPORT_PAPER_CONFIDENCE.has(confidenceRaw) ? confidenceRaw : "unknown"
  return {
    title: truncateText(source.title, 260),
    url: truncateText(source.url, 2200),
    authors: normalizeStringList(source.authors, { maxItems: 12, maxLength: 120 }),
    year,
    venue: truncateText(source.venue, 160),
    tags: normalizeStringList(source.tags, { maxItems: 20, maxLength: 44 }),
    status,
    priority,
    notes: truncateText(source.notes, 700),
    arxivId: truncateText(source.arxivId, 48),
    doi: truncateText(source.doi, 120),
    confidence,
    searchQuery: truncateText(source.searchQuery, 260)
  }
}

function normalizeLiteratureImport(resp) {
  const source = resp && typeof resp === "object" ? resp : {}
  const papers = Array.isArray(source.papers)
    ? source.papers.map((paper) => normalizeImportPaper(paper)).filter((paper) => paper.title).slice(0, 180)
    : []
  return {
    project: normalizeImportProject(source.project),
    papers,
    warnings: normalizeStringList(source.warnings, { maxItems: 28, maxLength: 220 })
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
  if (normalizedTask === "literature_import") {
    return normalizeLiteratureImport(resp)
  }
  if (normalizedTask === "project_relevance") {
    return normalizeProjectRelevance(resp, limits)
  }
  if (normalizedTask === "project_compare_table") {
    return normalizeProjectCompareTable(resp)
  }
  if (normalizedTask === "project_matrix_row_fill") {
    return normalizeProjectMatrixRowFill(resp)
  }
  if (normalizedTask === "project_screening_suggest") {
    return normalizeProjectScreeningSuggest(resp)
  }
  if (normalizedTask === "project_contribution_map") {
    return normalizeProjectContributionMap(resp)
  }
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
