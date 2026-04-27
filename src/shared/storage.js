import { DEFAULT_SETTINGS, normalizeSettings } from "./settings_schema.js";
import { makeId, normalizeCard } from "./models.js";
import {
  buildCanonicalPaperKey,
  buildTitleFingerprint,
  normalizeArxivId,
  normalizeDoi,
  normalizePaperUrl
} from "./paper_identity.js";

const DIAGNOSTICS_VERBOSE_KEY = "diagnostics.verbose";
const SETTINGS_KEY = "settings";
const CARDS_BY_DOC_ID_KEY = "cardsByDocId";
const GLOSSARY_BY_DOC_ID_KEY = "glossaryByDocId";
const OPENAI_FILE_IDS_BY_DOC_ID_KEY = "openaiFileIdsByDocId";
const ORIENTATION_CACHE_BY_DOC_ID_KEY = "orientationCacheByDocId";
const OUTLINE_BY_DOC_ID_KEY = "outlineByDocId";
const INTENTS_BY_DOC_ID_KEY = "intentsByDocId";
const WALKTHROUGH_BY_DOC_ID_KEY = "walkthroughByDocId";
const PROJECTS_KEY = "projects";
const PROJECT_PAPERS_BY_PROJECT_ID_KEY = "projectPapersByProjectId";
const PROJECT_ANALYSES_BY_PROJECT_ID_KEY = "projectAnalysesByProjectId";
const PROJECT_COMPARISONS_BY_KEY = "projectComparisonsByKey";
const ACTIVE_PROJECT_ID_KEY = "activeProjectId";
const PROJECT_MATRICES_BY_PROJECT_ID_KEY = "projectMatricesByProjectId";
const PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY = "projectDiscoveryCandidatesByProjectId";
const PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY = "projectScreenReasonLibraryByProjectId";
const PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY = "projectSavedSearchesByProjectId";
const PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY = "projectPipelineJobsByProjectId";
const PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY = "projectCitationGraphByProjectId";

function getStorageArea() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      return chrome.storage.local;
    }
  } catch (_error) {
    // Ignore and fall back.
  }
  return null;
}

function buildFallbackResult(keys) {
  if (typeof keys === "string") {
    return { [keys]: undefined };
  }

  if (Array.isArray(keys)) {
    return keys.reduce((acc, key) => {
      acc[key] = undefined;
      return acc;
    }, {});
  }

  if (keys && typeof keys === "object") {
    return { ...keys };
  }

  return {};
}

export async function get(keys) {
  const storage = getStorageArea();
  if (!storage) {
    return buildFallbackResult(keys);
  }

  try {
    return await storage.get(keys);
  } catch (_error) {
    return buildFallbackResult(keys);
  }
}

export async function set(obj) {
  const storage = getStorageArea();
  if (!storage) {
    return false;
  }

  try {
    await storage.set(obj ?? {});
    return true;
  } catch (_error) {
    return false;
  }
}

export async function getVerbose() {
  const values = await get({ [DIAGNOSTICS_VERBOSE_KEY]: false });
  return Boolean(values?.[DIAGNOSTICS_VERBOSE_KEY]);
}

export async function setVerbose(value) {
  return set({ [DIAGNOSTICS_VERBOSE_KEY]: Boolean(value) });
}

export async function getSettings() {
  const values = await get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  return normalizeSettings(values?.[SETTINGS_KEY]);
}

export async function setSettings(partial) {
  const current = await getSettings();
  const update = partial && typeof partial === "object" ? partial : {};
  const next = normalizeSettings({ ...current, ...update });
  const payload = { [SETTINGS_KEY]: next };
  if (Object.prototype.hasOwnProperty.call(update, "openaiApiKey") && current.openaiApiKey !== next.openaiApiKey) {
    payload[OPENAI_FILE_IDS_BY_DOC_ID_KEY] = {};
  }
  const didPersist = await set(payload);
  return didPersist ? next : current;
}

export async function clearOpenAIKey() {
  return setSettings({ openaiApiKey: null });
}

function normalizeDocId(docId) {
  return typeof docId === "string" && docId.trim() ? docId.trim() : "unknown"
}

function ensureObjectMap(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value
  }
  return {}
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function truncateText(value, maxLength) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength).trim()
}

function normalizeNumber(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function normalizeStringList(list, maxItems, maxLength) {
  const source = Array.isArray(list) ? list : []
  return source.map((item) => truncateText(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

function normalizeSectionIntentList(list) {
  const source = Array.isArray(list) ? list : []
  return source
    .map((item) => ({
      title: truncateText(item?.title, 140),
      intent: truncateText(item?.intent, 220)
    }))
    .filter((item) => item.title && item.intent)
    .slice(0, 40)
}

function normalizeOrientationSections(list) {
  const source = Array.isArray(list) ? list : []
  return source
    .map((section, index) => {
      const title = truncateText(section?.title, 180)
      const numericPageIndex = Number(section?.pageIndex)
      if (!Number.isFinite(numericPageIndex) || numericPageIndex < 0) {
        return null
      }
      const pageIndex = Math.floor(numericPageIndex)
      const level = normalizeNumber(section?.level, 1, 1, 8)
      if (!title) {
        return null
      }
      const sourceType = section?.source === "outline" ? "outline" : "heuristic"
      const sectionId = truncateText(section?.id, 80) || `sec_${pageIndex}_${index}`
      return {
        id: sectionId,
        title,
        pageIndex,
        level,
        source: sourceType
      }
    })
    .filter(Boolean)
    .slice(0, 280)
}

function normalizeOutlineSections(list) {
  const source = Array.isArray(list) ? list : []
  return source
    .map((section) => {
      const title = truncateText(section?.title, 180)
      const numericPageIndex = Number(section?.pageIndex)
      if (!Number.isFinite(numericPageIndex) || numericPageIndex < 0) {
        return null
      }
      const pageIndex = Math.floor(numericPageIndex)
      const level = normalizeNumber(section?.level, 1, 1, 8)
      if (!title) {
        return null
      }
      return {
        title,
        pageIndex,
        level
      }
    })
    .filter(Boolean)
    .slice(0, 320)
}

function normalizeOutlineEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  return {
    version: 1,
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now(),
    sections: normalizeOutlineSections(source.sections)
  }
}

function normalizeSectionKey(key) {
  return typeof key === "string" ? key.replace(/\s+/g, " ").trim().slice(0, 220) : ""
}

function normalizeSectionIntentsEntry(entry) {
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}
  const normalized = {}
  let count = 0
  for (const [rawKey, rawIntent] of Object.entries(source)) {
    if (count >= 360) {
      break
    }
    const key = normalizeSectionKey(rawKey)
    const intent = truncateText(rawIntent, 220)
    if (!key || !intent) {
      continue
    }
    normalized[key] = intent
    count += 1
  }
  return normalized
}

function normalizeIntentString(value) {
  return truncateText(value, 220)
}

function normalizeOrientationCacheEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  const sections = normalizeOrientationSections(source.sections)
  return {
    version: 1,
    updatedAt: Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now(),
    sections,
    summary: {
      purpose: truncateText(source.summary?.purpose, 400),
      contribution: truncateText(source.summary?.contribution, 400),
      focusBullets: normalizeStringList(source.summary?.focusBullets, 8, 220),
      keyTerms: normalizeStringList(source.summary?.keyTerms, 12, 60),
      sectionIntents: normalizeSectionIntentList(source.summary?.sectionIntents)
    }
  }
}

function normalizeGlossaryTerm(termObj) {
  const input = termObj && typeof termObj === "object" ? termObj : {}
  const normalizedGrounding = input.grounding && typeof input.grounding === "object" ? input.grounding : {}
  const quote =
    typeof normalizedGrounding.quote === "string"
      ? normalizedGrounding.quote.replace(/\s+/g, " ").trim().slice(0, 300)
      : ""
  const sectionTitle =
    typeof normalizedGrounding.sectionTitle === "string" && normalizedGrounding.sectionTitle.trim()
      ? normalizedGrounding.sectionTitle.trim()
      : "Unknown section"
  const pageIndex = Number.isFinite(normalizedGrounding.pageIndex)
    ? Math.max(0, Number(normalizedGrounding.pageIndex))
    : 0

  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : makeId("term"),
    cardId: typeof input.cardId === "string" ? input.cardId : "",
    type: input.type === "definition" || input.type === "explanation" ? input.type : "definition",
    term: typeof input.term === "string" ? input.term.replace(/\s+/g, " ").trim().slice(0, 180) : "",
    shortAnswer:
      typeof input.shortAnswer === "string"
        ? input.shortAnswer.replace(/\s+/g, " ").trim().slice(0, 320)
        : "",
    createdAt:
      typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
        ? input.createdAt
        : Date.now(),
    grounding: {
      pageIndex,
      sectionTitle,
      quote
    }
  }
}

