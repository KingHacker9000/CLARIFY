import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { createLogger, getDebugInfo } from "../shared/diagnostics.js";
import { initSelectionSystem } from "./selection.js";
import { clearHighlights, highlightOnPage } from "./highlight.js";
import {
  addGlossaryTerm,
  appendCard,
  clearOpenAIKey,
  getCards,
  getGlossaryTerms,
  getOpenAIFileId,
  getOutline,
  getIntents,
  getOrientationCache,
  getSettings,
  getVerbose,
  getWalkthrough,
  setOutline,
  removeCard,
  setOpenAIFileId,
  setOrientationCache,
  setWalkthrough,
  removeGlossaryTerm,
  setSettings,
  setVerbose,
  togglePin
} from "../shared/storage.js";
import { deriveDocId, makeId, normalizeCard } from "../shared/models.js";
import { generateLLM } from "../shared/llm/index.js";
import { uploadPdfToOpenAI } from "../shared/openai/files.js";
import { getPdfBytes, REMOTE_BYTES_BLOCKED } from "./pdf_bytes.js";
import { extractOutline } from "./outline.js";
import { buildPageTextCache, getPageText } from "./page_text.js";
import { buildSectionTree } from "./reading_map_tree.js";
import { createIntentManager } from "./intent_manager.js";

const logger = createLogger("VIEWER");
const DEFAULT_VIEWER_TITLE = "CLARIFY";
const DEFAULT_SCALE = 1.2;
const MIN_SCALE = 0.6;
const MAX_SCALE = 3.2;
const ZOOM_STEP = 0.2;
const SIDEBAR_DEFAULT_WIDTH = 360;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH_RATIO = 1 / 3;
const SIDEBAR_COLLAPSE_TRIGGER_WIDTH = 200;
const PDF_PANE_MIN_WIDTH = 280;
const SIDEBAR_COLLAPSED_WIDTH = 56;
const SOURCE_HIGHLIGHT_DELAY_MS = 80;
const MAX_CONTEXT_LENGTH = 800;
const ORIENTATION_CONTEXT_CHAR_LIMIT = 3000;
const ORIENTATION_ABSTRACT_CHAR_LIMIT = 1200;
const ORIENTATION_MAX_KEY_TERMS = 8;
const ORIENTATION_MAX_FLOW_FOCUS_BULLETS = 4;
const ORIENTATION_MAX_STRUCTURE_FOCUS_BULLETS = 5;
const ORIENTATION_TEXT_SCAN_PAGES = 8;
const PANEL_TOAST_DURATION_MS = 1600;
const PAGE_VISIBILITY_THRESHOLD = 0.6;
const SECTION_RAIL_MIN_LEFT_GUTTER = 34;
const SECTION_RAIL_LABEL_STEP = 28;
const SECTION_RAIL_LABEL_RADIUS = 4;
const SECTION_RAIL_MAX_HOVER_WIDTH = 220;
const SECTION_JUMP_VIEWPORT_MARGIN_TOP = 120;
const REMOTE_LOAD_ERROR_MESSAGE =
  "This PDF could not be loaded due to site restrictions (CORS/login). Try downloading and opening it locally.";
const FILE_URL_LOAD_HINT_MESSAGE =
  "If this file URL doesn't load, open it locally using the Open PDF button.";
const WHOLE_PDF_LOCAL_REQUIRED_MESSAGE =
  "Whole PDF requires local access. Download this PDF and open it locally.";
const ICON_PIN = "\uD83D\uDCCC";
const ICON_COPY = "\uD83D\uDCCB";
const ICON_DELETE = "\uD83D\uDDD1\uFE0F";
const ICON_REGENERATE_LIGHT_URL = new URL("../../assets/icons/regenerate.png", import.meta.url).toString();
const ICON_REGENERATE_DARK_URL = new URL(
  "../../assets/icons/regenerate-dark.png",
  import.meta.url
).toString();

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.mjs",
  import.meta.url
).toString();

const layoutEl = document.getElementById("layout");
const sidebarEl = document.getElementById("sidebar");
const sidebarResizeHandle = document.getElementById("sidebarResizeHandle");
const panel = document.getElementById("panel");
const statusEl = document.getElementById("status");
const readingModeStatusEl = document.getElementById("readingModeStatus");
const contextScopeStatusEl = document.getElementById("contextScopeStatus");
const pdfRoot = document.getElementById("pdfRoot");
const sectionRailEl = document.getElementById("sectionRail");
const pdfToolbarEl = document.querySelector(".pdfToolbar");
const fileInput = document.getElementById("fileInput");
const openFileBtn = document.getElementById("openFile");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageIndicatorEl = document.getElementById("pageIndicator");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomInBtn = document.getElementById("zoomIn");
const fitWidthBtn = document.getElementById("fitWidth");
const toggleSidebarBtn = document.getElementById("toggleSidebar");
const reopenSidebarBtn = document.getElementById("reopenSidebar");
const diagnosticsToggleBtn = document.getElementById("diagnosticsToggle");
const diagnosticsMenu = document.getElementById("diagnosticsMenu");
const verboseToggle = document.getElementById("verboseToggle");
const copyDebugInfoBtn = document.getElementById("copyDebugInfo");
const copyStatusEl = document.getElementById("copyStatus");
const readingModeFlowRadio = document.getElementById("readingModeFlow");
const readingModeStructureRadio = document.getElementById("readingModeStructure");
const llmModeSelect = document.getElementById("llmModeSelect");
const llmModeOpenAIOption = document.getElementById("llmModeOpenAIOption");
const llmModeHelpEl = document.getElementById("llmModeHelp");
const openaiApiKeyInput = document.getElementById("openaiApiKeyInput");
const saveApiKeyBtn = document.getElementById("saveApiKey");
const clearApiKeyBtn = document.getElementById("clearApiKey");
const apiKeyStatusEl = document.getElementById("apiKeyStatus");
const autoOpenPdfToggle = document.getElementById("autoOpenPdfToggle");
const contextScopeSelect = document.getElementById("contextScopeSelect");
const wholePdfSettings = document.getElementById("wholePdfSettings");
const wholePdfUploadEnabled = document.getElementById("wholePdfUploadEnabled");
const wholePdfUploadBehavior = document.getElementById("wholePdfUploadBehavior");
const wholePdfUploadSession = document.getElementById("wholePdfUploadSession");
const wholePdfUploadRemember = document.getElementById("wholePdfUploadRemember");
const promptCacheDefault = document.getElementById("promptCacheDefault");
const promptCache24h = document.getElementById("promptCache24h");
const wholePdfHelpText = document.getElementById("wholePdfHelpText");

const renderState = {
  pdfDoc: null,
  loadingTask: null,
  activeRenderTask: null,
  visibilityObserver: null,
  pageNodes: [],
  pageVisibility: new Map(),
  loadToken: 0,
  renderToken: 0,
  fitWidthEnabled: false,
  baseViewportWidth: null
};

let openedPdfSource = null;
let currentPdf = null;
let copyStatusTimer = null;
let apiStatusTimer = null;
let currentSettings = null;
let renderChain = Promise.resolve();
let scrollTicking = false;
let fitResizeFrame = null;
let selectionSystem = null;
const sessionFileIdByDocId = new Map();
const uploadPromiseByDocId = new Map();
let contextScopeTransientStatus = "";
const sidebarState = {
  width: SIDEBAR_DEFAULT_WIDTH,
  collapsed: false,
  resizePointerId: null,
  resizeStartX: 0,
  resizeStartWidth: SIDEBAR_DEFAULT_WIDTH
};

function createEmptyOrientationData() {
  return {
    purpose: "",
    contribution: "",
    focusBullets: [],
    keyTerms: [],
    sectionIntents: {},
    sections: []
  }
}

function createReadingMapUiState() {
  return {
    expandedKeys: new Set(),
    visibleIntentKeys: new Set(),
    intentLoadingByKey: {},
    topLevelPrewarming: false,
    groupPrewarmByKey: {}
  }
}

function createOrientationUiState(readingMode = "flow") {
  return {
    status: "idle",
    loadingMessage: "",
    errorMessage: "",
    collapsed: false,
    mapExpanded: readingMode === "structure",
    userCollapsed: false,
    userMapPreference: false,
    intentsStatus: "idle",
    readingMap: createReadingMapUiState(),
    data: createEmptyOrientationData()
  }
}

function createWalkthroughUiState() {
  return {
    items: [],
    confirmRebuild: false,
    saving: false
  }
}

const sidebarUiState = {
  docId: "unknown",
  cards: [],
  glossaryTerms: [],
  walkthrough: createWalkthroughUiState(),
  toastMessage: "",
  activeTab: "orientation",
  orientation: createOrientationUiState("flow")
};
let recentJumpState = null;
let orientationRunToken = 0;
let panelToastTimer = null;
let sectionIntentManager = null
let sectionIntentManagerDocId = ""
const sectionRailState = {
  isHovering: false,
  pointerY: 0,
  selectedIndex: 0,
  renderFrame: 0,
  closeTimer: 0
}

const RETRIEVAL_BLOCK_MIN_CHARS = 50;
const RETRIEVAL_BLOCK_MAX_CHARS = 420;
const RETRIEVAL_PRIMARY_QUOTE_MAX = 300;
const RETRIEVAL_CITATION_QUOTE_MAX = 260;
const RETRIEVAL_MAX_CITATIONS = 4;
const RETRIEVAL_STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "done",
  "during",
  "each",
  "for",
  "from",
  "had",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "might",
  "more",
  "most",
  "no",
  "not",
  "of",
  "on",
  "or",
  "other",
  "our",
  "out",
  "over",
  "same",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "under",
  "use",
  "used",
  "using",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "will",
  "with",
  "within",
  "without",
  "would"
]);

function sanitizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function clampText(value, maxLength = 220) {
  const normalized = sanitizeText(value)
  if (!normalized) {
    return ""
  }
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(maxLength - 3, 1)).trim()}...`
}

function truncateText(value, maxLength = 220) {
  const normalized = sanitizeText(value)
  if (!normalized) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || normalized.length <= maxLength) {
    return normalized
  }
  return normalized.slice(0, maxLength).trim()
}

function parseOptionalPageIndex(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null
  }
  return Math.floor(numeric)
}

function createGroundingSourceTrigger({ cardId, sourceText, pageIndex, label, compact = false }) {
  const trigger = document.createElement("button")
  trigger.type = "button"
  trigger.className = "cardGroundingSource"
  if (compact) {
    trigger.classList.add("cardCitationQuote")
  }
  trigger.dataset.cardAction = "jump"
  trigger.dataset.cardId = cardId
  trigger.dataset.sourceStrict = "true"

  const normalizedText = sanitizeText(sourceText)
  if (normalizedText) {
    trigger.dataset.sourceText = normalizedText
  }
  if (Number.isFinite(pageIndex)) {
    trigger.dataset.sourcePageIndex = String(Math.max(0, Math.floor(Number(pageIndex))))
  }

  const badge = document.createElement("span")
  badge.className = "cardGroundingSourceLabel"
  const pageLabel = Number.isFinite(pageIndex) ? `Page ${Number(pageIndex) + 1}` : "Page ?"
  badge.textContent = `${label} - ${pageLabel}`

  const text = document.createElement("span")
  text.className = "cardGroundingSourceText"
  text.textContent = normalizedText || "No quote available."

  trigger.append(badge, text)
  return trigger
}

function normalizeTabName(tab) {
  const candidate = typeof tab === "string" ? tab : ""
  const validTabs = new Set(["orientation", "explain", "glossary", "figures", "walkthrough"])
  return validTabs.has(candidate) ? candidate : "orientation"
}

function getEmptyMessage(tab) {
  if (tab === "orientation") {
    return "Open a PDF to generate purpose, focus points, key terms, and a reading map."
  }
  if (tab === "explain") {
    return "No explanations yet. Select text in the PDF, then use Define or Explain."
  }
  if (tab === "glossary") {
    return "Your glossary is empty. Save terms from explanation cards."
  }
  if (tab === "figures") {
    return "No figure translations yet. Select a caption and use Translate."
  }
  return "No walkthrough notes yet. Generate section one-liners."
}

function renderEmpty(tab = "orientation") {
  panel.innerHTML = ""
  const wrapper = document.createElement("div")
  wrapper.className = "panelEmpty"

  if (tab === "orientation") {
    const heading = document.createElement("h3")
    heading.className = "panelTitle"
    heading.textContent = "Paper Orientation"
    wrapper.append(heading)
  }

  const message = document.createElement("p")
  message.className = "panelEmptyMessage"
  message.textContent = getEmptyMessage(tab)
  wrapper.append(message)
  panel.append(wrapper)
}

function getSortedCards(cards) {
  return [...cards].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1
    }
    const createdA = Number(a.createdAt) || 0
    const createdB = Number(b.createdAt) || 0
    return createdB - createdA
  })
}

function getCardsForTab(tab) {
  if (tab === "explain") {
    return getSortedCards(
      sidebarUiState.cards.filter((card) => card.type === "definition" || card.type === "explanation")
    )
  }
  if (tab === "figures") {
    return getSortedCards(sidebarUiState.cards.filter((card) => card.type === "quant"))
  }
  return []
}

function createBulletList(items) {
  const list = document.createElement("ul")
  list.className = "cardListBullets"
  for (const item of items) {
    const normalized = clampText(item, 180)
    if (!normalized) {
      continue
    }
    const li = document.createElement("li")
    li.textContent = normalized
    list.append(li)
  }
  return list
}

function createDetailSection(title, bodyText) {
  const section = document.createElement("section")
  section.className = "cardDetailSection"
  const heading = document.createElement("h5")
  heading.textContent = title
  section.append(heading)
  const paragraph = document.createElement("p")
  paragraph.textContent = clampText(bodyText, 320)
  section.append(paragraph)
  return section
}

function createCardNode(card) {
  const article = document.createElement("article")
  article.className = "sidebarCard"
  if (card.pinned) {
    article.classList.add("pinned")
  }
  article.dataset.cardId = card.id

  const header = document.createElement("header")
  header.className = "cardHeader"
  const title = document.createElement("h4")
  title.className = "cardTitle"
  title.textContent = clampText(card.title, 180) || "Untitled selection"
  const meta = document.createElement("p")
  meta.className = "cardMeta"
  const pageLabel = Number.isFinite(card.grounding?.pageIndex)
    ? `Page ${Number(card.grounding.pageIndex) + 1}`
    : "Page ?"
  const sectionTitle = clampText(card.grounding?.sectionTitle || "Unknown section", 120)
  meta.textContent = `${pageLabel} - ${sectionTitle}`
  if (card.type === "quant") {
    const metaRow = document.createElement("div")
    metaRow.className = "cardMetaRow"
    const figureIntentButton = document.createElement("button")
    figureIntentButton.type = "button"
    figureIntentButton.className = "cardIntentOverlay"
    figureIntentButton.dataset.cardAction = "toggle-figure-intent"
    figureIntentButton.dataset.cardId = card.id
    figureIntentButton.textContent = "?"
    metaRow.append(meta, figureIntentButton)
    header.append(title, metaRow)
  } else {
    header.append(title, meta)
  }
  article.append(header)

  const shortAnswer = document.createElement("p")
  shortAnswer.className = "cardShortAnswer"
  shortAnswer.textContent = clampText(card.shortAnswer, 280)
  article.append(shortAnswer)

  if (card.type === "quant") {
    const figureIntentKey = getFigureIntentKey(card)
    if (isIntentVisible(figureIntentKey)) {
      const intentMap = getSectionIntentMapFromOrientationData(getOrientationState().data?.sectionIntents)
      const intent = clampText(intentMap[figureIntentKey], 220)
      const bubble = document.createElement("div")
      bubble.className = "cardIntentBubble"
      bubble.textContent = isIntentLoading(figureIntentKey) ? "Generating..." : intent || "No intent available yet."
      article.append(bubble)
    }
  }

  const grounding = document.createElement("section")
  grounding.className = "cardGrounding"
  const groundingLabel = document.createElement("p")
  groundingLabel.className = "cardGroundingLabel"
  groundingLabel.textContent = `Grounded in: ${pageLabel} - ${sectionTitle}`
  const quote = createGroundingSourceTrigger({
    cardId: card.id,
    sourceText: card.grounding?.quote,
    pageIndex: Number.isFinite(card.grounding?.pageIndex) ? Number(card.grounding.pageIndex) : null,
    label: "Primary quote"
  })
  const citationQuotes = Array.isArray(card.grounding?.citationQuotes)
    ? card.grounding.citationQuotes.filter(Boolean).slice(0, 4)
    : []
  const citationPages = Array.isArray(card.grounding?.citationPages)
    ? card.grounding.citationPages
    : []
  const sourceNodes = [quote]
  citationQuotes.forEach((citationQuote, index) => {
    const citationPageIndex = Number.isFinite(citationPages[index])
      ? Number(citationPages[index])
      : Number.isFinite(card.grounding?.pageIndex)
        ? Number(card.grounding.pageIndex)
        : null
    const citation = createGroundingSourceTrigger({
      cardId: card.id,
      sourceText: citationQuote,
      pageIndex: citationPageIndex,
      label: `Citation ${index + 1}`,
      compact: true
    })
    sourceNodes.push(citation)
  })
  const jumpButton = document.createElement("button")
  jumpButton.type = "button"
  jumpButton.className = "cardActionButton"
  jumpButton.dataset.cardAction = "jump"
  jumpButton.dataset.cardId = card.id
  jumpButton.textContent = "Jump to source"

  if (sourceNodes.length > 2) {
    const alwaysVisibleSources = sourceNodes.slice(0, 2)
    const hiddenSources = sourceNodes.slice(2)
    const moreDetails = document.createElement("details")
    moreDetails.className = "cardGroundingMore"
    const moreSummary = document.createElement("summary")
    moreSummary.className = "cardGroundingMoreSummary"
    const hiddenCount = hiddenSources.length
    moreSummary.textContent = hiddenCount === 1 ? "Show 1 more source" : `Show ${hiddenCount} more sources`
    moreDetails.append(moreSummary)
    for (const sourceNode of hiddenSources) {
      moreDetails.append(sourceNode)
    }
    grounding.append(groundingLabel, ...alwaysVisibleSources, moreDetails, jumpButton)
  } else {
    grounding.append(groundingLabel, ...sourceNodes, jumpButton)
  }
  article.append(grounding)

  const details = document.createElement("details")
  details.className = "cardDetails"
  const summary = document.createElement("summary")
  summary.textContent = "Details"
  details.append(summary)

  if (card.type === "quant") {
    details.append(
      createDetailSection("What it shows", card.details?.whatItShows),
      createDetailSection("Takeaway", card.details?.takeaway),
      createDetailSection("Supports claim", card.details?.supportsClaim),
      (() => {
        const section = document.createElement("section")
        section.className = "cardDetailSection"
        const heading = document.createElement("h5")
        heading.textContent = "What to look at"
        section.append(heading, createBulletList(card.details?.whatToLookAt || []))
        return section
      })()
    )
  } else {
    details.append(
      createDetailSection("ELI5", card.details?.eli5),
      (() => {
        const section = document.createElement("section")
        section.className = "cardDetailSection"
        const heading = document.createElement("h5")
        heading.textContent = "Steps"
        section.append(heading, createBulletList(card.details?.steps || []))
        return section
      })(),
      (() => {
        const section = document.createElement("section")
        section.className = "cardDetailSection"
        const heading = document.createElement("h5")
        heading.textContent = "How this paper uses it"
        section.append(heading, createBulletList(card.details?.paperUsage || []))
        return section
      })()
    )
  }

  article.append(details)

  const footer = document.createElement("footer")
  footer.className = "cardFooter"

  const pinButton = document.createElement("button")
  pinButton.type = "button"
  pinButton.className = "cardActionButton iconButton"
  pinButton.dataset.cardAction = "pin"
  pinButton.dataset.cardId = card.id
  pinButton.title = card.pinned ? "Unpin" : "Pin"
  pinButton.setAttribute("aria-label", card.pinned ? "Unpin" : "Pin")
  pinButton.textContent = ICON_PIN
  footer.append(pinButton)

  const copyButton = document.createElement("button")
  copyButton.type = "button"
  copyButton.className = "cardActionButton iconButton"
  copyButton.dataset.cardAction = "copy"
  copyButton.dataset.cardId = card.id
  copyButton.title = "Copy"
  copyButton.setAttribute("aria-label", "Copy")
  copyButton.textContent = ICON_COPY
  footer.append(copyButton)

  if (card.type !== "quant") {
    const glossaryButton = document.createElement("button")
    glossaryButton.type = "button"
    glossaryButton.className = "cardActionButton"
    glossaryButton.dataset.cardAction = "glossary"
    glossaryButton.dataset.cardId = card.id
    glossaryButton.textContent = "Add to Glossary"
    footer.append(glossaryButton)
  }

  const deleteButton = document.createElement("button")
  deleteButton.type = "button"
  deleteButton.className = "cardActionButton danger iconButton"
  deleteButton.dataset.cardAction = "delete"
  deleteButton.dataset.cardId = card.id
  deleteButton.title = "Delete"
  deleteButton.setAttribute("aria-label", "Delete")
  deleteButton.textContent = ICON_DELETE
  footer.append(deleteButton)

  article.append(footer)
  return article
}

function renderCardsTab(tab) {
  const cards = getCardsForTab(tab)
  if (cards.length === 0) {
    renderEmpty(tab)
    return
  }

  panel.innerHTML = ""
  const list = document.createElement("div")
  list.className = "cardList"
  for (const card of cards) {
    list.append(createCardNode(card))
  }
  panel.append(list)
}

function getSortedGlossaryTerms(terms) {
  return [...terms].sort((a, b) => {
    const createdA = Number(a.createdAt) || 0
    const createdB = Number(b.createdAt) || 0
    return createdB - createdA
  })
}

function createGlossaryNode(term) {
  const article = document.createElement("article")
  article.className = "glossaryTerm"

  const header = document.createElement("header")
  header.className = "glossaryHeader"
  const title = document.createElement("h4")
  title.className = "glossaryTitle"
  title.textContent = clampText(term.term, 180) || "Untitled term"
  const meta = document.createElement("p")
  meta.className = "glossaryMeta"
  const pageLabel = Number.isFinite(term.grounding?.pageIndex)
    ? `Page ${Number(term.grounding.pageIndex) + 1}`
    : "Page ?"
  const sectionTitle = clampText(term.grounding?.sectionTitle || "Unknown section", 120)
  meta.textContent = `${pageLabel} - ${sectionTitle}`
  header.append(title, meta)
  article.append(header)

  const summary = document.createElement("p")
  summary.className = "glossarySummary"
  summary.textContent = clampText(term.shortAnswer, 320)
  article.append(summary)

  if (term.grounding?.quote) {
    const quote = document.createElement("blockquote")
    quote.className = "glossaryQuote"
    quote.textContent = sanitizeText(term.grounding.quote)
    article.append(quote)
  }

  const footer = document.createElement("footer")
  footer.className = "glossaryFooter"
  const deleteButton = document.createElement("button")
  deleteButton.type = "button"
  deleteButton.className = "cardActionButton danger"
  deleteButton.dataset.termAction = "delete"
  deleteButton.dataset.termId = term.id
  deleteButton.textContent = "Delete"
  footer.append(deleteButton)
  article.append(footer)

  return article
}

function renderGlossaryTab() {
  const terms = getSortedGlossaryTerms(sidebarUiState.glossaryTerms)
  if (terms.length === 0) {
    renderEmpty("glossary")
    return
  }

  panel.innerHTML = ""
  const list = document.createElement("div")
  list.className = "glossaryList"
  for (const term of terms) {
    list.append(createGlossaryNode(term))
  }
  panel.append(list)
}

function normalizeSectionTitleKey(title) {
  return sanitizeText(title).toLowerCase()
}

function normalizeSectionKeyTitle(title) {
  return sanitizeText(title).toLowerCase()
}

function getSectionLevel(section) {
  return Number.isFinite(Number(section?.level)) ? Math.max(1, Math.floor(Number(section.level))) : 1
}

function getSectionDisplayTitle(section) {
  return sanitizeText(section?.title || section?.displayTitle)
}

function getSectionKey(section) {
  const pageIndex = parseOptionalPageIndex(section?.pageIndex)
  const titleKey = normalizeSectionKeyTitle(getSectionDisplayTitle(section))
  if (pageIndex == null || !titleKey) {
    return ""
  }
  const level = getSectionLevel(section)
  return `${pageIndex}:${level}:${titleKey}`
}

function getSectionKeysFromSections(sections) {
  const keys = []
  const seen = new Set()
  for (const section of Array.isArray(sections) ? sections : []) {
    const key = getSectionKey(section)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    keys.push(key)
  }
  return keys
}

function normalizeSectionIntentMap(intentsObj) {
  const source = intentsObj && typeof intentsObj === "object" && !Array.isArray(intentsObj) ? intentsObj : {}
  const normalized = {}
  for (const [rawKey, rawIntent] of Object.entries(source)) {
    const key = sanitizeText(rawKey)
    const intent = clampText(rawIntent, 220)
    if (!key || !intent) {
      continue
    }
    normalized[key] = intent
  }
  return normalized
}

function getSectionIntentMapFromOrientationData(sectionIntents) {
  return normalizeSectionIntentMap(sectionIntents)
}

function mapIntentsToCurrentSections(sections, intentsObj) {
  const intents = normalizeSectionIntentMap(intentsObj)
  const mapped = {}
  for (const section of Array.isArray(sections) ? sections : []) {
    const sectionKey = getSectionKey(section)
    if (!sectionKey) {
      continue
    }
    const intent = clampText(intents[sectionKey], 220)
    if (intent) {
      mapped[sectionKey] = intent
    }
  }
  return mapped
}

function getReadingModeOrDefault() {
  return currentSettings?.defaultReadingMode === "structure" ? "structure" : "flow"
}

function getOrientationState() {
  if (!sidebarUiState.orientation || typeof sidebarUiState.orientation !== "object") {
    sidebarUiState.orientation = createOrientationUiState(getReadingModeOrDefault())
  }
  return sidebarUiState.orientation
}

function getReadingMapState() {
  const orientationState = getOrientationState()
  if (!orientationState.readingMap || typeof orientationState.readingMap !== "object") {
    orientationState.readingMap = createReadingMapUiState()
  }
  return orientationState.readingMap
}

function resetReadingMapState() {
  const orientationState = getOrientationState()
  orientationState.readingMap = createReadingMapUiState()
}

function setIntentLoading(sectionKey, isLoading) {
  if (!sectionKey) {
    return
  }
  const readingMapState = getReadingMapState()
  readingMapState.intentLoadingByKey[sectionKey] = Boolean(isLoading)
}

function isIntentLoading(sectionKey) {
  const readingMapState = getReadingMapState()
  return Boolean(readingMapState.intentLoadingByKey[sectionKey])
}

function setIntentVisible(sectionKey, visible) {
  if (!sectionKey) {
    return
  }
  const readingMapState = getReadingMapState()
  if (visible) {
    readingMapState.visibleIntentKeys.add(sectionKey)
    return
  }
  readingMapState.visibleIntentKeys.delete(sectionKey)
}

function isIntentVisible(sectionKey) {
  const readingMapState = getReadingMapState()
  return readingMapState.visibleIntentKeys.has(sectionKey)
}

function setNodeExpanded(sectionKey, expanded) {
  if (!sectionKey) {
    return
  }
  const readingMapState = getReadingMapState()
  if (expanded) {
    readingMapState.expandedKeys.add(sectionKey)
    return
  }
  readingMapState.expandedKeys.delete(sectionKey)
}

function isNodeExpanded(sectionKey) {
  const readingMapState = getReadingMapState()
  return readingMapState.expandedKeys.has(sectionKey)
}

function applyOrientationModeDefaults(mode, { force = false } = {}) {
  const orientationState = getOrientationState()
  const normalizedMode = mode === "structure" ? "structure" : "flow"
  if (force || !orientationState.userMapPreference) {
    orientationState.mapExpanded = normalizedMode === "structure"
  }
  if (force || !orientationState.userCollapsed) {
    orientationState.collapsed = false
  }
}

function resetOrientationStateForDocument() {
  sidebarUiState.orientation = createOrientationUiState(getReadingModeOrDefault())
  sectionIntentManager = null
  sectionIntentManagerDocId = ""
}

function updateOrientationSections(sections) {
  const orientationState = getOrientationState()
  const safeSections = Array.isArray(sections) ? sections : []
  orientationState.data.sections = safeSections
}

function setOrientationLoading(message = "Generating orientation...") {
  const orientationState = getOrientationState()
  orientationState.status = "loading"
  orientationState.loadingMessage = sanitizeText(message) || "Generating orientation..."
  orientationState.errorMessage = ""
  orientationState.intentsStatus = "idle"
}

function setOrientationError(message) {
  const orientationState = getOrientationState()
  orientationState.status = "error"
  orientationState.loadingMessage = ""
  orientationState.errorMessage = clampText(message || "Orientation generation failed.", 220)
}

function setOrientationReady(data) {
  const orientationState = getOrientationState()
  orientationState.status = "ready"
  orientationState.loadingMessage = ""
  orientationState.errorMessage = ""
  orientationState.data = {
    ...createEmptyOrientationData(),
    ...(data && typeof data === "object" ? data : {})
  }
}

function setOrientationIntentsStatus(status = "idle") {
  const orientationState = getOrientationState()
  orientationState.intentsStatus = status === "loading" ? "loading" : "idle"
}

function toggleOrientationCollapsed(collapsed) {
  const orientationState = getOrientationState()
  orientationState.collapsed = Boolean(collapsed)
  orientationState.userCollapsed = true
  renderPanel()
}

function toggleOrientationMapExpanded(expanded) {
  const orientationState = getOrientationState()
  orientationState.mapExpanded = Boolean(expanded)
  orientationState.userMapPreference = true
  renderPanel()
}

function showPanelToast(message, durationMs = PANEL_TOAST_DURATION_MS) {
  sidebarUiState.toastMessage = clampText(message, 140)
  if (panelToastTimer) {
    clearTimeout(panelToastTimer)
  }
  if (sidebarUiState.activeTab === "orientation" || sidebarUiState.activeTab === "walkthrough") {
    renderPanel()
  }
  panelToastTimer = setTimeout(() => {
    panelToastTimer = null
    sidebarUiState.toastMessage = ""
    if (sidebarUiState.activeTab === "orientation" || sidebarUiState.activeTab === "walkthrough") {
      renderPanel()
    }
  }, Math.max(700, Number(durationMs) || PANEL_TOAST_DURATION_MS))
}

function createPanelToastNode(message) {
  const text = clampText(message, 140)
  if (!text) {
    return null
  }
  const toast = document.createElement("p")
  toast.className = "panelToast"
  toast.textContent = text
  return toast
}

function createOrientationHeader({ actionLabel = "Start reading" }) {
  const header = document.createElement("div")
  header.className = "orientationHeader"

  const title = document.createElement("h3")
  title.className = "panelTitle"
  title.textContent = "Paper Orientation"
  header.append(title)

  const actions = document.createElement("div")
  actions.className = "orientationHeaderActions"

  const regenerateButton = document.createElement("button")
  regenerateButton.type = "button"
  regenerateButton.className = "orientationIconButton"
  regenerateButton.dataset.orientationAction = "regenerate"
  regenerateButton.title = "Regenerate orientation"
  regenerateButton.setAttribute("aria-label", "Regenerate orientation")
  const regenerateIcon = document.createElement("img")
  regenerateIcon.className = "orientationIconImage"
  regenerateIcon.alt = ""
  regenerateIcon.src =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? ICON_REGENERATE_LIGHT_URL
      : ICON_REGENERATE_DARK_URL
  regenerateButton.append(regenerateIcon)
  actions.append(regenerateButton)

  const actionButton = document.createElement("button")
  actionButton.type = "button"
  actionButton.className = "orientationAction"
  actionButton.dataset.orientationAction = "collapse"
  actionButton.textContent = actionLabel
  actions.append(actionButton)

  header.append(actions)

  return header
}

function createOrientationParagraph(text) {
  const paragraph = document.createElement("p")
  paragraph.className = "orientationParagraph"
  paragraph.textContent = text
  return paragraph
}

function createOrientationBullets(items) {
  const list = document.createElement("ul")
  list.className = "orientationBullets"
  for (const item of items) {
    const text = clampText(item, 220)
    if (!text) {
      continue
    }
    const li = document.createElement("li")
    li.textContent = text
    list.append(li)
  }
  return list
}

function createOrientationSection(title) {
  const section = document.createElement("section")
  section.className = "orientationSection"
  const heading = document.createElement("h4")
  heading.className = "orientationSectionTitle"
  heading.textContent = title
  section.append(heading)
  return section
}

function createOrientationLoading(message) {
  const container = document.createElement("div")
  container.className = "orientationLoading"

  const text = document.createElement("p")
  text.className = "orientationLoadingText"
  text.textContent = message
  container.append(text)

  for (let index = 0; index < 3; index += 1) {
    const line = document.createElement("div")
    line.className = "orientationSkeletonLine"
    container.append(line)
  }
  return container
}

function createOrientationKeyTerms(terms) {
  const wrapper = document.createElement("div")
  wrapper.className = "orientationKeyTerms"
  for (const term of terms.slice(0, ORIENTATION_MAX_KEY_TERMS)) {
    const chipText = clampText(term, 48)
    if (!chipText) {
      continue
    }
    const chip = document.createElement("span")
    chip.className = "orientationTermChip"
    chip.textContent = chipText
    wrapper.append(chip)
  }
  return wrapper
}

function renderOrientationReadingMap(
  container,
  sections,
  sectionIntents,
  mapExpanded,
  readingMode,
  intentsStatus = "idle"
) {
  void sectionIntents
  void mapExpanded
  void readingMode
  void intentsStatus
  const mapSection = createOrientationSection("Section markers")
  const normalizedSections = Array.isArray(sections) ? sections : []

  const actionRow = document.createElement("div")
  actionRow.className = "orientationMapActions"

  const walkthroughButton = document.createElement("button")
  walkthroughButton.type = "button"
  walkthroughButton.className = "orientationMapActionButton"
  walkthroughButton.dataset.orientationAction = "build-walkthrough"
  walkthroughButton.disabled = normalizedSections.length === 0
  walkthroughButton.textContent = "Build walkthrough"
  actionRow.append(walkthroughButton)
  mapSection.append(actionRow)

  if (normalizedSections.length === 0) {
    const empty = document.createElement("p")
    empty.className = "orientationMutedText"
    empty.textContent = "No outline detected for section markers."
    mapSection.append(empty)
    container.append(mapSection)
    return
  }

  const summary = document.createElement("p")
  summary.className = "orientationMutedText"
  summary.textContent =
    normalizedSections.length === 1
      ? "1 section marker is available on the left rail."
      : `${normalizedSections.length} section markers are available on the left rail.`
  mapSection.append(summary)
  container.append(mapSection)
}

function renderOrientationTab() {
  if (!currentPdf || !renderState.pdfDoc) {
    renderEmpty("orientation")
    return
  }

  const readingMode = getReadingModeOrDefault()
  const orientationState = getOrientationState()
  panel.innerHTML = ""

  if (orientationState.collapsed) {
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = "orientationChip"
    chip.dataset.orientationAction = "expand"
    chip.textContent = "Orientation"
    panel.append(chip)
    return
  }

  const container = document.createElement("div")
  container.className = "orientationPanel"
  container.append(
    createOrientationHeader({
      actionLabel: readingMode === "structure" ? "Collapse" : "Start reading"
    })
  )
  const toast = createPanelToastNode(sidebarUiState.toastMessage)
  if (toast) {
    container.append(toast)
  }

  if (orientationState.status === "loading") {
    container.append(createOrientationLoading(orientationState.loadingMessage || "Generating orientation..."))
    if (Array.isArray(orientationState.data?.sections) && orientationState.data.sections.length > 0) {
      renderOrientationReadingMap(
        container,
        orientationState.data.sections,
        orientationState.data.sectionIntents,
        orientationState.mapExpanded,
        readingMode,
        orientationState.intentsStatus
      )
    }
    panel.append(container)
    return
  }

  if (orientationState.status === "error") {
    const error = document.createElement("p")
    error.className = "orientationError"
    error.textContent = orientationState.errorMessage || "Orientation generation failed."
    container.append(error)
  }

  const data = orientationState.data || createEmptyOrientationData()
  const glanceSection = createOrientationSection("Paper at a glance")
  const purpose = clampText(data.purpose, readingMode === "flow" ? 220 : 320)
  const contribution = clampText(data.contribution, readingMode === "flow" ? 220 : 320)
  const glanceText = [purpose, contribution].filter(Boolean).join(" ")
  glanceSection.append(
    createOrientationParagraph(
      glanceText || "Orientation is still building. Start with the introduction and abstract."
    )
  )
  container.append(glanceSection)

  const focusSection = createOrientationSection("What to focus on")
  const focusLimit =
    readingMode === "structure" ? ORIENTATION_MAX_STRUCTURE_FOCUS_BULLETS : ORIENTATION_MAX_FLOW_FOCUS_BULLETS
  const focusBullets =
    Array.isArray(data.focusBullets) && data.focusBullets.length > 0
      ? data.focusBullets.slice(0, focusLimit)
      : ["Identify the main claim, method assumptions, and the evidence supporting conclusions."]
  focusSection.append(createOrientationBullets(focusBullets))
  container.append(focusSection)

  const keyTermsSection = createOrientationSection("Key terms")
  keyTermsSection.append(createOrientationKeyTerms(Array.isArray(data.keyTerms) ? data.keyTerms : []))
  if (readingMode === "structure") {
    container.append(keyTermsSection)
  } else {
    const keyTermsDetails = document.createElement("details")
    keyTermsDetails.className = "orientationDetails"
    const keyTermsSummary = document.createElement("summary")
    keyTermsSummary.textContent = "Key terms"
    keyTermsDetails.append(keyTermsSummary, keyTermsSection)
    container.append(keyTermsDetails)
  }

  renderOrientationReadingMap(
    container,
    data.sections,
    data.sectionIntents,
    orientationState.mapExpanded,
    readingMode,
    orientationState.intentsStatus
  )

  panel.append(container)
}

function normalizeWalkthroughItems(items) {
  const source = Array.isArray(items) ? items : []
  return source
    .map((item, index) => ({
      sectionTitle: clampText(item?.sectionTitle, 180) || `Section ${index + 1}`,
      oneLiner: clampText(item?.oneLiner, 220),
      pageIndex: Number.isFinite(Number(item?.pageIndex)) ? Math.max(0, Math.floor(Number(item.pageIndex))) : 0,
      createdAt:
        typeof item?.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    }))
    .slice(0, 120)
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeKeywordRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function splitSectionLabel(sectionTitle) {
  const text = clampText(sectionTitle, 180)
  const matched = text.match(/^(\d+(?:\.\d+)*|[IVXLCM]+)\s+(.+)$/i)
  if (!matched) {
    return { number: "", title: text }
  }
  return {
    number: sanitizeText(matched[1]),
    title: sanitizeText(matched[2])
  }
}

function buildWalkthroughKeywordList(sectionTitle, explanation) {
  const keywordSet = new Set()
  const titleWords = sanitizeText(sectionTitle)
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9-]/g, ""))
    .filter((word) => word.length >= 5)
    .slice(0, 6)
  for (const word of titleWords) {
    keywordSet.add(word)
  }

  const actionWords = ["introduce", "argue", "discuss", "present", "describe", "summarize", "evaluate", "compare"]
  for (const word of actionWords) {
    if (new RegExp(`\\b${escapeKeywordRegExp(word)}\\w*\\b`, "i").test(explanation)) {
      keywordSet.add(word)
    }
  }

  return [...keywordSet].slice(0, 10).sort((a, b) => b.length - a.length)
}

function formatWalkthroughExplanationHtml(explanation, sectionTitle) {
  const text = clampText(explanation, 320)
  if (!text) {
    return ""
  }
  let html = escapeHtml(text)
  const keywords = buildWalkthroughKeywordList(sectionTitle, text)
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b(${escapeKeywordRegExp(keyword)}\\w*)\\b`, "gi")
    html = html.replace(pattern, "<strong>$1</strong>")
  }
  return html
}

function renderWalkthroughTab() {
  if (!currentPdf || !renderState.pdfDoc) {
    renderEmpty("walkthrough")
    return
  }

  const walkthroughState = sidebarUiState.walkthrough || createWalkthroughUiState()
  panel.innerHTML = ""

  const container = document.createElement("div")
  container.className = "walkthroughPanel"

  const headingRow = document.createElement("div")
  headingRow.className = "walkthroughHeader"
  const heading = document.createElement("h3")
  heading.className = "panelTitle"
  heading.textContent = "Walkthrough"
  headingRow.append(heading)

  const rebuildButton = document.createElement("button")
  rebuildButton.type = "button"
  rebuildButton.className = "walkthroughAction"
  rebuildButton.dataset.walkthroughAction = "rebuild"
  rebuildButton.textContent = "Rebuild from orientation"
  headingRow.append(rebuildButton)
  container.append(headingRow)

  const toast = createPanelToastNode(sidebarUiState.toastMessage)
  if (toast) {
    container.append(toast)
  }

  if (walkthroughState.confirmRebuild) {
    const confirm = document.createElement("div")
    confirm.className = "walkthroughConfirm"
    const text = document.createElement("span")
    text.textContent = "Replace existing walkthrough items?"
    const confirmButton = document.createElement("button")
    confirmButton.type = "button"
    confirmButton.className = "walkthroughAction"
    confirmButton.dataset.walkthroughAction = "confirm-rebuild"
    confirmButton.textContent = "Replace"
    const cancelButton = document.createElement("button")
    cancelButton.type = "button"
    cancelButton.className = "walkthroughAction"
    cancelButton.dataset.walkthroughAction = "cancel-rebuild"
    cancelButton.textContent = "Cancel"
    confirm.append(text, confirmButton, cancelButton)
    container.append(confirm)
  }

  const items = normalizeWalkthroughItems(walkthroughState.items)
  if (items.length === 0) {
    const empty = document.createElement("p")
    empty.className = "panelEmptyMessage"
    empty.textContent = getEmptyMessage("walkthrough")
    container.append(empty)
    panel.append(container)
    return
  }

  const list = document.createElement("div")
  list.className = "walkthroughList"
  items.forEach((item, index) => {
    const row = document.createElement("article")
    row.className = "walkthroughItem"
    row.dataset.walkthroughIndex = String(index)

    const jumpButton = document.createElement("button")
    jumpButton.type = "button"
    jumpButton.className = "walkthroughJump"
    jumpButton.dataset.walkthroughAction = "jump"
    jumpButton.dataset.walkthroughIndex = String(index)
    jumpButton.dataset.sectionPageIndex = String(item.pageIndex)
    jumpButton.dataset.sectionTitle = item.sectionTitle
    const sectionLabel = splitSectionLabel(item.sectionTitle)
    if (sectionLabel.number) {
      const number = document.createElement("span")
      number.className = "walkthroughSectionNumber"
      number.textContent = sectionLabel.number
      const title = document.createElement("span")
      title.className = "walkthroughSectionTitle"
      title.textContent = sectionLabel.title
      jumpButton.append(number, title)
    } else {
      const title = document.createElement("span")
      title.className = "walkthroughSectionTitle"
      title.textContent = item.sectionTitle
      jumpButton.append(title)
    }

    const oneLinerPreview = document.createElement("p")
    oneLinerPreview.className = "walkthroughPreview"
    const previewHtml = formatWalkthroughExplanationHtml(item.oneLiner, item.sectionTitle)
    if (previewHtml) {
      oneLinerPreview.innerHTML = previewHtml
    } else {
      oneLinerPreview.textContent = "Add a one-line roadmap note."
    }
    row.append(jumpButton, oneLinerPreview)
    list.append(row)
  })
  container.append(list)
  panel.append(container)
}

function renderPanel() {
  const tab = sidebarUiState.activeTab
  if (tab === "orientation") {
    renderOrientationTab()
    return
  }
  if (tab === "explain" || tab === "figures") {
    renderCardsTab(tab)
    return
  }
  if (tab === "glossary") {
    renderGlossaryTab()
    return
  }
  if (tab === "walkthrough") {
    renderWalkthroughTab()
    return
  }
  renderEmpty(tab)
}

function setActiveTab(tab) {
  const normalizedTab = normalizeTabName(tab)
  sidebarUiState.activeTab = normalizedTab
  if (normalizedTab !== "walkthrough") {
    sidebarUiState.walkthrough.confirmRebuild = false
  }
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === normalizedTab)
  })
  renderPanel()
  logger.info("Tab switched", { tab: normalizedTab })
  logger.debug("Rendered tab content", { tab: normalizedTab })
}

