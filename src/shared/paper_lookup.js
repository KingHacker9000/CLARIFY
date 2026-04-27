import { buildCanonicalPaperKey, buildTitleFingerprint, normalizePaperUrl } from "./paper_identity.js"

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function clampText(value, maxLength = 220) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength).trim()
}

function normalizeHttpUrl(value) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  try {
    const parsed = new URL(text)
    const protocol = parsed.protocol.toLowerCase()
    if (protocol !== "http:" && protocol !== "https:") {
      return ""
    }
    return parsed.toString()
  } catch (_error) {
    return ""
  }
}

function normalizeArxivId(value) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  const fromUrl = text.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i)
  if (fromUrl?.[1]) {
    return fromUrl[1].replace(/\.pdf$/i, "")
  }
  const direct = text.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/i)
  if (direct?.[1]) {
    return direct[1]
  }
  const legacy = text.match(/^([a-z\-]+\/\d{7}(?:v\d+)?)$/i)
  if (legacy?.[1]) {
    return legacy[1]
  }
  return ""
}

function normalizeDoi(value) {
  const text = normalizeText(value).replace(/^doi:\s*/i, "")
  if (!text) {
    return ""
  }
  const fromUrl = text.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i)
  return fromUrl?.[0] ? fromUrl[0].toLowerCase() : ""
}

function toArxivPdfUrl(arxivId) {
  const normalizedId = normalizeArxivId(arxivId)
  if (!normalizedId) {
    return ""
  }
  return `https://arxiv.org/pdf/${normalizedId}.pdf`
}

function canonicalizeProvidedUrl(urlValue) {
  const normalized = normalizeHttpUrl(urlValue)
  if (!normalized) {
    return ""
  }
  const arxivId = normalizeArxivId(normalized)
  if (arxivId) {
    return toArxivPdfUrl(arxivId)
  }
  return normalized
}

function tokenizeTitle(value) {
  const normalized = normalizeText(value).toLowerCase()
  if (!normalized) {
    return []
  }
  return normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function titleScore(left, right) {
  const leftTokens = tokenizeTitle(left)
  const rightTokens = tokenizeTitle(right)
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0
  }
  const leftSet = new Set(leftTokens)
  const rightSet = new Set(rightTokens)
  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1
    }
  }
  const precision = overlap / leftSet.size
  const recall = overlap / rightSet.size
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
  const leftJoined = leftTokens.join(" ")
  const rightJoined = rightTokens.join(" ")
  if (leftJoined === rightJoined) {
    return 1
  }
  const prefixBonus =
    leftJoined.startsWith(rightJoined) || rightJoined.startsWith(leftJoined)
      ? 0.08
      : 0
  return Math.max(0, Math.min(1, f1 + prefixBonus))
}

function normalizePaperInput(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  return {
    title: clampText(source.title, 260),
    url: clampText(source.url, 2200),
    arxivId: clampText(source.arxivId, 48),
    doi: clampText(source.doi, 120),
    searchQuery: clampText(source.searchQuery, 260)
  }
}

function isPdfLikeUrl(urlValue) {
  const url = normalizeHttpUrl(urlValue).toLowerCase()
  if (!url) {
    return false
  }
  if (url.includes(".pdf")) {
    return true
  }
  if (url.includes("arxiv.org/pdf/")) {
    return true
  }
  return false
}

