import { makeId } from "./models.js"
import {
  addProjectPaper,
  get,
  getProjectPapers,
  set,
  updateProjectPaper
} from "./storage.js"
import { buildCanonicalPaperKey, buildTitleFingerprint, normalizeArxivId, normalizeDoi, normalizePaperUrl } from "./paper_identity.js"

const PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY = "projectDiscoveryCandidatesByProjectId"
const PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY = "projectScreenReasonLibraryByProjectId"
const PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY = "projectSavedSearchesByProjectId"
const PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY = "projectPipelineJobsByProjectId"
const PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY = "projectCitationGraphByProjectId"

const DISCOVERY_OPEN_ACCESS_STATES = new Set(["open", "closed", "unknown"])
const DISCOVERY_RETRIEVAL_STATES = new Set(["new", "queued", "promoted", "duplicate", "screened", "error"])
const PIPELINE_JOB_TYPES = new Set(["candidate_ingest", "dedup_pass", "screening_suggest", "fulltext_fetch", "matrix_fill"])
const PIPELINE_JOB_STATES = new Set(["queued", "running", "done", "failed", "retry"])

const DEFAULT_SCREEN_REASONS = Object.freeze([
  { code: "out_of_scope", label: "Out of scope", description: "Paper does not match project task/domain.", isDefault: true },
  { code: "wrong_modality", label: "Wrong modality", description: "Input/output modality does not fit project.", isDefault: true },
  { code: "weak_evidence", label: "Weak evidence", description: "Insufficient experimental support.", isDefault: true },
  { code: "not_peer_reviewed", label: "Not peer reviewed", description: "Source quality does not meet inclusion bar.", isDefault: true },
  { code: "duplicate", label: "Duplicate", description: "Duplicate of another record.", isDefault: true },
  { code: "no_full_text", label: "No full text", description: "Full paper is not accessible.", isDefault: true },
  { code: "language", label: "Language mismatch", description: "Paper language is not supported for this review.", isDefault: true }
])

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function truncateText(value, maxLength = 220) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength).trim()
}

function normalizeProjectId(projectId) {
  return normalizeText(projectId)
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function normalizeStringList(value, maxItems = 16, maxLength = 120) {
  const source = Array.isArray(value) ? value : []
  return source
    .map((item) => truncateText(item, maxLength))
    .filter(Boolean)
    .slice(0, Math.max(0, maxItems))
}

function normalizeNumber(value, fallback = 0, min = 0, max = 100) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.max(min, Math.min(max, numeric))
}

function normalizeCandidateCanonicalKey(source) {
  const manual = truncateText(source?.canonicalKey, 420)
  if (manual) {
    return manual
  }
  const generated = buildCanonicalPaperKey({
    doi: source?.doi,
    arxivId: source?.arxivId,
    url: source?.url,
    title: source?.title,
    docId: source?.url
  })
  if (generated) {
    return generated
  }
  const fingerprint = buildTitleFingerprint(source?.title)
  return fingerprint ? `title:${fingerprint}` : ""
}