function normalizeGlossaryList(value) {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((term) => normalizeGlossaryTerm(term))
}

function normalizeWalkthroughItem(item, index = 0) {
  const source = item && typeof item === "object" ? item : {}
  const sectionTitle = truncateText(source.sectionTitle, 180)
  const oneLiner = truncateText(source.oneLiner, 220)
  const numericPageIndex = Number(source.pageIndex)
  const pageIndex =
    Number.isFinite(numericPageIndex) && numericPageIndex >= 0
      ? Math.floor(numericPageIndex)
      : 0
  return {
    sectionTitle: sectionTitle || `Section ${index + 1}`,
    oneLiner: oneLiner || (sectionTitle ? `Read this section for: ${sectionTitle}` : "Read this section."),
    pageIndex,
    createdAt:
      typeof source.createdAt === "number" && Number.isFinite(source.createdAt)
        ? source.createdAt
        : Date.now()
  }
}

function normalizeWalkthroughList(value) {
  const source = Array.isArray(value) ? value : []
  return source.map((item, index) => normalizeWalkthroughItem(item, index)).slice(0, 120)
}

const PROJECT_PAPER_STATUSES = new Set(["queued", "reading", "included", "excluded"])
const PROJECT_PAPER_SOURCE_TYPES = new Set(["remote", "file", "local"])
const PROJECT_RECOMMENDATIONS = new Set(["include", "exclude", "review"])
const PROJECT_SCREEN_STATES = new Set([
  "candidate",
  "title_abstract_review",
  "full_text_review",
  "included",
  "excluded",
  "needs_info"
])
const PROJECT_SCREEN_DECISIONS = new Set(["include", "exclude", "needs_info", "pending"])

function stableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback
}

function normalizeProjectId(projectId) {
  return typeof projectId === "string" && projectId.trim() ? projectId.trim() : ""
}

function normalizeProjectName(name) {
  return truncateText(name, 140) || "Untitled project"
}

function normalizeProjectRubric(rubric) {
  return normalizeStringList(rubric, 24, 120)
}

function normalizeProject(entity) {
  const source = entity && typeof entity === "object" ? entity : {}
  const now = Date.now()
  const createdAt = normalizeTimestamp(source.createdAt, now)
  const updatedAt = normalizeTimestamp(source.updatedAt, now)
  const lastOpenedAt = normalizeTimestamp(source.lastOpenedAt, updatedAt)
  const id = normalizeProjectId(source.id) || makeId("proj")

  return {
    id,
    name: normalizeProjectName(source.name),
    researchQuestion: truncateText(source.researchQuestion, 900),
    objective: truncateText(source.objective, 900),
    scopeNotes: truncateText(source.scopeNotes, 2200),
    keyTerms: normalizeStringList(source.keyTerms, 32, 80),
    rubric: normalizeProjectRubric(source.rubric),
    createdAt,
    updatedAt,
    lastOpenedAt,
    archived: Boolean(source.archived)
  }
}

function areEqualStringLists(left, right) {
  const leftList = Array.isArray(left) ? left : []
  const rightList = Array.isArray(right) ? right : []
  if (leftList.length !== rightList.length) {
    return false
  }
  for (let index = 0; index < leftList.length; index += 1) {
    if (leftList[index] !== rightList[index]) {
      return false
    }
  }
  return true
}

function didProjectContextChange(current, nextProject) {
  const previous = current && typeof current === "object" ? current : {}
  const next = nextProject && typeof nextProject === "object" ? nextProject : {}
  return (
    previous.researchQuestion !== next.researchQuestion ||
    previous.objective !== next.objective ||
    previous.scopeNotes !== next.scopeNotes ||
    !areEqualStringLists(previous.keyTerms, next.keyTerms) ||
    !areEqualStringLists(previous.rubric, next.rubric)
  )
}

export function buildLocalPaperFingerprint(filename, fileSize, fileLastModified) {
  const safeName = truncateText(filename, 220) || "document.pdf"
  const size = Number.isFinite(Number(fileSize)) ? Math.max(0, Number(fileSize)) : 0
  const modified = Number.isFinite(Number(fileLastModified)) ? Math.max(0, Number(fileLastModified)) : 0
  return `${safeName}:${size}:${modified}`
}

function normalizeProjectPaperSourceType(sourceType) {
  if (!sourceType) {
    return "remote"
  }
  const normalized = normalizeText(sourceType).toLowerCase()
  if (PROJECT_PAPER_SOURCE_TYPES.has(normalized)) {
    return normalized
  }
  if (normalized === "remote_url") {
    return "remote"
  }
  if (normalized === "file_url") {
    return "file"
  }
  if (normalized === "local_file") {
    return "local"
  }
  return "remote"
}

function normalizeProjectPaperScreenState(value, status = "queued") {
  const normalized = normalizeText(value).toLowerCase()
  if (PROJECT_SCREEN_STATES.has(normalized)) {
    return normalized
  }
  if (status === "included") {
    return "included"
  }
  if (status === "excluded") {
    return "excluded"
  }
  if (status === "reading") {
    return "full_text_review"
  }
  return "title_abstract_review"
}