function setDiagnosticsMenuOpen(isOpen) {
  diagnosticsMenu.hidden = !isOpen;
  diagnosticsToggleBtn.setAttribute("aria-expanded", String(isOpen));
  logger.debug("Diagnostics menu toggled", { open: isOpen });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function syncFitWidthUi() {
  fitWidthBtn.setAttribute("aria-pressed", String(renderState.fitWidthEnabled));
  pdfRoot.classList.toggle("fitWidthMode", renderState.fitWidthEnabled);
}

function setFitWidthEnabled(enabled) {
  const nextEnabled = Boolean(enabled);
  const didChange = renderState.fitWidthEnabled !== nextEnabled;
  renderState.fitWidthEnabled = nextEnabled;
  syncFitWidthUi();

  if (didChange && currentPdf && renderState.pageNodes.length > 0) {
    applyVisualScale();
  }
}

function clampSidebarWidth(width) {
  const layoutWidth = layoutEl?.clientWidth || window.innerWidth || 0;
  const ratioMax = Math.floor(layoutWidth * SIDEBAR_MAX_WIDTH_RATIO);
  const availableMax = layoutWidth - PDF_PANE_MIN_WIDTH;
  const dynamicMax = Math.max(SIDEBAR_MIN_WIDTH, Math.min(availableMax, ratioMax));
  return Math.min(dynamicMax, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function applySidebarLayout() {
  const sidebarWidth = sidebarState.collapsed
    ? SIDEBAR_COLLAPSED_WIDTH
    : clampSidebarWidth(sidebarState.width);
  layoutEl.style.gridTemplateColumns = `minmax(0, 1fr) ${Math.round(sidebarWidth)}px`;
}

function setSidebarWidth(width, options = {}) {
  const clamped = clampSidebarWidth(width);
  sidebarState.width = clamped;
  applySidebarLayout();

  if (!options.skipFitWidthResize) {
    handleWindowResize();
  }
}

function setSidebarCollapsed(collapsed, options = {}) {
  sidebarState.collapsed = Boolean(collapsed);
  layoutEl.classList.toggle("sidebarCollapsed", sidebarState.collapsed);
  toggleSidebarBtn.setAttribute("aria-pressed", String(sidebarState.collapsed));
  toggleSidebarBtn.textContent = sidebarState.collapsed ? "Show Panel" : "Hide Panel";
  toggleSidebarBtn.setAttribute(
    "aria-label",
    sidebarState.collapsed ? "Show sidebar panel" : "Hide sidebar panel"
  );
  applySidebarLayout();

  if (!options.skipFitWidthResize) {
    handleWindowResize();
  }
}

function initializeSidebarState() {
  const initialWidth = sidebarEl.getBoundingClientRect().width || SIDEBAR_DEFAULT_WIDTH;
  setSidebarWidth(initialWidth, { skipFitWidthResize: true });
  setSidebarCollapsed(false, { skipFitWidthResize: true });
}

function handleSidebarResizeStart(event) {
  if ((event.pointerType === "mouse" && event.button !== 0) || sidebarState.collapsed) {
    return;
  }

  sidebarState.resizePointerId = event.pointerId;
  sidebarState.resizeStartX = event.clientX;
  sidebarState.resizeStartWidth = sidebarEl.getBoundingClientRect().width || sidebarState.width;
  if (sidebarResizeHandle.setPointerCapture) {
    try {
      sidebarResizeHandle.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Best effort.
    }
  }
  window.addEventListener("pointermove", handleSidebarResizeMove);
  window.addEventListener("pointerup", handleSidebarResizeEnd);
  window.addEventListener("pointercancel", handleSidebarResizeEnd);
  document.body.classList.add("resizingSidebar");
  event.preventDefault();
}

function handleSidebarResizeMove(event) {
  if (event.pointerId !== sidebarState.resizePointerId) {
    return;
  }

  const delta = sidebarState.resizeStartX - event.clientX;
  const nextWidth = sidebarState.resizeStartWidth + delta;
  if (nextWidth <= SIDEBAR_COLLAPSE_TRIGGER_WIDTH) {
    setSidebarCollapsed(true, { skipFitWidthResize: true });
    handleSidebarResizeEnd(event);
    return;
  }

  setSidebarWidth(nextWidth, { skipFitWidthResize: true });
}

function handleSidebarResizeEnd(event) {
  if (event.pointerId !== sidebarState.resizePointerId && sidebarState.resizePointerId != null) {
    return;
  }

  const hadActiveResize = sidebarState.resizePointerId != null;
  const pointerId = sidebarState.resizePointerId;
  window.removeEventListener("pointermove", handleSidebarResizeMove);
  window.removeEventListener("pointerup", handleSidebarResizeEnd);
  window.removeEventListener("pointercancel", handleSidebarResizeEnd);
  sidebarState.resizePointerId = null;
  document.body.classList.remove("resizingSidebar");
  if (sidebarResizeHandle.releasePointerCapture && pointerId != null) {
    try {
      sidebarResizeHandle.releasePointerCapture(pointerId);
    } catch (_error) {
      // Best effort.
    }
  }
  if (hadActiveResize) {
    handleWindowResize();
  }
}

function setCopyStatus(text) {
  copyStatusEl.textContent = text;

  if (copyStatusTimer) {
    clearTimeout(copyStatusTimer);
  }

  if (text) {
    copyStatusTimer = setTimeout(() => {
      copyStatusEl.textContent = "";
      copyStatusTimer = null;
    }, 1400);
  }
}

function inferOpenedPdfSourceFromSrc(src) {
  if (!src) {
    return null;
  }

  const lowered = src.toLowerCase();
  if (lowered.startsWith("http:") || lowered.startsWith("https:")) {
    return "remote";
  }

  return "remote";
}

function sanitizeUrlForLog(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_error) {
    return url.split("?")[0].split("#")[0];
  }
}

function getFilenameFromUrl(url) {
  const normalizedUrl = sanitizeText(url)
  if (!normalizedUrl) {
    return ""
  }

  const readLastPathSegment = (value) => {
    const segment = value.split("/").filter(Boolean).pop() || ""
    if (!segment) {
      return ""
    }
    try {
      return decodeURIComponent(segment).trim()
    } catch (_error) {
      return segment.trim()
    }
  }

  try {
    const parsed = new URL(normalizedUrl)
    return readLastPathSegment(parsed.pathname || "")
  } catch (_error) {
    const withoutQuery = normalizedUrl.split("?")[0].split("#")[0]
    return readLastPathSegment(withoutQuery)
  }
}

function normalizePdfFilename(value) {
  const normalized = sanitizeText(value)
  if (!normalized) {
    return ""
  }
  if (normalized.toLowerCase().endsWith(".pdf")) {
    return normalized
  }
  return `${normalized}.pdf`
}

function getCurrentPdfTitleLabel() {
  if (!currentPdf) {
    return ""
  }

  const filename = normalizePdfFilename(currentPdf.filename)
  if (filename) {
    return filename
  }

  if (currentPdf.sourceType === "remote") {
    const inferredFilename = normalizePdfFilename(getFilenameFromUrl(currentPdf.url))
    if (inferredFilename) {
      return inferredFilename
    }
    const safeUrl = sanitizeUrlForLog(currentPdf.url)
    if (safeUrl) {
      return safeUrl
    }
  }

  return "document.pdf"
}

function updateDocumentTitle() {
  const titleLabel = getCurrentPdfTitleLabel()
  document.title = titleLabel ? `${titleLabel} - ${DEFAULT_VIEWER_TITLE}` : DEFAULT_VIEWER_TITLE
}

function getViewerBaseUrl() {
  return `${location.origin}${location.pathname}`;
}

function getReadingModeLabel(mode) {
  return mode === "structure" ? "Structure" : "Flow";
}

function updateReadingModeStatus(mode) {
  readingModeStatusEl.textContent = `Mode: ${getReadingModeLabel(mode)}`;
}

function getContextScopeLabel(scope) {
  if (scope === "whole_pdf") {
    return "Whole PDF"
  }
  if (scope === "page") {
    return "Page"
  }
  return "Selection"
}

function setContextScopeTransientStatus(text) {
  contextScopeTransientStatus = sanitizeText(text)
  updateContextScopeStatus()
}

function clearContextScopeTransientStatus() {
  contextScopeTransientStatus = ""
  updateContextScopeStatus()
}

function updateContextScopeStatus() {
  if (!contextScopeStatusEl) {
    return
  }
  if (contextScopeTransientStatus) {
    contextScopeStatusEl.textContent = `Context: ${contextScopeTransientStatus}`
    return
  }
  const scope = currentSettings?.contextScope || "selection"
  contextScopeStatusEl.textContent = `Context: ${getContextScopeLabel(scope)}`
}

function maskApiKey(apiKey) {
  if (!apiKey) {
    return "";
  }

  const trimmed = apiKey.trim();
  if (!trimmed) {
    return "";
  }

  const tail = trimmed.slice(-4);
  if (trimmed.startsWith("sk-")) {
    return `sk-****${tail}`;
  }
  return `****${tail}`;
}

function setApiPresenceStatus(settings) {
  if (!settings?.openaiApiKey) {
    apiKeyStatusEl.textContent = "No key set";
    return;
  }

  apiKeyStatusEl.textContent = `Key is set (${maskApiKey(settings.openaiApiKey)})`;
}

function setApiStatus(text) {
  apiKeyStatusEl.textContent = text;

  if (apiStatusTimer) {
    clearTimeout(apiStatusTimer);
  }

  apiStatusTimer = setTimeout(() => {
    apiStatusTimer = null;
    setApiPresenceStatus(currentSettings);
  }, 1400);
}

function getWholePdfHelpMessage(settings) {
  const baseWarning =
    "Whole PDF sends the document to the LLM provider. Use only for documents you're OK sharing."
  if (settings?.llmMode === "mock") {
    return "Mock mode ignores upload and uses selection/page context."
  }
  if (!settings?.openaiApiKey && (settings?.llmMode === "auto" || settings?.llmMode === "openai")) {
    return "Set API key to enable Whole PDF mode."
  }
  return baseWarning
}

function createSectionId(title, pageIndex, position) {
  const slug = sanitizeText(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
  const safeSlug = slug || "section"
  return `sec_${Math.max(pageIndex, 0)}_${position}_${safeSlug}`
}

function parseSectionTitleNumbering(rawTitle) {
  const title = sanitizeText(rawTitle)
  if (!title) {
    return {
      numbering: "",
      displayTitle: ""
    }
  }

  const matched = title.match(/^((?:\d+(?:\.\d+)*|[IVXLCM]+))(?:[\.\)]?)\s+(.+)$/i)
  if (!matched) {
    return {
      numbering: "",
      displayTitle: title
    }
  }

  return {
    numbering: sanitizeText(matched[1]).replace(/\.$/, ""),
    displayTitle: sanitizeText(matched[2]) || title
  }
}

function normalizeReadingMapSections(sections) {
  if (!Array.isArray(sections)) {
    return []
  }
  const sorted = sections
    .map((section) => ({
      title: sanitizeText(section?.title),
      pageIndex: parseOptionalPageIndex(section?.pageIndex),
      level: Number.isFinite(Number(section?.level)) ? Math.max(1, Math.floor(Number(section.level))) : 1,
      source: section?.source === "outline" ? "outline" : "heuristic"
    }))
    .filter((section) => section.title && section.pageIndex != null)
    .sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) {
        return a.pageIndex - b.pageIndex
      }
      return a.level - b.level
    })

  const normalized = []
  let lastTitle = ""
  let lastPage = -10
  for (const section of sorted) {
    const normalizedTitle = section.title.toLowerCase()
    if (normalizedTitle === lastTitle && section.pageIndex <= lastPage + 1) {
      continue
    }
    const titleParts = parseSectionTitleNumbering(section.title)
    normalized.push({
      id: createSectionId(section.title, section.pageIndex, normalized.length),
      numbering: titleParts.numbering,
      displayTitle: titleParts.displayTitle,
      ...section
    })
    lastTitle = normalizedTitle
    lastPage = section.pageIndex
  }

  return normalized
}

function toStoredOutlineSections(sections) {
  const source = Array.isArray(sections) ? sections : []
  return source
    .map((section) => ({
      title: sanitizeText(section?.title || section?.displayTitle),
      pageIndex: parseOptionalPageIndex(section?.pageIndex),
      level: getSectionLevel(section)
    }))
    .filter((section) => section.title && section.pageIndex != null)
}

function buildFallbackSectionIntent(sectionTitle) {
  const normalizedTitle = clampText(sectionTitle, 120) || "this section"
  return clampText(`Read this section for: ${normalizedTitle}`, 220)
}

function isLowPriorityWalkthroughSection(sectionTitle) {
  const title = sanitizeText(sectionTitle).toLowerCase()
  if (!title) {
    return false
  }
  return (
    /\breferences?\b/.test(title) ||
    /\bbibliograph/.test(title) ||
    /\bappendix\b/.test(title) ||
    /\backnowledg(e)?ments?\b/.test(title) ||
    /\bsupplement(ar(y|al))?\b/.test(title)
  )
}

async function loadCachedSectionIntentsForDocument(docId, sections) {
  if (!docId || docId === "unknown") {
    return {}
  }
  const cachedIntents = await getIntents(docId)
  return mapIntentsToCurrentSections(sections, cachedIntents)
}

function buildWalkthroughItemsFromSections(sections, sectionIntentMap) {
  const sourceSections = Array.isArray(sections) ? sections : []
  const intentMap = normalizeSectionIntentMap(sectionIntentMap)
  const topLevelSections = sourceSections.filter(
    (section) => getSectionLevel(section) === 1 && !isLowPriorityWalkthroughSection(getSectionDisplayTitle(section))
  )
  return topLevelSections.map((section) => {
    const sectionTitle = getSectionDisplayTitle(section)
    const sectionKey = getSectionKey(section)
    const oneLiner = clampText(intentMap[sectionKey], 220) || buildFallbackSectionIntent(sectionTitle)
    return {
      sectionTitle,
      oneLiner,
      pageIndex: parseOptionalPageIndex(section?.pageIndex) ?? 0,
      createdAt: Date.now()
    }
  })
}

async function persistWalkthroughForCurrentDocument(items) {
  const docId = deriveDocId(currentPdf)
  if (!docId || docId === "unknown") {
    return false
  }
  const normalizedItems = normalizeWalkthroughItems(items)
  sidebarUiState.walkthrough.items = normalizedItems
  sidebarUiState.walkthrough.confirmRebuild = false
  return setWalkthrough(docId, normalizedItems)
}

async function buildWalkthroughFromOrientation({ forceRebuild = false } = {}) {
  const sections = getReadingMapSections()
  if (sections.length === 0) {
    showPanelToast("No outline available")
    return false
  }
  const orientationState = getOrientationState()
  const intentMap = mapIntentsToCurrentSections(sections, orientationState.data?.sectionIntents)
  const items = buildWalkthroughItemsFromSections(sections, intentMap)
  if (!forceRebuild && items.length === 0) {
    showPanelToast("No top-level sections found")
    return false
  }
  const persisted = await persistWalkthroughForCurrentDocument(items)
  if (!persisted) {
    showPanelToast("Walkthrough save failed")
    return false
  }
  setActiveTab("walkthrough")
  showPanelToast("Walkthrough created")
  setStatus("Walkthrough created")
  return true
}

async function jumpToSection(pageIndex, sectionTitle, behavior = "smooth") {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null) {
    return
  }
  const pageNode = getPageNodeByIndex(normalizedPageIndex)
  if (!pageNode) {
    return
  }

  if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
    document.activeElement.blur()
  }

  scrollToPage(normalizedPageIndex + 1, behavior)
  await waitForPageInView(pageNode)
  const anchor = findSectionAnchorInPage(pageNode, sectionTitle)
  if (anchor) {
    const minPageTop = Math.max(pageNode.offsetTop + 6, 0)
    const targetTop = Math.max(
      pageNode.offsetTop + anchor.top - SECTION_JUMP_VIEWPORT_MARGIN_TOP,
      minPageTop
    )
    pdfRoot.scrollTo({ top: targetTop, behavior })
    await waitForPageInView(pageNode)
  }
  await waitForHighlightTiming()
  const needleText = clampText(sectionTitle, 160)
  if (needleText) {
    const result = highlightOnPage({
      pdfRoot,
      pageIndex: normalizedPageIndex,
      needleText,
      preferExact: false
    })
    if (result.success) {
      rememberRecentJump(normalizedPageIndex, [needleText])
    }
  }
}

function ensureSectionIntentManager() {
  if (!currentPdf || !renderState.pdfDoc) {
    return null
  }
  const docId = deriveDocId(currentPdf)
  if (!docId || docId === "unknown") {
    return null
  }
  if (sectionIntentManager && sectionIntentManagerDocId === docId) {
    return sectionIntentManager
  }
  sectionIntentManager = createIntentManager({
    docId,
    pdfDoc: renderState.pdfDoc,
    logger
  })
  sectionIntentManagerDocId = docId
  return sectionIntentManager
}

function getSectionTreeRootsForCurrentDocument() {
  const sections = getReadingMapSections()
  const roots = buildSectionTree(sections)
  const topLevel = roots.filter((node) => Number(node?.level) === 1)
  return topLevel.length > 0 ? topLevel : roots
}

function findSectionNodeByKey(nodes, sectionKey) {
  const targetKey = sanitizeText(sectionKey)
  if (!targetKey) {
    return null
  }
  const queue = [...(Array.isArray(nodes) ? nodes : [])]
  while (queue.length > 0) {
    const node = queue.shift()
    if (!node) {
      continue
    }
    if (sanitizeText(node.key) === targetKey) {
      return node
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      queue.unshift(...node.children)
    }
  }
  return null
}

function upsertOrientationIntent(sectionKey, intent) {
  const key = sanitizeText(sectionKey)
  const normalizedIntent = clampText(intent, 220)
  if (!key || !normalizedIntent) {
    return
  }
  const orientationState = getOrientationState()
  const existing = getSectionIntentMapFromOrientationData(orientationState.data?.sectionIntents)
  orientationState.data.sectionIntents = {
    ...existing,
    [key]: normalizedIntent
  }
}

async function ensureIntentForSectionNode(node) {
  const manager = ensureSectionIntentManager()
  if (!node || !node.key || !manager) {
    return ""
  }
  const sectionKey = sanitizeText(node.key)
  if (!sectionKey) {
    return ""
  }
  const currentMap = getSectionIntentMapFromOrientationData(getOrientationState().data?.sectionIntents)
  const existing = clampText(currentMap[sectionKey], 220)
  if (existing) {
    return existing
  }

  setIntentLoading(sectionKey, true)
  renderPdfIntentOverlays()
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
  try {
    const intent = clampText(await manager.getOrGenerateIntent(node), 220)
    if (intent) {
      upsertOrientationIntent(sectionKey, intent)
      return intent
    }
    return ""
  } finally {
    setIntentLoading(sectionKey, false)
    renderPdfIntentOverlays()
    if (sidebarUiState.activeTab === "orientation") {
      renderPanel()
    }
  }
}

async function handleGenerateTopLevelIntents() {
  const manager = ensureSectionIntentManager()
  const readingMapState = getReadingMapState()
  if (readingMapState.topLevelPrewarming || !manager) {
    return
  }
  const nodes = getSectionTreeRootsForCurrentDocument()
  if (nodes.length === 0) {
    return
  }

  readingMapState.topLevelPrewarming = true
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
  try {
    await manager.prewarmTopLevelIntents(nodes)
    for (const node of nodes) {
      const intent = await manager.getOrGenerateIntent(node)
      if (intent) {
        upsertOrientationIntent(node.key, intent)
      }
    }
  } finally {
    readingMapState.topLevelPrewarming = false
    if (sidebarUiState.activeTab === "orientation") {
      renderPanel()
    }
  }
}

async function handleGenerateChildIntentsForSection(sectionKey) {
  const manager = ensureSectionIntentManager()
  const key = sanitizeText(sectionKey)
  if (!key || !manager) {
    return
  }
  const readingMapState = getReadingMapState()
  if (readingMapState.groupPrewarmByKey[key]) {
    return
  }
  const node = findSectionNodeByKey(getSectionTreeRootsForCurrentDocument(), key)
  if (!node || !Array.isArray(node.children) || node.children.length === 0) {
    return
  }

  readingMapState.groupPrewarmByKey[key] = true
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
  try {
    for (const child of node.children) {
      const intent = await ensureIntentForSectionNode(child)
      if (intent) {
        upsertOrientationIntent(child.key, intent)
      }
    }
  } finally {
    readingMapState.groupPrewarmByKey[key] = false
    if (sidebarUiState.activeTab === "orientation") {
      renderPanel()
    }
  }
}

function clearPdfIntentOverlays() {
  for (const pageNode of renderState.pageNodes) {
    if (!(pageNode instanceof HTMLElement)) {
      continue
    }
    const overlays = pageNode.querySelectorAll(".pdfIntentOverlay")
    for (const overlay of overlays) {
      overlay.remove()
    }
    const bubbles = pageNode.querySelectorAll(".pdfIntentBubble")
    for (const bubble of bubbles) {
      bubble.remove()
    }
  }
}