function normalizeDiscoveryCandidate(entry, requiredProjectId = "") {
  const source = ensureObject(entry)
  const now = Date.now()
  const createdAt = normalizeTimestamp(source.createdAt, now)
  const updatedAt = normalizeTimestamp(source.updatedAt, now)
  const openAccessStateRaw = normalizeText(source.openAccessState).toLowerCase()
  const retrievalStateRaw = normalizeText(source.retrievalState).toLowerCase()
  return {
    id: truncateText(source.id, 120) || makeId("cand"),
    projectId: normalizeProjectId(source.projectId) || requiredProjectId,
    canonicalKey: normalizeCandidateCanonicalKey(source),
    title: truncateText(source.title, 320) || "Untitled candidate",
    authors: normalizeStringList(source.authors, 20, 120),
    year: Number.isFinite(Number(source.year)) ? Math.max(1800, Math.min(2100, Math.floor(Number(source.year)))) : null,
    venue: truncateText(source.venue, 160),
    doi: normalizeDoi(source.doi),
    arxivId: normalizeArxivId(source.arxivId || source.url),
    url: normalizePaperUrl(source.url),
    abstract: truncateText(source.abstract, 2600),
    source: truncateText(source.source, 80) || "unknown",
    sourceRank: Math.floor(normalizeNumber(source.sourceRank, 0, 0, 100)),
    openAccessState: DISCOVERY_OPEN_ACCESS_STATES.has(openAccessStateRaw) ? openAccessStateRaw : "unknown",
    retrievalState: DISCOVERY_RETRIEVAL_STATES.has(retrievalStateRaw) ? retrievalStateRaw : "new",
    duplicateOf: truncateText(source.duplicateOf, 120),
    runId: truncateText(source.runId, 120),
    seedPaperId: truncateText(source.seedPaperId, 120),
    createdAt,
    updatedAt
  }
}

function normalizeCandidates(list, projectId) {
  const source = Array.isArray(list) ? list : []
  const normalized = []
  const seenIds = new Set()
  for (const raw of source) {
    const candidate = normalizeDiscoveryCandidate(raw, projectId)
    if (!candidate.projectId || candidate.projectId !== projectId || !candidate.id || seenIds.has(candidate.id)) {
      continue
    }
    seenIds.add(candidate.id)
    normalized.push(candidate)
    if (normalized.length >= 4000) {
      break
    }
  }
  return normalized
}

async function getCandidatesByProjectMap() {
  const values = await get({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: {} })
  const source = ensureObject(values?.[PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY])
  const next = {}
  for (const [projectId, list] of Object.entries(source)) {
    const normalizedProjectId = normalizeProjectId(projectId)
    if (!normalizedProjectId) {
      continue
    }
    next[normalizedProjectId] = normalizeCandidates(list, normalizedProjectId)
  }
  return next
}

function normalizeReasonEntry(entry) {
  const source = ensureObject(entry)
  const code = truncateText(source.code, 80).toLowerCase().replace(/[^a-z0-9_]+/g, "_")
  return {
    code: code || `reason_${Date.now().toString(36)}`,
    label: truncateText(source.label, 80) || "Unnamed reason",
    description: truncateText(source.description, 220),
    isDefault: Boolean(source.isDefault)
  }
}

function normalizeReasonLibrary(value) {
  const source = Array.isArray(value) ? value : []
  const next = []
  const seen = new Set()
  for (const raw of source) {
    const reason = normalizeReasonEntry(raw)
    if (!reason.code || seen.has(reason.code)) {
      continue
    }
    seen.add(reason.code)
    next.push(reason)
    if (next.length >= 60) {
      break
    }
  }
  if (next.length === 0) {
    return DEFAULT_SCREEN_REASONS.map((entry) => ({ ...entry }))
  }
  return next
}

async function getReasonLibraryByProjectMap() {
  const values = await get({ [PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY]: {} })
  const source = ensureObject(values?.[PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY])
  const next = {}
  for (const [projectId, list] of Object.entries(source)) {
    const normalizedProjectId = normalizeProjectId(projectId)
    if (!normalizedProjectId) {
      continue
    }
    next[normalizedProjectId] = normalizeReasonLibrary(list)
  }
  return next
}