function normalizeProjectPaperScreenDecision(value, screenState = "title_abstract_review", status = "queued") {
  const normalized = normalizeText(value).toLowerCase()
  if (PROJECT_SCREEN_DECISIONS.has(normalized)) {
    return normalized
  }
  if (screenState === "included" || status === "included") {
    return "include"
  }
  if (screenState === "excluded" || status === "excluded") {
    return "exclude"
  }
  if (screenState === "needs_info") {
    return "needs_info"
  }
  return "pending"
}

function normalizeProjectPaperSourceRecords(value) {
  const source = Array.isArray(value) ? value : []
  const normalized = []
  for (const raw of source) {
    const record = raw && typeof raw === "object" ? raw : {}
    const sourceLabel = truncateText(record.source, 80)
    const sourceRef = truncateText(record.sourceRef || record.url, 2200)
    if (!sourceLabel && !sourceRef) {
      continue
    }
    normalized.push({
      source: sourceLabel || "unknown",
      sourceRef,
      sourceRank: Number.isFinite(Number(record.sourceRank))
        ? Math.max(0, Math.min(100, Number(record.sourceRank)))
        : 0,
      openAccessState: truncateText(record.openAccessState, 40),
      retrievalState: truncateText(record.retrievalState, 40),
      candidateId: truncateText(record.candidateId, 120),
      addedAt: normalizeTimestamp(record.addedAt, Date.now())
    })
    if (normalized.length >= 40) {
      break
    }
  }
  return normalized
}

function normalizeProjectPaperScreenEvidence(value) {
  const source = value && typeof value === "object" ? value : {}
  const suggestion = normalizeText(source.decisionSuggestion).toLowerCase()
  return {
    decisionSuggestion:
      suggestion === "include" || suggestion === "exclude" || suggestion === "needs_info" || suggestion === "review"
        ? suggestion
        : "",
    confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0)),
    reasonCandidates: normalizeStringList(source.reasonCandidates, 12, 80),
    evidenceSnippet: truncateText(source.evidenceSnippet, 360),
    evidencePage: Number.isFinite(Number(source.evidencePage))
      ? Math.max(0, Math.floor(Number(source.evidencePage)))
      : null,
    insufficientReason: truncateText(source.insufficientReason, 180),
    updatedAt: normalizeTimestamp(source.updatedAt, Date.now())
  }
}

function normalizeProjectPaperSourceRef(sourceType, sourceRef, fallback = {}) {
  const source = sourceRef && typeof sourceRef === "object" ? sourceRef : {}
  if (sourceType === "local") {
    const filename = truncateText(source.filename || fallback.filename, 220)
    const fileSize = Number.isFinite(Number(source.fileSize ?? fallback.fileSize))
      ? Math.max(0, Number(source.fileSize ?? fallback.fileSize))
      : 0
    const fileLastModified = Number.isFinite(Number(source.fileLastModified ?? fallback.fileLastModified))
      ? Math.max(0, Number(source.fileLastModified ?? fallback.fileLastModified))
      : 0
    const localFingerprint =
      truncateText(source.localFingerprint, 320) ||
      buildLocalPaperFingerprint(filename, fileSize, fileLastModified)
    return {
      localFingerprint,
      filename,
      fileSize,
      fileLastModified
    }
  }

  const url = truncateText(source.url || fallback.url, 2200)
  return { url }
}

function deriveDocIdFromProjectPaper(sourceType, docId, sourceRef) {
  const normalizedDocId = normalizeDocId(docId)
  if (normalizedDocId !== "unknown") {
    return normalizedDocId
  }
  if (sourceType === "local") {
    const fingerprint = truncateText(sourceRef?.localFingerprint, 320)
    return fingerprint || "unknown"
  }
  const url = truncateText(sourceRef?.url, 2200)
  return url || "unknown"
}

function normalizeProjectPaper(entity, requiredProjectId = "") {
  const source = entity && typeof entity === "object" ? entity : {}
  const now = Date.now()
  const sourceType = normalizeProjectPaperSourceType(source.sourceType)
  const normalizedSourceRef = normalizeProjectPaperSourceRef(sourceType, source.sourceRef, {
    url: source.url,
    filename: source.filename,
    fileSize: source.fileSize,
    fileLastModified: source.fileLastModified
  })
  const normalizedDocId = deriveDocIdFromProjectPaper(sourceType, source.docId, normalizedSourceRef)
  const status = PROJECT_PAPER_STATUSES.has(source.status) ? source.status : "queued"
  const screenState = normalizeProjectPaperScreenState(source.screenState, status)
  const screenDecision = normalizeProjectPaperScreenDecision(source.screenDecision, screenState, status)
  const createdAt = normalizeTimestamp(source.addedAt, now)
  const updatedAt = normalizeTimestamp(source.updatedAt, now)
  const doi = normalizeDoi(source.doi)
  const arxivId = normalizeArxivId(source.arxivId || normalizedSourceRef?.url || normalizedDocId)
  const titleFingerprint = truncateText(source.titleFingerprint, 220) || buildTitleFingerprint(source.title)
  const canonicalKey =
    truncateText(source.canonicalKey, 420) ||
    buildCanonicalPaperKey({
      doi,
      arxivId,
      url: normalizePaperUrl(normalizedSourceRef?.url || source.url || normalizedDocId),
      title: source.title,
      docId: normalizedDocId
    })

  return {
    id: truncateText(source.id, 120) || makeId("paper"),
    projectId: normalizeProjectId(source.projectId) || requiredProjectId || "",
    docId: normalizedDocId,
    title: truncateText(source.title, 260) || "Untitled paper",
    sourceType,
    sourceRef: normalizedSourceRef,
    status,
    screenState,
    screenDecision,
    screenReasonCodes: normalizeStringList(source.screenReasonCodes, 12, 80),
    screenNotes: truncateText(source.screenNotes, 900),
    decisionBy: truncateText(source.decisionBy, 120),
    decisionAt: Number.isFinite(Number(source.decisionAt)) ? Math.floor(Number(source.decisionAt)) : null,
    priority: normalizeNumber(source.priority, 2, 1, 5),
    tags: normalizeStringList(source.tags, 20, 44),
    sourceRecords: normalizeProjectPaperSourceRecords(source.sourceRecords),
    qualityScore: normalizeNumber(source.qualityScore, 0, 0, 100),
    screenEvidence: normalizeProjectPaperScreenEvidence(source.screenEvidence),
    doi,
    arxivId,
    titleFingerprint,
    canonicalKey,
    addedAt: createdAt,
    updatedAt
  }
}