async function fetchArxivCandidates(queryText, maxResults = 5) {
  const query = clampText(queryText, 260)
  if (!query) {
    return []
  }
  const params = new URLSearchParams()
  params.set("search_query", `all:"${query}"`)
  params.set("start", "0")
  params.set("max_results", String(Math.max(1, Math.min(8, maxResults))))
  params.set("sortBy", "relevance")
  params.set("sortOrder", "descending")
  const url = `https://export.arxiv.org/api/query?${params.toString()}`
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/atom+xml, text/xml;q=0.9"
    }
  })
  if (!response.ok) {
    throw new Error(`arXiv lookup failed (${response.status}).`)
  }
  const xmlText = await response.text()
  const parser = new DOMParser()
  const xml = parser.parseFromString(xmlText, "application/xml")
  const entries = Array.from(xml.getElementsByTagName("entry"))
  return entries
    .map((entry) => {
      const titleNode = entry.getElementsByTagName("title")[0]
      const idNode = entry.getElementsByTagName("id")[0]
      const summaryNode = entry.getElementsByTagName("summary")[0]
      const publishedNode = entry.getElementsByTagName("published")[0]
      const authorNodes = Array.from(entry.getElementsByTagName("author"))
      const title = normalizeText(titleNode?.textContent)
      const idText = normalizeText(idNode?.textContent)
      const summary = normalizeText(summaryNode?.textContent)
      const published = normalizeText(publishedNode?.textContent)
      const publishedYear = published && /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null
      let pdfUrl = ""
      const linkNodes = Array.from(entry.getElementsByTagName("link"))
      for (const linkNode of linkNodes) {
        const href = normalizeHttpUrl(linkNode.getAttribute("href") || "")
        const rel = normalizeText(linkNode.getAttribute("rel") || "").toLowerCase()
        const titleAttr = normalizeText(linkNode.getAttribute("title") || "").toLowerCase()
        if (href && (titleAttr === "pdf" || rel === "related")) {
          if (href.includes("arxiv.org/pdf/")) {
            pdfUrl = href.toLowerCase().endsWith(".pdf") ? href : `${href}.pdf`
            break
          }
        }
      }
      if (!pdfUrl) {
        const arxivId = normalizeArxivId(idText)
        pdfUrl = toArxivPdfUrl(arxivId)
      }
      const arxivId = normalizeArxivId(idText || pdfUrl)
      const authors = authorNodes
        .map((authorNode) => normalizeText(authorNode?.getElementsByTagName("name")?.[0]?.textContent))
        .filter(Boolean)
        .slice(0, 12)
      return {
        title,
        url: pdfUrl,
        source: "arxiv_search",
        arxivId,
        authors,
        year: Number.isFinite(publishedYear) ? publishedYear : null,
        venue: "arXiv",
        abstract: summary
      }
    })
    .filter((item) => item.title && item.url)
}

function findOpenAccessPdfUrl(work) {
  if (!work || typeof work !== "object") {
    return ""
  }
  const openAccessUrl = normalizeHttpUrl(work?.open_access?.oa_url)
  if (openAccessUrl && isPdfLikeUrl(openAccessUrl)) {
    return openAccessUrl
  }
  const primaryPdf = normalizeHttpUrl(work?.primary_location?.pdf_url)
  if (primaryPdf) {
    return primaryPdf
  }
  const locations = Array.isArray(work?.locations) ? work.locations : []
  for (const location of locations) {
    const locationPdf = normalizeHttpUrl(location?.pdf_url)
    if (locationPdf) {
      return locationPdf
    }
    const sourceUrl = normalizeHttpUrl(location?.landing_page_url)
    if (sourceUrl && isPdfLikeUrl(sourceUrl)) {
      return sourceUrl
    }
  }
  if (openAccessUrl) {
    return openAccessUrl
  }
  return ""
}

async function fetchOpenAlexCandidatesByTitle(queryText, maxResults = 6) {
  const query = clampText(queryText, 260)
  if (!query) {
    return []
  }
  const params = new URLSearchParams()
  params.set("search", query)
  params.set("per-page", String(Math.max(1, Math.min(10, maxResults))))
  params.set(
    "select",
    "display_name,doi,publication_year,open_access,primary_location,locations"
  )
  const url = `https://api.openalex.org/works?${params.toString()}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OpenAlex lookup failed (${response.status}).`)
  }
  const payload = await response.json()
  const results = Array.isArray(payload?.results) ? payload.results : []
  return results
    .map((result) => {
      const title = normalizeText(result?.display_name)
      const pdfUrl = findOpenAccessPdfUrl(result)
      const doi = normalizeDoi(result?.doi)
      const year = Number.isFinite(Number(result?.publication_year)) ? Math.floor(Number(result.publication_year)) : null
      const venue = normalizeText(
        result?.primary_location?.source?.display_name ||
        result?.best_oa_location?.source?.display_name ||
        ""
      )
      const fallbackDoiUrl = doi ? `https://doi.org/${doi}` : ""
      const resolvedUrl = pdfUrl || fallbackDoiUrl
      const openAccessState = result?.open_access?.is_oa ? "open" : "closed"
      return {
        title,
        url: resolvedUrl,
        source: pdfUrl ? "openalex_pdf" : "openalex_doi",
        doi,
        year,
        venue,
        openAccessState
      }
    })
    .filter((item) => item.title && item.url)
}