function normalizeSavedSearch(entry, requiredProjectId = "") {
  const source = ensureObject(entry)
  const now = Date.now()
  return {
    id: truncateText(source.id, 120) || makeId("search"),
    projectId: normalizeProjectId(source.projectId) || requiredProjectId,
    name: truncateText(source.name, 120) || "Untitled search",
    keywords: truncateText(source.keywords, 240),
    mustHave: truncateText(source.mustHave, 240),
    excludeTerms: truncateText(source.excludeTerms, 240),
    yearFrom: Number.isFinite(Number(source.yearFrom)) ? Math.max(1800, Math.min(2100, Math.floor(Number(source.yearFrom)))) : null,
    yearTo: Number.isFinite(Number(source.yearTo)) ? Math.max(1800, Math.min(2100, Math.floor(Number(source.yearTo)))) : null,
    venueFilter: truncateText(source.venueFilter, 140),
    typeFilter: truncateText(source.typeFilter, 40) || "all",
    autoEnabled: Boolean(source.autoEnabled),
    intervalDays: Math.max(1, Math.min(30, Number.isFinite(Number(source.intervalDays)) ? Math.floor(Number(source.intervalDays)) : 7)),
    lastRunAt: Number.isFinite(Number(source.lastRunAt)) ? Math.floor(Number(source.lastRunAt)) : null,
    nextRunAt: Number.isFinite(Number(source.nextRunAt)) ? Math.floor(Number(source.nextRunAt)) : null,
    createdAt: normalizeTimestamp(source.createdAt, now),
    updatedAt: normalizeTimestamp(source.updatedAt, now)
  }
}

function normalizeSavedSearches(value, projectId) {
  const source = Array.isArray(value) ? value : []
  const next = []
  const seen = new Set()
  for (const raw of source) {
    const search = normalizeSavedSearch(raw, projectId)
    if (!search.id || seen.has(search.id) || search.projectId !== projectId) {
      continue
    }
    seen.add(search.id)
    next.push(search)
    if (next.length >= 80) {
      break
    }
  }
  return next
}

async function getSavedSearchesByProjectMap() {
  const values = await get({ [PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY]: {} })
  const source = ensureObject(values?.[PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY])
  const next = {}
  for (const [projectId, list] of Object.entries(source)) {
    const normalizedProjectId = normalizeProjectId(projectId)
    if (!normalizedProjectId) {
      continue
    }
    next[normalizedProjectId] = normalizeSavedSearches(list, normalizedProjectId)
  }
  return next
}

function normalizeJob(entry, requiredProjectId = "") {
  const source = ensureObject(entry)
  const now = Date.now()
  const type = PIPELINE_JOB_TYPES.has(source.type) ? source.type : "candidate_ingest"
  const stateRaw = normalizeText(source.state).toLowerCase()
  return {
    id: truncateText(source.id, 120) || makeId("job"),
    projectId: normalizeProjectId(source.projectId) || requiredProjectId,
    type,
    state: PIPELINE_JOB_STATES.has(stateRaw) ? stateRaw : "queued",
    attempts: Math.max(0, Math.min(20, Number.isFinite(Number(source.attempts)) ? Math.floor(Number(source.attempts)) : 0)),
    maxAttempts: Math.max(1, Math.min(20, Number.isFinite(Number(source.maxAttempts)) ? Math.floor(Number(source.maxAttempts)) : 3)),
    payload: ensureObject(source.payload),
    lastError: truncateText(source.lastError, 220),
    errorLog: normalizeStringList(source.errorLog, 40, 220),
    nextRetryAt: Number.isFinite(Number(source.nextRetryAt)) ? Math.floor(Number(source.nextRetryAt)) : null,
    createdAt: normalizeTimestamp(source.createdAt, now),
    updatedAt: normalizeTimestamp(source.updatedAt, now)
  }
}

function normalizeJobs(value, projectId) {
  const source = Array.isArray(value) ? value : []
  const next = []
  const seen = new Set()
  for (const raw of source) {
    const job = normalizeJob(raw, projectId)
    if (!job.id || seen.has(job.id) || job.projectId !== projectId) {
      continue
    }
    seen.add(job.id)
    next.push(job)
    if (next.length >= 500) {
      break
    }
  }
  return next
}

async function getJobsByProjectMap() {
  const values = await get({ [PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY]: {} })
  const source = ensureObject(values?.[PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY])
  const next = {}
  for (const [projectId, list] of Object.entries(source)) {
    const normalizedProjectId = normalizeProjectId(projectId)
    if (!normalizedProjectId) {
      continue
    }
    next[normalizedProjectId] = normalizeJobs(list, normalizedProjectId)
  }
  return next
}