function matchProjectPaperIdentity(left, right) {
  const leftObj = left && typeof left === "object" ? left : {}
  const rightObj = right && typeof right === "object" ? right : {}
  const leftCanonical = truncateText(leftObj.canonicalKey, 420)
  const rightCanonical = truncateText(rightObj.canonicalKey, 420)
  if (leftCanonical && rightCanonical && leftCanonical === rightCanonical) {
    return true
  }
  const leftDoi = normalizeDoi(leftObj.doi)
  const rightDoi = normalizeDoi(rightObj.doi)
  if (leftDoi && rightDoi && leftDoi === rightDoi) {
    return true
  }
  const leftArxiv = normalizeArxivId(leftObj.arxivId || leftObj.sourceRef?.url || leftObj.docId)
  const rightArxiv = normalizeArxivId(rightObj.arxivId || rightObj.sourceRef?.url || rightObj.docId)
  if (leftArxiv && rightArxiv && leftArxiv === rightArxiv) {
    return true
  }
  const leftUrl = normalizePaperUrl(leftObj.sourceRef?.url || leftObj.url || leftObj.docId).toLowerCase()
  const rightUrl = normalizePaperUrl(rightObj.sourceRef?.url || rightObj.url || rightObj.docId).toLowerCase()
  if (leftUrl && rightUrl && leftUrl === rightUrl) {
    return true
  }
  const leftFingerprint = truncateText(leftObj.titleFingerprint, 220) || buildTitleFingerprint(leftObj.title)
  const rightFingerprint = truncateText(rightObj.titleFingerprint, 220) || buildTitleFingerprint(rightObj.title)
  return Boolean(leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint)
}

function normalizeGroundingPages(value, maxItems = 8) {
  const source = Array.isArray(value) ? value : typeof value === "number" ? [value] : []
  return source
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0)
    .map((item) => Math.floor(item))
    .slice(0, Math.max(1, maxItems))
}

function normalizeProjectAnalysisEntry(entry, projectId = "", docId = "") {
  const source = entry && typeof entry === "object" ? entry : {}
  const now = Date.now()
  const recommendation = PROJECT_RECOMMENDATIONS.has(source.recommendation) ? source.recommendation : "review"
  const fitScore = normalizeNumber(source.fitScore, 0, 0, 100)
  return {
    projectId: normalizeProjectId(source.projectId) || projectId,
    docId: normalizeDocId(source.docId || docId),
    fitScore,
    recommendation,
    relevanceSummary: truncateText(source.relevanceSummary, 900),
    methodMatch: truncateText(source.methodMatch, 700),
    gapsOrRisks: normalizeStringList(source.gapsOrRisks, 12, 260),
    recommendedSections: normalizeStringList(source.recommendedSections, 12, 180),
    groundingPages: normalizeGroundingPages(source.groundingPages, 8),
    groundingQuotes: normalizeStringList(source.groundingQuotes, 8, 280),
    warnings: normalizeStringList(source.warnings, 10, 200),
    degraded: Boolean(source.degraded),
    deepAttempted: source.deepAttempted !== false,
    provider: truncateText(source.provider, 40),
    createdAt: normalizeTimestamp(source.createdAt, now),
    updatedAt: normalizeTimestamp(source.updatedAt, now)
  }
}

function normalizeComparisonPaperVersions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  const next = {}
  for (const [paperId, version] of Object.entries(source)) {
    const normalizedPaperId = truncateText(paperId, 120)
    const numericVersion = Number(version)
    if (!normalizedPaperId || !Number.isFinite(numericVersion)) {
      continue
    }
    next[normalizedPaperId] = Math.max(0, Math.floor(numericVersion))
  }
  return next
}

function normalizeComparisonRows(rows) {
  const source = Array.isArray(rows) ? rows : []
  return source
    .map((row) => {
      const rowObj = row && typeof row === "object" ? row : {}
      const criterion = truncateText(rowObj.criterion || rowObj.title || "", 180)
      const cells = Array.isArray(rowObj.cells)
        ? rowObj.cells
            .map((cell) => {
              const cellObj = cell && typeof cell === "object" ? cell : {}
              return {
                paperId: truncateText(cellObj.paperId, 120),
                value: truncateText(cellObj.value || cellObj.text, 420),
                groundingPage: Number.isFinite(Number(cellObj.groundingPage))
                  ? Math.max(0, Math.floor(Number(cellObj.groundingPage)))
                  : null,
                groundingQuote: truncateText(cellObj.groundingQuote, 260)
              }
            })
            .filter((cell) => cell.paperId || cell.value)
            .slice(0, 12)
        : []
      if (!criterion) {
        return null
      }
      return { criterion, cells }
    })
    .filter(Boolean)
    .slice(0, 64)
}

function normalizeComparisonResult(result) {
  const source = result && typeof result === "object" ? result : {}
  return {
    columns: normalizeStringList(source.columns, 12, 120),
    rows: normalizeComparisonRows(source.rows),
    crossPaperInsights: normalizeStringList(source.crossPaperInsights, 16, 320),
    contradictions: normalizeStringList(source.contradictions, 16, 320),
    evidenceGaps: normalizeStringList(source.evidenceGaps, 16, 320)
  }
}

function normalizeProjectComparison(entry) {
  const source = entry && typeof entry === "object" ? entry : {}
  const now = Date.now()
  const paperIds = normalizeStringList(source.paperIds, 6, 120)
  const rubric = normalizeProjectRubric(source.rubric)
  const rubricHash = truncateText(source.rubricHash, 80) || stableHash(rubric.join("|"))
  const paperVersions = normalizeComparisonPaperVersions(source.paperVersions)
  const key =
    truncateText(source.key, 600) ||
    `${truncateText(source.projectId, 120)}|${paperIds.join(",")}|${rubricHash}|${stableHash(paperVersions)}`
  return {
    key,
    projectId: truncateText(source.projectId, 120),
    paperIds,
    rubric,
    rubricHash,
    paperVersions,
    result: normalizeComparisonResult(source.result),
    warnings: normalizeStringList(source.warnings, 10, 200),
    createdAt: normalizeTimestamp(source.createdAt, now),
    updatedAt: normalizeTimestamp(source.updatedAt, now)
  }
}

function normalizeProjectsList(value) {
  const source = Array.isArray(value) ? value : []
  const seen = new Set()
  const normalized = []
  for (const item of source) {
    const project = normalizeProject(item)
    if (!project.id || seen.has(project.id)) {
      continue
    }
    seen.add(project.id)
    normalized.push(project)
  }
  return normalized
}

function sortProjectsByLastOpened(projects) {
  const list = Array.isArray(projects) ? [...projects] : []
  return list.sort((a, b) => {
    const diff = Number(b?.lastOpenedAt || 0) - Number(a?.lastOpenedAt || 0)
    if (Math.abs(diff) > 0) {
      return diff
    }
    return String(a?.name || "").localeCompare(String(b?.name || ""))
  })
}

function normalizeProjectPapersByProjectMap(value) {
  const source = ensureObjectMap(value)
  const normalized = {}
  for (const [projectIdRaw, papersRaw] of Object.entries(source)) {
    const projectId = normalizeProjectId(projectIdRaw)
    if (!projectId) {
      continue
    }
    const papers = Array.isArray(papersRaw) ? papersRaw : []
    normalized[projectId] = papers
      .map((paper) => normalizeProjectPaper(paper, projectId))
      .filter((paper) => paper.projectId === projectId)
      .slice(0, 500)
  }
  return normalized
}