async function fetchOpenAlexCandidateByDoi(doi) {
  const normalizedDoi = normalizeDoi(doi)
  if (!normalizedDoi) {
    return null
  }
  const params = new URLSearchParams()
  params.set("filter", `doi:${normalizedDoi}`)
  params.set("per-page", "1")
  params.set(
    "select",
    "display_name,doi,publication_year,open_access,primary_location,locations"
  )
  const url = `https://api.openalex.org/works?${params.toString()}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OpenAlex DOI lookup failed (${response.status}).`)
  }
  const payload = await response.json()
  const result = Array.isArray(payload?.results) ? payload.results[0] : null
  if (!result) {
    return null
  }
  const title = normalizeText(result?.display_name)
  const pdfUrl = findOpenAccessPdfUrl(result)
  const finalDoi = normalizeDoi(result?.doi || normalizedDoi)
  const resolvedUrl = pdfUrl || (finalDoi ? `https://doi.org/${finalDoi}` : "")
  if (!resolvedUrl) {
    return null
  }
  const year = Number.isFinite(Number(result?.publication_year)) ? Math.floor(Number(result.publication_year)) : null
  const venue = normalizeText(
    result?.primary_location?.source?.display_name ||
    result?.best_oa_location?.source?.display_name ||
    ""
  )
  return {
    title,
    url: resolvedUrl,
    source: pdfUrl ? "openalex_doi_pdf" : "openalex_doi",
    doi: finalDoi,
    year,
    venue,
    openAccessState: result?.open_access?.is_oa ? "open" : "closed"
  }
}

function pickBestCandidate(candidates, expectedTitle) {
  const safeCandidates = Array.isArray(candidates) ? candidates : []
  if (safeCandidates.length === 0) {
    return null
  }
  const expected = normalizeText(expectedTitle)
  let best = null
  for (const candidate of safeCandidates) {
    const candidateTitle = normalizeText(candidate?.title)
    const candidateUrl = normalizeHttpUrl(candidate?.url)
    if (!candidateTitle || !candidateUrl) {
      continue
    }
    const similarity = titleScore(expected, candidateTitle)
    const pdfBonus = isPdfLikeUrl(candidateUrl) ? 0.12 : 0
    const sourceBonus = candidate?.source?.startsWith("arxiv") ? 0.08 : 0
    const score = Math.max(0, Math.min(1, similarity + pdfBonus + sourceBonus))
    if (!best || score > best.score) {
      best = {
        ...candidate,
        score
      }
    }
  }
  return best
}