function normalizeIntentSearchText(value) {
  return sanitizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function extractTitleTokens(title) {
  const words = normalizeIntentSearchText(title)
    .split(" ")
    .filter((word) => word.length >= 4)
  return words.slice(0, 4)
}

function findSectionAnchorInPage(pageNode, title) {
  if (!(pageNode instanceof HTMLElement)) {
    return null
  }
  const pageSurface = pageNode.querySelector(".pdfPageSurface")
  const textLayer = pageNode.querySelector(".textLayer")
  if (!(pageSurface instanceof HTMLElement) || !(textLayer instanceof HTMLElement)) {
    return null
  }
  const spans = Array.from(textLayer.querySelectorAll("span")).filter((span) => span instanceof HTMLElement)
  if (spans.length === 0) {
    return null
  }

  const titleTokens = extractTitleTokens(title)
  if (titleTokens.length === 0) {
    return null
  }
  const normalizedTitle = normalizeIntentSearchText(title)
  const minimumTokenMatches = titleTokens.length >= 2 ? 2 : 1
  let bestSpan = null
  let bestScore = Number.NEGATIVE_INFINITY
  const surfaceRect = pageSurface.getBoundingClientRect()
  const surfaceHeight = Math.max(surfaceRect.height, 1)
  for (const span of spans) {
    const spanText = normalizeIntentSearchText(span.textContent || "")
    if (!spanText) {
      continue
    }

    let tokenMatches = 0
    for (const token of titleTokens) {
      if (spanText.includes(token)) {
        tokenMatches += 1
      }
    }
    if (tokenMatches < minimumTokenMatches) {
      continue
    }

    const spanRect = span.getBoundingClientRect()
    const relativeTop = spanRect.top - surfaceRect.top
    const wordCount = spanText.split(" ").filter(Boolean).length
    let score = tokenMatches * 4
    if (spanText === normalizedTitle) {
      score += 40
    } else if (normalizedTitle && spanText.includes(normalizedTitle)) {
      score += 26
    }
    if (tokenMatches === titleTokens.length) {
      score += 10
    }
    if (wordCount <= 10) {
      score += 4
    }
    if (spanText.length <= 70) {
      score += 4
    } else if (spanText.length > 120) {
      score -= 8
    }
    score += Math.min(Math.max(spanRect.height, 0), 24) * 0.55
    if (relativeTop <= surfaceHeight * 0.45) {
      score += 3
    }

    if (score > bestScore) {
      bestScore = score
      bestSpan = span
    }
  }
  if (!(bestSpan instanceof HTMLElement) || !Number.isFinite(bestScore) || bestScore <= 0) {
    return null
  }

  const spanRect = bestSpan.getBoundingClientRect()
  return {
    left: Math.max(6, spanRect.right - surfaceRect.left + 4),
    top: Math.max(4, spanRect.top - surfaceRect.top - 2),
    pageSurface
  }
}

function renderPdfIntentOverlays() {
  clearPdfIntentOverlays()
  const sections = getReadingMapSections()
  const intentMap = getSectionIntentMapFromOrientationData(getOrientationState().data?.sectionIntents)
  if (!Array.isArray(sections) || sections.length === 0) {
    return
  }

  for (const section of sections) {
    const sectionKey = getSectionKey(section)
    if (!sectionKey) {
      continue
    }
    const pageIndex = parseOptionalPageIndex(section?.pageIndex)
    if (pageIndex == null) {
      continue
    }
    const pageNode = getPageNodeByIndex(pageIndex)
    const anchor = findSectionAnchorInPage(pageNode, getSectionDisplayTitle(section))
    if (!anchor) {
      continue
    }

    const button = document.createElement("button")
    button.type = "button"
    button.className = "pdfIntentOverlay"
    button.dataset.pdfIntentAction = "toggle"
    button.dataset.sectionKey = sectionKey
    button.textContent = "?"
    button.style.left = `${anchor.left}px`
    button.style.top = `${anchor.top}px`
    anchor.pageSurface.append(button)

    if (isIntentVisible(sectionKey)) {
      const bubble = document.createElement("div")
      bubble.className = "pdfIntentBubble"
      const intent = clampText(intentMap[sectionKey], 220)
      bubble.textContent = isIntentLoading(sectionKey) ? "Generating..." : intent || "No intent available yet."
      bubble.style.left = `${Math.min(anchor.left + 24, Math.max(anchor.pageSurface.clientWidth - 220, 10))}px`
      bubble.style.top = `${Math.max(anchor.top - 2, 4)}px`
      anchor.pageSurface.append(bubble)
    }
  }
}

async function handlePdfIntentOverlayClick(buttonEl) {
  const sectionKey = sanitizeText(buttonEl?.dataset?.sectionKey)
  if (!sectionKey) {
    return
  }
  const currentlyVisible = isIntentVisible(sectionKey)
  setIntentVisible(sectionKey, !currentlyVisible)
  renderPdfIntentOverlays()
  if (currentlyVisible) {
    return
  }
  const node = findSectionNodeByKey(getSectionTreeRootsForCurrentDocument(), sectionKey)
  if (!node) {
    return
  }
  await ensureIntentForSectionNode(node)
  renderPdfIntentOverlays()
}

function getFigureIntentKey(card) {
  const cardId = sanitizeText(card?.id)
  if (!cardId) {
    return ""
  }
  return `figure:${cardId.toLowerCase()}`
}

function buildFigureIntentNode(card) {
  const sectionTitle = clampText(card?.title || card?.grounding?.sectionTitle || "Figure", 160)
  const pageIndex = parseOptionalPageIndex(card?.grounding?.pageIndex) ?? 0
  const key = getFigureIntentKey(card)
  return {
    key,
    title: sectionTitle,
    pageIndex,
    level: 1,
    hasChildren: false,
    children: []
  }
}

async function handleToggleFigureIntent(card) {
  const cardKey = getFigureIntentKey(card)
  if (!cardKey) {
    return
  }
  const visible = isIntentVisible(cardKey)
  setIntentVisible(cardKey, !visible)
  if (visible) {
    renderPanel()
    return
  }
  renderPanel()
  await ensureIntentForSectionNode(buildFigureIntentNode(card))
}

function isLoadTokenCurrent(loadToken) {
  return (
    loadToken === renderState.loadToken &&
    Boolean(currentPdf) &&
    Boolean(renderState.pdfDoc) &&
    renderState.pdfDoc === currentPdf.pdfDocRef
  )
}

function isOrientationRunCurrent(loadToken, runToken) {
  return isLoadTokenCurrent(loadToken) && runToken === orientationRunToken
}

function updateOrientationLoadingMessage(message) {
  setOrientationLoading(message)
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
}

function applyReadingMapToCurrentDocument(sections) {
  if (!currentPdf || typeof currentPdf !== "object") {
    return
  }
  const normalizedSections = normalizeReadingMapSections(sections)
  currentPdf.readingMap = { sections: normalizedSections }
  updateOrientationSections(normalizedSections)
  resetReadingMapState()
  const docId = deriveDocId(currentPdf)
  sectionIntentManager =
    renderState.pdfDoc && docId
      ? createIntentManager({
          docId,
          pdfDoc: renderState.pdfDoc,
          logger
        })
      : null
  sectionIntentManagerDocId = sectionIntentManager ? docId : ""
  const orientationState = getOrientationState()
  orientationState.data.sectionIntents = mapIntentsToCurrentSections(
    normalizedSections,
    orientationState.data?.sectionIntents
  )
  renderPdfIntentOverlays()
  scheduleSectionRailRender()
}

function summarizeFirstPageTopLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return ""
  }
  return lines.map((line) => sanitizeText(line)).filter(Boolean).slice(0, 3).join(" ")
}

async function getFirstPageTopLines(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc.getPage !== "function") {
    return []
  }
  const page = await pdfDoc.getPage(1)
  const viewport = page.getViewport({ scale: 1 })
  const pageHeight = Math.max(Number(viewport?.height) || 0, 1)
  const textContent = await page.getTextContent()
  const items = Array.isArray(textContent?.items) ? textContent.items : []

  const linesByY = new Map()
  for (const item of items) {
    const text = sanitizeText(item?.str)
    if (!text || text.length > 140 || /^(\d+|page\s+\d+)$/i.test(text)) {
      continue
    }
    const transform = Array.isArray(item?.transform) ? item.transform : null
    const x = Number(transform?.[4])
    const y = Number(transform?.[5])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue
    }
    if (y / pageHeight < 0.58) {
      continue
    }
    const yKey = Math.round(y / 2)
    let bucket = linesByY.get(yKey)
    if (!bucket) {
      bucket = { y, parts: [] }
      linesByY.set(yKey, bucket)
    } else {
      bucket.y = Math.max(bucket.y, y)
    }
    bucket.parts.push({ x, text })
  }

  const lines = [...linesByY.values()]
    .map((bucket) => {
      bucket.parts.sort((a, b) => a.x - b.x)
      return {
        y: bucket.y,
        text: sanitizeText(bucket.parts.map((part) => part.text).join(" "))
      }
    })
    .filter((line) => line.text.length > 2)
    .sort((a, b) => b.y - a.y)

  const unique = []
  const seen = new Set()
  for (const line of lines) {
    const key = line.text.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(line.text)
    if (unique.length >= 3) {
      break
    }
  }
  return unique
}

function extractAbstractSnippet(text) {
  const normalized = sanitizeText(text)
  if (!normalized) {
    return ""
  }
  const lower = normalized.toLowerCase()
  const abstractIndex = lower.indexOf("abstract")
  if (abstractIndex >= 0) {
    const fromAbstract = normalized.slice(abstractIndex)
    const introIndex = fromAbstract.toLowerCase().indexOf("introduction")
    const snippet = introIndex > 120 ? fromAbstract.slice(0, introIndex) : fromAbstract
    return truncateText(snippet, ORIENTATION_ABSTRACT_CHAR_LIMIT)
  }
  return truncateText(normalized, ORIENTATION_ABSTRACT_CHAR_LIMIT)
}

function clampOrientationContext({ titleGuess, abstractText, headings }) {
  let normalizedTitle = truncateText(titleGuess, 240)
  let normalizedAbstract = truncateText(abstractText, ORIENTATION_ABSTRACT_CHAR_LIMIT)
  let normalizedHeadings = (Array.isArray(headings) ? headings : [])
    .map((heading) => truncateText(heading, 120))
    .filter(Boolean)
    .slice(0, 20)

  const measureLength = () =>
    normalizedTitle.length + normalizedAbstract.length + normalizedHeadings.join(" | ").length

  while (measureLength() > ORIENTATION_CONTEXT_CHAR_LIMIT && normalizedHeadings.length > 6) {
    normalizedHeadings.pop()
  }
  if (measureLength() > ORIENTATION_CONTEXT_CHAR_LIMIT) {
    const targetAbstractLength = Math.max(
      500,
      ORIENTATION_CONTEXT_CHAR_LIMIT - normalizedTitle.length - normalizedHeadings.join(" | ").length
    )
    normalizedAbstract = truncateText(normalizedAbstract, targetAbstractLength)
  }
  if (measureLength() > ORIENTATION_CONTEXT_CHAR_LIMIT) {
    const targetTitleLength = Math.max(80, 220 - (measureLength() - ORIENTATION_CONTEXT_CHAR_LIMIT))
    normalizedTitle = truncateText(normalizedTitle, targetTitleLength)
  }
  if (measureLength() > ORIENTATION_CONTEXT_CHAR_LIMIT) {
    const overflow = measureLength() - ORIENTATION_CONTEXT_CHAR_LIMIT
    normalizedAbstract = truncateText(normalizedAbstract, Math.max(120, normalizedAbstract.length - overflow))
  }
  while (measureLength() > ORIENTATION_CONTEXT_CHAR_LIMIT && normalizedHeadings.length > 0) {
    normalizedHeadings.pop()
  }

  return {
    titleGuess: normalizedTitle,
    abstractText: normalizedAbstract,
    headings: normalizedHeadings
  }
}

async function buildOrientationInput(pdfDoc, sections) {
  const maxScanPages = Math.min(ORIENTATION_TEXT_SCAN_PAGES, Number(pdfDoc?.numPages) || 0)
  if (maxScanPages < 1) {
    return clampOrientationContext({
      titleGuess: "",
      abstractText: "",
      headings: (Array.isArray(sections) ? sections : []).map((section) => section.title).filter(Boolean)
    })
  }
  const pageTextCache = await buildPageTextCache(pdfDoc, { maxPages: maxScanPages })
  const firstPageText = await getPageText(pdfDoc, 0)
  const topLines = await getFirstPageTopLines(pdfDoc)
  const titleGuess = summarizeFirstPageTopLines(topLines) || truncateText(firstPageText, 220)

  let abstractPageIndex = 0
  for (let pageIndex = 0; pageIndex < maxScanPages; pageIndex += 1) {
    const text = sanitizeText(pageTextCache.get(pageIndex) || "")
    if (/\babstract\b/i.test(text)) {
      abstractPageIndex = pageIndex
      break
    }
  }
  const abstractSourceText =
    sanitizeText(pageTextCache.get(abstractPageIndex) || "") || sanitizeText(firstPageText || "")
  const abstractText = extractAbstractSnippet(abstractSourceText)
  const headings = (Array.isArray(sections) ? sections : []).map((section) => section.title).filter(Boolean)

  return clampOrientationContext({
    titleGuess,
    abstractText,
    headings
  })
}

function normalizeOrientationResult(response, sections) {
  const source = response && typeof response === "object" ? response : {}

  return {
    purpose: clampText(source.purpose, 360),
    contribution: clampText(source.contribution, 360),
    focusBullets: Array.isArray(source.focusBullets)
      ? source.focusBullets.map((item) => clampText(item, 220)).filter(Boolean)
      : [],
    keyTerms: Array.isArray(source.keyTerms)
      ? source.keyTerms.map((item) => clampText(item, 48)).filter(Boolean).slice(0, ORIENTATION_MAX_KEY_TERMS)
      : [],
    sectionIntents: {},
    sections
  }
}

function buildOrientationSummaryFromData(data) {
  const source = data && typeof data === "object" ? data : {}
  return {
    purpose: clampText(source.purpose, 360),
    contribution: clampText(source.contribution, 360),
    focusBullets: Array.isArray(source.focusBullets)
      ? source.focusBullets.map((item) => clampText(item, 220)).filter(Boolean)
      : [],
    keyTerms: Array.isArray(source.keyTerms)
      ? source.keyTerms.map((item) => clampText(item, 48)).filter(Boolean).slice(0, ORIENTATION_MAX_KEY_TERMS)
      : [],
    sectionIntents: {}
  }
}

function hasOrientationSummary(summary) {
  const source = summary && typeof summary === "object" ? summary : {}
  return Boolean(
    sanitizeText(source.purpose) ||
      sanitizeText(source.contribution) ||
      (Array.isArray(source.focusBullets) && source.focusBullets.length > 0) ||
      (Array.isArray(source.keyTerms) && source.keyTerms.length > 0)
  )
}

async function applyCachedOrientationForDocument(docId, loadToken, runToken) {
  if (!docId || docId === "unknown") {
    return false
  }
  const [cachedEntry, cachedOutline] = await Promise.all([getOrientationCache(docId), getOutline(docId)])
  if (!cachedEntry || !isOrientationRunCurrent(loadToken, runToken)) {
    return false
  }
  const cachedSections = normalizeReadingMapSections(
    Array.isArray(cachedOutline?.sections) && cachedOutline.sections.length > 0
      ? cachedOutline.sections
      : cachedEntry.sections
  )
  if ((!Array.isArray(cachedOutline?.sections) || cachedOutline.sections.length === 0) && cachedSections.length > 0) {
    void setOutline(docId, {
      updatedAt: Date.now(),
      sections: toStoredOutlineSections(cachedSections)
    })
  }
  const cachedSummary = buildOrientationSummaryFromData(cachedEntry.summary)
  if (!hasOrientationSummary(cachedSummary) && cachedSections.length === 0) {
    return false
  }

  applyReadingMapToCurrentDocument(cachedSections)
  const cachedIntents = await loadCachedSectionIntentsForDocument(docId, cachedSections)
  setOrientationReady({
    ...cachedSummary,
    sectionIntents: cachedIntents,
    sections: cachedSections
  })
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
  return true
}

async function persistOrientationForDocument(docId, sections, summary) {
  if (!docId || docId === "unknown") {
    return
  }
  await setOrientationCache(docId, {
    updatedAt: Date.now(),
    sections,
    summary
  })
}

async function generateOrientationForCurrentDocument(loadToken, { force = false } = {}) {
  const runToken = ++orientationRunToken
  if (!isOrientationRunCurrent(loadToken, runToken) || !renderState.pdfDoc) {
    return
  }

  try {
    const docId = deriveDocId(currentPdf)
    if (!force) {
      const usedCache = await applyCachedOrientationForDocument(docId, loadToken, runToken)
      if (usedCache) {
        return
      }
    }

    updateOrientationLoadingMessage(force ? "Regenerating orientation..." : "Generating orientation...")
    const cachedOutline = !force && docId && docId !== "unknown" ? await getOutline(docId) : null
    let outlineSections = normalizeReadingMapSections(cachedOutline?.sections)
    if (outlineSections.length === 0) {
      const outline = await extractOutline(renderState.pdfDoc)
      outlineSections = normalizeReadingMapSections(outline?.sections)
      if (docId && docId !== "unknown") {
        void setOutline(docId, {
          updatedAt: Date.now(),
          sections: toStoredOutlineSections(outlineSections)
        })
      }
    }
    if (!isOrientationRunCurrent(loadToken, runToken)) {
      return
    }

    const sections = outlineSections
    applyReadingMapToCurrentDocument(sections)
    updateOrientationLoadingMessage("Summarizing purpose and reading map...")

    const orientationInput = await buildOrientationInput(renderState.pdfDoc, sections)
    if (!isOrientationRunCurrent(loadToken, runToken)) {
      return
    }

    const { response } = await generateLLM("orientation", {
      title: orientationInput.titleGuess,
      contextWindow: orientationInput.abstractText,
      headings: orientationInput.headings,
      readingMode: getReadingModeOrDefault()
    })
    if (!isOrientationRunCurrent(loadToken, runToken)) {
      return
    }

    const normalizedOrientation = normalizeOrientationResult(response, sections)
    const cachedIntents = await loadCachedSectionIntentsForDocument(docId, sections)
    const orientationSummary = buildOrientationSummaryFromData(normalizedOrientation)
    setOrientationReady({
      ...normalizedOrientation,
      sectionIntents: cachedIntents
    })
    void persistOrientationForDocument(docId, sections, orientationSummary)
    if (sidebarUiState.activeTab === "orientation") {
      renderPanel()
    }
  } catch (error) {
    if (!isOrientationRunCurrent(loadToken, runToken)) {
      return
    }
    logger.warn("Orientation generation failed", {
      message: error?.message || "Unknown error"
    })
    setOrientationError("Orientation is temporarily unavailable.")
    if (sidebarUiState.activeTab === "orientation") {
      renderPanel()
    }
  }
}

function getReadingMapSections() {
  if (!Array.isArray(currentPdf?.readingMap?.sections)) {
    return []
  }
  return currentPdf.readingMap.sections
}

function resolveSectionForPage(pageIndex) {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null) {
    return null
  }
  const sections = getReadingMapSections()
  let latest = null
  for (const section of sections) {
    if (!Number.isFinite(section?.pageIndex)) {
      continue
    }
    const sectionPageIndex = Math.max(0, Math.floor(Number(section.pageIndex)))
    if (sectionPageIndex <= normalizedPageIndex) {
      latest = section
      continue
    }
    break
  }
  return latest
}

function resolveSectionTitle(pageIndex) {
  const section = resolveSectionForPage(pageIndex)
  const title = sanitizeText(section?.title)
  if (title) {
    return title
  }
  if (Number.isFinite(pageIndex) && pageIndex >= 0) {
    return `Page ${Math.floor(Number(pageIndex)) + 1}`
  }
  return "Unknown section"
}

function resolveSectionId(pageIndex) {
  const section = resolveSectionForPage(pageIndex)
  const sectionId = sanitizeText(section?.id)
  return sectionId || null
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return value
  }
  return Math.min(max, Math.max(min, value))
}

function ensureSectionRailStructure() {
  if (!(sectionRailEl instanceof HTMLElement)) {
    return null
  }
  let markers = sectionRailEl.querySelector(".sectionRailMarkers")
  if (!(markers instanceof HTMLElement)) {
    markers = document.createElement("div")
    markers.className = "sectionRailMarkers"
    sectionRailEl.append(markers)
  }
  let labels = sectionRailEl.querySelector(".sectionRailLabels")
  if (!(labels instanceof HTMLElement)) {
    labels = document.createElement("div")
    labels.className = "sectionRailLabels"
    sectionRailEl.append(labels)
  }
  return { markers, labels }
}

function getSectionRailLeftGutter() {
  if (!(pdfRoot instanceof HTMLElement) || renderState.pageNodes.length === 0) {
    return 0
  }
  const rootRect = pdfRoot.getBoundingClientRect()
  const firstPageShell = renderState.pageNodes[0]
  if (!(firstPageShell instanceof HTMLElement)) {
    return 0
  }
  const firstPageSurface = firstPageShell.querySelector(".pdfPageSurface")
  if (!(firstPageSurface instanceof HTMLElement)) {
    return 0
  }
  const pageRect = firstPageSurface.getBoundingClientRect()
  return pageRect.left - rootRect.left
}

function getSectionIndexForPage(pageIndex, sections) {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex) ?? 0
  const source = Array.isArray(sections) ? sections : []
  let bestIndex = 0
  for (let index = 0; index < source.length; index += 1) {
    const sectionPage = parseOptionalPageIndex(source[index]?.pageIndex)
    if (sectionPage == null) {
      continue
    }
    if (sectionPage <= normalizedPageIndex) {
      bestIndex = index
      continue
    }
    break
  }
  return bestIndex
}

function clearSectionRailCloseTimer() {
  if (!sectionRailState.closeTimer) {
    return
  }
  clearTimeout(sectionRailState.closeTimer)
  sectionRailState.closeTimer = 0
}

function scheduleSectionRailClose() {
  clearSectionRailCloseTimer()
  sectionRailState.closeTimer = setTimeout(() => {
    sectionRailState.closeTimer = 0
    sectionRailState.isHovering = false
    scheduleSectionRailRender()
  }, 120)
}

function hideSectionRail() {
  if (!(sectionRailEl instanceof HTMLElement)) {
    return
  }
  clearSectionRailCloseTimer()
  sectionRailState.isHovering = false
  sectionRailEl.classList.remove("isOpen")
  sectionRailEl.hidden = true
}