function normalizeCitationGraph(entry) {
  const source = ensureObject(entry)
  const nodesRaw = Array.isArray(source.nodes) ? source.nodes : []
  const edgesRaw = Array.isArray(source.edges) ? source.edges : []
  const nodes = []
  const seenNodeIds = new Set()
  for (const rawNode of nodesRaw) {
    const node = ensureObject(rawNode)
    const normalized = {
      id: truncateText(node.id, 120) || makeId("node"),
      label: truncateText(node.label, 200),
      canonicalKey: truncateText(node.canonicalKey, 420),
      url: normalizePaperUrl(node.url),
      type: truncateText(node.type, 40) || "candidate",
      paperId: truncateText(node.paperId, 120),
      candidateId: truncateText(node.candidateId, 120)
    }
    if (!normalized.id || seenNodeIds.has(normalized.id)) {
      continue
    }
    seenNodeIds.add(normalized.id)
    nodes.push(normalized)
    if (nodes.length >= 2000) {
      break
    }
  }
  const edges = []
  const seenEdges = new Set()
  for (const rawEdge of edgesRaw) {
    const edge = ensureObject(rawEdge)
    const normalized = {
      id: truncateText(edge.id, 120) || makeId("edge"),
      from: truncateText(edge.from, 120),
      to: truncateText(edge.to, 120),
      direction: truncateText(edge.direction, 24) || "forward",
      source: truncateText(edge.source, 80) || "unknown"
    }
    if (!normalized.from || !normalized.to) {
      continue
    }
    const dedupKey = `${normalized.from}|${normalized.to}|${normalized.direction}`
    if (seenEdges.has(dedupKey)) {
      continue
    }
    seenEdges.add(dedupKey)
    edges.push(normalized)
    if (edges.length >= 4000) {
      break
    }
  }
  return {
    nodes,
    edges,
    updatedAt: normalizeTimestamp(source.updatedAt, Date.now())
  }
}

async function getCitationGraphByProjectMap() {
  const values = await get({ [PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY]: {} })
  const source = ensureObject(values?.[PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY])
  const next = {}
  for (const [projectId, graph] of Object.entries(source)) {
    const normalizedProjectId = normalizeProjectId(projectId)
    if (!normalizedProjectId) {
      continue
    }
    next[normalizedProjectId] = normalizeCitationGraph(graph)
  }
  return next
}

function candidateIdentity(candidate) {
  const canonical = truncateText(candidate?.canonicalKey, 420)
  if (canonical) {
    return `canonical:${canonical}`
  }
  const doi = normalizeDoi(candidate?.doi)
  if (doi) {
    return `doi:${doi}`
  }
  const arxivId = normalizeArxivId(candidate?.arxivId || candidate?.url)
  if (arxivId) {
    return `arxiv:${arxivId}`
  }
  const url = normalizePaperUrl(candidate?.url).toLowerCase()
  if (url) {
    return `url:${url}`
  }
  const fingerprint = buildTitleFingerprint(candidate?.title)
  return fingerprint ? `title:${fingerprint}` : ""
}

function dedupeCandidatesList(candidates) {
  const source = Array.isArray(candidates) ? candidates : []
  const identityToPrimary = new Map()
  const next = []
  let duplicateCount = 0
  for (const candidate of source) {
    const normalized = normalizeDiscoveryCandidate(candidate, candidate?.projectId || "")
    const identity = candidateIdentity(normalized)
    const primaryId = identity ? identityToPrimary.get(identity) : null
    if (!primaryId) {
      if (identity) {
        identityToPrimary.set(identity, normalized.id)
      }
      next.push({ ...normalized, duplicateOf: "" })
      continue
    }
    duplicateCount += 1
    next.push({
      ...normalized,
      duplicateOf: primaryId,
      retrievalState: "duplicate",
      updatedAt: Date.now()
    })
  }
  return { candidates: next, duplicateCount }
}