async function resolveOnePaperLink(paper) {
  const normalized = normalizePaperInput(paper)
  const directUrl = canonicalizeProvidedUrl(normalized.url)
  if (directUrl) {
    return {
      ...paper,
      resolvedUrl: directUrl,
      resolutionSource: "provided",
      resolutionConfidence: "high",
      lookupWarning: ""
    }
  }

  const arxivId = normalizeArxivId(normalized.arxivId)
  if (arxivId) {
    return {
      ...paper,
      resolvedUrl: toArxivPdfUrl(arxivId),
      resolutionSource: "arxiv_id",
      resolutionConfidence: "high",
      lookupWarning: ""
    }
  }

  const doi = normalizeDoi(normalized.doi)
  if (doi) {
    try {
      const byDoi = await fetchOpenAlexCandidateByDoi(doi)
      if (byDoi?.url) {
        return {
          ...paper,
          resolvedUrl: byDoi.url,
          resolutionSource: byDoi.source || "openalex_doi",
          resolutionConfidence: isPdfLikeUrl(byDoi.url) ? "high" : "medium",
          lookupWarning: isPdfLikeUrl(byDoi.url) ? "" : "Resolved DOI landing page (not a direct PDF)."
        }
      }
    } catch (_error) {
      // Fall through to title search.
    }
  }

  const searchQuery = normalized.searchQuery || normalized.title
  if (!searchQuery) {
    return {
      ...paper,
      resolvedUrl: "",
      resolutionSource: "none",
      resolutionConfidence: "low",
      lookupWarning: "Missing title/search query for lookup."
    }
  }

  const [arxivCandidates, openAlexCandidates] = await Promise.allSettled([
    fetchArxivCandidates(searchQuery, 6),
    fetchOpenAlexCandidatesByTitle(searchQuery, 6)
  ])

  const combinedCandidates = []
  if (arxivCandidates.status === "fulfilled") {
    combinedCandidates.push(...arxivCandidates.value)
  }
  if (openAlexCandidates.status === "fulfilled") {
    combinedCandidates.push(...openAlexCandidates.value)
  }

  const best = pickBestCandidate(combinedCandidates, normalized.title || searchQuery)
  if (best && best.score >= 0.44) {
    return {
      ...paper,
      resolvedUrl: best.url,
      resolutionSource: best.source || "search",
      resolutionConfidence: best.score >= 0.75 ? "high" : best.score >= 0.58 ? "medium" : "low",
      lookupWarning: isPdfLikeUrl(best.url) ? "" : "Resolved to a publication landing page (not direct PDF)."
    }
  }

  return {
    ...paper,
    resolvedUrl: "",
    resolutionSource: "none",
    resolutionConfidence: "low",
    lookupWarning: "Could not confidently resolve a paper URL."
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const source = Array.isArray(items) ? items : []
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1))
  const results = new Array(source.length)
  let nextIndex = 0

  async function worker() {
    while (true) {
      const currentIndex = nextIndex
      nextIndex += 1
      if (currentIndex >= source.length) {
        return
      }
      results[currentIndex] = await mapper(source[currentIndex], currentIndex)
    }
  }

  const workers = []
  for (let index = 0; index < Math.min(limit, source.length); index += 1) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
}

export async function resolveImportedPaperLinks(papers, options = {}) {
  const source = Array.isArray(papers) ? papers : []
  const maxLookups = Number.isFinite(Number(options.maxLookups))
    ? Math.max(1, Math.min(220, Math.floor(Number(options.maxLookups))))
    : 120
  const concurrency = Number.isFinite(Number(options.concurrency))
    ? Math.max(1, Math.min(8, Math.floor(Number(options.concurrency))))
    : 4

  const truncated = source.slice(0, maxLookups)
  const warnings = []
  const resolvedPapers = await mapWithConcurrency(truncated, concurrency, async (paper) => {
    try {
      const resolved = await resolveOnePaperLink(paper)
      if (resolved.lookupWarning) {
        const label = clampText(resolved.title || resolved.searchQuery || "Untitled paper", 120)
        warnings.push(`${label}: ${resolved.lookupWarning}`)
      }
      return resolved
    } catch (error) {
      const label = clampText(paper?.title || paper?.searchQuery || "Untitled paper", 120)
      warnings.push(`${label}: lookup error (${clampText(error?.message, 120)}).`)
      return {
        ...paper,
        resolvedUrl: "",
        resolutionSource: "error",
        resolutionConfidence: "low",
        lookupWarning: "Lookup failed."
      }
    }
  })

  if (source.length > maxLookups) {
    warnings.push(`Skipped ${source.length - maxLookups} papers due to lookup limit.`)
  }

  return {
    resolvedPapers,
    warnings
  }
}

function splitTerms(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean)
}

