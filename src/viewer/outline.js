const SECTION_KEYWORDS = [
  "abstract",
  "introduction",
  "related work",
  "method",
  "methods",
  "approach",
  "experiments",
  "results",
  "discussion",
  "conclusion",
  "references",
  "appendix"
]

const SECTION_KEYWORD_PATTERN = new RegExp(`\\b(?:${SECTION_KEYWORDS.join("|")})\\b`, "i")

function normalizeWhitespace(value) {
  if (typeof value !== "string") {
    return ""
  }
  return value.replace(/\s+/g, " ").trim()
}

function normalizeTitle(value) {
  const normalized = normalizeWhitespace(value)
  if (!normalized) {
    return ""
  }
  return normalized.slice(0, 180)
}

function normalizePageIndex(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null
  }
  return Math.floor(numeric)
}

async function resolveDestinationToPageIndex(pdfDoc, destination) {
  if (!destination) {
    return null
  }

  let resolvedDestination = destination
  if (typeof resolvedDestination === "string") {
    try {
      resolvedDestination = await pdfDoc.getDestination(resolvedDestination)
    } catch (_error) {
      return null
    }
  }

  if (!Array.isArray(resolvedDestination) || resolvedDestination.length === 0) {
    return null
  }

  const target = resolvedDestination[0]
  const numericTarget = normalizePageIndex(target)
  if (numericTarget != null) {
    const numPages = Number(pdfDoc?.numPages) || 0
    if (numericTarget < numPages) {
      return numericTarget
    }
    if (numericTarget > 0 && numericTarget - 1 < numPages) {
      return numericTarget - 1
    }
  }

  try {
    const pageIndex = await pdfDoc.getPageIndex(target)
    return normalizePageIndex(pageIndex)
  } catch (_error) {
    return null
  }
}

async function flattenOutlineItems(pdfDoc, items, level, collector) {
  if (!Array.isArray(items)) {
    return
  }

  for (const item of items) {
    const title = normalizeTitle(item?.title)
    const pageIndex = await resolveDestinationToPageIndex(pdfDoc, item?.dest)
    if (title && pageIndex != null) {
      collector.push({
        title,
        pageIndex,
        level: Math.max(1, Number(level) || 1),
        source: "outline"
      })
    }

    const children = Array.isArray(item?.items) ? item.items : []
    if (children.length > 0) {
      await flattenOutlineItems(pdfDoc, children, Math.max(1, Number(level) || 1) + 1, collector)
    }
  }
}

function dedupeConsecutiveSections(sections) {
  const sorted = [...sections].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) {
      return a.pageIndex - b.pageIndex
    }
    return a.level - b.level
  })

  const deduped = []
  let lastTitle = ""
  let lastPage = -10

  for (const section of sorted) {
    const normalizedTitle = normalizeWhitespace(section?.title).toLowerCase()
    if (!normalizedTitle) {
      continue
    }
    if (normalizedTitle === lastTitle && section.pageIndex <= lastPage + 1) {
      continue
    }
    deduped.push(section)
    lastTitle = normalizedTitle
    lastPage = section.pageIndex
  }

  return deduped
}

function isLikelyHeaderText(text) {
  const normalized = normalizeTitle(text)
  if (!normalized || normalized.length > 80 || !/[A-Za-z]/.test(normalized)) {
    return false
  }
  if (/^(page\s+\d+|\d+|[ivxlcdm]+)$/i.test(normalized)) {
    return false
  }

  const hasKeyword = SECTION_KEYWORD_PATTERN.test(normalized)
  if (hasKeyword) {
    return true
  }

  const words = normalized.split(" ").filter(Boolean)
  if (words.length === 0 || words.length > 14) {
    return false
  }

  const numberedHeader = /^(?:\d+(?:\.\d+){0,3}|[IVXLCM]+)\.?\s+[A-Za-z]/.test(normalized)
  if (numberedHeader) {
    return true
  }

  const titleCaseWords = words.filter((word) => /^[A-Z][A-Za-z0-9/-]*$/.test(word))
  const titleCaseRatio = titleCaseWords.length / words.length
  if (titleCaseRatio >= 0.62 && !/[.!?]$/.test(normalized)) {
    return true
  }

  const upperWords = words.filter((word) => /^[A-Z0-9/-]+$/.test(word))
  const upperRatio = upperWords.length / words.length
  return upperRatio >= 0.8 && words.length <= 8
}