export async function listProjectDiscoveryCandidates(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return []
  }
  const byProject = await getCandidatesByProjectMap()
  const candidates = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  return [...candidates].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

export async function upsertProjectDiscoveryCandidate(projectId, candidate) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return null
  }
  const byProject = await getCandidatesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const normalized = normalizeDiscoveryCandidate(
    {
      ...(ensureObject(candidate)),
      projectId: normalizedProjectId,
      updatedAt: Date.now()
    },
    normalizedProjectId
  )
  const identity = candidateIdentity(normalized)
  const index = current.findIndex(
    (entry) =>
      entry.id === normalized.id ||
      (identity && candidateIdentity(entry) === identity)
  )
  if (index < 0) {
    byProject[normalizedProjectId] = [normalized, ...current]
  } else {
    const merged = normalizeDiscoveryCandidate(
      {
        ...current[index],
        ...normalized,
        id: current[index].id,
        createdAt: current[index].createdAt || normalized.createdAt,
        updatedAt: Date.now()
      },
      normalizedProjectId
    )
    const next = [...current]
    next[index] = merged
    byProject[normalizedProjectId] = next
  }
  const didPersist = await set({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: byProject })
  return didPersist ? normalizeDiscoveryCandidate(normalized, normalizedProjectId) : null
}

export async function upsertProjectDiscoveryCandidates(projectId, candidates, options = {}) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return { createdCount: 0, updatedCount: 0, candidates: [] }
  }
  const runId = truncateText(options?.runId, 120) || makeId("run")
  const source = Array.isArray(candidates) ? candidates : []
  const byProject = await getCandidatesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const next = [...current]
  let createdCount = 0
  let updatedCount = 0
  for (const rawCandidate of source) {
    const normalized = normalizeDiscoveryCandidate(
      {
        ...(ensureObject(rawCandidate)),
        projectId: normalizedProjectId,
        runId,
        updatedAt: Date.now()
      },
      normalizedProjectId
    )
    const identity = candidateIdentity(normalized)
    const index = next.findIndex(
      (entry) =>
        entry.id === normalized.id ||
        (identity && candidateIdentity(entry) === identity)
    )
    if (index < 0) {
      next.unshift(normalized)
      createdCount += 1
      continue
    }
    const merged = normalizeDiscoveryCandidate(
      {
        ...next[index],
        ...normalized,
        id: next[index].id,
        createdAt: next[index].createdAt || normalized.createdAt,
        updatedAt: Date.now()
      },
      normalizedProjectId
    )
    next[index] = merged
    updatedCount += 1
  }
  byProject[normalizedProjectId] = next.slice(0, 4000)
  const didPersist = await set({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: byProject })
  return {
    createdCount: didPersist ? createdCount : 0,
    updatedCount: didPersist ? updatedCount : 0,
    runId,
    candidates: didPersist ? byProject[normalizedProjectId] : current
  }
}

export async function removeProjectDiscoveryCandidate(projectId, candidateId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedCandidateId = truncateText(candidateId, 120)
  if (!normalizedProjectId || !normalizedCandidateId) {
    return false
  }
  const byProject = await getCandidatesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const next = current.filter((entry) => entry.id !== normalizedCandidateId)
  if (next.length === current.length) {
    return false
  }
  byProject[normalizedProjectId] = next
  return set({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: byProject })
}

export async function dedupeProjectDiscoveryCandidates(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return { duplicateCount: 0, candidates: [] }
  }
  const byProject = await getCandidatesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const { candidates, duplicateCount } = dedupeCandidatesList(current)
  byProject[normalizedProjectId] = candidates
  const didPersist = await set({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: byProject })
  return {
    duplicateCount: didPersist ? duplicateCount : 0,
    candidates: didPersist ? candidates : current
  }
}