function normalizeProjectAnalysesByProjectMap(value) {
  const source = ensureObjectMap(value)
  const normalized = {}
  for (const [projectIdRaw, analysesRaw] of Object.entries(source)) {
    const projectId = normalizeProjectId(projectIdRaw)
    if (!projectId) {
      continue
    }
    const analysisMap = ensureObjectMap(analysesRaw)
    const nextMap = {}
    for (const [docIdRaw, entry] of Object.entries(analysisMap)) {
      const docId = normalizeDocId(docIdRaw)
      if (!docId || docId === "unknown") {
        continue
      }
      nextMap[docId] = normalizeProjectAnalysisEntry(entry, projectId, docId)
    }
    normalized[projectId] = nextMap
  }
  return normalized
}

function normalizeProjectComparisonsByKey(value) {
  const source = ensureObjectMap(value)
  const normalized = {}
  for (const [keyRaw, entry] of Object.entries(source)) {
    const key = truncateText(keyRaw, 600)
    if (!key) {
      continue
    }
    const comparison = normalizeProjectComparison({ ...(entry || {}), key })
    normalized[key] = comparison
  }
  return normalized
}

async function getOpenAIFileIdsByDocIdMap() {
  const values = await get({ [OPENAI_FILE_IDS_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[OPENAI_FILE_IDS_BY_DOC_ID_KEY])
}

async function getOutlineByDocIdMap() {
  const values = await get({ [OUTLINE_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[OUTLINE_BY_DOC_ID_KEY])
}

async function getIntentsByDocIdMap() {
  const values = await get({ [INTENTS_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[INTENTS_BY_DOC_ID_KEY])
}

async function getWalkthroughByDocIdMap() {
  const values = await get({ [WALKTHROUGH_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[WALKTHROUGH_BY_DOC_ID_KEY])
}

async function getOrientationCacheByDocIdMap() {
  const values = await get({ [ORIENTATION_CACHE_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[ORIENTATION_CACHE_BY_DOC_ID_KEY])
}

async function getCardsByDocIdMap() {
  const values = await get({ [CARDS_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[CARDS_BY_DOC_ID_KEY])
}

async function getGlossaryByDocIdMap() {
  const values = await get({ [GLOSSARY_BY_DOC_ID_KEY]: {} })
  return ensureObjectMap(values?.[GLOSSARY_BY_DOC_ID_KEY])
}

async function getProjectsList() {
  const values = await get({ [PROJECTS_KEY]: [] })
  return normalizeProjectsList(values?.[PROJECTS_KEY])
}

async function getProjectPapersByProjectMap() {
  const values = await get({ [PROJECT_PAPERS_BY_PROJECT_ID_KEY]: {} })
  return normalizeProjectPapersByProjectMap(values?.[PROJECT_PAPERS_BY_PROJECT_ID_KEY])
}

async function getProjectAnalysesByProjectMap() {
  const values = await get({ [PROJECT_ANALYSES_BY_PROJECT_ID_KEY]: {} })
  return normalizeProjectAnalysesByProjectMap(values?.[PROJECT_ANALYSES_BY_PROJECT_ID_KEY])
}

async function getProjectComparisonsByKeyMap() {
  const values = await get({ [PROJECT_COMPARISONS_BY_KEY]: {} })
  return normalizeProjectComparisonsByKey(values?.[PROJECT_COMPARISONS_BY_KEY])
}

export async function getCards(docId) {
  const normalizedDocId = normalizeDocId(docId)
  const cardsByDocId = await getCardsByDocIdMap()
  const cards = cardsByDocId[normalizedDocId]
  if (!Array.isArray(cards)) {
    return []
  }
  return cards.map((card) => normalizeCard(card))
}

export async function saveCards(docId, cards) {
  const normalizedDocId = normalizeDocId(docId)
  const cardsByDocId = await getCardsByDocIdMap()
  const safeCards = Array.isArray(cards) ? cards.map((card) => normalizeCard(card)) : []
  cardsByDocId[normalizedDocId] = safeCards
  return set({ [CARDS_BY_DOC_ID_KEY]: cardsByDocId })
}

export async function appendCard(docId, card) {
  const normalizedDocId = normalizeDocId(docId)
  const cards = await getCards(normalizedDocId)
  const nextCards = [...cards, normalizeCard(card)]
  const didPersist = await saveCards(normalizedDocId, nextCards)
  if (!didPersist) {
    return null
  }
  return nextCards[nextCards.length - 1]
}

export async function togglePin(docId, cardId) {
  const normalizedDocId = normalizeDocId(docId)
  const cards = await getCards(normalizedDocId)
  const nextCards = cards.map((card) => {
    if (card.id !== cardId) {
      return card
    }
    return normalizeCard({ ...card, pinned: !card.pinned })
  })
  await saveCards(normalizedDocId, nextCards)
  return nextCards
}

export async function removeCard(docId, cardId) {
  const normalizedDocId = normalizeDocId(docId)
  const cards = await getCards(normalizedDocId)
  const nextCards = cards.filter((card) => card.id !== cardId)
  await saveCards(normalizedDocId, nextCards)
  return nextCards
}

export async function addGlossaryTerm(docId, termObj) {
  const normalizedDocId = normalizeDocId(docId)
  const glossaryByDocId = await getGlossaryByDocIdMap()
  const docGlossary = normalizeGlossaryList(glossaryByDocId[normalizedDocId])
  const term = normalizeGlossaryTerm(termObj)
  glossaryByDocId[normalizedDocId] = [...docGlossary, term]
  const didPersist = await set({ [GLOSSARY_BY_DOC_ID_KEY]: glossaryByDocId })
  return didPersist ? term : null
}

export async function getGlossaryTerms(docId) {
  const normalizedDocId = normalizeDocId(docId)
  const glossaryByDocId = await getGlossaryByDocIdMap()
  return normalizeGlossaryList(glossaryByDocId[normalizedDocId])
}

export async function removeGlossaryTerm(docId, termId) {
  const normalizedDocId = normalizeDocId(docId)
  const glossaryByDocId = await getGlossaryByDocIdMap()
  const docGlossary = normalizeGlossaryList(glossaryByDocId[normalizedDocId])
  const nextGlossary = docGlossary.filter((term) => term.id !== termId)
  glossaryByDocId[normalizedDocId] = nextGlossary
  await set({ [GLOSSARY_BY_DOC_ID_KEY]: glossaryByDocId })
  return nextGlossary
}

export async function getWalkthrough(docId) {
  const normalizedDocId = normalizeDocId(docId)
  const walkthroughByDocId = await getWalkthroughByDocIdMap()
  return normalizeWalkthroughList(walkthroughByDocId[normalizedDocId])
}

export async function setWalkthrough(docId, items) {
  const normalizedDocId = normalizeDocId(docId)
  const walkthroughByDocId = await getWalkthroughByDocIdMap()
  walkthroughByDocId[normalizedDocId] = normalizeWalkthroughList(items)
  return set({ [WALKTHROUGH_BY_DOC_ID_KEY]: walkthroughByDocId })
}

export async function getOpenAIFileId(docId) {
  const normalizedDocId = normalizeDocId(docId)
  const mapping = await getOpenAIFileIdsByDocIdMap()
  const fileId = typeof mapping[normalizedDocId] === "string" ? mapping[normalizedDocId].trim() : ""
  return fileId || null
}

export async function setOpenAIFileId(docId, fileId) {
  const normalizedDocId = normalizeDocId(docId)
  const normalizedFileId = typeof fileId === "string" ? fileId.trim() : ""
  if (!normalizedFileId) {
    return false
  }
  const mapping = await getOpenAIFileIdsByDocIdMap()
  mapping[normalizedDocId] = normalizedFileId
  return set({ [OPENAI_FILE_IDS_BY_DOC_ID_KEY]: mapping })
}

export async function clearOpenAIFileId(docId) {
  const normalizedDocId = normalizeDocId(docId)
  const mapping = await getOpenAIFileIdsByDocIdMap()
  if (!(normalizedDocId in mapping)) {
    return true
  }
  delete mapping[normalizedDocId]
  return set({ [OPENAI_FILE_IDS_BY_DOC_ID_KEY]: mapping })
}

export async function getOrientationCache(docId) {
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return null
  }
  const mapping = await getOrientationCacheByDocIdMap()
  const entry = mapping[normalizedDocId]
  if (!entry || typeof entry !== "object") {
    return null
  }
  return normalizeOrientationCacheEntry(entry)
}

export async function setOrientationCache(docId, entry) {
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return false
  }
  const mapping = await getOrientationCacheByDocIdMap()
  mapping[normalizedDocId] = normalizeOrientationCacheEntry(entry)
  return set({ [ORIENTATION_CACHE_BY_DOC_ID_KEY]: mapping })
}

export async function clearOrientationCache(docId) {
  const normalizedDocId = normalizeDocId(docId)
  const mapping = await getOrientationCacheByDocIdMap()
  if (!(normalizedDocId in mapping)) {
    return true
  }
  delete mapping[normalizedDocId]
  return set({ [ORIENTATION_CACHE_BY_DOC_ID_KEY]: mapping })
}

export async function getOutline(docId) {
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return null
  }
  const mapping = await getOutlineByDocIdMap()
  const entry = mapping[normalizedDocId]
  if (!entry || typeof entry !== "object") {
    return null
  }
  const normalized = normalizeOutlineEntry(entry)
  return { sections: normalized.sections }
}

export async function setOutline(docId, outlineObj) {
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return false
  }
  const mapping = await getOutlineByDocIdMap()
  mapping[normalizedDocId] = normalizeOutlineEntry(outlineObj)
  return set({ [OUTLINE_BY_DOC_ID_KEY]: mapping })
}

export async function getSectionIntents(docId) {
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return null
  }
  const mapping = await getIntentsByDocIdMap()
  const entry = mapping[normalizedDocId]
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null
  }
  return normalizeSectionIntentsEntry(entry)
}

export async function setSectionIntents(docId, intentsObj) {
  return setIntents(docId, intentsObj)
}

export async function getIntents(docId) {
  const intents = await getSectionIntents(docId)
  return intents || {}
}

export async function setIntents(docId, intentsObj) {
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return false
  }
  const mapping = await getIntentsByDocIdMap()
  mapping[normalizedDocId] = normalizeSectionIntentsEntry(intentsObj)
  return set({ [INTENTS_BY_DOC_ID_KEY]: mapping })
}

export async function getIntent(docId, sectionKey) {
  const normalizedSectionKey = normalizeSectionKey(sectionKey)
  if (!normalizedSectionKey) {
    return null
  }
  const intents = await getIntents(docId)
  const intent = normalizeIntentString(intents[normalizedSectionKey])
  return intent || null
}

export async function setIntent(docId, sectionKey, intentString) {
  const normalizedDocId = normalizeDocId(docId)
  const normalizedSectionKey = normalizeSectionKey(sectionKey)
  const normalizedIntent = normalizeIntentString(intentString)
  if (!normalizedDocId || normalizedDocId === "unknown" || !normalizedSectionKey || !normalizedIntent) {
    return false
  }
  const mapping = await getIntentsByDocIdMap()
  const existingDocIntents = normalizeSectionIntentsEntry(mapping[normalizedDocId])
  existingDocIntents[normalizedSectionKey] = normalizedIntent
  mapping[normalizedDocId] = existingDocIntents
  return set({ [INTENTS_BY_DOC_ID_KEY]: mapping })
}

export async function getProjects(options = {}) {
  const includeArchived = Boolean(options?.includeArchived)
  const projects = sortProjectsByLastOpened(await getProjectsList())
  if (includeArchived) {
    return projects
  }
  return projects.filter((project) => !project.archived)
}

export async function getProjectById(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return null
  }
  const projects = await getProjectsList()
  return projects.find((project) => project.id === normalizedProjectId) || null
}

export async function createProject(partial) {
  const projects = await getProjectsList()
  const now = Date.now()
  const project = normalizeProject({
    ...(partial && typeof partial === "object" ? partial : {}),
    id: makeId("proj"),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    archived: false
  })
  const nextProjects = sortProjectsByLastOpened([project, ...projects])
  const didPersist = await set({ [PROJECTS_KEY]: nextProjects })
  return didPersist ? project : null
}

export async function updateProject(projectId, updates) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return null
  }
  const projects = await getProjectsList()
  const index = projects.findIndex((project) => project.id === normalizedProjectId)
  if (index < 0) {
    return null
  }
  const current = projects[index]
  const now = Date.now()
  const nextProject = normalizeProject({
    ...current,
    ...(updates && typeof updates === "object" ? updates : {}),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: now
  })
  const nextProjects = [...projects]
  nextProjects[index] = nextProject
  const nextProjectList = sortProjectsByLastOpened(nextProjects)
  if (!didProjectContextChange(current, nextProject)) {
    const didPersist = await set({ [PROJECTS_KEY]: nextProjectList })
    return didPersist ? nextProject : null
  }

  const [analysesByProject, comparisonsByKey] = await Promise.all([
    getProjectAnalysesByProjectMap(),
    getProjectComparisonsByKeyMap()
  ])
  if (normalizedProjectId in analysesByProject) {
    delete analysesByProject[normalizedProjectId]
  }
  for (const [key, entry] of Object.entries(comparisonsByKey)) {
    if (entry?.projectId === normalizedProjectId) {
      delete comparisonsByKey[key]
    }
  }
  const didPersist = await set({
    [PROJECTS_KEY]: nextProjectList,
    [PROJECT_ANALYSES_BY_PROJECT_ID_KEY]: analysesByProject,
    [PROJECT_COMPARISONS_BY_KEY]: comparisonsByKey
  })
  return didPersist ? nextProject : null
}

export async function touchProject(projectId) {
  return updateProject(projectId, { lastOpenedAt: Date.now() })
}

export async function archiveProject(projectId, archived = true) {
  return updateProject(projectId, { archived: Boolean(archived), lastOpenedAt: Date.now() })
}

export async function deleteProject(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return false
  }

  const projects = await getProjectsList()
  const nextProjects = projects.filter((project) => project.id !== normalizedProjectId)
  if (nextProjects.length === projects.length) {
    return false
  }

  const papersByProject = await getProjectPapersByProjectMap()
  if (normalizedProjectId in papersByProject) {
    delete papersByProject[normalizedProjectId]
  }

  const analysesByProject = await getProjectAnalysesByProjectMap()
  if (normalizedProjectId in analysesByProject) {
    delete analysesByProject[normalizedProjectId]
  }

  const comparisonsByKey = await getProjectComparisonsByKeyMap()
  for (const [key, entry] of Object.entries(comparisonsByKey)) {
    if (entry?.projectId === normalizedProjectId) {
      delete comparisonsByKey[key]
    }
  }

  const matrixValues = await get({ [PROJECT_MATRICES_BY_PROJECT_ID_KEY]: {} })
  const matricesByProject = ensureObjectMap(matrixValues?.[PROJECT_MATRICES_BY_PROJECT_ID_KEY])
  if (normalizedProjectId in matricesByProject) {
    delete matricesByProject[normalizedProjectId]
  }

  const [
    discoveryValues,
    reasonValues,
    searchValues,
    jobValues,
    graphValues
  ] = await Promise.all([
    get({ [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: {} }),
    get({ [PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY]: {} }),
    get({ [PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY]: {} }),
    get({ [PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY]: {} }),
    get({ [PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY]: {} })
  ])
  const discoveryByProject = ensureObjectMap(discoveryValues?.[PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY])
  const reasonByProject = ensureObjectMap(reasonValues?.[PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY])
  const searchesByProject = ensureObjectMap(searchValues?.[PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY])
  const jobsByProject = ensureObjectMap(jobValues?.[PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY])
  const graphByProject = ensureObjectMap(graphValues?.[PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY])
  if (normalizedProjectId in discoveryByProject) {
    delete discoveryByProject[normalizedProjectId]
  }
  if (normalizedProjectId in reasonByProject) {
    delete reasonByProject[normalizedProjectId]
  }
  if (normalizedProjectId in searchesByProject) {
    delete searchesByProject[normalizedProjectId]
  }
  if (normalizedProjectId in jobsByProject) {
    delete jobsByProject[normalizedProjectId]
  }
  if (normalizedProjectId in graphByProject) {
    delete graphByProject[normalizedProjectId]
  }

  const activeProjectId = await getActiveProjectId()
  const nextActiveProjectId = activeProjectId === normalizedProjectId ? null : activeProjectId

  return set({
    [PROJECTS_KEY]: sortProjectsByLastOpened(nextProjects),
    [PROJECT_PAPERS_BY_PROJECT_ID_KEY]: papersByProject,
    [PROJECT_ANALYSES_BY_PROJECT_ID_KEY]: analysesByProject,
    [PROJECT_COMPARISONS_BY_KEY]: comparisonsByKey,
    [PROJECT_MATRICES_BY_PROJECT_ID_KEY]: matricesByProject,
    [PROJECT_DISCOVERY_CANDIDATES_BY_PROJECT_ID_KEY]: discoveryByProject,
    [PROJECT_SCREEN_REASON_LIBRARY_BY_PROJECT_ID_KEY]: reasonByProject,
    [PROJECT_SAVED_SEARCHES_BY_PROJECT_ID_KEY]: searchesByProject,
    [PROJECT_PIPELINE_JOBS_BY_PROJECT_ID_KEY]: jobsByProject,
    [PROJECT_CITATION_GRAPH_BY_PROJECT_ID_KEY]: graphByProject,
    [ACTIVE_PROJECT_ID_KEY]: nextActiveProjectId
  })
}

export async function getActiveProjectId() {
  const values = await get({ [ACTIVE_PROJECT_ID_KEY]: null })
  const activeProjectId = normalizeProjectId(values?.[ACTIVE_PROJECT_ID_KEY])
  if (!activeProjectId) {
    return null
  }
  const existing = await getProjectById(activeProjectId)
  return existing ? activeProjectId : null
}

export async function setActiveProjectId(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    const didPersist = await set({ [ACTIVE_PROJECT_ID_KEY]: null })
    return didPersist ? null : await getActiveProjectId()
  }
  const project = await getProjectById(normalizedProjectId)
  if (!project) {
    return null
  }
  const didPersist = await set({ [ACTIVE_PROJECT_ID_KEY]: normalizedProjectId })
  if (!didPersist) {
    return await getActiveProjectId()
  }
  await touchProject(normalizedProjectId)
  return normalizedProjectId
}

export async function getProjectPapers(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return []
  }
  const papersByProject = await getProjectPapersByProjectMap()
  const papers = Array.isArray(papersByProject[normalizedProjectId]) ? papersByProject[normalizedProjectId] : []
  return [...papers].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

export async function addProjectPaper(projectId, paper) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return null
  }
  const now = Date.now()
  const normalizedPaper = normalizeProjectPaper(
    {
      ...(paper && typeof paper === "object" ? paper : {}),
      projectId: normalizedProjectId,
      addedAt: now,
      updatedAt: now
    },
    normalizedProjectId
  )
  if (!normalizedPaper.docId || normalizedPaper.docId === "unknown") {
    return null
  }

  const papersByProject = await getProjectPapersByProjectMap()
  const projectPapers = Array.isArray(papersByProject[normalizedProjectId]) ? papersByProject[normalizedProjectId] : []
  const existingIndex = projectPapers.findIndex(
    (entry) => entry.docId === normalizedPaper.docId || matchProjectPaperIdentity(entry, normalizedPaper)
  )
  if (existingIndex >= 0) {
    const existing = projectPapers[existingIndex]
    const merged = normalizeProjectPaper(
      {
        ...existing,
        ...normalizedPaper,
        id: existing.id,
        addedAt: existing.addedAt,
        updatedAt: now
      },
      normalizedProjectId
    )
    const nextProjectPapers = [...projectPapers]
    nextProjectPapers[existingIndex] = merged
    papersByProject[normalizedProjectId] = nextProjectPapers
    const didPersist = await set({ [PROJECT_PAPERS_BY_PROJECT_ID_KEY]: papersByProject })
    if (didPersist) {
      await touchProject(normalizedProjectId)
    }
    return didPersist ? merged : existing
  }

  papersByProject[normalizedProjectId] = [normalizedPaper, ...projectPapers]
  const didPersist = await set({ [PROJECT_PAPERS_BY_PROJECT_ID_KEY]: papersByProject })
  if (didPersist) {
    await touchProject(normalizedProjectId)
  }
  return didPersist ? normalizedPaper : null
}