function renderSectionRail() {
  sectionRailState.renderFrame = 0
  if (!(sectionRailEl instanceof HTMLElement)) {
    return
  }
  const sections = getReadingMapSections()
  if (!currentPdf || !renderState.pdfDoc || renderState.pageNodes.length === 0 || sections.length === 0) {
    hideSectionRail()
    return
  }

  const leftGutter = getSectionRailLeftGutter()
  const shouldShow = leftGutter >= SECTION_RAIL_MIN_LEFT_GUTTER
  if (!shouldShow) {
    hideSectionRail()
    return
  }

  const structure = ensureSectionRailStructure()
  if (!structure) {
    return
  }
  const { markers, labels } = structure
  const toolbarHeight = pdfToolbarEl instanceof HTMLElement ? pdfToolbarEl.offsetHeight : 44
  const firstPageSurface = renderState.pageNodes[0]?.querySelector?.(".pdfPageSurface")
  const pageHeight = firstPageSurface instanceof HTMLElement ? firstPageSurface.getBoundingClientRect().height : 0
  const targetHeight = clampNumber(
    pageHeight > 0 ? pageHeight / 4 : pdfRoot.clientHeight / 4,
    84,
    Math.max(Math.floor(pdfRoot.clientHeight * 0.42), 84)
  )
  const topOffset = Math.max((pdfRoot.clientHeight - targetHeight) / 2, 8)
  sectionRailEl.style.height = `${Math.round(targetHeight)}px`
  sectionRailEl.style.top = `${Math.round(toolbarHeight + topOffset)}px`
  sectionRailEl.style.bottom = "auto"
  sectionRailEl.hidden = false
  sectionRailEl.classList.toggle("isOpen", sectionRailState.isHovering)

  const maxIndex = Math.max(sections.length - 1, 0)
  const railHeight = Math.max(sectionRailEl.clientHeight || 120, 120)
  if (sectionRailState.isHovering) {
    const pointerY = clampNumber(sectionRailState.pointerY, 0, railHeight)
    const ratio = railHeight <= 1 ? 0 : pointerY / railHeight
    sectionRailState.pointerY = pointerY
    sectionRailState.selectedIndex = clampNumber(Math.round(ratio * maxIndex), 0, maxIndex)
  } else {
    const pageIndex = Math.max((currentPdf.pageNumber || 1) - 1, 0)
    sectionRailState.selectedIndex = clampNumber(getSectionIndexForPage(pageIndex, sections), 0, maxIndex)
    const ratio = maxIndex <= 0 ? 0.5 : sectionRailState.selectedIndex / maxIndex
    sectionRailState.pointerY = clampNumber(ratio * railHeight, 0, railHeight)
  }

  const selectedIndex = sectionRailState.selectedIndex
  markers.innerHTML = ""
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    const position = maxIndex <= 0 ? 0.5 : index / maxIndex
    const marker = document.createElement("button")
    marker.type = "button"
    marker.className = "sectionRailMarker"
    marker.dataset.sectionIndex = String(index)
    marker.style.setProperty("--position", String(position))
    marker.title = getSectionDisplayTitle(section) || `Page ${(parseOptionalPageIndex(section?.pageIndex) ?? 0) + 1}`
    marker.setAttribute("aria-label", marker.title)
    marker.addEventListener("mousedown", (event) => {
      event.preventDefault()
      event.stopPropagation()
      jumpToRailSectionByIndex(index)
    })
    marker.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    if (index === selectedIndex) {
      marker.classList.add("isSelected")
    }
    markers.append(marker)
  }

  labels.innerHTML = ""
  if (!sectionRailState.isHovering) {
    return
  }
  const anchorY = clampNumber(sectionRailState.pointerY, 0, railHeight)
  const start = Math.max(0, selectedIndex - SECTION_RAIL_LABEL_RADIUS)
  const end = Math.min(maxIndex, selectedIndex + SECTION_RAIL_LABEL_RADIUS)
  for (let index = start; index <= end; index += 1) {
    const section = sections[index]
    const level = getSectionLevel(section)
    const distance = Math.abs(index - selectedIndex)
    const proximity = Math.max(0, 1 - distance / (SECTION_RAIL_LABEL_RADIUS + 0.2))
    const labelButton = document.createElement("button")
    labelButton.type = "button"
    labelButton.className = "sectionRailLabel"
    labelButton.dataset.sectionIndex = String(index)
    labelButton.style.top = `${anchorY + (index - selectedIndex) * SECTION_RAIL_LABEL_STEP}px`
    labelButton.style.setProperty("--proximity", proximity.toFixed(3))
    labelButton.style.paddingLeft = `${6 + Math.max(0, level - 1) * 8}px`
    labelButton.textContent = clampText(getSectionDisplayTitle(section) || "Untitled section", 84)
    labelButton.title = getSectionDisplayTitle(section) || "Untitled section"
    labelButton.addEventListener("mousedown", (event) => {
      event.preventDefault()
      event.stopPropagation()
      jumpToRailSectionByIndex(index)
    })
    labelButton.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    if (index === selectedIndex) {
      labelButton.classList.add("isSelected")
    }
    labels.append(labelButton)
  }
}

function scheduleSectionRailRender() {
  if (sectionRailState.renderFrame) {
    return
  }
  sectionRailState.renderFrame = requestAnimationFrame(() => {
    renderSectionRail()
  })
}

function getSectionByRailIndex(sectionIndex) {
  const index = Number(sectionIndex)
  if (!Number.isFinite(index)) {
    return null
  }
  const sections = getReadingMapSections()
  return sections[Math.max(0, Math.floor(index))] || null
}

function jumpToRailSectionByIndex(sectionIndex) {
  const section = getSectionByRailIndex(sectionIndex)
  if (!section) {
    return
  }
  const pageIndex = parseOptionalPageIndex(section.pageIndex) ?? 0
  clearSectionRailCloseTimer()
  sectionRailState.isHovering = true
  void jumpToSection(pageIndex, getSectionDisplayTitle(section))
}

function handleSectionRailClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-section-index]") : null
  if (!(target instanceof HTMLButtonElement)) {
    return
  }
  jumpToRailSectionByIndex(target.dataset.sectionIndex)
}

function handleSectionRailPointerMove(event) {
  if (!(sectionRailEl instanceof HTMLElement)) {
    return
  }
  const rect = sectionRailEl.getBoundingClientRect()
  if (event.clientX - rect.left > SECTION_RAIL_MAX_HOVER_WIDTH) {
    clearSectionRailCloseTimer()
    sectionRailState.isHovering = false
    scheduleSectionRailRender()
    return
  }
  clearSectionRailCloseTimer()
  sectionRailState.isHovering = true
  sectionRailState.pointerY = event.clientY - rect.top
  scheduleSectionRailRender()
}

function buildGroundingQuote(selectedText, contextWindow) {
  const selected = sanitizeText(selectedText)
  const context = sanitizeText(contextWindow)
  if (!context) {
    return clampText(selected, 300)
  }

  const lowerContext = context.toLowerCase()
  const lowerSelected = selected.toLowerCase()
  let snippet = ""
  if (lowerSelected) {
    const selectedIndex = lowerContext.indexOf(lowerSelected)
    if (selectedIndex >= 0) {
      const before = Math.max(selectedIndex - 120, 0)
      const after = Math.min(selectedIndex + lowerSelected.length + 120, context.length)
      snippet = context.slice(before, after).trim()
      if (before > 0) {
        snippet = `...${snippet}`
      }
      if (after < context.length) {
        snippet = `${snippet}...`
      }
    }
  }

  if (!snippet) {
    snippet = context.slice(0, 200).trim()
    if (context.length > 200) {
      snippet = `${snippet}...`
    }
  }
  return clampText(snippet, 300)
}

function buildGrounding(payload) {
  const resolvedPageIndex = Number.isFinite(payload?.pageIndex)
    ? Math.max(0, Number(payload.pageIndex))
    : 0
  return {
    pageIndex: resolvedPageIndex,
    sectionId: resolveSectionId(resolvedPageIndex),
    sectionTitle: resolveSectionTitle(resolvedPageIndex),
    quote: buildGroundingQuote(payload?.selectedText, payload?.contextWindow),
    textRange: null
  }
}

function normalizeRetrievalText(value) {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/\u2026/g, "...")
}

function tokenizeForRetrieval(value) {
  const normalized = normalizeRetrievalText(value).replace(/[^a-z0-9]+/g, " ").trim()
  if (!normalized) {
    return []
  }
  return normalized
    .split(" ")
    .filter((token) => token.length >= 2 && !RETRIEVAL_STOP_WORDS.has(token))
}

function buildParagraphsFromLines(rawText) {
  const lines = String(rawText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return []
  }

  const paragraphs = []
  let current = ""
  for (const line of lines) {
    current = current ? `${current} ${line}` : line
    const closesSentence = /[.!?;:]\)?$/.test(line)
    if (closesSentence || current.length >= RETRIEVAL_BLOCK_MAX_CHARS - 40) {
      paragraphs.push(current.trim())
      current = ""
    }
  }
  if (current) {
    paragraphs.push(current.trim())
  }
  return paragraphs
}

function splitParagraphIntoBlocks(paragraphText) {
  const paragraph = sanitizeText(paragraphText)
  if (!paragraph || paragraph.length < RETRIEVAL_BLOCK_MIN_CHARS) {
    return []
  }
  if (paragraph.length <= RETRIEVAL_BLOCK_MAX_CHARS) {
    return [paragraph]
  }

  const sentences =
    paragraph
      .match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [paragraph]
  if (sentences.length <= 1) {
    const chunks = []
    let cursor = 0
    while (cursor < paragraph.length) {
      const next = paragraph.slice(cursor, cursor + RETRIEVAL_BLOCK_MAX_CHARS).trim()
      if (next.length >= RETRIEVAL_BLOCK_MIN_CHARS) {
        chunks.push(next)
      }
      cursor += RETRIEVAL_BLOCK_MAX_CHARS - 40
    }
    return chunks
  }

  const chunks = []
  let current = ""
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length <= RETRIEVAL_BLOCK_MAX_CHARS) {
      current = candidate
      continue
    }
    if (current.length >= RETRIEVAL_BLOCK_MIN_CHARS) {
      chunks.push(current.trim())
    }
    current = sentence
  }
  if (current.length >= RETRIEVAL_BLOCK_MIN_CHARS) {
    chunks.push(current.trim())
  }
  return chunks
}

function splitPageTextIntoBlocks(rawPageText) {
  const source = String(rawPageText || "")
  const paragraphCandidates = source
    .split(/\n\s*\n+/)
    .map((part) => sanitizeText(part))
    .filter(Boolean)
  const paragraphs = paragraphCandidates.length > 1 ? paragraphCandidates : buildParagraphsFromLines(source)
  const blocks = []
  for (const paragraph of paragraphs) {
    blocks.push(...splitParagraphIntoBlocks(paragraph))
  }
  return blocks
}

function getDocumentTextBlocks() {
  if (!currentPdf || !Array.isArray(renderState.pageNodes) || renderState.pageNodes.length === 0) {
    return []
  }

  const cache = currentPdf.retrievalBlockCache
  if (
    cache &&
    cache.renderToken === renderState.renderToken &&
    cache.loadToken === renderState.loadToken &&
    Array.isArray(cache.blocks)
  ) {
    return cache.blocks
  }

  const blocks = []
  const dedupe = new Set()
  for (const pageNode of renderState.pageNodes) {
    const pageIndex = Number(pageNode?.dataset?.pageIndex)
    const textLayer = pageNode?.querySelector?.(".textLayer")
    if (!Number.isFinite(pageIndex) || !(textLayer instanceof HTMLElement)) {
      continue
    }
    const rawText = textLayer.innerText || textLayer.textContent || ""
    const pageBlocks = splitPageTextIntoBlocks(rawText)
    for (const blockText of pageBlocks) {
      const normalized = normalizeRetrievalText(blockText)
      if (!normalized) {
        continue
      }
      const dedupeKey = `${pageIndex}:${normalized.slice(0, 420)}`
      if (dedupe.has(dedupeKey)) {
        continue
      }
      dedupe.add(dedupeKey)

      const tokens = tokenizeForRetrieval(normalized)
      blocks.push({
        pageIndex,
        text: blockText,
        textLower: normalized,
        tokenSet: new Set(tokens)
      })
    }
  }

  currentPdf.retrievalBlockCache = {
    renderToken: renderState.renderToken,
    loadToken: renderState.loadToken,
    blocks
  }
  return blocks
}

function appendUniqueAnchor(list, dedupe, value, minLength = 6) {
  const text = sanitizeText(value)
  if (!text || text.length < minLength) {
    return
  }
  const key = text.toLowerCase()
  if (dedupe.has(key)) {
    return
  }
  dedupe.add(key)
  list.push(text)
}

function extractCitationMarkers(texts) {
  const markers = new Set()
  const source = Array.isArray(texts) ? texts : []
  for (const text of source) {
    const matches = String(text || "").match(/\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g)
    if (!matches) {
      continue
    }
    for (const marker of matches) {
      markers.add(marker)
    }
  }
  return markers
}