export async function queueDiscoveryCandidateForScreening(projectId, candidateId, options = {}) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedCandidateId = truncateText(candidateId, 120)
  if (!normalizedProjectId || !normalizedCandidateId) {
    return null
  }
  const byProject = await getCandidatesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const candidate = current.find((entry) => entry.id === normalizedCandidateId)
  if (!candidate || candidate.duplicateOf) {
    return null
  }

  const paper = await addProjectPaper(normalizedProjectId, {
    docId: candidate.url || candidate.canonicalKey || candidate.id,
    title: candidate.title,
    sourceType: "remote",
    sourceRef: { url: candidate.url },
    doi: candidate.doi,
    arxivId: candidate.arxivId,
    canonicalKey: candidate.canonicalKey,
    status: "queued",
    priority: 2,
    screenState: "title_abstract_review",
    screenDecision: "pending",
    decisionBy: truncateText(options?.decisionBy || "user", 120),
    sourceRecords: [
      {
        source: candidate.source || "discovery",
        sourceRef: candidate.url || "",
        sourceRank: candidate.sourceRank || 0,
        openAccessState: candidate.openAccessState || "unknown",
        retrievalState: candidate.retrievalState || "new",
        candidateId: candidate.id,
        addedAt: Date.now()
      }
    ]
  })
  if (!paper) {
    return null
  }

  const nextCandidates = current.map((entry) =>
    entry.id !== normalizedCandidateId
      ? entry
      : {
          ...entry,
          retrievalState: "promoted",
          updatedAt: Date.now()
        }
  )
  byProject[normalizedProjectId] = nextCandidates
  await set({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: byProject })
  return paper
}

export async function queueDiscoveryCandidatesForScreening(projectId, candidateIds, options = {}) {
  const source = Array.isArray(candidateIds) ? candidateIds : []
  const queued = []
  for (const candidateId of source) {
    const queuedPaper = await queueDiscoveryCandidateForScreening(projectId, candidateId, options)
    if (queuedPaper) {
      queued.push(queuedPaper)
    }
  }
  return queued
}

export async function getProjectScreenReasonLibrary(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return DEFAULT_SCREEN_REASONS.map((entry) => ({ ...entry }))
  }
  const byProject = await getReasonLibraryByProjectMap()
  const reasons = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : null
  if (reasons && reasons.length > 0) {
    return reasons
  }
  return DEFAULT_SCREEN_REASONS.map((entry) => ({ ...entry }))
}

export async function setProjectScreenReasonLibrary(projectId, reasons) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return []
  }
  const byProject = await getReasonLibraryByProjectMap()
  const normalized = normalizeReasonLibrary(reasons)
  byProject[normalizedProjectId] = normalized
  const didPersist = await set({ [PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY]: byProject })
  return didPersist ? normalized : []
}

export async function listProjectSavedSearches(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return []
  }
  const byProject = await getSavedSearchesByProjectMap()
  const searches = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  return [...searches].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

export async function saveProjectSavedSearch(projectId, entry) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return null
  }
  const byProject = await getSavedSearchesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const normalized = normalizeSavedSearch(
    {
      ...(ensureObject(entry)),
      projectId: normalizedProjectId,
      updatedAt: Date.now()
    },
    normalizedProjectId
  )
  const index = current.findIndex((search) => search.id === normalized.id)
  if (index < 0) {
    byProject[normalizedProjectId] = [normalized, ...current]
  } else {
    const next = [...current]
    next[index] = {
      ...normalized,
      id: current[index].id,
      createdAt: current[index].createdAt || normalized.createdAt,
      updatedAt: Date.now()
    }
    byProject[normalizedProjectId] = next
  }
  const didPersist = await set({ [PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY]: byProject })
  return didPersist ? normalized : null
}

