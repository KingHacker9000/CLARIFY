const PAGE_TEXT_CACHE_BY_DOC = new Map()

function normalizeWhitespace(value) {
  if (typeof value !== "string") {
    return ""
  }
  return value.replace(/\s+/g, " ").trim()
}

function normalizePageIndex(pageIndex) {
  const numeric = Number(pageIndex)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null
  }
  return Math.floor(numeric)
}

function getDocCache(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc !== "object") {
    return null
  }
  let docCache = PAGE_TEXT_CACHE_BY_DOC.get(pdfDoc)
  if (!docCache) {
    docCache = new Map()
    PAGE_TEXT_CACHE_BY_DOC.set(pdfDoc, docCache)
  }
  return docCache
}

async function readPageText(pdfDoc, pageIndex) {
  if (!pdfDoc || typeof pdfDoc.getPage !== "function") {
    return ""
  }
  try {
    const page = await pdfDoc.getPage(pageIndex + 1)
    const textContent = await page.getTextContent()
    const items = Array.isArray(textContent?.items) ? textContent.items : []
    const text = items
      .map((item) => (typeof item?.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ")
    return normalizeWhitespace(text)
  } catch (_error) {
    return ""
  }
}

export async function getPageText(pdfDoc, pageIndex) {
  const normalizedPageIndex = normalizePageIndex(pageIndex)
  if (normalizedPageIndex == null) {
    return ""
  }
  const docCache = getDocCache(pdfDoc)
  if (!docCache) {
    return ""
  }
  if (docCache.has(normalizedPageIndex)) {
    return docCache.get(normalizedPageIndex) || ""
  }
  const numPages = Number(pdfDoc?.numPages) || 0
  if (normalizedPageIndex >= numPages) {
    docCache.set(normalizedPageIndex, "")
    return ""
  }
  const text = await readPageText(pdfDoc, normalizedPageIndex)
  docCache.set(normalizedPageIndex, text)
  return text
}

export async function buildPageTextCache(pdfDoc, { maxPages } = {}) {
  const docCache = getDocCache(pdfDoc)
  if (!docCache) {
    return new Map()
  }
  const totalPages = Number(pdfDoc?.numPages) || 0
  const hasMaxPages = Number.isFinite(Number(maxPages))
  const normalizedMaxPages = hasMaxPages ? Math.max(0, Math.floor(Number(maxPages))) : totalPages
  const limit = Math.min(totalPages, hasMaxPages ? normalizedMaxPages : totalPages)
  for (let pageIndex = 0; pageIndex < limit; pageIndex += 1) {
    if (docCache.has(pageIndex)) {
      continue
    }
    const text = await readPageText(pdfDoc, pageIndex)
    docCache.set(pageIndex, text)
  }
  return docCache
}