export async function updateProjectPaper(projectId, paperId, updates) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedPaperId = truncateText(paperId, 120)
  if (!normalizedProjectId || !normalizedPaperId) {
    return null
  }
  const papersByProject = await getProjectPapersByProjectMap()
  const projectPapers = Array.isArray(papersByProject[normalizedProjectId]) ? papersByProject[normalizedProjectId] : []
  const index = projectPapers.findIndex((paper) => paper.id === normalizedPaperId)
  if (index < 0) {
    return null
  }
  const current = projectPapers[index]
  const now = Date.now()
  const nextPaper = normalizeProjectPaper(
    {
      ...current,
      ...(updates && typeof updates === "object" ? updates : {}),
      id: current.id,
      projectId: normalizedProjectId,
      addedAt: current.addedAt,
      updatedAt: now
    },
    normalizedProjectId
  )
  const nextProjectPapers = [...projectPapers]
  nextProjectPapers[index] = nextPaper
  papersByProject[normalizedProjectId] = nextProjectPapers
  const didPersist = await set({ [PROJECT_PAPERS_BY_PROJECT_ID_KEY]: papersByProject })
  if (didPersist) {
    await touchProject(normalizedProjectId)
  }
  return didPersist ? nextPaper : current
}

export async function removeProjectPaper(projectId, paperId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedPaperId = truncateText(paperId, 120)
  if (!normalizedProjectId || !normalizedPaperId) {
    return false
  }
  const papersByProject = await getProjectPapersByProjectMap()
  const projectPapers = Array.isArray(papersByProject[normalizedProjectId]) ? papersByProject[normalizedProjectId] : []
  const nextProjectPapers = projectPapers.filter((paper) => paper.id !== normalizedPaperId)
  if (nextProjectPapers.length === projectPapers.length) {
    return false
  }
  papersByProject[normalizedProjectId] = nextProjectPapers
  const didPersist = await set({ [PROJECT_PAPERS_BY_PROJECT_ID_KEY]: papersByProject })
  if (didPersist) {
    await touchProject(normalizedProjectId)
  }
  return didPersist
}