function buildDiscoveryCandidate(entry, { queryText = "", runId = "" } = {}) {
  const source = entry && typeof entry === "object" ? entry : {}
  const doi = normalizeDoi(source.doi)
  const arxivId = normalizeArxivId(source.arxivId || source.url)
  const url = normalizePaperUrl(source.url)
  const title = clampText(source.title, 320) || "Untitled candidate"
  const canonicalKey =
    buildCanonicalPaperKey({
      doi,
      arxivId,
      url,
      title
    }) || `title:${buildTitleFingerprint(title)}`
  return {
    canonicalKey,
    title,
    authors: Array.isArray(source.authors)
      ? source.authors.map((author) => clampText(author, 120)).filter(Boolean).slice(0, 20)
      : [],
    year: Number.isFinite(Number(source.year)) ? Math.max(1800, Math.min(2100, Math.floor(Number(source.year)))) : null,
    venue: clampText(source.venue, 160),
    doi,
    arxivId,
    url,
    abstract: clampText(source.abstract, 2600),
    source: clampText(source.source, 80) || "search",
    sourceRank: Number.isFinite(Number(source.sourceRank))
      ? Math.max(0, Math.min(100, Math.floor(Number(source.sourceRank))))
      : 0,
    openAccessState: source.openAccessState === "open" || source.openAccessState === "closed" ? source.openAccessState : "unknown",
    retrievalState: "new",
    duplicateOf: "",
    queryText: clampText(queryText, 260),
    runId: clampText(runId, 120)
  }
}

function matchesTypeFilter(candidate, typeFilter) {
  const filter = normalizeText(typeFilter).toLowerCase()
  if (!filter || filter === "all") {
    return true
  }
  const venue = normalizeText(candidate?.venue).toLowerCase()
  const source = normalizeText(candidate?.source).toLowerCase()
  if (filter === "preprint") {
    return source.includes("arxiv") || venue.includes("arxiv")
  }
  if (filter === "conference") {
    return /\b(conf|conference|proceedings|cvpr|neurips|iclr|icml|eccv|aaai|acl|emnlp)\b/.test(venue)
  }
  if (filter === "journal") {
    return /\b(journal|transactions|letters|review)\b/.test(venue)
  }
  return true
}

function applyDiscoveryFilters(candidates, filters = {}) {
  const source = Array.isArray(candidates) ? candidates : []
  const mustHaveTerms = splitTerms(filters.mustHave)
  const excludeTerms = splitTerms(filters.excludeTerms)
  const venueFilter = normalizeText(filters.venueFilter).toLowerCase()
  const minYear = Number.isFinite(Number(filters.yearFrom)) ? Math.floor(Number(filters.yearFrom)) : null
  const maxYear = Number.isFinite(Number(filters.yearTo)) ? Math.floor(Number(filters.yearTo)) : null
  const typeFilter = normalizeText(filters.typeFilter).toLowerCase()
  return source.filter((candidate) => {
    const title = normalizeText(candidate?.title).toLowerCase()
    const abstract = normalizeText(candidate?.abstract).toLowerCase()
    const venue = normalizeText(candidate?.venue).toLowerCase()
    const haystack = `${title} ${abstract} ${venue}`.trim()
    if (mustHaveTerms.length > 0 && !mustHaveTerms.every((term) => haystack.includes(term))) {
      return false
    }
    if (excludeTerms.some((term) => haystack.includes(term))) {
      return false
    }
    if (venueFilter && !venue.includes(venueFilter)) {
      return false
    }
    const year = Number(candidate?.year)
    if (Number.isFinite(minYear) && (!Number.isFinite(year) || year < minYear)) {
      return false
    }
    if (Number.isFinite(maxYear) && (!Number.isFinite(year) || year > maxYear)) {
      return false
    }
    if (!matchesTypeFilter(candidate, typeFilter)) {
      return false
    }
    return true
  })
}

