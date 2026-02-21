import { DEFAULT_SETTINGS, normalizeSettings } from "./settings_schema.js";
import { makeId, normalizeCard } from "./models.js";

const DIAGNOSTICS_VERBOSE_KEY = "diagnostics.verbose";
const SETTINGS_KEY = "settings";
const CARDS_BY_DOC_ID_KEY = "cardsByDocId";
const GLOSSARY_BY_DOC_ID_KEY = "glossaryByDocId";
const OPENAI_FILE_IDS_BY_DOC_ID_KEY = "openaiFileIdsByDocId";
const ORIENTATION_CACHE_BY_DOC_ID_KEY = "orientationCacheByDocId";
const OUTLINE_BY_DOC_ID_KEY = "outlineByDocId";
const INTENTS_BY_DOC_ID_KEY = "intentsByDocId";
const WALKTHROUGH_BY_DOC_ID_KEY = "walkthroughByDocId";

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
  const didPersist = await set({ [SETTINGS_KEY]: next });
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