function getLineItems(textContentItems) {
  const buckets = new Map()
  for (const item of textContentItems) {
    const text = normalizeTitle(item?.str)
    if (!text) {
      continue
    }
    const transform = Array.isArray(item?.transform) ? item.transform : null
    const x = Number(transform?.[4])
    const y = Number(transform?.[5])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }

    const key = Math.round(y / 2)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { y, parts: [] }
      buckets.set(key, bucket)
    } else {
      bucket.y = Math.max(bucket.y, y)
    }
    bucket.parts.push({ x, text })
  }

  const lines = []
  for (const bucket of buckets.values()) {
    bucket.parts.sort((a, b) => a.x - b.x)
    const joined = normalizeWhitespace(bucket.parts.map((part) => part.text).join(" "))
    if (!joined) {
      continue
    }
    lines.push({ text: joined, y: bucket.y })
  }

  lines.sort((a, b) => b.y - a.y)
  return lines
}

async function extractHeuristicSections(pdfDoc) {
  const sections = []
  const numPages = Number(pdfDoc?.numPages) || 0
  let lastTitle = ""

  for (let pageIndex = 0; pageIndex < numPages; pageIndex += 1) {
    let lines = []
    let pageHeight = 1
    try {
      const page = await pdfDoc.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: 1 })
      pageHeight = Math.max(Number(viewport?.height) || 0, 1)
      const textContent = await page.getTextContent()
      const items = Array.isArray(textContent?.items) ? textContent.items : []
      lines = getLineItems(items)
    } catch (_error) {
      continue
    }

    let bestCandidate = null
    for (const line of lines) {
      if (!isLikelyHeaderText(line.text)) {
        continue
      }
      const normalized = normalizeTitle(line.text)
      if (!normalized) {
        continue
      }
      const topRatio = Number(line.y) / pageHeight
      const hasKeyword = SECTION_KEYWORD_PATTERN.test(normalized)
      if (!hasKeyword && topRatio < 0.56) {
        continue
      }

      const numberedHeader = /^(?:\d+(?:\.\d+){0,3}|[IVXLCM]+)\.?\s+[A-Za-z]/.test(normalized)
      const score = topRatio + (hasKeyword ? 1 : 0) + (numberedHeader ? 0.35 : 0)
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          title: normalized,
          pageIndex,
          level: 1,
          source: "heuristic",
          score
        }
      }
    }

    if (!bestCandidate) {
      continue
    }
    const normalizedTitle = bestCandidate.title.toLowerCase()
    if (normalizedTitle === lastTitle) {
      continue
    }
    sections.push({
      title: bestCandidate.title,
      pageIndex: bestCandidate.pageIndex,
      level: 1,
      source: "heuristic"
    })
    lastTitle = normalizedTitle
  }

  return dedupeConsecutiveSections(sections)
}

export async function extractOutline(pdfDoc) {
  let outlineItems = null
  try {
    outlineItems = await pdfDoc.getOutline()
  } catch (_error) {
    outlineItems = null
  }
  const sections = []

  if (Array.isArray(outlineItems) && outlineItems.length > 0) {
    await flattenOutlineItems(pdfDoc, outlineItems, 1, sections)
  }

  const normalizedOutlineSections = dedupeConsecutiveSections(
    sections.filter((section) => normalizePageIndex(section.pageIndex) != null && normalizeTitle(section.title))
  )

  if (normalizedOutlineSections.length > 0) {
    return { sections: normalizedOutlineSections }
  }

  const heuristicSections = await extractHeuristicSections(pdfDoc)
  return { sections: heuristicSections }
}