function dedupeDiscoveryCandidates(candidates) {
  const source = Array.isArray(candidates) ? candidates : []
  const byIdentity = new Map()
  for (const candidate of source) {
    const canonicalKey = normalizeText(candidate?.canonicalKey)
    const identity =
      canonicalKey ||
      normalizePaperUrl(candidate?.url).toLowerCase() ||
      `title:${buildTitleFingerprint(candidate?.title)}`
    if (!identity) {
      continue
    }
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, candidate)
      continue
    }
    const existing = byIdentity.get(identity)
    if (Number(candidate?.sourceRank || 0) > Number(existing?.sourceRank || 0)) {
      byIdentity.set(identity, candidate)
    }
  }
  return [...byIdentity.values()]
}

export async function searchDiscoveryCandidates(query, options = {}) {
  const keywords = normalizeText(query?.keywords || query?.query || query?.q)
  const mustHave = normalizeText(query?.mustHave)
  const queryText = [keywords, mustHave].filter(Boolean).join(" ").trim()
  if (!queryText) {
    return { candidates: [], warnings: ["Query is empty."], queryText: "" }
  }
  const maxResults = Number.isFinite(Number(options.maxResults))
    ? Math.max(5, Math.min(60, Math.floor(Number(options.maxResults))))
    : 30
  const runId = normalizeText(options.runId)
  const [arxivRes, openAlexRes] = await Promise.allSettled([
    fetchArxivCandidates(queryText, Math.max(3, Math.floor(maxResults / 2))),
    fetchOpenAlexCandidatesByTitle(queryText, Math.max(3, Math.floor(maxResults / 2)))
  ])
  const warnings = []
  if (arxivRes.status === "rejected") {
    warnings.push(`arXiv search failed: ${clampText(arxivRes.reason?.message, 140)}`)
  }
  if (openAlexRes.status === "rejected") {
    warnings.push(`OpenAlex search failed: ${clampText(openAlexRes.reason?.message, 140)}`)
  }
  const raw = [
    ...(arxivRes.status === "fulfilled" ? arxivRes.value : []),
    ...(openAlexRes.status === "fulfilled" ? openAlexRes.value : [])
  ].map((entry, index) =>
    buildDiscoveryCandidate(
      {
        ...entry,
        sourceRank: Math.max(1, 100 - index * 2)
      },
      { queryText, runId }
    )
  )
  const filtered = applyDiscoveryFilters(raw, query || {})
  const deduped = dedupeDiscoveryCandidates(filtered).slice(0, maxResults)
  return {
    candidates: deduped,
    warnings,
    queryText
  }
}

function normalizeOpenAlexWorkId(value) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  const direct = text.match(/^W\d+$/i)
  if (direct?.[0]) {
    return direct[0].toUpperCase()
  }
  const fromUrl = text.match(/openalex\.org\/(W\d+)/i)
  if (fromUrl?.[1]) {
    return fromUrl[1].toUpperCase()
  }
  return ""
}

async function fetchOpenAlexWorkById(workId) {
  const normalized = normalizeOpenAlexWorkId(workId)
  if (!normalized) {
    return null
  }
  const response = await fetch(`https://api.openalex.org/works/${normalized}`)
  if (!response.ok) {
    return null
  }
  return response.json()
}

async function resolveOpenAlexSeedWorkId(seedPaper) {
  const doi = normalizeDoi(seedPaper?.doi)
  if (!doi) {
    return ""
  }
  const params = new URLSearchParams()
  params.set("filter", `doi:${doi}`)
  params.set("per-page", "1")
  params.set("select", "id")
  const response = await fetch(`https://api.openalex.org/works?${params.toString()}`)
  if (!response.ok) {
    return ""
  }
  const payload = await response.json()
  const result = Array.isArray(payload?.results) ? payload.results[0] : null
  return normalizeOpenAlexWorkId(result?.id)
}