export async function getProjectPaperByDocId(projectId, docId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedProjectId || !normalizedDocId || normalizedDocId === "unknown") {
    return null
  }
  const papers = await getProjectPapers(normalizedProjectId)
  return papers.find((paper) => paper.docId === normalizedDocId) || null
}

export async function getProjectPaperAnalysis(projectId, docId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedProjectId || !normalizedDocId || normalizedDocId === "unknown") {
    return null
  }
  const analysesByProject = await getProjectAnalysesByProjectMap()
  const projectAnalyses = ensureObjectMap(analysesByProject[normalizedProjectId])
  const entry = projectAnalyses[normalizedDocId]
  if (!entry) {
    return null
  }
  return normalizeProjectAnalysisEntry(entry, normalizedProjectId, normalizedDocId)
}

export async function setProjectPaperAnalysis(projectId, docId, analysisEntry) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedProjectId || !normalizedDocId || normalizedDocId === "unknown") {
    return null
  }
  const analysesByProject = await getProjectAnalysesByProjectMap()
  const now = Date.now()
  const existingEntry = analysesByProject[normalizedProjectId]?.[normalizedDocId]
  const normalizedEntry = normalizeProjectAnalysisEntry(
    {
      ...(existingEntry || {}),
      ...(analysisEntry && typeof analysisEntry === "object" ? analysisEntry : {}),
      projectId: normalizedProjectId,
      docId: normalizedDocId,
      createdAt: existingEntry?.createdAt || now,
      updatedAt: now
    },
    normalizedProjectId,
    normalizedDocId
  )
  const projectAnalyses = ensureObjectMap(analysesByProject[normalizedProjectId])
  projectAnalyses[normalizedDocId] = normalizedEntry
  analysesByProject[normalizedProjectId] = projectAnalyses
  const didPersist = await set({ [PROJECT_ANALYSES_BY_PROJECT_ID_KEY]: analysesByProject })
  return didPersist ? normalizedEntry : existingEntry || null
}