export async function removeProjectSavedSearch(projectId, searchId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedSearchId = truncateText(searchId, 120)
  if (!normalizedProjectId || !normalizedSearchId) {
    return false
  }
  const byProject = await getSavedSearchesByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const next = current.filter((entry) => entry.id !== normalizedSearchId)
  if (next.length === current.length) {
    return false
  }
  byProject[normalizedProjectId] = next
  return set({ [PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY]: byProject })
}

export async function listProjectPipelineJobs(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return []
  }
  const byProject = await getJobsByProjectMap()
  const jobs = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  return [...jobs].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

export async function enqueueProjectPipelineJob(projectId, type, payload = {}, options = {}) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId || !PIPELINE_JOB_TYPES.has(type)) {
    return null
  }
  const byProject = await getJobsByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const now = Date.now()
  const job = normalizeJob(
    {
      id: makeId("job"),
      projectId: normalizedProjectId,
      type,
      state: "queued",
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Number.isFinite(Number(options.maxAttempts)) ? Math.floor(Number(options.maxAttempts)) : 3)),
      payload: ensureObject(payload),
      createdAt: now,
      updatedAt: now
    },
    normalizedProjectId
  )
  byProject[normalizedProjectId] = [job, ...current].slice(0, 500)
  const didPersist = await set({ [PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY]: byProject })
  return didPersist ? job : null
}

export async function updateProjectPipelineJob(projectId, jobId, updates = {}) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedJobId = truncateText(jobId, 120)
  if (!normalizedProjectId || !normalizedJobId) {
    return null
  }
  const byProject = await getJobsByProjectMap()
  const current = Array.isArray(byProject[normalizedProjectId]) ? byProject[normalizedProjectId] : []
  const index = current.findIndex((job) => job.id === normalizedJobId)
  if (index < 0) {
    return null
  }
  const existing = current[index]
  const nextStateRaw = normalizeText(updates.state).toLowerCase()
  const next = normalizeJob(
    {
      ...existing,
      ...(ensureObject(updates)),
      id: existing.id,
      projectId: normalizedProjectId,
      state: PIPELINE_JOB_STATES.has(nextStateRaw) ? nextStateRaw : existing.state,
      attempts: Number.isFinite(Number(updates.attempts))
        ? Math.max(0, Math.min(20, Math.floor(Number(updates.attempts))))
        : existing.attempts,
      errorLog: Array.isArray(updates.errorLog)
        ? updates.errorLog
        : updates.lastError
          ? [...(existing.errorLog || []), truncateText(updates.lastError, 220)].slice(-40)
          : existing.errorLog,
      updatedAt: Date.now()
    },
    normalizedProjectId
  )
  const jobs = [...current]
  jobs[index] = next
  byProject[normalizedProjectId] = jobs
  const didPersist = await set({ [PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY]: byProject })
  return didPersist ? next : existing
}

export async function getProjectScreeningMetrics(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return {
      discovered: 0,
      deduped: 0,
      titleAbstractScreened: 0,
      fullTextScreened: 0,
      included: 0,
      excluded: 0,
      pending: 0,
      queues: {
        discover: 0,
        screen: 0,
        extract: 0,
        compare: 0,
        position: 0
      },
      updatedAt: Date.now()
    }
  }
  const [candidates, papers] = await Promise.all([
    listProjectDiscoveryCandidates(normalizedProjectId),
    getProjectPapers(normalizedProjectId)
  ])
  const deduped = candidates.filter((candidate) => Boolean(candidate.duplicateOf)).length
  const titleAbstractScreened = papers.filter((paper) =>
    paper.screenState === "full_text_review" ||
    paper.screenState === "included" ||
    paper.screenState === "excluded" ||
    paper.screenState === "needs_info"
  ).length
  const fullTextScreened = papers.filter((paper) =>
    paper.screenState === "included" ||
    paper.screenState === "excluded" ||
    paper.screenState === "needs_info"
  ).length
  const included = papers.filter((paper) => paper.screenState === "included").length
  const excluded = papers.filter((paper) => paper.screenState === "excluded").length
  const pendingPapers = papers.filter((paper) =>
    paper.screenState === "candidate" ||
    paper.screenState === "title_abstract_review" ||
    paper.screenState === "full_text_review"
  ).length
  const pendingCandidates = candidates.filter(
    (candidate) => !candidate.duplicateOf && candidate.retrievalState !== "promoted" && candidate.retrievalState !== "screened"
  ).length
  const matrixEligible = papers.filter((paper) => paper.screenState === "included" || paper.screenState === "needs_info").length
  return {
    discovered: candidates.length,
    deduped,
    titleAbstractScreened,
    fullTextScreened,
    included,
    excluded,
    pending: pendingPapers + pendingCandidates,
    queues: {
      discover: pendingCandidates,
      screen: pendingPapers,
      extract: matrixEligible,
      compare: included,
      position: included
    },
    updatedAt: Date.now()
  }
}