function detectAcronymToken(value) {
  const source = sanitizeText(value)
  if (!source) {
    return ""
  }
  const compact = source.replace(/[^A-Za-z0-9]/g, "")
  if (!/^[A-Z0-9]{2,10}$/.test(compact)) {
    return ""
  }
  if (!/[A-Z]/.test(compact)) {
    return ""
  }
  return compact
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function containsAcronymDefinitionPattern(text, acronym) {
  const source = sanitizeText(text)
  const token = sanitizeText(acronym)
  if (!source || !token) {
    return false
  }
  const escaped = escapeRegExp(token)
  const patterns = [
    new RegExp(`\\b[A-Za-z][A-Za-z\\-]*(?:\\s+[A-Za-z][A-Za-z\\-]*){1,8}\\s*\\(${escaped}\\)`, "i"),
    new RegExp(`\\b${escaped}\\s*\\([A-Za-z][A-Za-z\\-]*(?:\\s+[A-Za-z][A-Za-z\\-]*){1,8}\\)`, "i")
  ]
  return patterns.some((pattern) => pattern.test(source))
}

function makeSnippetAroundAnchor(text, anchor, maxLength) {
  const source = sanitizeText(text)
  if (!source) {
    return ""
  }
  if (source.length <= maxLength) {
    return source
  }

  const anchorText = sanitizeText(anchor).toLowerCase()
  const sourceLower = source.toLowerCase()
  let anchorIndex = anchorText ? sourceLower.indexOf(anchorText) : -1
  if (anchorIndex < 0 && anchorText) {
    const anchorTokens = tokenizeForRetrieval(anchorText)
    for (const token of anchorTokens.slice(0, 3)) {
      const tokenIndex = sourceLower.indexOf(token)
      if (tokenIndex >= 0) {
        anchorIndex = tokenIndex
        break
      }
    }
  }
  if (anchorIndex < 0) {
    anchorIndex = 0
  }

  const padding = Math.floor((maxLength - 24) / 2)
  let start = Math.max(anchorIndex - padding, 0)
  let end = Math.min(start + maxLength, source.length)
  if (end - start < maxLength) {
    start = Math.max(end - maxLength, 0)
  }

  let snippet = source.slice(start, end).trim()
  if (start > 0) {
    snippet = `...${snippet}`
  }
  if (end < source.length) {
    snippet = `${snippet}...`
  }
  return snippet
}

function buildGroundingAnchorsFromResponse({ selectedText, contextWindow, response, details }) {
  const anchors = []
  const dedupe = new Set()

  appendUniqueAnchor(anchors, dedupe, selectedText, 4)
  appendUniqueAnchor(anchors, dedupe, response?.shortAnswer, 12)
  appendUniqueAnchor(anchors, dedupe, response?.eli5, 12)
  appendUniqueAnchor(anchors, dedupe, response?.whatItShows, 10)
  appendUniqueAnchor(anchors, dedupe, response?.takeaway, 10)

  const supportsClaim = Array.isArray(response?.supportsClaim) ? response.supportsClaim : []
  for (const support of supportsClaim) {
    appendUniqueAnchor(anchors, dedupe, support, 10)
  }

  const groundingQuotes = Array.isArray(response?.groundingQuotes) ? response.groundingQuotes : []
  for (const groundingQuote of groundingQuotes) {
    appendUniqueAnchor(anchors, dedupe, groundingQuote, 8)
  }

  const detailTextItems = Array.isArray(details) ? details : []
  for (const detailText of detailTextItems) {
    appendUniqueAnchor(anchors, dedupe, detailText, 10)
  }

  const contextSnippet = truncateText(contextWindow, 320)
  appendUniqueAnchor(anchors, dedupe, contextSnippet, 20)
  return anchors.slice(0, 14)
}

function buildDetailsRetrievalTexts(cardType, response) {
  if (cardType === "quant") {
    const items = []
    const whatItShows = sanitizeText(response?.whatItShows)
    const takeaway = sanitizeText(response?.takeaway)
    if (whatItShows) {
      items.push(whatItShows)
    }
    if (takeaway) {
      items.push(takeaway)
    }
    const supportsClaim = Array.isArray(response?.supportsClaim) ? response.supportsClaim : []
    for (const support of supportsClaim) {
      const normalized = sanitizeText(support)
      if (normalized) {
        items.push(normalized)
      }
    }
    return items
  }

  const items = []
  const eli5 = sanitizeText(response?.eli5)
  if (eli5) {
    items.push(eli5)
  }
  const steps = Array.isArray(response?.steps) ? response.steps : []
  for (const step of steps) {
    const normalized = sanitizeText(step)
    if (normalized) {
      items.push(normalized)
    }
  }
  const paperUsage = Array.isArray(response?.paperUsage) ? response.paperUsage : []
  for (const usage of paperUsage) {
    const normalized = sanitizeText(usage)
    if (normalized) {
      items.push(normalized)
    }
  }
  return items
}

function scoreBlockAgainstAnchors(block, anchors, options = {}) {
  const normalizedAnchors = Array.isArray(anchors) ? anchors : []
  if (!block || normalizedAnchors.length === 0) {
    return { score: 0, bestAnchor: "" }
  }

  let score = 0
  let bestAnchor = ""
  let bestAnchorScore = 0
  for (const anchor of normalizedAnchors) {
    const anchorText = sanitizeText(anchor)
    if (!anchorText) {
      continue
    }
    const anchorLower = anchorText.toLowerCase()
    let anchorScore = 0

    if (anchorLower.length >= 24 && block.textLower.includes(anchorLower)) {
      anchorScore += 8
    }

    const anchorTokens = tokenizeForRetrieval(anchorText).slice(0, 14)
    if (anchorTokens.length > 0) {
      let matched = 0
      for (const token of anchorTokens) {
        if (block.tokenSet.has(token)) {
          matched += 1
        }
      }
      const coverage = matched / Math.max(Math.min(anchorTokens.length, 14), 1)
      anchorScore += coverage * 6
      anchorScore += Math.min(matched, 8) * 0.18
    }

    if (anchorScore > bestAnchorScore) {
      bestAnchorScore = anchorScore
      bestAnchor = anchorText
    }
    score += Math.min(anchorScore, 8)
  }

  const selectedTextNormalized = normalizeRetrievalText(options.selectedText || "")
  if (selectedTextNormalized && selectedTextNormalized.length >= 18 && block.textLower.includes(selectedTextNormalized)) {
    score -= 2.6
  }

  const preferredPageIndex = Number(options.preferredPageIndex)
  if (Number.isFinite(preferredPageIndex) && preferredPageIndex >= 0) {
    const distance = Math.abs(block.pageIndex - preferredPageIndex)
    if (distance === 0) {
      score += 0.45
    } else if (distance === 1) {
      score += 0.2
    }
  }

  const acronym = sanitizeText(options.acronym || "")
  if (acronym) {
    if (containsAcronymDefinitionPattern(block.text, acronym)) {
      score += 6.5
    } else if (block.textLower.includes(acronym.toLowerCase())) {
      score += 1.3
    }
  }

  const citationMarkers = options.citationMarkers instanceof Set ? options.citationMarkers : new Set()
  if (citationMarkers.size > 0) {
    for (const marker of citationMarkers) {
      if (block.text.includes(marker)) {
        score += 1.8
      }
    }
  }

  return { score, bestAnchor }
}

function retrieveRelevantDocumentBlocks({
  anchors,
  selectedText,
  preferredPageIndex,
  acronym,
  citationMarkers,
  maxResults = RETRIEVAL_MAX_CITATIONS + 1
}) {
  const documentBlocks = getDocumentTextBlocks()
  const normalizedAnchors = Array.isArray(anchors) ? anchors.filter(Boolean) : []
  if (documentBlocks.length === 0 || normalizedAnchors.length === 0) {
    return []
  }

  const scored = []
  for (const block of documentBlocks) {
    const result = scoreBlockAgainstAnchors(block, normalizedAnchors, {
      selectedText,
      preferredPageIndex,
      acronym,
      citationMarkers
    })
    if (result.score < 0.7) {
      continue
    }
    scored.push({
      ...block,
      score: result.score,
      bestAnchor: result.bestAnchor
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const unique = []
  const dedupe = new Set()
  for (const item of scored) {
    const dedupeKey = `${item.pageIndex}:${item.text.slice(0, 160).toLowerCase()}`
    if (dedupe.has(dedupeKey)) {
      continue
    }
    dedupe.add(dedupeKey)
    unique.push(item)
    if (unique.length >= maxResults) {
      break
    }
  }

  return unique
}

function resolveGroundingFromDocument({
  selectedText,
  contextWindow,
  response,
  cardType,
  preferredPageIndex,
  baseGrounding
}) {
  const details = buildDetailsRetrievalTexts(cardType, response)
  const anchors = buildGroundingAnchorsFromResponse({
    selectedText,
    contextWindow,
    response,
    details
  })
  const citationMarkers = extractCitationMarkers(anchors)
  const acronym = detectAcronymToken(selectedText)
  const rankedBlocks = retrieveRelevantDocumentBlocks({
    anchors,
    selectedText,
    preferredPageIndex,
    acronym,
    citationMarkers,
    maxResults: RETRIEVAL_MAX_CITATIONS + 3
  })

  if (rankedBlocks.length === 0) {
    return {
      pageIndex: baseGrounding.pageIndex,
      sectionId: baseGrounding.sectionId,
      sectionTitle: baseGrounding.sectionTitle,
      quote: baseGrounding.quote,
      citationPages: Array.isArray(response?.groundingPages) ? response.groundingPages : [],
      citationQuotes: Array.isArray(response?.groundingQuotes) ? response.groundingQuotes : []
    }
  }

  const primary = rankedBlocks[0]
  const citations = rankedBlocks.slice(1, RETRIEVAL_MAX_CITATIONS + 1)
  const citationPages = []
  const citationQuotes = []
  const seenCitationKeys = new Set()
  for (const block of citations) {
    const snippet = makeSnippetAroundAnchor(block.text, block.bestAnchor, RETRIEVAL_CITATION_QUOTE_MAX)
    if (!snippet) {
      continue
    }
    const key = `${block.pageIndex}:${snippet.toLowerCase()}`
    if (seenCitationKeys.has(key)) {
      continue
    }
    seenCitationKeys.add(key)
    citationPages.push(block.pageIndex)
    citationQuotes.push(snippet)
  }

  const modelGroundingQuotes = Array.isArray(response?.groundingQuotes) ? response.groundingQuotes : []
  for (const modelQuote of modelGroundingQuotes) {
    if (citationQuotes.length >= RETRIEVAL_MAX_CITATIONS) {
      break
    }
    const mapped = retrieveRelevantDocumentBlocks({
      anchors: [modelQuote],
      selectedText,
      preferredPageIndex,
      acronym,
      citationMarkers,
      maxResults: 1
    })
    const block = mapped[0]
    if (!block) {
      continue
    }
    const snippet = makeSnippetAroundAnchor(block.text, modelQuote, RETRIEVAL_CITATION_QUOTE_MAX)
    if (!snippet) {
      continue
    }
    const key = `${block.pageIndex}:${snippet.toLowerCase()}`
    if (seenCitationKeys.has(key)) {
      continue
    }
    seenCitationKeys.add(key)
    citationPages.push(block.pageIndex)
    citationQuotes.push(snippet)
  }

  return {
    pageIndex: primary.pageIndex,
    sectionId: resolveSectionId(primary.pageIndex),
    sectionTitle: resolveSectionTitle(primary.pageIndex),
    quote: makeSnippetAroundAnchor(primary.text, primary.bestAnchor, RETRIEVAL_PRIMARY_QUOTE_MAX),
    citationPages,
    citationQuotes
  }
}

function buildLocatorContextHint(selectedText, contextWindow) {
  const selected = sanitizeText(selectedText)
  const context = sanitizeText(contextWindow)
  if (!selected && !context) {
    return ""
  }

  if (!context) {
    return clampText(selected, 200)
  }

  const lowerContext = context.toLowerCase()
  const lowerSelected = selected.toLowerCase()
  if (lowerSelected) {
    const selectedIndex = lowerContext.indexOf(lowerSelected)
    if (selectedIndex >= 0) {
      const before = Math.max(selectedIndex - 70, 0)
      const after = Math.min(selectedIndex + lowerSelected.length + 70, context.length)
      let snippet = context.slice(before, after).trim()
      if (before > 0) {
        snippet = `...${snippet}`
      }
      if (after < context.length) {
        snippet = `${snippet}...`
      }
      return clampText(snippet, 200)
    }
  }

  return clampText(context, 200)
}

function buildCardLocator(payload) {
  const resolvedPageIndex = Number.isFinite(payload?.pageIndex)
    ? Math.max(0, Number(payload.pageIndex))
    : 0

  return {
    selectedText: truncateText(payload?.selectedText, 200),
    pageIndex: resolvedPageIndex,
    contextHint: buildLocatorContextHint(payload?.selectedText, payload?.contextWindow)
  }
}

function getPageContextWindow(pageIndex, fallbackContext = "") {
  if (!Number.isFinite(pageIndex) || pageIndex < 0) {
    return clampText(fallbackContext, MAX_CONTEXT_LENGTH)
  }
  const pageNode = getPageNodeByIndex(pageIndex)
  const textLayer = pageNode?.querySelector?.(".textLayer")
  const pageText = sanitizeText(textLayer?.innerText || "")
  if (!pageText) {
    return clampText(fallbackContext, MAX_CONTEXT_LENGTH)
  }
  return clampText(pageText, MAX_CONTEXT_LENGTH)
}

function getEffectiveContextWindow(payload, settings) {
  const baseContext = clampText(payload?.contextWindow, MAX_CONTEXT_LENGTH)
  const contextScope = settings?.contextScope || "selection"
  if (contextScope === "page") {
    return getPageContextWindow(payload?.pageIndex, baseContext)
  }
  return baseContext
}

function getWholePdfUploadMode(settings) {
  if (settings?.wholePdfUpload === "remember") {
    return "remember"
  }
  if (settings?.wholePdfUpload === "session") {
    return "session"
  }
  return "off"
}

async function syncWholePdfStatusFromCache(docId, settings) {
  if (settings?.contextScope !== "whole_pdf" || getWholePdfUploadMode(settings) === "off") {
    return
  }

  const normalizedDocId = sanitizeText(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return
  }

  if (sessionFileIdByDocId.has(normalizedDocId)) {
    setContextScopeTransientStatus("Whole PDF (ready)")
    return
  }

  if (getWholePdfUploadMode(settings) === "remember") {
    const rememberedFileId = await getOpenAIFileId(normalizedDocId)
    if (rememberedFileId) {
      sessionFileIdByDocId.set(normalizedDocId, rememberedFileId)
      setContextScopeTransientStatus("Whole PDF (ready)")
    }
  }
}

async function ensureOpenAIFileId({ docId, currentPdf: pdfState, settings, apiKey }) {
  if (settings?.contextScope !== "whole_pdf") {
    return { fileId: null, warnings: [] }
  }
  if (!apiKey) {
    return { fileId: null, warnings: ["OpenAI key missing"] }
  }
  if (getWholePdfUploadMode(settings) === "off") {
    return { fileId: null, warnings: ["Whole PDF upload is off"] }
  }

  const normalizedDocId = sanitizeText(docId)
  if (!normalizedDocId || normalizedDocId === "unknown") {
    return { fileId: null, warnings: ["Document id unavailable for Whole PDF upload"] }
  }

  const fromSession = sessionFileIdByDocId.get(normalizedDocId)
  if (fromSession) {
    setContextScopeTransientStatus("Whole PDF (ready)")
    return { fileId: fromSession, warnings: [] }
  }

  if (getWholePdfUploadMode(settings) === "remember") {
    const rememberedFileId = await getOpenAIFileId(normalizedDocId)
    if (rememberedFileId) {
      sessionFileIdByDocId.set(normalizedDocId, rememberedFileId)
      setContextScopeTransientStatus("Whole PDF (ready)")
      return { fileId: rememberedFileId, warnings: [] }
    }
  }

  const inFlight = uploadPromiseByDocId.get(normalizedDocId)
  if (inFlight) {
    return inFlight
  }

  const uploadPromise = (async () => {
    try {
      setContextScopeTransientStatus("Whole PDF (uploading...)")
      const { bytes, filename } = await getPdfBytes(pdfState)
      const { fileId } = await uploadPdfToOpenAI({ apiKey, filename, bytes })
      sessionFileIdByDocId.set(normalizedDocId, fileId)
      if (getWholePdfUploadMode(settings) === "remember") {
        await setOpenAIFileId(normalizedDocId, fileId)
      }
      setContextScopeTransientStatus("Whole PDF (ready)")
      return { fileId, warnings: [] }
    } catch (error) {
      const code = sanitizeText(error?.code || error?.message || "")
      if (code === REMOTE_BYTES_BLOCKED) {
        setContextScopeTransientStatus("Whole PDF (needs local file)")
        return {
          fileId: null,
          warnings: [
            "Cannot access remote PDF bytes due to site restrictions. Download and open locally for Whole PDF mode."
          ]
        }
      }
      const message = sanitizeText(error?.message || "Unknown upload error")
      return {
        fileId: null,
        warnings: [`Whole PDF upload failed. Used selection/page context. (${clampText(message, 120)})`]
      }
    }
  })()

  uploadPromiseByDocId.set(normalizedDocId, uploadPromise)
  try {
    return await uploadPromise
  } finally {
    uploadPromiseByDocId.delete(normalizedDocId)
  }
}

function mapSelectionActionToCardType(actionType) {
  if (actionType === "define") {
    return "definition"
  }
  if (actionType === "explain") {
    return "explanation"
  }
  if (actionType === "translate") {
    return "quant"
  }
  return null
}

function normalizeLimitNumber(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function clampGroundingCitations(citationPages, citationQuotes, settings) {
  const maxQuoteChars = normalizeLimitNumber(settings?.maxQuoteChars, 240, 80, 480)
  const maxCitations = normalizeLimitNumber(settings?.maxCitations, 3, 1, 6)
  const quotes = Array.isArray(citationQuotes) ? citationQuotes : []
  const pages = Array.isArray(citationPages) ? citationPages : []
  return {
    citationQuotes: quotes
      .map((quote) => clampText(quote, maxQuoteChars))
      .filter(Boolean)
      .slice(0, maxCitations),
    citationPages: pages
      .map((page) => parseOptionalPageIndex(page))
      .filter((page) => page != null)
      .slice(0, maxCitations)
  }
}

async function buildCardFromSelection(payload) {
  const cardType = mapSelectionActionToCardType(payload?.type)
  if (!cardType) {
    return null
  }

  const settings = currentSettings ?? (await getSettings())
  const contextScope = settings?.contextScope || "selection"
  const selectedText = clampText(payload?.selectedText, 500) || "Selected text"
  const contextWindow = getEffectiveContextWindow(payload, settings)
  const grounding = buildGrounding({
    pageIndex: payload?.pageIndex,
    selectedText,
    contextWindow
  })
  const docId = deriveDocId(currentPdf)
  const preWarnings = []
  const llmInput = {
    selectedText: clampText(selectedText, 200),
    contextWindow: clampText(contextWindow, 800),
    title: clampText(selectedText, 180),
    grounding: {
      pageIndex: grounding.pageIndex,
      sectionTitle: grounding.sectionTitle,
      quote: clampText(grounding.quote, 300)
    }
  }

  if (contextScope === "whole_pdf") {
    if (settings?.llmMode === "mock") {
      preWarnings.push("Whole PDF mode is ignored in Mock mode. Used selection/page context.")
    } else if (!settings?.openaiApiKey) {
      preWarnings.push("Set API key to enable Whole PDF mode. Used selection/page context.")
    } else if (getWholePdfUploadMode(settings) === "off") {
      preWarnings.push("Enable 'Upload PDF to OpenAI' to use Whole PDF mode. Used selection/page context.")
    } else {
      const fileResolution = await ensureOpenAIFileId({
        docId,
        currentPdf,
        settings,
        apiKey: settings.openaiApiKey
      })
      if (fileResolution.fileId) {
        llmInput.openaiFileId = fileResolution.fileId
      }
      if (Array.isArray(fileResolution.warnings) && fileResolution.warnings.length > 0) {
        preWarnings.push(...fileResolution.warnings)
      }
      if (fileResolution.warnings?.some((warning) => warning.includes("Cannot access remote PDF bytes"))) {
        setStatus(WHOLE_PDF_LOCAL_REQUIRED_MESSAGE)
      }
    }
  }

  const { providerUsed, response, warnings } = await generateLLM(cardType, llmInput)
  const allWarnings = [...preWarnings, ...(Array.isArray(warnings) ? warnings : [])]

  const details =
    cardType === "quant"
      ? {
          eli5: "",
          steps: [],
          paperUsage: [],
          whatItShows: response.whatItShows,
          takeaway: response.takeaway,
          supportsClaim: Array.isArray(response.supportsClaim)
            ? response.supportsClaim.join(" ")
            : "",
          whatToLookAt: response.whatToLookAt
        }
      : {
          eli5: response.eli5,
          steps: response.steps,
          paperUsage: response.paperUsage
        }
  const locator = buildCardLocator({
    pageIndex: payload?.pageIndex,
    selectedText,
    contextWindow
  })
  const retrievedGrounding = resolveGroundingFromDocument({
    selectedText,
    contextWindow,
    response,
    cardType,
    preferredPageIndex: payload?.pageIndex,
    baseGrounding: grounding
  })
  const rawCitationPages =
    Array.isArray(retrievedGrounding.citationPages) && retrievedGrounding.citationPages.length > 0
      ? retrievedGrounding.citationPages
      : response.groundingPages
  const rawCitationQuotes =
    Array.isArray(retrievedGrounding.citationQuotes) && retrievedGrounding.citationQuotes.length > 0
      ? retrievedGrounding.citationQuotes
      : response.groundingQuotes
  const { citationPages, citationQuotes } = clampGroundingCitations(
    rawCitationPages,
    rawCitationQuotes,
    settings
  )
  const resolvedGroundingPageIndex = Number.isFinite(retrievedGrounding.pageIndex)
    ? Math.max(0, Number(retrievedGrounding.pageIndex))
    : grounding.pageIndex
  const resolvedSectionTitle = resolveSectionTitle(resolvedGroundingPageIndex)
  const resolvedSectionId = resolveSectionId(resolvedGroundingPageIndex)

  return normalizeCard({
    id: makeId("card"),
    type: cardType,
    title: selectedText,
    shortAnswer: response.shortAnswer,
    details,
    grounding: {
      pageIndex: resolvedGroundingPageIndex,
      sectionId: sanitizeText(resolvedSectionId || retrievedGrounding.sectionId),
      sectionTitle: sanitizeText(resolvedSectionTitle || retrievedGrounding.sectionTitle || grounding.sectionTitle),
      quote: clampText(retrievedGrounding.quote || grounding.quote, 300),
      citationPages,
      citationQuotes
    },
    locator,
    meta: {
      provider: providerUsed,
      warnings: allWarnings
    },
    createdAt: Date.now(),
    pinned: false,
    selectedText,
    contextWindow
  })
}

function formatCardForCopy(card) {
  const pageIndex = Number.isFinite(card?.grounding?.pageIndex) ? Number(card.grounding.pageIndex) : 0
  const pageLabel = `Page ${pageIndex + 1}`
  const section = clampText(card?.grounding?.sectionTitle || "Unknown section", 120)
  const quote = clampText(card?.grounding?.quote || "", 300)
  return [
    `Title: ${clampText(card?.title, 180)}`,
    `Type: ${card?.type || "explanation"}`,
    `Short answer: ${clampText(card?.shortAnswer, 320)}`,
    `Grounded in: ${pageLabel} - ${section}`,
    `Quote: "${quote}"`
  ].join("\n")
}

function getCardById(cardId) {
  if (!cardId) {
    return null
  }
  return sidebarUiState.cards.find((card) => card.id === cardId) ?? null
}

function getGlossaryTermById(termId) {
  if (!termId) {
    return null
  }
  return sidebarUiState.glossaryTerms.find((term) => term.id === termId) ?? null
}

function getPageNodeByIndex(pageIndex) {
  if (!Number.isFinite(pageIndex) || pageIndex < 0) {
    return null
  }
  const fromState = renderState.pageNodes[pageIndex]
  if (fromState) {
    return fromState
  }
  return pdfRoot.querySelector(`.pdfPageShell[data-page-index="${pageIndex}"]`)
}

function waitForPageInView(pageNode) {
  if (!(pageNode instanceof HTMLElement)) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeoutMs = 1400
    const startTime = performance.now()
    let stableFrames = 0
    let lastScrollTop = pdfRoot.scrollTop

    const check = () => {
      const now = performance.now()
      const top = pdfRoot.scrollTop
      const viewportBottom = top + pdfRoot.clientHeight
      const pageTop = pageNode.offsetTop
      const pageBottom = pageTop + pageNode.offsetHeight
      const inView = pageTop < viewportBottom - 24 && pageBottom > top + 24
      const delta = Math.abs(top - lastScrollTop)
      stableFrames = delta < 1 ? stableFrames + 1 : 0
      lastScrollTop = top

      if ((inView && stableFrames >= 3) || now - startTime > timeoutMs) {
        resolve()
        return
      }
      requestAnimationFrame(check)
    }

    requestAnimationFrame(check)
  })
}

function waitForHighlightTiming() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, SOURCE_HIGHLIGHT_DELAY_MS)
    })
  })
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function resolveCardPageIndex(card, preferredPageIndex = null) {
  if (Number.isFinite(preferredPageIndex) && preferredPageIndex >= 0) {
    return Math.max(0, Number(preferredPageIndex))
  }
  if (Number.isFinite(card?.grounding?.pageIndex)) {
    return Math.max(0, Number(card.grounding.pageIndex))
  }
  if (Number.isFinite(card?.locator?.pageIndex)) {
    return Math.max(0, Number(card.locator.pageIndex))
  }
  return null
}

function normalizeNeedleText(value) {
  return sanitizeText(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/\u2026/g, "...")
}

function appendNeedleCandidate(candidates, dedupeSet, value) {
  const normalized = normalizeNeedleText(value)
  if (!normalized) {
    return
  }

  const queue = [normalized]
  const withoutPrefix = normalized.replace(/^(citation|quote)\s*\d*\s*:\s*/i, "")
  if (withoutPrefix !== normalized) {
    queue.push(withoutPrefix)
  }

  const fragments = normalized
    .split(/\.\.\.+/)
    .map((part) => sanitizeText(part))
    .filter((part) => part.length >= 14)
    .sort((a, b) => b.length - a.length)
  queue.push(...fragments.slice(0, 3))

  for (const candidate of queue) {
    const trimmed = truncateText(candidate, 260)
    if (!trimmed) {
      continue
    }

    const key = trimmed.toLowerCase()
    if (!dedupeSet.has(key)) {
      dedupeSet.add(key)
      candidates.push(trimmed)
    }

    if (trimmed.length > 180) {
      const startSlice = trimmed.slice(0, 180).trim()
      const endSlice = trimmed.slice(-180).trim()
      const sliceCandidates = [startSlice, endSlice]
      for (const sliceCandidate of sliceCandidates) {
        const sliceKey = sliceCandidate.toLowerCase()
        if (sliceCandidate && !dedupeSet.has(sliceKey)) {
          dedupeSet.add(sliceKey)
          candidates.push(sliceCandidate)
        }
      }
    }
  }
}

function buildCardNeedleCandidates(card, preferredText = "", options = {}) {
  const candidates = []
  const dedupeSet = new Set()
  const strictSource = Boolean(options.strictSource)
  appendNeedleCandidate(candidates, dedupeSet, preferredText)
  if (strictSource && candidates.length > 0) {
    return candidates.slice(0, 10)
  }
  appendNeedleCandidate(candidates, dedupeSet, card?.locator?.selectedText)
  appendNeedleCandidate(candidates, dedupeSet, card?.selectedText)
  appendNeedleCandidate(candidates, dedupeSet, card?.grounding?.quote)
  appendNeedleCandidate(candidates, dedupeSet, card?.locator?.contextHint)
  appendNeedleCandidate(candidates, dedupeSet, card?.title)

  const citationQuotes = Array.isArray(card?.grounding?.citationQuotes)
    ? card.grounding.citationQuotes
    : []
  for (const citationQuote of citationQuotes) {
    appendNeedleCandidate(candidates, dedupeSet, citationQuote)
    if (candidates.length >= 14) {
      break
    }
  }

  return candidates.slice(0, 14)
}

function tryHighlightNeedles(pageIndex, needleCandidates) {
  const candidates = needleCandidates.length > 0 ? needleCandidates : [""]
  for (const preferExact of [true, false]) {
    for (const needleText of candidates) {
      const result = highlightOnPage({
        pdfRoot,
        pageIndex,
        needleText,
        preferExact
      })
      if (result.success) {
        return { ...result, needleText, preferExact }
      }
    }
  }

  return {
    success: false,
    matchesCount: 0,
    needleText: candidates[0] || "",
    preferExact: false
  }
}

function getHighlightFocusRect(pageNode) {
  if (!(pageNode instanceof HTMLElement)) {
    return null
  }
  const textLayer = pageNode.querySelector(".textLayer")
  if (!(textLayer instanceof HTMLElement)) {
    return null
  }

  const focusElements = [
    ...Array.from(textLayer.querySelectorAll(".clarify-highlight")),
    ...Array.from(textLayer.querySelectorAll(".clarify-highlight-overlay"))
  ]
  if (focusElements.length === 0) {
    return null
  }

  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const element of focusElements) {
    const rect = element.getBoundingClientRect()
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
      continue
    }
    top = Math.min(top, rect.top)
    bottom = Math.max(bottom, rect.bottom)
  }

  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
    return null
  }
  return { top, bottom, height: Math.max(bottom - top, 1) }
}

function centerPageRegionInViewport(pageNode, focusRect, behavior = "smooth") {
  if (!(pageNode instanceof HTMLElement)) {
    return
  }

  const rootRect = pdfRoot.getBoundingClientRect()
  const focusCenter =
    focusRect && Number.isFinite(focusRect.top)
      ? pdfRoot.scrollTop + (focusRect.top - rootRect.top) + focusRect.height / 2
      : pageNode.offsetTop + pageNode.offsetHeight / 2
  const targetTop = focusCenter - pdfRoot.clientHeight / 2

  const pageTop = pageNode.offsetTop
  const pageBottom = pageTop + pageNode.offsetHeight
  const minPageTop = Math.max(pageTop - 12, 0)
  const maxPageTop = Math.max(minPageTop, pageBottom - pdfRoot.clientHeight + 12)
  const constrainedToPage = Math.min(maxPageTop, Math.max(minPageTop, targetTop))
  const maxScrollTop = Math.max(pdfRoot.scrollHeight - pdfRoot.clientHeight, 0)
  const clampedTop = Math.min(maxScrollTop, Math.max(0, constrainedToPage))

  pdfRoot.scrollTo({
    top: clampedTop,
    behavior
  })
}

async function centerPageOnHighlight(pageNode, behavior = "smooth") {
  await waitForNextFrame()
  await waitForNextFrame()
  const focusRect = getHighlightFocusRect(pageNode)
  centerPageRegionInViewport(pageNode, focusRect, behavior)
}

function rememberRecentJump(pageIndex, needleCandidates) {
  const normalizedNeedles = []
  const dedupe = new Set()
  for (const needle of Array.isArray(needleCandidates) ? needleCandidates : []) {
    const normalized = normalizeNeedleText(needle)
    if (!normalized) {
      continue
    }
    const key = normalized.toLowerCase()
    if (dedupe.has(key)) {
      continue
    }
    dedupe.add(key)
    normalizedNeedles.push(normalized)
    if (normalizedNeedles.length >= 12) {
      break
    }
  }

  recentJumpState = {
    pageIndex: Number.isFinite(pageIndex) ? Math.max(0, Number(pageIndex)) : 0,
    needleCandidates: normalizedNeedles,
    timestamp: Date.now()
  }
}

function clearRecentJump() {
  recentJumpState = null
}

function hasRecentJump(maxAgeMs = 7000) {
  return Boolean(
    recentJumpState &&
      Number.isFinite(recentJumpState.pageIndex) &&
      Array.isArray(recentJumpState.needleCandidates) &&
      recentJumpState.needleCandidates.length > 0 &&
      Date.now() - Number(recentJumpState.timestamp || 0) <= maxAgeMs
  )
}

function buildCardGroundingRepairAnchors(card) {
  const anchors = []
  const dedupe = new Set()
  appendUniqueAnchor(anchors, dedupe, card?.grounding?.quote, 8)
  appendUniqueAnchor(anchors, dedupe, card?.shortAnswer, 10)
  appendUniqueAnchor(anchors, dedupe, card?.title, 4)
  appendUniqueAnchor(anchors, dedupe, card?.selectedText, 4)
  appendUniqueAnchor(anchors, dedupe, card?.locator?.contextHint, 10)

  const citationQuotes = Array.isArray(card?.grounding?.citationQuotes)
    ? card.grounding.citationQuotes
    : []
  for (const quote of citationQuotes) {
    appendUniqueAnchor(anchors, dedupe, quote, 8)
  }

  const details = card?.details && typeof card.details === "object" ? card.details : {}
  appendUniqueAnchor(anchors, dedupe, details.eli5, 10)
  appendUniqueAnchor(anchors, dedupe, details.whatItShows, 10)
  appendUniqueAnchor(anchors, dedupe, details.takeaway, 10)

  const listFields = [details.steps, details.paperUsage, details.whatToLookAt]
  for (const listField of listFields) {
    if (!Array.isArray(listField)) {
      continue
    }
    for (const item of listField) {
      appendUniqueAnchor(anchors, dedupe, item, 10)
    }
  }

  return anchors.slice(0, 14)
}

