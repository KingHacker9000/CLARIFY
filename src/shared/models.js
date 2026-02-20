const CARD_TYPES = new Set(["definition", "explanation", "quant"])

function sanitizeText(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback
  }
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized || fallback
}

function clampText(value, maxLength) {
  const text = sanitizeText(value)
  if (!text) {
    return ""
  }
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(maxLength - 3, 1)).trim()}...`
}

function truncateText(value, maxLength) {
  const text = sanitizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength).trim()
}

function clampWords(value, maxWords) {
  const text = sanitizeText(value)
  if (!text) {
    return ""
  }
  const words = text.split(" ")
  if (words.length <= maxWords) {
    return text
  }
  return `${words.slice(0, maxWords).join(" ")}...`
}

function normalizeList(value, maxItems = 6, maxLength = 180) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => clampText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizeTruncatedList(value, maxItems = 6, maxLength = 180) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => truncateText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems)
}

function normalizeNumberList(value, maxItems = 6) {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .map((item) => Math.floor(item))
    .slice(0, maxItems)
}

function normalizeMeta(meta) {
  const input = meta && typeof meta === "object" ? meta : {}
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.map((warning) => clampText(warning, 200)).filter(Boolean).slice(0, 6)
    : []
  return {
    provider: sanitizeText(input.provider),
    warnings
  }
}

export function makeId(prefix = "id") {
  const now = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${now}_${random}`
}

export function normalizeCard(card) {
  const input = card && typeof card === "object" ? card : {}
  const type = CARD_TYPES.has(input.type) ? input.type : "explanation"

  const quote = truncateText(input.grounding?.quote, 300)
  const sectionTitle = sanitizeText(input.grounding?.sectionTitle, "Unknown section")
  const sectionId = sanitizeText(input.grounding?.sectionId)
  const pageIndex = Number.isFinite(input.grounding?.pageIndex)
    ? Math.max(0, Number(input.grounding.pageIndex))
    : 0
  const locatorPageIndex = Number.isFinite(input.locator?.pageIndex)
    ? Math.max(0, Number(input.locator.pageIndex))
    : pageIndex

  const details = {
    eli5: clampText(input.details?.eli5, 320),
    steps: normalizeList(input.details?.steps, 8, 180),
    paperUsage: normalizeList(input.details?.paperUsage, 8, 180),
    whatItShows: clampText(input.details?.whatItShows, 220),
    takeaway: clampText(input.details?.takeaway, 220),
    supportsClaim: clampText(input.details?.supportsClaim, 220),
    whatToLookAt: normalizeList(input.details?.whatToLookAt, 8, 180)
  }

  return {
    id: sanitizeText(input.id) || makeId("card"),
    type,
    title: clampText(input.title || input.selectedText, 180) || "Untitled selection",
    shortAnswer: clampWords(input.shortAnswer, 35),
    details,
    grounding: {
      pageIndex,
      sectionId: sectionId || null,
      sectionTitle,
      quote,
      citationPages: normalizeNumberList(input.grounding?.citationPages, 6),
      citationQuotes: normalizeTruncatedList(input.grounding?.citationQuotes, 6, 260),
      textRange: input.grounding?.textRange ?? null
    },
    locator: {
      selectedText: truncateText(input.locator?.selectedText || input.selectedText || input.title, 200),
      pageIndex: locatorPageIndex,
      contextHint: truncateText(input.locator?.contextHint, 200)
    },
    createdAt:
      typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
        ? input.createdAt
        : Date.now(),
    pinned: Boolean(input.pinned),
    meta: normalizeMeta(input.meta),
    selectedText: clampText(input.selectedText || input.title, 500),
    contextWindow: clampText(input.contextWindow, 800)
  }
}

export function deriveDocId(currentPdf) {
  if (!currentPdf || typeof currentPdf !== "object") {
    return "unknown"
  }

  const sourceType = currentPdf.sourceType
  const url = sanitizeText(currentPdf.url)
  if (sourceType === "remote" && url) {
    return url
  }

  const filename = sanitizeText(currentPdf.filename || currentPdf.name)
  const size = currentPdf.fileSize ?? currentPdf.size
  const lastModified = currentPdf.fileLastModified ?? currentPdf.lastModified
  const hasLocalIdentity =
    sourceType === "local" &&
    filename &&
    Number.isFinite(size) &&
    Number.isFinite(lastModified)

  if (hasLocalIdentity) {
    return `${filename}:${Number(size)}:${Number(lastModified)}`
  }

  return "unknown"
}