export async function getProjectCitationGraph(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return { nodes: [], edges: [], updatedAt: Date.now() }
  }
  const byProject = await getCitationGraphByProjectMap()
  return byProject[normalizedProjectId] || { nodes: [], edges: [], updatedAt: Date.now() }
}

export async function setProjectCitationGraph(projectId, graph) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return { nodes: [], edges: [], updatedAt: Date.now() }
  }
  const byProject = await getCitationGraphByProjectMap()
  const normalized = normalizeCitationGraph({
    ...(ensureObject(graph)),
    updatedAt: Date.now()
  })
  byProject[normalizedProjectId] = normalized
  const didPersist = await set({ [PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY]: byProject })
  return didPersist ? normalized : byProject[normalizedProjectId]
}

export async function appendProjectCitationGraph(projectId, graphPatch) {
  const current = await getProjectCitationGraph(projectId)
  const patch = normalizeCitationGraph(graphPatch)
  const nodesById = new Map(current.nodes.map((node) => [node.id, node]))
  for (const node of patch.nodes) {
    nodesById.set(node.id, { ...(nodesById.get(node.id) || {}), ...node })
  }
  const edgeKey = (edge) => `${edge.from}|${edge.to}|${edge.direction}`
  const edgesByKey = new Map(current.edges.map((edge) => [edgeKey(edge), edge]))
  for (const edge of patch.edges) {
    edgesByKey.set(edgeKey(edge), edge)
  }
  return setProjectCitationGraph(projectId, {
    nodes: [...nodesById.values()],
    edges: [...edgesByKey.values()],
    updatedAt: Date.now()
  })
}

export async function applyScreenDecisionToPaper(projectId, paperId, decision, options = {}) {
  const normalizedDecision = normalizeText(decision).toLowerCase()
  let nextScreenState = "title_abstract_review"
  let nextStatus = "queued"
  if (normalizedDecision === "include") {
    nextScreenState = "included"
    nextStatus = "included"
  } else if (normalizedDecision === "exclude") {
    nextScreenState = "excluded"
    nextStatus = "excluded"
  } else if (normalizedDecision === "needs_info") {
    nextScreenState = "needs_info"
    nextStatus = "reading"
  }
  const reasonCodes = normalizeStringList(options.reasonCodes, 12, 80)
  if (nextScreenState === "excluded" && reasonCodes.length === 0) {
    throw new Error("Exclusion reason is required.")
  }
  return updateProjectPaper(projectId, paperId, {
    status: nextStatus,
    screenState: nextScreenState,
    screenDecision: normalizedDecision === "include" || normalizedDecision === "exclude" || normalizedDecision === "needs_info"
      ? normalizedDecision
      : "pending",
    screenReasonCodes: reasonCodes,
    screenNotes: truncateText(options.screenNotes, 900),
    decisionBy: truncateText(options.decisionBy || "user", 120),
    decisionAt: Date.now(),
    qualityScore: Number.isFinite(Number(options.qualityScore))
      ? Math.max(0, Math.min(100, Math.floor(Number(options.qualityScore))))
      : undefined
  })
}