function findRetrievedJumpTargets(card, preferredPageIndex) {
  const anchors = buildCardGroundingRepairAnchors(card)
  if (anchors.length === 0) {
    return []
  }

  const acronym = detectAcronymToken(card?.selectedText || card?.title || "")
  const citationMarkers = extractCitationMarkers(anchors)
  const blocks = retrieveRelevantDocumentBlocks({
    anchors,
    selectedText: card?.selectedText || card?.title || "",
    preferredPageIndex,
    acronym,
    citationMarkers,
    maxResults: 4
  })

  const targets = []
  const seen = new Set()
  for (const block of blocks) {
    const needle = makeSnippetAroundAnchor(
      block.text,
      block.bestAnchor || anchors[0],
      RETRIEVAL_PRIMARY_QUOTE_MAX
    )
    if (!needle) {
      continue
    }
    const key = `${block.pageIndex}:${needle.toLowerCase()}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    targets.push({
      pageIndex: block.pageIndex,
      needle
    })
  }
  return targets
}

async function jumpToCardSource(card, options = {}) {
  const preferredPageIndex = parseOptionalPageIndex(options?.preferredPageIndex)
  const pageIndex = resolveCardPageIndex(card, preferredPageIndex)
  if (pageIndex == null) {
    return
  }

  const pageNode = getPageNodeByIndex(pageIndex)
  if (!pageNode) {
    return
  }

  scrollToPage(pageIndex + 1, "instant")
  await waitForPageInView(pageNode)
  await waitForHighlightTiming()

  const initialNeedleCandidates = buildCardNeedleCandidates(card, options?.preferredText, {
    strictSource: options?.strictSource
  })
  let activePageIndex = pageIndex
  let activePageNode = pageNode
  let highlightResult = tryHighlightNeedles(pageIndex, initialNeedleCandidates)
  if (options?.strictSource && highlightResult.success && !highlightResult.preferExact) {
    highlightResult = { ...highlightResult, success: false }
  }

  if (!highlightResult.success) {
    const retrievedTargets = findRetrievedJumpTargets(card, pageIndex)
    for (const target of retrievedTargets) {
      const targetPageNode = getPageNodeByIndex(target.pageIndex)
      if (!targetPageNode) {
        continue
      }
      if (target.pageIndex !== activePageIndex) {
        scrollToPage(target.pageIndex + 1, "instant")
        await waitForPageInView(targetPageNode)
        await waitForHighlightTiming()
      }

      const fallbackResult = tryHighlightNeedles(target.pageIndex, [target.needle])
      if (
        fallbackResult.success &&
        (!options?.strictSource || fallbackResult.preferExact)
      ) {
        activePageIndex = target.pageIndex
        activePageNode = targetPageNode
        highlightResult = fallbackResult
        break
      }
    }
  }

  logger.info("Jump-to-source highlight result", {
    success: highlightResult.success,
    matchesCount: highlightResult.matchesCount,
    preferExact: highlightResult.preferExact,
    candidateCount: initialNeedleCandidates.length,
    pageIndex: activePageIndex
  })

  if (highlightResult.success) {
    rememberRecentJump(activePageIndex, [highlightResult.needleText, ...initialNeedleCandidates])
  } else {
    clearRecentJump()
  }

  await centerPageOnHighlight(activePageNode, "smooth")
}

async function restoreRecentJumpHighlightAfterRender() {
  if (!hasRecentJump()) {
    return false
  }

  const pageIndex = Number(recentJumpState.pageIndex)
  const needleCandidates = Array.isArray(recentJumpState.needleCandidates)
    ? recentJumpState.needleCandidates
    : []
  if (!Number.isFinite(pageIndex) || pageIndex < 0 || needleCandidates.length === 0) {
    clearRecentJump()
    return false
  }

  const pageNode = getPageNodeByIndex(pageIndex)
  if (!pageNode) {
    clearRecentJump()
    return false
  }

  scrollToPage(pageIndex + 1, "instant")
  await waitForPageInView(pageNode)
  await waitForHighlightTiming()
  const result = tryHighlightNeedles(pageIndex, needleCandidates)
  if (!result.success) {
    clearRecentJump()
    return false
  }

  await centerPageOnHighlight(pageNode, "auto")
  return true
}

async function loadCardsForCurrentDocument() {
  const docId = deriveDocId(currentPdf)
  sidebarUiState.docId = docId
  const [cards, glossaryTerms, walkthroughItems] = await Promise.all([
    getCards(docId),
    getGlossaryTerms(docId),
    getWalkthrough(docId)
  ])
  sidebarUiState.cards = cards.map((card) => normalizeCard(card))
  sidebarUiState.glossaryTerms = glossaryTerms
  sidebarUiState.walkthrough = {
    ...createWalkthroughUiState(),
    items: normalizeWalkthroughItems(walkthroughItems)
  }
  renderPanel()
  logger.info("Loaded cards for current document", {
    docId,
    cardCount: sidebarUiState.cards.length,
    glossaryCount: sidebarUiState.glossaryTerms.length,
    walkthroughCount: sidebarUiState.walkthrough.items.length
  })
  if (currentSettings) {
    void syncWholePdfStatusFromCache(docId, currentSettings)
  }
}

async function handleSelectionAction(payload) {
  const card = await buildCardFromSelection(payload)
  if (!card) {
    return
  }

  const docId = deriveDocId(currentPdf)
  sidebarUiState.docId = docId

  const persistedCard = await appendCard(docId, card)
  const finalCard = persistedCard ? normalizeCard(persistedCard) : card
  sidebarUiState.cards = [...sidebarUiState.cards, finalCard]

  if (finalCard.type === "quant") {
    setActiveTab("figures")
  } else {
    setActiveTab("explain")
  }

  if (sidebarState.collapsed) {
    setSidebarCollapsed(false)
  }

  logger.info("Card created from selection action", {
    actionType: payload?.type,
    cardType: finalCard.type,
    docId,
    cardId: finalCard.id
  })
}

async function handlePanelCardAction(event) {
  const eventTarget = event.target instanceof Element ? event.target : null
  if (!eventTarget) {
    return
  }

  const orientationButton = eventTarget.closest("button[data-orientation-action]")
  if (orientationButton && panel.contains(orientationButton)) {
    const action = orientationButton.dataset.orientationAction
    if (action === "expand") {
      toggleOrientationCollapsed(false)
      return
    }
    if (action === "collapse") {
      toggleOrientationCollapsed(true)
      return
    }
    if (action === "expand-map") {
      toggleOrientationMapExpanded(true)
      return
    }
    if (action === "collapse-map") {
      toggleOrientationMapExpanded(false)
      return
    }
    if (action === "expand-node" || action === "collapse-node") {
      const sectionKey = sanitizeText(orientationButton.dataset.sectionKey)
      if (sectionKey) {
        setNodeExpanded(sectionKey, action === "expand-node")
        renderPanel()
      }
      return
    }
    if (action === "generate-top-level-intents") {
      void handleGenerateTopLevelIntents()
      return
    }
    if (action === "generate-node-children-intents") {
      void handleGenerateChildIntentsForSection(orientationButton.dataset.sectionKey)
      return
    }
    if (action === "regenerate") {
      if (renderState.pdfDoc && currentPdf) {
        void generateOrientationForCurrentDocument(renderState.loadToken, { force: true })
      }
      return
    }
    if (action === "build-walkthrough") {
      void buildWalkthroughFromOrientation()
      return
    }
    if (action === "jump-section") {
      const pageIndex = parseOptionalPageIndex(orientationButton.dataset.sectionPageIndex)
      if (pageIndex != null) {
        void jumpToSection(pageIndex, orientationButton.dataset.sectionTitle, "smooth")
        const sectionTitle = sanitizeText(orientationButton.dataset.sectionTitle)
        setStatus(sectionTitle ? `Jumped to ${sectionTitle} (Page ${pageIndex + 1})` : `Jumped to Page ${pageIndex + 1}`)
      }
      return
    }
  }

  const walkthroughButton = eventTarget.closest("button[data-walkthrough-action]")
  if (walkthroughButton && panel.contains(walkthroughButton)) {
    const action = walkthroughButton.dataset.walkthroughAction
    if (action === "rebuild") {
      const hasExisting = normalizeWalkthroughItems(sidebarUiState.walkthrough.items).length > 0
      if (hasExisting) {
        sidebarUiState.walkthrough.confirmRebuild = true
        renderPanel()
        return
      }
      void buildWalkthroughFromOrientation({ forceRebuild: true })
      return
    }
    if (action === "confirm-rebuild") {
      void buildWalkthroughFromOrientation({ forceRebuild: true })
      return
    }
    if (action === "cancel-rebuild") {
      sidebarUiState.walkthrough.confirmRebuild = false
      renderPanel()
      return
    }
    if (action === "jump") {
      const pageIndex = parseOptionalPageIndex(walkthroughButton.dataset.sectionPageIndex)
      if (pageIndex != null) {
        void jumpToSection(pageIndex, walkthroughButton.dataset.sectionTitle, "smooth")
      }
      return
    }
  }

  const termButton = eventTarget.closest("button[data-term-action]")
  if (termButton && panel.contains(termButton)) {
    const termAction = termButton.dataset.termAction
    const termId = termButton.dataset.termId
    const term = getGlossaryTermById(termId)
    if (!term) {
      return
    }

    if (termAction === "delete") {
      const nextTerms = await removeGlossaryTerm(sidebarUiState.docId, term.id)
      sidebarUiState.glossaryTerms = Array.isArray(nextTerms)
        ? nextTerms
        : sidebarUiState.glossaryTerms.filter((item) => item.id !== term.id)
      renderPanel()
      setStatus("Glossary entry deleted")
    }
    return
  }

  const button = eventTarget.closest("button[data-card-action]")
  if (!button || !panel.contains(button)) {
    return
  }

  const cardId = button.dataset.cardId
  const action = button.dataset.cardAction
  const card = getCardById(cardId)
  if (!card) {
    return
  }

  if (action === "jump") {
    void jumpToCardSource(card, {
      preferredText: button.dataset.sourceText || "",
      preferredPageIndex: button.dataset.sourcePageIndex,
      strictSource: button.dataset.sourceStrict === "true"
    })
    return
  }

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(formatCardForCopy(card))
      setStatus("Card copied")
    } catch (_error) {
      setStatus("Copy failed")
    }
    return
  }

  if (action === "toggle-figure-intent" && card.type === "quant") {
    void handleToggleFigureIntent(card)
    return
  }

  if (action === "pin") {
    const nextCards = await togglePin(sidebarUiState.docId, card.id)
    sidebarUiState.cards = Array.isArray(nextCards)
      ? nextCards.map((item) => normalizeCard(item))
      : sidebarUiState.cards.map((item) =>
          item.id === card.id ? normalizeCard({ ...item, pinned: !item.pinned }) : item
        )
    renderPanel()
    return
  }

  if (action === "delete") {
    const nextCards = await removeCard(sidebarUiState.docId, card.id)
    sidebarUiState.cards = Array.isArray(nextCards)
      ? nextCards.map((item) => normalizeCard(item))
      : sidebarUiState.cards.filter((item) => item.id !== card.id)
    renderPanel()
    return
  }

  if (action === "glossary" && card.type !== "quant") {
    const glossaryTerm = await addGlossaryTerm(sidebarUiState.docId, {
      cardId: card.id,
      type: card.type,
      term: card.title,
      shortAnswer: card.shortAnswer,
      createdAt: Date.now(),
      grounding: card.grounding
    })
    if (glossaryTerm) {
      sidebarUiState.glossaryTerms = [glossaryTerm, ...sidebarUiState.glossaryTerms]
      if (sidebarUiState.activeTab === "glossary") {
        renderPanel()
      }
    }
    setStatus(glossaryTerm ? "Saved to glossary" : "Glossary save failed")
  }
}

function ensureSelectionSystemInitialized() {
  if (selectionSystem) {
    return;
  }

  selectionSystem = initSelectionSystem({
    pdfRoot,
    onAction: (payload) => {
      logger.info("Selection action:", payload.type);
      logger.debug("Selection payload", {
        type: payload.type,
        selectedTextLength: payload.selectedText?.length ?? 0,
        pageIndex: payload.pageIndex,
        contextWindowLength: payload.contextWindow?.length ?? 0
      });
      void handleSelectionAction(payload)
    }
  });
}

function applySettingsToUi(settings) {
  currentSettings = settings;

  readingModeFlowRadio.checked = settings.defaultReadingMode === "flow";
  readingModeStructureRadio.checked = settings.defaultReadingMode === "structure";
  updateReadingModeStatus(settings.defaultReadingMode);
  applyOrientationModeDefaults(settings.defaultReadingMode);

  const hasOpenAIKey = Boolean(settings.openaiApiKey);
  llmModeOpenAIOption.disabled = !hasOpenAIKey;
  llmModeHelpEl.hidden = hasOpenAIKey;
  llmModeSelect.value = hasOpenAIKey || settings.llmMode !== "openai" ? settings.llmMode : "auto";

  contextScopeSelect.value = settings.contextScope;
  wholePdfSettings.hidden = settings.contextScope !== "whole_pdf";
  wholePdfUploadEnabled.checked = settings.wholePdfUpload !== "off";
  wholePdfUploadBehavior.hidden = settings.wholePdfUpload === "off";
  wholePdfUploadSession.checked = settings.wholePdfUpload !== "remember";
  wholePdfUploadRemember.checked = settings.wholePdfUpload === "remember";
  promptCacheDefault.checked = settings.promptCacheRetention !== "24h";
  promptCache24h.checked = settings.promptCacheRetention === "24h";
  wholePdfHelpText.textContent = getWholePdfHelpMessage(settings);
  if (
    settings.contextScope !== "whole_pdf" ||
    settings.wholePdfUpload === "off" ||
    settings.llmMode === "mock" ||
    !settings.openaiApiKey
  ) {
    contextScopeTransientStatus = "";
  }

  autoOpenPdfToggle.checked = settings.autoOpenPdf;
  setApiPresenceStatus(settings);
  updateContextScopeStatus();
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
  void syncWholePdfStatusFromCache(sidebarUiState.docId, settings);
}

async function loadVerboseState() {
  const verbose = await getVerbose();
  verboseToggle.checked = verbose;
  logger.debug("Verbose logging state loaded", { verbose });
}

async function loadSettingsState() {
  let settings = await getSettings();

  if (!settings.openaiApiKey && settings.llmMode === "openai") {
    settings = await setSettings({ llmMode: "auto" });
  }

  applySettingsToUi(settings);

  logger.info("Settings loaded", {
    llmMode: settings.llmMode,
    hasOpenAIKey: Boolean(settings.openaiApiKey),
    contextScope: settings.contextScope,
    wholePdfUpload: settings.wholePdfUpload,
    promptCacheRetention: settings.promptCacheRetention,
    defaultReadingMode: settings.defaultReadingMode,
    autoOpenPdf: settings.autoOpenPdf
  });
}

function showPdfMessage(message) {
  pdfRoot.innerHTML = "";
  const messageEl = document.createElement("div");
  messageEl.className = "pdfMessage";
  messageEl.textContent = message;
  pdfRoot.append(messageEl);
}

function ensureScaleFactor() {
  // Keep CSS text-layer scale in the same coordinate space as viewport.scale.
  const scale = currentPdf?.renderedScale != null ? currentPdf.renderedScale : 1;
  pdfRoot.style.setProperty("--scale-factor", String(scale));
}

function captureViewportAnchor() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null;
  }

  const viewportCenterY = pdfRoot.scrollTop + pdfRoot.clientHeight / 2;
  let activeNode = renderState.pageNodes[0];

  for (const node of renderState.pageNodes) {
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (viewportCenterY >= top && viewportCenterY <= bottom) {
      activeNode = node;
      break;
    }
    if (viewportCenterY > top) {
      activeNode = node;
    }
  }

  const pageNumber = Number(activeNode.dataset.pageNumber || 1);
  const pageTop = activeNode.offsetTop;
  const pageHeight = Math.max(activeNode.offsetHeight, 1);
  const pageSurface = activeNode.firstElementChild;
  const pageLeft = activeNode.offsetLeft + (pageSurface?.offsetLeft || 0);
  const pageWidth = Math.max(pageSurface?.getBoundingClientRect().width || 1, 1);
  const viewportCenterX = pdfRoot.scrollLeft + pdfRoot.clientWidth / 2;
  const yRatio = Math.min(Math.max((viewportCenterY - pageTop) / pageHeight, 0), 1);
  const xRatio = Math.min(Math.max((viewportCenterX - pageLeft) / pageWidth, 0), 1);

  return { pageNumber, yRatio, xRatio };
}

function restoreViewportAnchor(anchor) {
  if (!anchor || renderState.pageNodes.length === 0) {
    return;
  }

  const pageNode = renderState.pageNodes[anchor.pageNumber - 1];
  if (!pageNode) {
    return;
  }

  const pageSurface = pageNode.firstElementChild;
  const pageCenterY = pageNode.offsetTop + anchor.yRatio * pageNode.offsetHeight;
  const pageLeft = pageNode.offsetLeft + (pageSurface?.offsetLeft || 0);
  const pageWidth = Math.max(pageSurface?.getBoundingClientRect().width || 1, 1);
  const pageCenterX = pageLeft + (anchor.xRatio ?? 0.5) * pageWidth;
  const nextScrollTop = Math.max(pageCenterY - pdfRoot.clientHeight / 2, 0);
  const nextScrollLeft = Math.max(pageCenterX - pdfRoot.clientWidth / 2, 0);

  pdfRoot.scrollTop = nextScrollTop;
  pdfRoot.scrollLeft = nextScrollLeft;
  setCurrentPage(anchor.pageNumber);
}

function applyVisualScale() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return;
  }

  for (const node of renderState.pageNodes) {
    const pageSurface = node.firstElementChild;
    if (!pageSurface) {
      continue;
    }

    const baseWidth = Number(node.dataset.baseWidth || 0);
    const baseHeight = Number(node.dataset.baseHeight || 0);

    if (baseWidth > 0 && baseHeight > 0) {
      node.style.height = `${Math.max(baseHeight, 1)}px`;
      pageSurface.style.width = `${baseWidth}px`;
      pageSurface.style.height = `${baseHeight}px`;
    }

    pageSurface.style.transformOrigin = "top left";
    pageSurface.style.transform = "none";
  }
}

function setScalePreservingViewport(nextScale, options = {}) {
  if (!currentPdf || !renderState.pdfDoc) {
    return;
  }

  const clampedScale = clampScale(nextScale);
  if (Math.abs(clampedScale - currentPdf.scale) < 0.0001) {
    return;
  }

  const anchor = options.preserveCenter === false ? null : captureViewportAnchor();
  currentPdf.scale = clampedScale;
  currentPdf.renderedScale = clampedScale;
  ensureScaleFactor();
  updatePdfControls();

  const loadToken = renderState.loadToken;
  void scheduleRender(anchor?.pageNumber ?? currentPdf.pageNumber, loadToken).then(() => {
    if (!anchor || loadToken !== renderState.loadToken) {
      return;
    }
    restoreViewportAnchor(anchor);
  });
}

function getPdfAvailableWidth() {
  const rootStyle = window.getComputedStyle(pdfRoot);
  const paddingX =
    Number.parseFloat(rootStyle.paddingLeft || "0") +
    Number.parseFloat(rootStyle.paddingRight || "0");
  return Math.max(pdfRoot.clientWidth - paddingX, 160);
}

function getRenderedPageDisplayWidth() {
  const firstNode = renderState.pageNodes[0];
  if (!firstNode) {
    return null;
  }
  const firstSurface = firstNode.firstElementChild;
  if (!firstSurface) {
    return null;
  }
  return Math.max(firstSurface.getBoundingClientRect().width, 1);
}

function updatePdfControls() {
  const numPages = currentPdf?.numPages ?? 0;
  const pageNumber = currentPdf?.pageNumber ?? 0;
  const hasDocument = Boolean(renderState.pdfDoc && numPages);
  const hasAllPagesRendered = hasDocument && renderState.pageNodes.length === numPages;

  pageIndicatorEl.textContent = numPages ? `Page ${pageNumber} / ${numPages}` : "Page - / -";
  prevPageBtn.disabled = !hasAllPagesRendered || pageNumber <= 1;
  nextPageBtn.disabled = !hasAllPagesRendered || pageNumber >= numPages;
  zoomOutBtn.disabled = !hasDocument || currentPdf.scale <= MIN_SCALE + 0.001;
  zoomInBtn.disabled = !hasDocument || currentPdf.scale >= MAX_SCALE - 0.001;
  fitWidthBtn.disabled = !hasDocument;
  syncFitWidthUi();
  scheduleSectionRailRender()
}

function disconnectPageObserver() {
  if (renderState.visibilityObserver) {
    renderState.visibilityObserver.disconnect();
    renderState.visibilityObserver = null;
  }
  renderState.pageVisibility.clear();
}

function cancelActiveRenderTask() {
  if (!renderState.activeRenderTask) {
    return;
  }
  try {
    renderState.activeRenderTask.cancel();
  } catch (_error) {
    // Best effort.
  }
  renderState.activeRenderTask = null;
}

function clearRenderedPages() {
  clearHighlights(pdfRoot)
  cancelActiveRenderTask();
  disconnectPageObserver();
  renderState.pageNodes = [];
  pdfRoot.innerHTML = "";
  hideSectionRail()
  if (currentPdf && typeof currentPdf === "object") {
    currentPdf.retrievalBlockCache = null
  }
}

async function disposeCurrentDocument() {
  clearRenderedPages();
  clearRecentJump()

  if (fitResizeFrame) {
    cancelAnimationFrame(fitResizeFrame);
    fitResizeFrame = null;
  }

  if (renderState.loadingTask) {
    try {
      await renderState.loadingTask.destroy();
    } catch (_error) {
      // Best effort.
    }
    renderState.loadingTask = null;
  }

  if (renderState.pdfDoc) {
    try {
      await renderState.pdfDoc.destroy();
    } catch (_error) {
      // Best effort.
    }
    renderState.pdfDoc = null;
  }

  renderState.baseViewportWidth = null;
}

function setCurrentPage(pageNumber) {
  if (!currentPdf || !currentPdf.numPages) {
    return;
  }

  const clamped = Math.min(Math.max(pageNumber, 1), currentPdf.numPages);
  if (currentPdf.pageNumber !== clamped) {
    currentPdf.pageNumber = clamped;
  }
  updatePdfControls();
}

function getNearestPageFromViewportCenter() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null
  }

  const viewportCenter = pdfRoot.scrollTop + pdfRoot.clientHeight / 2
  let nearestPage = currentPdf.pageNumber
  let nearestDistance = Number.POSITIVE_INFINITY

  for (const node of renderState.pageNodes) {
    const pageNumber = Number(node.dataset.pageNumber)
    const pageCenter = node.offsetTop + node.offsetHeight / 2
    const distance = Math.abs(pageCenter - viewportCenter)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestPage = pageNumber
    }
  }

  return nearestPage
}

function getMostVisiblePage(minRatio = 0) {
  if (!renderState.pageVisibility.size) {
    return null
  }

  let bestPage = null
  let bestRatio = -1
  for (const [pageNumber, ratio] of renderState.pageVisibility.entries()) {
    if (!Number.isFinite(pageNumber) || !Number.isFinite(ratio)) {
      continue
    }
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestPage = pageNumber
    }
  }

  if (bestPage == null || bestRatio < minRatio) {
    return null
  }
  return bestPage
}

function updateCurrentPageFromScroll() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return;
  }

  const observerPage = getMostVisiblePage(PAGE_VISIBILITY_THRESHOLD)
  if (observerPage != null) {
    setCurrentPage(observerPage)
    return
  }

  const fallbackPage = getNearestPageFromViewportCenter()
  if (fallbackPage != null) {
    setCurrentPage(fallbackPage)
  }
}

function handlePdfScroll() {
  if (scrollTicking) {
    return;
  }
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    updateCurrentPageFromScroll();
  });
}

function connectPageObserver() {
  disconnectPageObserver();

  if (renderState.pageNodes.length === 0) {
    return;
  }

  const thresholds = [0, PAGE_VISIBILITY_THRESHOLD, 1];
  renderState.visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber);
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        renderState.pageVisibility.set(pageNumber, ratio);
      }

      const bestPage = getMostVisiblePage(PAGE_VISIBILITY_THRESHOLD)
      if (bestPage != null) {
        setCurrentPage(bestPage)
      }
    },
    { root: pdfRoot, threshold: thresholds }
  );

  for (const node of renderState.pageNodes) {
    renderState.pageVisibility.set(Number(node.dataset.pageNumber), 0);
    renderState.visibilityObserver.observe(node);
  }

  updateCurrentPageFromScroll();
}

function scrollToPage(pageNumber, behavior = "smooth") {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return;
  }

  const clamped = Math.min(Math.max(pageNumber, 1), currentPdf.numPages);
  const pageNode = renderState.pageNodes[clamped - 1];
  if (!pageNode) {
    return;
  }

  const targetTop = Math.max(pageNode.offsetTop - 8, 0)
  if (behavior === "instant") {
    pdfRoot.scrollTop = targetTop
  } else {
    pdfRoot.scrollTo({
      top: targetTop,
      behavior
    });
  }
  setCurrentPage(clamped);
}

function getLoadedStatusText() {
  if (!currentPdf) {
    return "No PDF loaded";
  }

  const sourceLabel =
    currentPdf.sourceType === "local"
      ? currentPdf.filename
      : sanitizeUrlForLog(currentPdf.url ?? "");

  return `Loaded: ${sourceLabel} (${currentPdf.numPages} pages)`;
}

function clampScale(scale) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

async function ensureBaseViewportWidth(loadToken) {
  if (renderState.baseViewportWidth) {
    return renderState.baseViewportWidth;
  }
  if (!renderState.pdfDoc) {
    return null;
  }

  const firstPage = await renderState.pdfDoc.getPage(1);
  if (loadToken !== renderState.loadToken) {
    return null;
  }
  renderState.baseViewportWidth = firstPage.getViewport({ scale: 1 }).width;
  return renderState.baseViewportWidth;
}

async function computeFitWidthScale(loadToken) {
  const availableWidth = getPdfAvailableWidth();
  const renderedPageWidth = getRenderedPageDisplayWidth();

  if (renderedPageWidth && currentPdf?.scale) {
    return clampScale(currentPdf.scale * (availableWidth / renderedPageWidth));
  }

  const baseWidth = await ensureBaseViewportWidth(loadToken);
  if (!baseWidth) {
    return null;
  }

  return clampScale(availableWidth / baseWidth);
}

async function renderAllPages(targetPageNumber, loadToken) {
  if (!renderState.pdfDoc || !currentPdf || loadToken !== renderState.loadToken) {
    return;
  }

  const pdfDoc = renderState.pdfDoc;
  const renderScale = currentPdf.renderedScale || currentPdf.scale;
  const renderToken = ++renderState.renderToken;
  clearRenderedPages();
  ensureScaleFactor();
  updatePdfControls();

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
      return;
    }

    setStatus(`Loading page ${pageNumber}/${pdfDoc.numPages}`);
    logger.info("Render page i", { pageNumber });

    const page = await pdfDoc.getPage(pageNumber);
    if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
      return;
    }

    const viewport = page.getViewport({ scale: renderScale });
    if (!renderState.baseViewportWidth) {
      renderState.baseViewportWidth = page.getViewport({ scale: 1 }).width;
    }
    if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
      return;
    }
    const pageWidth = Math.max(viewport.width, 1);
    const pageHeight = Math.max(viewport.height, 1);

    const pageShell = document.createElement("section");
    pageShell.className = "pdfPageShell";
    pageShell.dataset.pageNumber = String(pageNumber);
    pageShell.dataset.pageIndex = String(pageNumber - 1);
    pageShell.dataset.baseWidth = String(pageWidth);
    pageShell.dataset.baseHeight = String(pageHeight);

    const pageSurface = document.createElement("div");
    pageSurface.className = "page pdfPageSurface";
    pageSurface.style.width = `${pageWidth}px`;
    pageSurface.style.height = `${pageHeight}px`;
    pageSurface.style.setProperty("--user-unit", String(viewport.userUnit || 1));
    pageSurface.dataset.mainRotation = String(viewport.rotation);

    const canvas = document.createElement("canvas");
    canvas.className = "pdfPageCanvas";
    pageSurface.append(canvas);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.dataset.mainRotation = String(viewport.rotation);
    pageSurface.append(textLayerDiv);

    pageShell.append(pageSurface);
    pdfRoot.append(pageShell);
    renderState.pageNodes.push(pageShell);

    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.max(Math.floor(pageWidth * outputScale), 1);
    canvas.height = Math.max(Math.floor(pageHeight * outputScale), 1);
    canvas.style.width = `${pageWidth}px`;
    canvas.style.height = `${pageHeight}px`;

    const canvasContext = canvas.getContext("2d", { alpha: false });
    if (!canvasContext) {
      throw new Error("Unable to get 2D rendering context.");
    }

    const transform =
      outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    const renderTask = page.render({
      canvasContext,
      viewport,
      transform
    });
    renderState.activeRenderTask = renderTask;

    try {
      await renderTask.promise;
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        throw error;
      }
      return;
    } finally {
      if (renderState.activeRenderTask === renderTask) {
        renderState.activeRenderTask = null;
      }
    }

    if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
      return;
    }

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true
      }),
      container: textLayerDiv,
      viewport
    });
    await textLayer.render();
    if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
      return;
    }

    const endOfContent = document.createElement("div");
    endOfContent.className = "endOfContent";
    textLayerDiv.append(endOfContent);
    page.cleanup();
  }

  if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
    return;
  }

  connectPageObserver();
  applyVisualScale();
  ensureSelectionSystemInitialized();

  if (renderState.fitWidthEnabled) {
    const correctedFitScale = await computeFitWidthScale(loadToken);
    if (correctedFitScale && Math.abs(correctedFitScale - currentPdf.scale) > 0.005) {
      setScalePreservingViewport(correctedFitScale, { preserveCenter: false });
      pdfRoot.scrollLeft = 0;
    }
  }

  let restoredJump = false
  if (hasRecentJump()) {
    restoredJump = await restoreRecentJumpHighlightAfterRender()
    if (loadToken !== renderState.loadToken || renderToken !== renderState.renderToken) {
      return;
    }
  }

  if (!restoredJump) {
    scrollToPage(targetPageNumber, "instant");
  }
  setStatus(getLoadedStatusText());
  updatePdfControls();
  renderPdfIntentOverlays()
  scheduleSectionRailRender()
}

function scheduleRender(targetPageNumber, loadToken = renderState.loadToken) {
  renderChain = renderChain
    .then(async () => {
      if (loadToken !== renderState.loadToken) {
        return;
      }
      await renderAllPages(targetPageNumber, loadToken);
    })
    .catch((error) => {
      if (loadToken !== renderState.loadToken) {
        return;
      }
      logger.error("Render pipeline failed", { message: error?.message ?? "Unknown error" });
      showPdfMessage("This PDF could not be rendered.");
      setStatus("Failed to render PDF");
      updatePdfControls();
    });

  return renderChain;
}

function handleLoadFailure(sourceType, error) {
  const failedUrl = currentPdf?.url;
  const failedRemoteFileUrl =
    sourceType === "remote" &&
    typeof failedUrl === "string" &&
    failedUrl.toLowerCase().startsWith("file://");

  currentPdf = null;
  updateDocumentTitle();
  clearContextScopeTransientStatus();
  renderState.pdfDoc = null;
  renderState.loadingTask = null;
  renderState.baseViewportWidth = null;
  sidebarUiState.docId = "unknown";
  sidebarUiState.cards = [];
  sidebarUiState.glossaryTerms = [];
  sidebarUiState.walkthrough = createWalkthroughUiState()
  sidebarUiState.toastMessage = ""
  resetOrientationStateForDocument()
  ensureScaleFactor();
  updatePdfControls();
  renderPanel();

  if (sourceType === "remote") {
    const remoteFailureMessage = failedRemoteFileUrl
      ? `${REMOTE_LOAD_ERROR_MESSAGE} ${FILE_URL_LOAD_HINT_MESSAGE}`
      : REMOTE_LOAD_ERROR_MESSAGE;
    showPdfMessage(remoteFailureMessage);
    setStatus(
      failedRemoteFileUrl
        ? `Failed to load file URL. ${FILE_URL_LOAD_HINT_MESSAGE}`
        : "Remote PDF blocked by site restrictions"
    );
  } else {
    showPdfMessage("This file could not be opened. Try another PDF.");
    setStatus("Failed to load local PDF");
  }

  logger.warn("PDF load failed", {
    sourceType,
    message: error?.message ?? "Unknown error"
  });
}

async function loadPdfSource(source, documentParams) {
  const loadToken = ++renderState.loadToken;
  setFitWidthEnabled(false);

  if (selectionSystem) {
    selectionSystem.destroy();
    selectionSystem = null;
  }

  await disposeCurrentDocument();
  if (loadToken !== renderState.loadToken) {
    return;
  }

  currentPdf = {
    sourceType: source.sourceType,
    filename: source.filename,
    localFile: source.localFile ?? null,
    url: source.url,
    fileSize: source.fileSize,
    fileLastModified: source.fileLastModified,
    numPages: 0,
    scale: DEFAULT_SCALE,
    renderedScale: DEFAULT_SCALE,
    pageNumber: 1,
    retrievalBlockCache: null,
    readingMap: { sections: [] },
    pdfDocRef: null
  };
  updateDocumentTitle();
  clearContextScopeTransientStatus();
  sidebarUiState.docId = deriveDocId(currentPdf);
  sidebarUiState.cards = [];
  sidebarUiState.glossaryTerms = [];
  sidebarUiState.walkthrough = createWalkthroughUiState()
  sidebarUiState.toastMessage = ""
  resetOrientationStateForDocument()
  setOrientationLoading("Loading PDF...")
  ensureScaleFactor();
  updatePdfControls();
  renderPanel();
  showPdfMessage("Loading PDF...");

  const loadingTask = pdfjsLib.getDocument(documentParams);
  renderState.loadingTask = loadingTask;

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (error) {
    if (loadToken !== renderState.loadToken) {
      return;
    }
    handleLoadFailure(source.sourceType, error);
    return;
  }

  if (loadToken !== renderState.loadToken) {
    try {
      await pdfDoc.destroy();
    } catch (_error) {
      // Ignore stale document cleanup errors.
    }
    return;
  }

  renderState.loadingTask = null;
  renderState.pdfDoc = pdfDoc;
  currentPdf.pdfDocRef = pdfDoc;
  currentPdf.numPages = pdfDoc.numPages;
  currentPdf.pageNumber = 1;

  setFitWidthEnabled(true);
  const initialFitScale = await computeFitWidthScale(loadToken);
  if (initialFitScale && loadToken === renderState.loadToken) {
    currentPdf.scale = initialFitScale;
    currentPdf.renderedScale = initialFitScale;
  } else {
    setFitWidthEnabled(false);
  }

  logger.info("Loaded PDF: numPages", { numPages: pdfDoc.numPages });
  updatePdfControls();
  void generateOrientationForCurrentDocument(loadToken);
  await loadCardsForCurrentDocument();
  await scheduleRender(1, loadToken);
}

async function loadPdfFromLocalFile(file) {
  if (!file) {
    return;
  }

  openedPdfSource = "local";
  logger.info("Loading PDF local: filename, size", {
    filename: file.name,
    size: file.size
  });

  setActiveTab("orientation");
  setStatus(`Loading: ${file.name}`);

  try {
    const arrayBuffer = await file.arrayBuffer();
    await loadPdfSource(
      {
        sourceType: "local",
        filename: file.name,
        localFile: file,
        fileSize: file.size,
        fileLastModified: file.lastModified
      },
      {
        data: arrayBuffer
      }
    );
  } catch (error) {
    handleLoadFailure("local", error);
  }
}

async function loadPdfFromRemoteUrl(srcUrl) {
  if (!srcUrl) {
    return;
  }

  const isFileUrl = srcUrl.toLowerCase().startsWith("file://");
  openedPdfSource = "remote";
  logger.info("Loading PDF remote: url (ok), but do not log tokens", {
    url: sanitizeUrlForLog(srcUrl)
  });

  setActiveTab("orientation");
  setStatus(
    isFileUrl
      ? `Loading file URL. ${FILE_URL_LOAD_HINT_MESSAGE}`
      : `Loading: ${sanitizeUrlForLog(srcUrl)}`
  );

  await loadPdfSource(
    {
      sourceType: "remote",
      filename: normalizePdfFilename(getFilenameFromUrl(srcUrl)),
      url: srcUrl
    },
    {
      url: srcUrl
    }
  );
}

function handleZoom(delta) {
  if (!currentPdf || !renderState.pdfDoc) {
    return;
  }

  setFitWidthEnabled(false);
  setScalePreservingViewport(currentPdf.scale + delta);
}

async function handleFitWidth() {
  if (!currentPdf || !renderState.pdfDoc) {
    return;
  }

  if (renderState.fitWidthEnabled) {
    handleZoom(-ZOOM_STEP);
    return;
  }

  const wasFitWidthEnabled = renderState.fitWidthEnabled;
  setFitWidthEnabled(true);

  const loadToken = renderState.loadToken;
  const fitScale = await computeFitWidthScale(loadToken);
  if (!fitScale || loadToken !== renderState.loadToken || !currentPdf) {
    setFitWidthEnabled(wasFitWidthEnabled);
    return;
  }

  setScalePreservingViewport(fitScale, { preserveCenter: false });
  pdfRoot.scrollLeft = 0;
  updatePdfControls();
}

function handleWindowResize() {
  if (!sidebarState.collapsed) {
    sidebarState.width = clampSidebarWidth(sidebarState.width);
  }
  applySidebarLayout();
  scheduleSectionRailRender()

  if (!renderState.fitWidthEnabled || !currentPdf || !renderState.pdfDoc) {
    return;
  }

  if (fitResizeFrame) {
    cancelAnimationFrame(fitResizeFrame);
  }

  fitResizeFrame = requestAnimationFrame(async () => {
    fitResizeFrame = null;
    const loadToken = renderState.loadToken;
    const fitScale = await computeFitWidthScale(loadToken);
    if (!fitScale || loadToken !== renderState.loadToken) {
      return;
    }
    setScalePreservingViewport(fitScale, { preserveCenter: false });
    pdfRoot.scrollLeft = 0;
  });
}

async function handleReadingModeChange(event) {
  if (!event.target?.checked) {
    return;
  }

  const nextMode = event.target.value;
  const settings = await setSettings({ defaultReadingMode: nextMode });
  applySettingsToUi(settings);
  logger.info("Reading mode changed", { mode: settings.defaultReadingMode });
}

async function handleLlmModeChange() {
  const nextMode = llmModeSelect.value;

  if (nextMode === "openai" && llmModeOpenAIOption.disabled) {
    llmModeHelpEl.hidden = false;
    llmModeSelect.value = currentSettings?.llmMode ?? "auto";
    return;
  }

  const settings = await setSettings({ llmMode: nextMode });
  applySettingsToUi(settings);
  logger.info(`LLM mode changed to ${settings.llmMode}`);
}

async function handleContextScopeChange() {
  const nextScope = contextScopeSelect.value;
  const settings = await setSettings({ contextScope: nextScope });
  if (nextScope !== "whole_pdf") {
    clearContextScopeTransientStatus();
  }
  applySettingsToUi(settings);
}

async function handleWholePdfUploadToggleChange() {
  const enabled = wholePdfUploadEnabled.checked;
  const nextMode = enabled ? (wholePdfUploadRemember.checked ? "remember" : "session") : "off";
  const settings = await setSettings({ wholePdfUpload: nextMode });
  if (!enabled) {
    clearContextScopeTransientStatus();
  }
  applySettingsToUi(settings);
}

async function handleWholePdfUploadBehaviorChange() {
  if (!wholePdfUploadEnabled.checked) {
    return;
  }
  const nextMode = wholePdfUploadRemember.checked ? "remember" : "session";
  const settings = await setSettings({ wholePdfUpload: nextMode });
  applySettingsToUi(settings);
}

async function handlePromptCacheRetentionChange() {
  const nextRetention = promptCache24h.checked ? "24h" : "default";
  const settings = await setSettings({ promptCacheRetention: nextRetention });
  applySettingsToUi(settings);
}

async function handleSaveApiKey() {
  const apiKey = openaiApiKeyInput.value.trim();
  if (!apiKey) {
    setApiStatus("Enter a key");
    return;
  }

  const settings = await setSettings({ openaiApiKey: apiKey });
  openaiApiKeyInput.value = "";
  applySettingsToUi(settings);
  setApiStatus("Saved");
  logger.info("OpenAI key set");
}

async function handleClearApiKey() {
  await clearOpenAIKey();

  let settings = await getSettings();
  if (settings.llmMode === "openai") {
    settings = await setSettings({ llmMode: "auto" });
    logger.info("LLM mode changed to auto");
  }

  openaiApiKeyInput.value = "";
  applySettingsToUi(settings);
  setApiStatus("Key cleared");
  logger.info("OpenAI key cleared");
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
});
panel.addEventListener("click", (event) => {
  void handlePanelCardAction(event);
});
pdfRoot.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("button[data-pdf-intent-action]") : null
  if (!(target instanceof HTMLButtonElement)) {
    return
  }
  void handlePdfIntentOverlayClick(target)
});
if (sectionRailEl instanceof HTMLElement) {
  sectionRailEl.addEventListener("mouseover", (event) => {
    const target = event.target
    const overTracks =
      target instanceof Element && Boolean(target.closest(".sectionRailMarkers"))
    if (!sectionRailState.isHovering && !overTracks) {
      return
    }
    handleSectionRailPointerMove(event)
  })
  sectionRailEl.addEventListener("mousemove", (event) => {
    const target = event.target
    const overTracks =
      target instanceof Element && Boolean(target.closest(".sectionRailMarkers"))
    if (!sectionRailState.isHovering && !overTracks) {
      return
    }
    handleSectionRailPointerMove(event)
  })
  sectionRailEl.addEventListener("mouseout", (event) => {
    const next = event.relatedTarget
    if (next instanceof Node && sectionRailEl.contains(next)) {
      return
    }
    scheduleSectionRailClose()
  })
  sectionRailEl.addEventListener("mousedown", () => {
    clearSectionRailCloseTimer()
  })
  sectionRailEl.addEventListener("click", (event) => {
    clearSectionRailCloseTimer()
    sectionRailState.isHovering = true
    handleSectionRailClick(event)
  })
}

toggleSidebarBtn.addEventListener("click", () => {
  setSidebarCollapsed(!sidebarState.collapsed);
});

reopenSidebarBtn?.addEventListener("click", () => {
  setSidebarCollapsed(false);
});

sidebarResizeHandle.addEventListener("pointerdown", handleSidebarResizeStart);
sidebarResizeHandle.addEventListener("lostpointercapture", handleSidebarResizeEnd);

openFileBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";

  if (!file) {
    return;
  }

  await loadPdfFromLocalFile(file);
});

prevPageBtn.addEventListener("click", () => {
  if (!currentPdf) {
    return;
  }
  scrollToPage(currentPdf.pageNumber - 1);
});

nextPageBtn.addEventListener("click", () => {
  if (!currentPdf) {
    return;
  }
  scrollToPage(currentPdf.pageNumber + 1);
});

zoomOutBtn.addEventListener("click", () => {
  handleZoom(-ZOOM_STEP);
});

zoomInBtn.addEventListener("click", () => {
  handleZoom(ZOOM_STEP);
});

fitWidthBtn.addEventListener("click", () => {
  void handleFitWidth();
});

pdfRoot.addEventListener("scroll", handlePdfScroll, { passive: true });
window.addEventListener("resize", handleWindowResize);

diagnosticsToggleBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setDiagnosticsMenuOpen(diagnosticsMenu.hidden);
});

diagnosticsMenu.addEventListener("click", (event) => {
  event.stopPropagation();
});

document.addEventListener("click", () => {
  setDiagnosticsMenuOpen(false);
});

verboseToggle.addEventListener("change", async () => {
  const enabled = verboseToggle.checked;
  const didPersist = await setVerbose(enabled);

  if (!didPersist) {
    logger.warn("Failed to persist verbose logging toggle");
  }

  logger.info("Verbose logging updated", { enabled, persisted: didPersist });
});

copyDebugInfoBtn.addEventListener("click", async () => {
  try {
    const info = await getDebugInfo({
      viewerUrl: getViewerBaseUrl(),
      openedPdfSource
    });
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
    setCopyStatus("Copied");
    logger.info("Debug info copied to clipboard");
  } catch (error) {
    setCopyStatus("Copy failed");
    logger.error("Failed to copy debug info", { message: error?.message ?? "Unknown error" });
  }
});

readingModeFlowRadio.addEventListener("change", handleReadingModeChange);
readingModeStructureRadio.addEventListener("change", handleReadingModeChange);
llmModeSelect.addEventListener("change", handleLlmModeChange);
contextScopeSelect.addEventListener("change", () => {
  void handleContextScopeChange();
});
wholePdfUploadEnabled.addEventListener("change", () => {
  void handleWholePdfUploadToggleChange();
});
wholePdfUploadSession.addEventListener("change", () => {
  void handleWholePdfUploadBehaviorChange();
});
wholePdfUploadRemember.addEventListener("change", () => {
  void handleWholePdfUploadBehaviorChange();
});
promptCacheDefault.addEventListener("change", () => {
  void handlePromptCacheRetentionChange();
});
promptCache24h.addEventListener("change", () => {
  void handlePromptCacheRetentionChange();
});
saveApiKeyBtn.addEventListener("click", handleSaveApiKey);
clearApiKeyBtn.addEventListener("click", handleClearApiKey);

autoOpenPdfToggle.addEventListener("change", async () => {
  const settings = await setSettings({ autoOpenPdf: autoOpenPdfToggle.checked });
  applySettingsToUi(settings);
});

// Load optional ?src= URL.
const params = new URLSearchParams(location.search);
const src = params.get("src");
if (src) {
  openedPdfSource = inferOpenedPdfSourceFromSrc(src);
  logger.info("?src parameter detected", { source: openedPdfSource });
  logger.debug("?src parameter present", { source: openedPdfSource });
}

logger.info("Viewer loaded");
void Promise.all([loadVerboseState(), loadSettingsState()]);
setActiveTab("orientation");
ensureScaleFactor();
initializeSidebarState();
updatePdfControls();
updateDocumentTitle();
if (src) {
  void loadPdfFromRemoteUrl(src);
} else {
  setStatus("No PDF loaded");
}