function candidateFromOpenAlexWork(work, direction, seedPaperId = "", runId = "") {
  const source = work && typeof work === "object" ? work : {}
  const title = normalizeText(source?.display_name)
  const doi = normalizeDoi(source?.doi)
  const pdfUrl = findOpenAccessPdfUrl(source)
  const finalUrl = normalizePaperUrl(pdfUrl || (doi ? `https://doi.org/${doi}` : ""))
  const year = Number.isFinite(Number(source?.publication_year)) ? Math.floor(Number(source.publication_year)) : null
  const venue = normalizeText(
    source?.primary_location?.source?.display_name ||
    source?.host_venue?.display_name ||
    ""
  )
  const authors = Array.isArray(source?.authorships)
    ? source.authorships
        .map((entry) => normalizeText(entry?.author?.display_name))
        .filter(Boolean)
        .slice(0, 12)
    : []
  const arxivId = normalizeArxivId(finalUrl || "")
  const openAccessState = source?.open_access?.is_oa ? "open" : "closed"
  return buildDiscoveryCandidate(
    {
      title,
      doi,
      arxivId,
      url: finalUrl,
      year,
      venue,
      authors,
      source: direction === "backward" ? "citation_backward" : "citation_forward",
      sourceRank: 70,
      openAccessState,
      abstract: ""
    },
    { queryText: `seed:${normalizeText(seedPaperId)}`, runId }
  )
}

export async function expandDiscoveryFromSeedPaper(seedPaper, options = {}) {
  const direction = normalizeText(options.direction).toLowerCase() || "both"
  const maxResults = Number.isFinite(Number(options.maxResults))
    ? Math.max(5, Math.min(40, Math.floor(Number(options.maxResults))))
    : 20
  const runId = normalizeText(options.runId)
  const seedWorkId = await resolveOpenAlexSeedWorkId(seedPaper)
  if (!seedWorkId) {
    return {
      candidates: [],
      edges: [],
      warnings: ["Seed paper requires a DOI to run citation expansion."]
    }
  }
  const warnings = []
  const candidateMap = new Map()
  const edges = []
  const seedKey = buildCanonicalPaperKey(seedPaper) || `title:${buildTitleFingerprint(seedPaper?.title)}`
  const shouldBackward = direction === "both" || direction === "backward"
  const shouldForward = direction === "both" || direction === "forward"

  if (shouldBackward) {
    const seedWork = await fetchOpenAlexWorkById(seedWorkId)
    const referencedIds = Array.isArray(seedWork?.referenced_works)
      ? seedWork.referenced_works.map((value) => normalizeOpenAlexWorkId(value)).filter(Boolean).slice(0, maxResults)
      : []
    const referencedWorks = await mapWithConcurrency(referencedIds, 4, async (workId) => fetchOpenAlexWorkById(workId))
    for (const work of referencedWorks) {
      if (!work) {
        continue
      }
      const candidate = candidateFromOpenAlexWork(work, "backward", seedPaper?.id || "", runId)
      if (!candidate.canonicalKey) {
        continue
      }
      candidateMap.set(candidate.canonicalKey, candidate)
      edges.push({
        from: seedKey,
        to: candidate.canonicalKey,
        direction: "backward",
        source: "openalex"
      })
    }
  }

  if (shouldForward) {
    const params = new URLSearchParams()
    params.set("filter", `cites:${seedWorkId}`)
    params.set("per-page", String(maxResults))
    params.set(
      "select",
      "id,display_name,doi,publication_year,open_access,primary_location,host_venue,authorships"
    )
    const response = await fetch(`https://api.openalex.org/works?${params.toString()}`)
    if (!response.ok) {
      warnings.push(`Forward citation lookup failed (${response.status}).`)
    } else {
      const payload = await response.json()
      const works = Array.isArray(payload?.results) ? payload.results : []
      for (const work of works.slice(0, maxResults)) {
        const candidate = candidateFromOpenAlexWork(work, "forward", seedPaper?.id || "", runId)
        if (!candidate.canonicalKey) {
          continue
        }
        candidateMap.set(candidate.canonicalKey, candidate)
        edges.push({
          from: seedKey,
          to: candidate.canonicalKey,
          direction: "forward",
          source: "openalex"
        })
      }
    }
  }

  return {
    candidates: [...candidateMap.values()],
    edges,
    warnings
  }
}