export async function getProjectPaperAnalyses(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return {}
  }
  const analysesByProject = await getProjectAnalysesByProjectMap()
  return ensureObjectMap(analysesByProject[normalizedProjectId])
}

export async function clearProjectPaperAnalysis(projectId, docId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const normalizedDocId = normalizeDocId(docId)
  if (!normalizedProjectId || !normalizedDocId || normalizedDocId === "unknown") {
    return false
  }
  const analysesByProject = await getProjectAnalysesByProjectMap()
  const projectAnalyses = ensureObjectMap(analysesByProject[normalizedProjectId])
  if (!(normalizedDocId in projectAnalyses)) {
    return true
  }
  delete projectAnalyses[normalizedDocId]
  analysesByProject[normalizedProjectId] = projectAnalyses
  return set({ [PROJECT_ANALYSES_BY_PROJECT_ID_KEY]: analysesByProject })
}

export function buildProjectComparisonCacheKey({ projectId, paperIds, rubric, paperVersions }) {
  const normalizedProjectId = normalizeProjectId(projectId) || "unknown"
  const normalizedPaperIds = normalizeStringList(paperIds, 6, 120).sort()
  const normalizedRubric = normalizeProjectRubric(rubric)
  const rubricHash = stableHash(normalizedRubric.join("|"))
  const normalizedPaperVersions = normalizeComparisonPaperVersions(paperVersions)
  const versionsHash = stableHash(normalizedPaperVersions)
  return `${normalizedProjectId}|${normalizedPaperIds.join(",")}|${rubricHash}|${versionsHash}`
}

export async function getProjectComparison(cacheKey) {
  const normalizedKey = truncateText(cacheKey, 600)
  if (!normalizedKey) {
    return null
  }
  const comparisonsByKey = await getProjectComparisonsByKeyMap()
  const entry = comparisonsByKey[normalizedKey]
  return entry ? normalizeProjectComparison(entry) : null
}

export async function setProjectComparison(entry) {
  const normalized = normalizeProjectComparison(entry)
  if (!normalized.key || !normalized.projectId) {
    return null
  }
  const comparisonsByKey = await getProjectComparisonsByKeyMap()
  const existing = comparisonsByKey[normalized.key]
  comparisonsByKey[normalized.key] = normalizeProjectComparison({
    ...(existing || {}),
    ...normalized,
    key: normalized.key,
    projectId: normalized.projectId,
    createdAt: existing?.createdAt || normalized.createdAt,
    updatedAt: Date.now()
  })
  const didPersist = await set({ [PROJECT_COMPARISONS_BY_KEY]: comparisonsByKey })
  return didPersist ? comparisonsByKey[normalized.key] : existing || null
}

export async function listProjectComparisons(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return []
  }
  const comparisonsByKey = await getProjectComparisonsByKeyMap()
  return Object.values(comparisonsByKey)
    .filter((entry) => entry?.projectId === normalizedProjectId)
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
}

export async function clearProjectComparisonsForProject(projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) {
    return false
  }
  const comparisonsByKey = await getProjectComparisonsByKeyMap()
  let didChange = false
  for (const [key, entry] of Object.entries(comparisonsByKey)) {
    if (entry?.projectId === normalizedProjectId) {
      delete comparisonsByKey[key]
      didChange = true
    }
  }
  if (!didChange) {
    return true
  }
  return set({ [PROJECT_COMPARISONS_BY_KEY]: comparisonsByKey })
}
