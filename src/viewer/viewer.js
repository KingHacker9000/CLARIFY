import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { createLogger, getDebugInfo } from "../shared/diagnostics.js";
import { initSelectionSystem } from "./selection.js";
import { clearHighlights, collectHighlightMatchesOnPages, highlightOnPage } from "./highlight.js";
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
import { applyMode } from "./mode_manager.js";
import {
  flattenWorksheetModelToQuestions,
  parseWorksheetPagesToModel,
  serializeWorksheetModelAsXml
} from "./worksheet_parser.js"

const logger = createLogger("VIEWER");
const DEFAULT_VIEWER_TITLE = "CLARIFY";
const DEFAULT_SCALE = 1.2;
const MIN_SCALE = 0.6;
const MAX_SCALE = 3.2;
const ZOOM_STEP = 0.2;
const ZOOM_QUALITY_UPGRADE_THRESHOLD = 1.22;
const ZOOM_QUALITY_DOWNGRADE_THRESHOLD = 0.78;
const ZOOM_QUALITY_DEBOUNCE_MS = 180;
const ZOOM_QUALITY_INITIAL_RENDER_COUNT = 1;
const MAX_CANVAS_OUTPUT_SCALE = 1.85;
const MAX_CANVAS_PIXELS = 8_000_000;
const MIN_CANVAS_OUTPUT_SCALE = 0.5;
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
const LAZY_RENDER_PAGE_THRESHOLD = 80;
const LAZY_RENDER_PRIORITY_RADIUS = 2;
const LAZY_RENDER_IDLE_TIMEOUT_MS = 120;
const SECTION_RAIL_MIN_LEFT_GUTTER = 34;
const SECTION_RAIL_LABEL_STEP = 28;
const SECTION_RAIL_LABEL_RADIUS = 4;
const SECTION_RAIL_MAX_HOVER_WIDTH = 220;
const SECTION_JUMP_VIEWPORT_MARGIN_TOP = 120;
const SECTION_CLICK_ORDER_TOLERANCE = 10;
const SECTION_MULTI_COLUMN_MIN_SAMPLES = 28;
const SECTION_MULTI_COLUMN_MIN_GAP_RATIO = 0.14;
const FLOW_DIGEST_MAX_SCAN_PAGES = 3;
const FLOW_DIGEST_MAX_KEYWORDS = 6;
const FLOW_DIGEST_MAX_OVERVIEW_PHRASES = 4;
const FLOW_DIGEST_MAX_TECHNICAL_TERMS = 2;
const FLOW_DIGEST_MAX_HIGHLIGHTS = 10;
const WORKSHEET_DETECTION_MAX_PAGES = 24;
const WORKSHEET_PAGE_SNIPPET_MAX_CHARS = 1400;
const WORKSHEET_DETECTION_MAX_TOTAL_CHARS = 22000;
const WORKSHEET_QUESTION_MAX_ITEMS = 180;
const WORKSHEET_OVERLAY_MAX_CHARS = 180;
const REMOTE_LOAD_ERROR_MESSAGE =
  "This PDF could not be loaded due to site restrictions (CORS/login). Try downloading and opening it locally.";
const FILE_URL_LOAD_HINT_MESSAGE =
  "If this file URL doesn't load, open it locally using the Open PDF button.";
const WHOLE_PDF_LOCAL_REQUIRED_MESSAGE =
  "Whole PDF requires local access. Download this PDF and open it locally.";
const ICON_PIN = "\uD83D\uDCCC";
const ICON_COPY = "\uD83D\uDCCB";
const ICON_DELETE = "\uD83D\uDDD1\uFE0F";
const ICON_REGENERATE_LIGHT_THEME_URL = new URL("../../assets/icons/regenerate.png", import.meta.url).toString();
const ICON_REGENERATE_DARK_THEME_URL = new URL(
  "../../assets/icons/regenerate-dark.png",
  import.meta.url
).toString();
const ICON_OPEN_LIGHT_THEME_URL = new URL("../../assets/icons/open.png", import.meta.url).toString();
const ICON_OPEN_DARK_THEME_URL = new URL("../../assets/icons/open-dark.png", import.meta.url).toString();
const ICON_FIT_WIDTH_LIGHT_THEME_URL = new URL("../../assets/icons/fit-width.png", import.meta.url).toString();
const ICON_FIT_WIDTH_DARK_THEME_URL = new URL("../../assets/icons/fit-width-dark.png", import.meta.url).toString();
const ICON_HIGHLIGHTER_LIGHT_THEME_URL = new URL("../../assets/icons/highlighter.png", import.meta.url).toString();
const ICON_HIGHLIGHTER_DARK_THEME_URL = new URL(
  "../../assets/icons/highlighter-dark.png",
  import.meta.url
).toString();
const ICON_THEME_TO_DARK_URL = new URL("../../assets/icons/to-dark-mode.png", import.meta.url).toString();
const ICON_THEME_TO_LIGHT_URL = new URL("../../assets/icons/to-light-mode.png", import.meta.url).toString();

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.mjs",
  import.meta.url
).toString();
const PDFJS_WASM_BASE_URL = new URL("../vendor/pdfjs/wasm/", import.meta.url).toString();

const layoutEl = document.getElementById("layout");
const sidebarEl = document.getElementById("sidebar");
const sidebarResizeHandle = document.getElementById("sidebarResizeHandle");
const panel = document.getElementById("panel");
const statusEl = document.getElementById("status");
const contextScopeStatusEl = document.getElementById("contextScopeStatus");
const toolbarModeFlowBtn = document.getElementById("toolbarModeFlow");
const toolbarModeStructureBtn = document.getElementById("toolbarModeStructure");
const toolbarModeWorksheetBtn = document.getElementById("toolbarModeWorksheet");
const toolbarModeViewerBtn = document.getElementById("toolbarModeViewer");
const pdfRoot = document.getElementById("pdfRoot");
const sectionRailEl = document.getElementById("sectionRail");
const pdfToolbarEl = document.querySelector(".pdfToolbar");
const fileInput = document.getElementById("fileInput");
const openFileBtn = document.getElementById("openFile");
const downloadPdfBtn = document.getElementById("downloadPdf");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageIndicatorEl = document.getElementById("pageIndicator");
const zoomOutBtn = document.getElementById("zoomOut");
const zoomInBtn = document.getElementById("zoomIn");
const zoomIndicatorEl = document.getElementById("zoomIndicator");
const fitWidthBtn = document.getElementById("fitWidth");
const highlighterToggleBtn = document.getElementById("highlighterToggle");
const themeToggleBtn = document.getElementById("themeToggle");
const reopenSidebarBtn = document.getElementById("reopenSidebar");
const diagnosticsToggleBtn = document.getElementById("diagnosticsToggle");
const diagnosticsMenu = document.getElementById("diagnosticsMenu");
const verboseToggle = document.getElementById("verboseToggle");
const debugModeToggle = document.getElementById("debugModeToggle");
const copyDebugInfoBtn = document.getElementById("copyDebugInfo");
const copyStatusEl = document.getElementById("copyStatus");
const readingModeViewerRadio = document.getElementById("readingModeViewer");
const readingModeFlowRadio = document.getElementById("readingModeFlow");
const readingModeStructureRadio = document.getElementById("readingModeStructure");
const readingModeWorksheetRadio = document.getElementById("readingModeWorksheet");
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
const walkthroughTabButton = document.getElementById("walkthroughTabButton");
const openFileIconEl = openFileBtn?.querySelector(".toolbarIconImage");
const fitWidthIconEl = fitWidthBtn?.querySelector(".toolbarIconImage");
const highlighterIconEl = highlighterToggleBtn?.querySelector(".toolbarIconImage");
const themeToggleIconEl = themeToggleBtn?.querySelector(".toolbarIconImage");

const renderState = {
  pdfDoc: null,
  loadingTask: null,
  activeRenderTask: null,
  activeTextLayer: null,
  visibilityObserver: null,
  pageNodes: [],
  pageVisibility: new Map(),
  loadToken: 0,
  renderToken: 0,
  fitWidthEnabled: false,
  baseViewportWidth: null,
  lazyRenderEnabled: false,
  lazyRenderQueue: [],
  lazyRenderQueueSet: new Set(),
  lazyRenderRunning: false,
  lazyRenderTimer: null,
  initialRenderInProgress: false,
  zoomQualityTimer: null,
  pendingZoomQualityScale: null,
  pendingZoomQualityAnchor: null,
  pendingZoomQualityForce: false
};

let openedPdfSource = null;
let currentPdf = null;
let copyStatusTimer = null;
let apiStatusTimer = null;
let currentSettings = null;
let renderChain = Promise.resolve();
let scrollTicking = false;
let fitResizeFrame = null;
const pointerState = {
  insidePdfRoot: false,
  clientX: 0,
  clientY: 0
}
let selectionSystem = null;
const highlighterState = {
  items: [],
  nextId: 1
}
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
    digestByKey: {},
    digestLoadingByKey: {},
    visibleDigestKeys: new Set(),
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

function createWorksheetUiState() {
  return {
    status: "idle",
    errorMessage: "",
    docId: "unknown",
    questions: [],
    detectionPromise: null,
    detectionWarnings: [],
    parserModel: null,
    parserXml: "",
    parserDebugVisible: false
  }
}

const sidebarUiState = {
  docId: "unknown",
  cards: [],
  glossaryTerms: [],
  glossarySuggestions: [],
  walkthrough: createWalkthroughUiState(),
  worksheet: createWorksheetUiState(),
  toastMessage: "",
  activeTab: "orientation",
  lastTabByMode: {
    flow: "explain",
    structure: "orientation",
    worksheet: "explain"
  },
  orientation: createOrientationUiState("flow")
};
let recentJumpState = null;
let orientationRunToken = 0;
let worksheetRunToken = 0;
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
const modeUiState = {
  mode: "viewer",
  previousMode: "",
  hasAppliedMode: false,
  cardDetailsOpenByDefault: false,
  maxGroundingQuotes: 1,
  autoGenerateOnLoad: false,
  autoBuildWalkthroughOnLoad: false,
  autoPrewarmOnLoad: false,
  walkthroughVisible: false,
  sidebarVisible: true,
  aiEnabled: false
}
const structurePrewarmedDocIds = new Set()
let pendingCardAutoScrollId = ""

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
const FLOW_DIGEST_GENERIC_TERMS = new Set([
  "abstract",
  "acknowledgments",
  "appendix",
  "conclusion",
  "conclusions",
  "discussion",
  "experiment",
  "experiments",
  "figure",
  "introduction",
  "method",
  "methods",
  "paper",
  "references",
  "result",
  "results",
  "section",
  "study",
  "table"
]);

function normalizeReadingMode(mode) {
  if (mode === "viewer") {
    return "viewer"
  }
  if (mode === "structure") {
    return "structure"
  }
  if (mode === "worksheet") {
    return "worksheet"
  }
  return "flow"
}

function getActiveReadingMode() {
  return normalizeReadingMode(modeUiState.mode)
}

function isViewerMode() {
  return getActiveReadingMode() === "viewer"
}

function isWorksheetMode() {
  return getActiveReadingMode() === "worksheet"
}

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
  if (!validTabs.has(candidate)) {
    return "orientation"
  }
  if (candidate === "walkthrough" && !modeUiState.walkthroughVisible) {
    return "explain"
  }
  return candidate
}

function isTabVisible(tab) {
  if (tab === "walkthrough") {
    return modeUiState.walkthroughVisible
  }
  return true
}

function getFlowPreferredTab() {
  const lastUsed = normalizeTabName(sidebarUiState.lastTabByMode?.flow || "")
  if (lastUsed && isTabVisible(lastUsed) && lastUsed !== "walkthrough") {
    return lastUsed
  }
  return "explain"
}

function getStructurePreferredTab() {
  return "orientation"
}

function getWorksheetPreferredTab() {
  const lastUsed = normalizeTabName(sidebarUiState.lastTabByMode?.worksheet || "")
  if (lastUsed && isTabVisible(lastUsed) && lastUsed !== "walkthrough" && lastUsed !== "orientation") {
    return lastUsed
  }
  return "explain"
}

function getEmptyMessage(tab) {
  if (tab === "orientation") {
    return "Open a PDF to generate purpose, focus points, and key terms."
  }
  if (tab === "explain") {
    if (isWorksheetMode()) {
      return "Detect worksheet questions, then click the green A button to generate answers."
    }
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
  const maxGroundingQuotes = Math.max(1, Number(modeUiState.maxGroundingQuotes) || 1)
  const citationQuotes = Array.isArray(card.grounding?.citationQuotes)
    ? card.grounding.citationQuotes.filter(Boolean).slice(0, Math.max(0, maxGroundingQuotes - 1))
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
  details.open = Boolean(modeUiState.cardDetailsOpenByDefault)
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
  if (pendingCardAutoScrollId) {
    const targetCardId = pendingCardAutoScrollId
    pendingCardAutoScrollId = ""
    requestAnimationFrame(() => {
      const target = panel.querySelector(`[data-card-id="${targetCardId}"]`)
      if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" })
      }
    })
  }
}

function renderWorksheetAnswersTab() {
  if (!currentPdf || !renderState.pdfDoc) {
    renderEmpty("explain")
    return
  }

  const worksheetState = getWorksheetState()
  panel.innerHTML = ""

  const wrapper = document.createElement("div")
  wrapper.className = "worksheetAnswerList"

  const header = document.createElement("header")
  header.className = "worksheetAnswerHeader"
  const title = document.createElement("h3")
  title.className = "panelTitle"
  title.textContent = "Worksheet Answers"
  const headerActions = document.createElement("div")
  headerActions.className = "worksheetAnswerHeaderActions"
  const detectButton = document.createElement("button")
  detectButton.type = "button"
  detectButton.className = "orientationMapActionButton"
  detectButton.dataset.worksheetAction = "detect"
  detectButton.textContent = worksheetState.status === "loading" ? "Detecting..." : "Refresh questions"
  detectButton.disabled = worksheetState.status === "loading"
  if (Boolean(currentSettings?.debugMode)) {
    const parserButton = document.createElement("button")
    parserButton.type = "button"
    parserButton.className = "orientationMapSubtleAction"
    parserButton.dataset.worksheetAction = "toggle-parser-view"
    parserButton.textContent = worksheetState.parserDebugVisible ? "Hide parsed XML" : "View parsed XML"
    parserButton.disabled = !(typeof worksheetState.parserXml === "string" && worksheetState.parserXml.trim())
    headerActions.append(parserButton)
  }
  headerActions.append(detectButton)
  header.append(title, headerActions)
  wrapper.append(header)

  if (Boolean(currentSettings?.debugMode) && worksheetState.parserDebugVisible) {
    const debugSection = document.createElement("section")
    debugSection.className = "worksheetParserDebug"
    const debugTitle = document.createElement("p")
    debugTitle.className = "worksheetParserDebugTitle"
    debugTitle.textContent = "Parsed worksheet XML"
    debugSection.append(debugTitle)
    const debugPre = document.createElement("pre")
    debugPre.className = "worksheetParserDebugPre"
    debugPre.textContent =
      typeof worksheetState.parserXml === "string" && worksheetState.parserXml.trim()
        ? worksheetState.parserXml
        : "<worksheet />"
    debugSection.append(debugPre)
    wrapper.append(debugSection)
  }

  if (worksheetState.status === "idle") {
    const hint = document.createElement("p")
    hint.className = "worksheetMutedText"
    hint.textContent = "Detecting worksheet questions..."
    wrapper.append(hint)
    panel.append(wrapper)
    void ensureWorksheetQuestionsForCurrentDocument()
    return
  }

  if (worksheetState.status === "loading") {
    const hint = document.createElement("p")
    hint.className = "worksheetMutedText"
    hint.textContent = "Detecting worksheet questions..."
    wrapper.append(hint)
    panel.append(wrapper)
    return
  }

  if (worksheetState.status === "error") {
    const error = document.createElement("p")
    error.className = "orientationError"
    error.textContent = worksheetState.errorMessage || "Failed to detect worksheet questions."
    wrapper.append(error)
    panel.append(wrapper)
    return
  }

  const questions = Array.isArray(worksheetState.questions) ? worksheetState.questions : []
  if (questions.length === 0) {
    const empty = document.createElement("p")
    empty.className = "worksheetMutedText"
    empty.textContent = "No worksheet questions detected."
    wrapper.append(empty)
    panel.append(wrapper)
    return
  }

  const list = document.createElement("div")
  list.className = "worksheetAnswerCards"
  const byIdMap = getWorksheetQuestionsByIdMap()
  const orderedQuestions = [...questions].sort((a, b) => {
    const pageDiff = (parseOptionalPageIndex(a?.pageIndex) ?? 0) - (parseOptionalPageIndex(b?.pageIndex) ?? 0)
    if (pageDiff !== 0) {
      return pageDiff
    }
    const sortDiff = (Number(a?.sortIndex) || 0) - (Number(b?.sortIndex) || 0)
    if (sortDiff !== 0) {
      return sortDiff
    }
    return sanitizeText(a?.questionText).localeCompare(sanitizeText(b?.questionText))
  })
  orderedQuestions.forEach((question, index) => {
    const card = document.createElement("article")
    card.className = "worksheetAnswerCard"
    card.dataset.questionId = question.id
    const depth = Math.min(3, Math.max(0, getWorksheetQuestionDepth(question, byIdMap)))
    card.dataset.depth = String(depth)
    if (question.hasChildren) {
      card.classList.add("isGroup")
    }

    const row = document.createElement("div")
    row.className = "worksheetAnswerMetaRow"
    const label = document.createElement("p")
    label.className = "worksheetAnswerMeta"
    const pageLabel = `Page ${Math.max(0, Number(question.pageIndex || 0)) + 1}`
    const gradeLabel = clampText(question.gradeLevel, 80)
    const marksValue = normalizeWorksheetMarksValue(question.marksValue)
    const marksLabel =
      clampText(question.marksRaw, 80) ||
      (Number.isFinite(marksValue) ? `${Number(marksValue)} ${Boolean(question.marksEach) ? "marks each" : "marks"}` : "")
    const typeLabel = normalizeWorksheetQuestionType(question.questionType).replace(/_/g, " ")
    const itemLabel =
      normalizeWorksheetLabel(question.label) ||
      deriveWorksheetLabelForCandidate(question.questionText, question.kind) ||
      `Q${index + 1}`
    const metaBits = [itemLabel, pageLabel]
    if (gradeLabel) {
      metaBits.push(gradeLabel)
    }
    if (marksLabel) {
      metaBits.push(marksLabel)
    }
    if (typeLabel && typeLabel !== "unknown") {
      metaBits.push(typeLabel)
    }
    if (question.hasChildren) {
      const progress = countWorksheetAnsweredLeafQuestions(question, byIdMap)
      if (progress.total > 0) {
        metaBits.push(`${progress.answered}/${progress.total} answered`)
      }
    }
    label.textContent = metaBits.join(" - ")
    row.append(label)

    const actions = document.createElement("div")
    actions.className = "worksheetAnswerActions"
    const jumpButton = document.createElement("button")
    jumpButton.type = "button"
    jumpButton.className = "orientationMapSubtleAction"
    jumpButton.dataset.worksheetAction = "jump"
    jumpButton.dataset.questionId = question.id
    jumpButton.textContent = "Jump"
    actions.append(jumpButton)
    row.append(actions)
    card.append(row)

    const questionText = document.createElement("p")
    questionText.className = "worksheetQuestionText"
    questionText.textContent = clampText(question.anchorText || question.questionText, 420)
    card.append(questionText)

    const answerText = document.createElement("div")
    answerText.className = "worksheetAnswerText"
    if (question.answerLoading) {
      answerText.textContent = question.hasChildren ? "Generating sub-answers..." : "Generating answer..."
    } else if (question.hasChildren) {
      const progress = countWorksheetAnsweredLeafQuestions(question, byIdMap)
      if (progress.total > 0) {
        if (progress.answered === 0) {
          answerText.textContent = "Click the green A next to this item to generate all sub-answers."
          answerText.classList.add("isPlaceholder")
        } else if (progress.answered < progress.total) {
          answerText.textContent = `${progress.answered} of ${progress.total} sub-answers generated.`
        } else {
          answerText.textContent = `All ${progress.total} sub-answers are generated.`
        }
      } else {
        answerText.textContent = "Click the green A next to this item to generate answers."
        answerText.classList.add("isPlaceholder")
      }
      const summary = createWorksheetGroupAnswerSummaryNode(question, byIdMap)
      if (summary instanceof HTMLElement) {
        answerText.classList.remove("isPlaceholder")
        answerText.append(summary)
      }
    } else if (normalizeWorksheetAnswerText(question.answerText, 1200)) {
      answerText.append(createWorksheetAnswerRichNode(question, { surface: "sidebar", compact: false }))
    } else {
      answerText.textContent = "Click the green A next to the question to generate an answer."
      answerText.classList.add("isPlaceholder")
    }
    card.append(answerText)

    list.append(card)
  })
  wrapper.append(list)

  if (Array.isArray(worksheetState.detectionWarnings) && worksheetState.detectionWarnings.length > 0) {
    const warning = document.createElement("p")
    warning.className = "worksheetMutedText"
    warning.textContent = clampText(worksheetState.detectionWarnings[0], 180)
    wrapper.append(warning)
  }

  panel.append(wrapper)
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
  const suggestions = Array.isArray(sidebarUiState.glossarySuggestions) ? sidebarUiState.glossarySuggestions : []
  if (terms.length === 0 && suggestions.length === 0) {
    renderEmpty("glossary")
    return
  }

  panel.innerHTML = ""
  if (suggestions.length > 0) {
    const suggested = document.createElement("section")
    suggested.className = "orientationSection"
    const heading = document.createElement("h4")
    heading.className = "orientationSectionTitle"
    heading.textContent = "Suggestions"
    const chips = document.createElement("div")
    chips.className = "orientationKeyTerms"
    for (const suggestion of suggestions.slice(0, 12)) {
      const chip = document.createElement("span")
      chip.className = "orientationTermChip"
      chip.textContent = clampText(suggestion, 48)
      chips.append(chip)
    }
    suggested.append(heading, chips)
    panel.append(suggested)
  }

  if (terms.length > 0) {
    const list = document.createElement("div")
    list.className = "glossaryList"
    for (const term of terms) {
      list.append(createGlossaryNode(term))
    }
    panel.append(list)
  }
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
  if (modeUiState.hasAppliedMode) {
    return getActiveReadingMode()
  }
  return "viewer"
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

function setDigestLoading(sectionKey, isLoading) {
  const key = sanitizeText(sectionKey)
  if (!key) {
    return
  }
  const readingMapState = getReadingMapState()
  readingMapState.digestLoadingByKey[key] = Boolean(isLoading)
}

function isDigestLoading(sectionKey) {
  const key = sanitizeText(sectionKey)
  if (!key) {
    return false
  }
  const readingMapState = getReadingMapState()
  return Boolean(readingMapState.digestLoadingByKey[key])
}

function setDigestVisible(sectionKey, visible) {
  const key = sanitizeText(sectionKey)
  if (!key) {
    return
  }
  const readingMapState = getReadingMapState()
  if (visible) {
    readingMapState.visibleDigestKeys.add(key)
    return
  }
  readingMapState.visibleDigestKeys.delete(key)
}

function isDigestVisible(sectionKey) {
  const key = sanitizeText(sectionKey)
  if (!key) {
    return false
  }
  const readingMapState = getReadingMapState()
  return readingMapState.visibleDigestKeys.has(key)
}

function normalizeDigestHighlightsList(value, limit = FLOW_DIGEST_MAX_KEYWORDS) {
  const maxItems = Number.isFinite(limit) ? Math.max(1, Math.floor(Number(limit))) : FLOW_DIGEST_MAX_KEYWORDS
  const source = Array.isArray(value) ? value : []
  const dedupe = new Set()
  const result = []
  for (const item of source) {
    const text = truncateText(sanitizeText(item), 96)
    if (!text) {
      continue
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length
    if (wordCount < 2) {
      continue
    }
    const key = text.toLowerCase()
    if (dedupe.has(key)) {
      continue
    }
    dedupe.add(key)
    result.push(text)
    if (result.length >= maxItems) {
      break
    }
  }
  return result
}

function setDigestEntry(sectionKey, entry) {
  const key = sanitizeText(sectionKey)
  if (!key || !entry || typeof entry !== "object") {
    return
  }
  const summary = clampText(entry.summary, 260)
  const keywords = normalizeDigestHighlightsList(entry.keywords, FLOW_DIGEST_MAX_KEYWORDS)
  const pageIndex = parseOptionalPageIndex(entry.pageIndex)
  const readingMapState = getReadingMapState()
  readingMapState.digestByKey[key] = {
    summary,
    keywords,
    pageIndex
  }
}

function getDigestEntry(sectionKey) {
  const key = sanitizeText(sectionKey)
  if (!key) {
    return null
  }
  const readingMapState = getReadingMapState()
  const entry = readingMapState.digestByKey[key]
  if (!entry || typeof entry !== "object") {
    return null
  }
  return {
    summary: clampText(entry.summary, 260),
    keywords: normalizeDigestHighlightsList(entry.keywords, FLOW_DIGEST_MAX_KEYWORDS),
    pageIndex: parseOptionalPageIndex(entry.pageIndex)
  }
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
  const normalizedMode = normalizeReadingMode(mode)
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
  regenerateIcon.src = isDarkThemeEnabled() ? ICON_REGENERATE_DARK_THEME_URL : ICON_REGENERATE_LIGHT_THEME_URL
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

function createOrientationParagraph(text, options = {}) {
  const paragraph = document.createElement("p")
  paragraph.className = "orientationParagraph"
  paragraph.innerHTML = formatInlineRichTextHtml(text, options)
  return paragraph
}

function createOrientationLeadStack(entries, fallbackText, options = {}) {
  const stack = document.createElement("div")
  stack.className = "orientationLeadStack"
  let hasRows = false
  for (const entry of Array.isArray(entries) ? entries : []) {
    const label = clampText(entry?.label, 48)
    const text = clampText(entry?.text, 360)
    if (!label || !text) {
      continue
    }
    hasRows = true
    const row = document.createElement("article")
    row.className = "orientationLeadItem"

    const rowLabel = document.createElement("h5")
    rowLabel.className = "orientationLeadLabel"
    rowLabel.textContent = label

    const rowText = document.createElement("p")
    rowText.className = "orientationLeadText"
    rowText.innerHTML = formatInlineRichTextHtml(text, options)

    row.append(rowLabel, rowText)
    stack.append(row)
  }
  if (!hasRows) {
    stack.append(
      createOrientationParagraph(
        clampText(fallbackText, 220) || "Orientation is still building. Start with the introduction and abstract.",
        options
      )
    )
  }
  return stack
}

function createOrientationBullets(items, options = {}) {
  const list = document.createElement("ul")
  list.className = "orientationBullets"
  for (const item of items) {
    const text = clampText(item, 220)
    if (!text) {
      continue
    }
    const li = document.createElement("li")
    li.innerHTML = formatInlineRichTextHtml(text, { ...options, context: "bullet" })
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
    const hint = document.createElement("p")
    hint.className = "orientationMutedText orientationMutedHint"
    hint.textContent = "Use the walkthrough to build a guided reading order from current headings."
    mapSection.append(hint)
    container.append(mapSection)
    return
  }

  const summary = document.createElement("p")
  summary.className = "orientationMutedText"
  summary.textContent =
    normalizedSections.length === 1
      ? "1 section marker is available on the left rail."
      : `${normalizedSections.length} section markers are available on the left rail.`
  const hint = document.createElement("p")
  hint.className = "orientationMutedText orientationMutedHint"
  hint.textContent = "Scan the rail first, then jump by section to keep context while reading."
  mapSection.append(summary, hint)
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
    const collapsedPanel = document.createElement("div")
    collapsedPanel.className = "orientationCollapsedPanel"
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = "orientationChip"
    chip.dataset.orientationAction = "expand"
    chip.textContent = "Orientation"
    collapsedPanel.append(chip)

    if (modeUiState.mode === "flow") {
      const actionRow = document.createElement("div")
      actionRow.className = "orientationMiniActions"

      const summarizeButton = document.createElement("button")
      summarizeButton.type = "button"
      summarizeButton.className = "orientationMiniAction"
      summarizeButton.dataset.orientationAction = "summarize-section"
      summarizeButton.textContent = "Summarize current section"
      summarizeButton.disabled = !Boolean(currentPdf && renderState.pdfDoc)

      const keyTermsButton = document.createElement("button")
      keyTermsButton.type = "button"
      keyTermsButton.className = "orientationMiniAction"
      keyTermsButton.dataset.orientationAction = "key-terms"
      keyTermsButton.textContent = "Key terms so far"
      keyTermsButton.disabled = !Boolean(currentPdf && renderState.pdfDoc)

      actionRow.append(summarizeButton, keyTermsButton)
      collapsedPanel.append(actionRow)
    }

    panel.append(collapsedPanel)
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
  const orientationKeyTerms = Array.isArray(data.keyTerms) ? data.keyTerms : []
  const orientationTextOptions = { keyTerms: orientationKeyTerms, context: "orientation" }
  const glanceSection = createOrientationSection("Paper at a glance")
  const purpose = clampText(data.purpose, readingMode === "flow" ? 220 : 320)
  const contribution = clampText(data.contribution, readingMode === "flow" ? 220 : 320)
  glanceSection.append(
    createOrientationLeadStack(
      [
        { label: "Purpose", text: purpose },
        { label: "Contribution", text: contribution }
      ],
      "Orientation is still building. Start with the introduction and abstract.",
      orientationTextOptions
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
  focusSection.append(createOrientationBullets(focusBullets, orientationTextOptions))
  container.append(focusSection)

  const keyTermsSection = createOrientationSection("Key terms")
  keyTermsSection.append(createOrientationKeyTerms(orientationKeyTerms))
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

function formatInlineRichTextHtml(value, options = {}) {
  const sourceText = sanitizeText(value)
  const escaped = escapeHtml(sourceText)
  if (!escaped) {
    return ""
  }

  const source = options && typeof options === "object" ? options : {}
  const context = sanitizeText(source.context).toLowerCase()
  const keyTerms = Array.isArray(source.keyTerms) ? source.keyTerms : []
  const hasManualFormatting = /(\*\*[^*]+\*\*|__[^_]+__|(^|[^*])\*[^*]+\*(?!\*))/g.test(sourceText)

  // Supported inline markers:
  // **bold**, *italic*, __underline__
  let html = escaped
  html = html.replace(/__(?=\S)(.+?\S)__/g, "<u>$1</u>")
  html = html.replace(/\*\*(?=\S)(.+?\S)\*\*/g, "<strong>$1</strong>")
  html = html.replace(/(^|[^*])\*(?=\S)(.+?\S)\*(?!\*)/g, "$1<em>$2</em>")
  if (hasManualFormatting) {
    return html
  }

  if (context === "bullet") {
    html = autoItalicizeLeadingAction(html)
  }

  html = autoBoldKeyTerms(html, keyTerms)
  if (!/<strong>/.test(html)) {
    html = autoBoldFirstSignificantWord(html)
  }
  html = autoUnderlineFirstStrongToken(html)
  return html
}

function replaceInTextSegments(html, transform) {
  if (typeof html !== "string" || typeof transform !== "function") {
    return ""
  }
  return html
    .split(/(<[^>]+>)/g)
    .map((segment) => (segment.startsWith("<") ? segment : transform(segment)))
    .join("")
}

function autoItalicizeLeadingAction(html) {
  const actionPattern =
    /^\s*(Understand|Learn|Examine|Review|Identify|Compare|Evaluate|Trace|Track|Check|Note|Focus|Map|Scan)\b/i
  return html.replace(actionPattern, "<em>$1</em>")
}

function autoBoldKeyTerms(html, keyTerms) {
  const normalizedTerms = [...new Set(
    keyTerms
      .map((term) => sanitizeText(term))
      .filter((term) => term.length >= 3)
  )]
    .sort((left, right) => right.length - left.length)
    .slice(0, 6)
  if (normalizedTerms.length === 0) {
    return html
  }

  let output = html
  for (const term of normalizedTerms) {
    const escapedTerm = escapeKeywordRegExp(term)
    const pattern = new RegExp(`(^|[^A-Za-z0-9])(${escapedTerm})(?=$|[^A-Za-z0-9])`, "gi")
    output = replaceInTextSegments(output, (segment) =>
      segment.replace(pattern, (_match, prefix, value) => `${prefix}<strong>${value}</strong>`)
    )
  }
  return output
}

function autoUnderlineFirstStrongToken(html) {
  if (/<u>/.test(html)) {
    return html
  }
  return html.replace(/<strong>([^<]+)<\/strong>/, "<strong><u>$1</u></strong>")
}

function autoBoldFirstSignificantWord(html) {
  let replaced = false
  return replaceInTextSegments(html, (segment) => {
    if (replaced) {
      return segment
    }
    return segment.replace(/\b([A-Za-z][A-Za-z-]{3,})\b/, (_match, token) => {
      replaced = true
      return `<strong>${token}</strong>`
    })
  })
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

function getNextWalkthroughItem(items) {
  const source = Array.isArray(items) ? items : []
  if (source.length === 0) {
    return null
  }
  const currentPageIndex = Math.max(0, (currentPdf?.pageNumber || 1) - 1)
  for (const item of source) {
    const itemPageIndex = parseOptionalPageIndex(item?.pageIndex)
    if (itemPageIndex == null) {
      continue
    }
    if (itemPageIndex > currentPageIndex) {
      return item
    }
  }
  return source[source.length - 1] || null
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
  const isStructureMode = modeUiState.mode === "structure"

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
    if (isStructureMode) {
      const ctaButton = document.createElement("button")
      ctaButton.type = "button"
      ctaButton.className = "walkthroughAction"
      ctaButton.dataset.walkthroughAction = "create-top-level"
      ctaButton.textContent = "Create walkthrough (top-level)"
      container.append(ctaButton)
    }
    panel.append(container)
    return
  }

  if (isStructureMode) {
    const nextItem = getNextWalkthroughItem(items)
    if (nextItem) {
      const hintRow = document.createElement("div")
      hintRow.className = "walkthroughNextHint"
      const nextTitle = clampText(nextItem.sectionTitle, 120)
      const label = document.createElement("span")
      label.textContent = `Next: ${nextTitle || "section"}`
      const jumpButton = document.createElement("button")
      jumpButton.type = "button"
      jumpButton.className = "walkthroughAction"
      jumpButton.dataset.walkthroughAction = "jump-next"
      jumpButton.textContent = "Jump to next walkthrough section"
      hintRow.append(label, jumpButton)
      container.append(hintRow)
    }
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
      oneLinerPreview.textContent = "Add a one-line section note."
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
  if (tab === "explain" && isWorksheetMode()) {
    renderWorksheetAnswersTab()
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

function setActiveTab(tab, options = {}) {
  const normalizedTab = normalizeTabName(tab)
  const fromModeApply = Boolean(options?.fromModeApply)
  sidebarUiState.activeTab = normalizedTab
  if (normalizedTab !== "walkthrough") {
    sidebarUiState.walkthrough.confirmRebuild = false
  }
  const activeMode = normalizeReadingMode(modeUiState.mode)
  if (!fromModeApply && normalizedTab !== "walkthrough") {
    sidebarUiState.lastTabByMode[activeMode] = normalizedTab
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

function setStatus(text, options = {}) {
  const message = sanitizeText(text) || "No PDF loaded"
  statusEl.textContent = message
  const explicitTitle = sanitizeText(options?.title)
  statusEl.title = explicitTitle || message
}

function getShortStatusLabel(value, maxLength = 42) {
  const text = sanitizeText(value)
  if (!text) {
    return ""
  }
  return clampText(text, maxLength)
}

function getLoadedStatusSourceShort() {
  if (!currentPdf) {
    return ""
  }
  const localFilename = normalizePdfFilename(currentPdf.filename)
  if (localFilename) {
    return getShortStatusLabel(localFilename, 44)
  }
  if (currentPdf.sourceType === "remote") {
    const inferredFilename = normalizePdfFilename(getFilenameFromUrl(currentPdf.url))
    if (inferredFilename) {
      return getShortStatusLabel(inferredFilename, 44)
    }
    const sanitizedUrl = sanitizeUrlForLog(currentPdf.url)
    if (sanitizedUrl) {
      try {
        const parsed = new URL(sanitizedUrl)
        return getShortStatusLabel(parsed.hostname || sanitizedUrl, 44)
      } catch (_error) {
        return getShortStatusLabel(sanitizedUrl, 44)
      }
    }
  }
  return "document.pdf"
}

function getLoadedStatusSourceFull() {
  if (!currentPdf) {
    return ""
  }
  if (currentPdf.sourceType === "local") {
    return normalizePdfFilename(currentPdf.filename) || "Local PDF"
  }
  if (currentPdf.sourceType === "remote") {
    const sanitizedUrl = sanitizeUrlForLog(currentPdf.url)
    if (sanitizedUrl) {
      return sanitizedUrl
    }
  }
  return getCurrentPdfTitleLabel()
}

function getLoadedStatusTooltipText() {
  if (!currentPdf) {
    return ""
  }
  const fullSource = getLoadedStatusSourceFull()
  const section = clampText(currentPdf.currentSectionTitle || "", 180)
  const pageLabel = Number.isFinite(currentPdf.pageNumber) ? `Page ${currentPdf.pageNumber}` : "Page ?"
  const parts = [
    `Loaded: ${fullSource || "document.pdf"}`,
    pageLabel
  ]
  if (section) {
    parts.push(`Section: ${section}`)
  }
  return parts.join(" | ")
}

function updateLoadedStatusTooltip() {
  if (!(statusEl instanceof HTMLElement)) {
    return
  }
  const statusText = sanitizeText(statusEl.textContent)
  if (!statusText.startsWith("Loaded:")) {
    return
  }
  const tooltip = getLoadedStatusTooltipText()
  if (tooltip) {
    statusEl.title = tooltip
  }
}

function clearTextSelection() {
  const selection = window.getSelection?.()
  if (!selection) {
    return
  }
  try {
    selection.removeAllRanges()
  } catch (_error) {
    // Best effort.
  }
}

function resetHighlighterState() {
  highlighterState.items = []
  highlighterState.nextId = 1
}

function clampRatio(value) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function roundRectValue(value) {
  return Math.round(clampRatio(value) * 10000) / 10000
}

function makeRectKey(rect) {
  return `${roundRectValue(rect.x)}:${roundRectValue(rect.y)}:${roundRectValue(rect.width)}:${roundRectValue(rect.height)}`
}

function normalizeHighlightTextKey(value) {
  return sanitizeText(value).toLowerCase()
}

function dedupeHighlightRects(rects) {
  const result = []
  const dedupe = new Set()
  for (const rect of Array.isArray(rects) ? rects : []) {
    const width = clampRatio(rect?.width)
    const height = clampRatio(rect?.height)
    if (width <= 0 || height <= 0) {
      continue
    }
    const normalized = {
      x: clampRatio(rect?.x),
      y: clampRatio(rect?.y),
      width,
      height
    }
    const key = makeRectKey(normalized)
    if (dedupe.has(key)) {
      continue
    }
    dedupe.add(key)
    result.push(normalized)
  }
  return result
}

function ensureHighlightLayer(pageShell) {
  if (!(pageShell instanceof HTMLElement)) {
    return null
  }
  let layer = pageShell.querySelector(".userHighlightLayer")
  if (layer instanceof HTMLElement) {
    return layer
  }
  const pageSurface = pageShell.querySelector(".pdfPageSurface")
  if (!(pageSurface instanceof HTMLElement)) {
    return null
  }
  layer = document.createElement("div")
  layer.className = "userHighlightLayer"
  pageSurface.append(layer)
  return layer
}

function renderUserHighlightsForPage(pageIndex) {
  const pageShell = getPageNodeByIndex(pageIndex)
  if (!(pageShell instanceof HTMLElement)) {
    return
  }
  const layer = ensureHighlightLayer(pageShell)
  if (!(layer instanceof HTMLElement)) {
    return
  }
  layer.innerHTML = ""

  const highlights = highlighterState.items.filter((item) => item.pageIndex === pageIndex)
  for (const item of highlights) {
    for (const rect of item.rects) {
      const node = document.createElement("button")
      node.type = "button"
      node.className = "userHighlightRect"
      node.dataset.highlightId = item.id
      node.style.left = `${Math.round(clampRatio(rect.x) * 10000) / 100}%`
      node.style.top = `${Math.round(clampRatio(rect.y) * 10000) / 100}%`
      node.style.width = `${Math.round(clampRatio(rect.width) * 10000) / 100}%`
      node.style.height = `${Math.round(clampRatio(rect.height) * 10000) / 100}%`
      node.title = "Click to remove highlight"
      node.setAttribute("aria-label", node.title)
      layer.append(node)
    }
  }
}

function renderAllUserHighlights() {
  for (const pageNode of renderState.pageNodes) {
    const pageIndex = Number(pageNode?.dataset?.pageIndex)
    if (!Number.isFinite(pageIndex) || pageIndex < 0) {
      continue
    }
    renderUserHighlightsForPage(pageIndex)
  }
}

function addOrMergeHighlight(highlight) {
  if (!highlight || !Number.isFinite(highlight.pageIndex) || highlight.pageIndex < 0) {
    return false
  }
  const nextRects = dedupeHighlightRects(highlight.rects)
  if (nextRects.length === 0) {
    return false
  }

  const textKey = normalizeHighlightTextKey(highlight.selectedText)
  if (!textKey) {
    return false
  }

  const existingIndex = highlighterState.items.findIndex(
    (item) => item.pageIndex === highlight.pageIndex && item.textKey === textKey
  )
  if (existingIndex >= 0) {
    const existing = highlighterState.items[existingIndex]
    const mergedRects = dedupeHighlightRects([...(existing?.rects || []), ...nextRects])
    highlighterState.items[existingIndex] = {
      ...existing,
      rects: mergedRects
    }
    renderUserHighlightsForPage(highlight.pageIndex)
    return true
  }

  highlighterState.items.push({
    id: `hl_${highlighterState.nextId++}`,
    pageIndex: Math.max(0, Math.floor(Number(highlight.pageIndex))),
    textKey,
    rects: nextRects
  })
  renderUserHighlightsForPage(highlight.pageIndex)
  return true
}

function addOrMergeHighlightFromPayload(payload) {
  return addOrMergeHighlight({
    pageIndex: payload?.pageIndex,
    selectedText: payload?.selectedText,
    rects: payload?.highlightRects
  })
}

function removeHighlightById(highlightId) {
  if (!highlightId) {
    return
  }
  const existing = highlighterState.items.find((item) => item.id === highlightId)
  if (!existing) {
    return
  }
  highlighterState.items = highlighterState.items.filter((item) => item.id !== highlightId)
  renderUserHighlightsForPage(existing.pageIndex)
}

function buildManualHighlightFromSelection() {
  const selection = window.getSelection?.()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null
  }
  const selectedText = sanitizeText(selection.toString())
  if (!selectedText) {
    return null
  }
  const range = selection.getRangeAt(0)
  const startParent =
    range.startContainer?.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer
  const endParent =
    range.endContainer?.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer

  const startPage = startParent?.closest?.(".pdfPageShell")
  const endPage = endParent?.closest?.(".pdfPageShell")
  if (!(startPage instanceof HTMLElement) || !(endPage instanceof HTMLElement) || startPage !== endPage) {
    return null
  }
  if (!pdfRoot.contains(startPage)) {
    return null
  }

  const pageIndex = Number(startPage.dataset.pageIndex)
  if (!Number.isFinite(pageIndex) || pageIndex < 0) {
    return null
  }
  const textLayer = startPage.querySelector(".textLayer")
  if (!(textLayer instanceof HTMLElement)) {
    return null
  }

  const layerRect = textLayer.getBoundingClientRect()
  if (!Number.isFinite(layerRect.width) || !Number.isFinite(layerRect.height) || layerRect.width <= 0 || layerRect.height <= 0) {
    return null
  }

  const rects = []
  for (const rawRect of Array.from(range.getClientRects())) {
    const clippedLeft = Math.max(rawRect.left, layerRect.left)
    const clippedTop = Math.max(rawRect.top, layerRect.top)
    const clippedRight = Math.min(rawRect.right, layerRect.right)
    const clippedBottom = Math.min(rawRect.bottom, layerRect.bottom)
    const width = clippedRight - clippedLeft
    const height = clippedBottom - clippedTop
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      continue
    }
    rects.push({
      x: clampRatio((clippedLeft - layerRect.left) / layerRect.width),
      y: clampRatio((clippedTop - layerRect.top) / layerRect.height),
      width: clampRatio(width / layerRect.width),
      height: clampRatio(height / layerRect.height)
    })
  }

  if (rects.length === 0) {
    return null
  }

  return {
    pageIndex,
    selectedText,
    rects
  }
}

function handleManualHighlightSelection() {
  const highlight = buildManualHighlightFromSelection()
  if (!highlight) {
    return false
  }
  const didHighlight = addOrMergeHighlight(highlight)
  if (!didHighlight) {
    return false
  }
  clearTextSelection()
  setStatus("Highlight added.")
  return true
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
  if (!modeUiState.sidebarVisible) {
    layoutEl.classList.add("viewerOnly")
    layoutEl.style.gridTemplateColumns = "minmax(0, 1fr)"
    return
  }
  layoutEl.classList.remove("viewerOnly")
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
  if (reopenSidebarBtn instanceof HTMLButtonElement) {
    reopenSidebarBtn.setAttribute("aria-pressed", String(sidebarState.collapsed));
    reopenSidebarBtn.textContent = sidebarState.collapsed ? "\u203A" : "\u2039";
    reopenSidebarBtn.setAttribute(
      "aria-label",
      sidebarState.collapsed ? "Show sidebar panel" : "Hide sidebar panel"
    );
    reopenSidebarBtn.title = sidebarState.collapsed ? "Show Sidebar" : "Hide Sidebar";
  }
  applySidebarLayout();

  if (!options.skipFitWidthResize) {
    handleWindowResize();
  }
}

function setSidebarVisibility(visible) {
  modeUiState.sidebarVisible = Boolean(visible)
  if (!modeUiState.sidebarVisible) {
    hideSectionRail()
  }
  applySidebarLayout()
  if (currentPdf && renderState.pdfDoc) {
    handleWindowResize()
  }
}

function setAiEnabled(enabled) {
  modeUiState.aiEnabled = Boolean(enabled)
  if (selectionSystem) {
    selectionSystem.destroy()
    selectionSystem = null
  }
  if (currentPdf && renderState.pdfDoc) {
    ensureSelectionSystemInitialized()
  }
  renderPdfIntentOverlays()
  renderPdfWorksheetOverlays()
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
  const normalizedSrc = normalizeRemotePdfSourceUrl(src)
  if (!normalizedSrc) {
    return null;
  }

  if (normalizedSrc.toLowerCase().startsWith("file:")) {
    return "local"
  }

  return "remote";
}

function normalizeRemotePdfSourceUrl(url) {
  const normalizedUrl = sanitizeText(url)
  if (!normalizedUrl) {
    return ""
  }

  try {
    const parsed = new URL(normalizedUrl)
    const protocol = parsed.protocol.toLowerCase()
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "file:" && protocol !== "blob:") {
      return ""
    }
    return parsed.toString()
  } catch (_error) {
    return ""
  }
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

function setToolbarModeToggle(mode) {
  const normalizedMode = normalizeReadingMode(mode)
  toolbarModeViewerBtn?.setAttribute("aria-pressed", String(normalizedMode === "viewer"))
  toolbarModeFlowBtn?.setAttribute("aria-pressed", String(normalizedMode === "flow"))
  toolbarModeStructureBtn?.setAttribute("aria-pressed", String(normalizedMode === "structure"))
  toolbarModeWorksheetBtn?.setAttribute("aria-pressed", String(normalizedMode === "worksheet"))
}

function setModeMicroActionsVisible(visible) {
  void visible
}

function updateSectionStatus(sectionTitle = "", options = {}) {
  const normalizedTitle = clampText(sectionTitle, 180)
  const normalizedSectionId = sanitizeText(options?.sectionId) || null
  const normalizedSectionKey = sanitizeText(options?.sectionKey)
  const normalizedSectionPageIndex = parseOptionalPageIndex(options?.pageIndex)

  if (currentPdf && typeof currentPdf === "object") {
    currentPdf.currentSectionTitle = normalizedTitle
    if (!normalizedTitle && !normalizedSectionId && !normalizedSectionKey) {
      currentPdf.currentSectionId = null
      currentPdf.currentSectionKey = ""
      currentPdf.currentSectionPageIndex = null
    } else {
      currentPdf.currentSectionId = normalizedSectionId
      currentPdf.currentSectionKey = normalizedSectionKey
      currentPdf.currentSectionPageIndex = normalizedSectionPageIndex
    }
  }

  if (!currentPdf) {
    setStatus("No PDF loaded")
    return
  }
  if (!normalizedTitle && !(Number(currentPdf.numPages) > 0)) {
    return
  }

  const statusText = normalizedTitle ? `Section: ${normalizedTitle}` : getLoadedStatusText()
  setStatus(statusText, { title: getLoadedStatusTooltipText() })
}

function setWalkthroughTabVisibility(visible) {
  modeUiState.walkthroughVisible = Boolean(visible)
  if (walkthroughTabButton instanceof HTMLElement) {
    walkthroughTabButton.classList.toggle("isModeHidden", !visible)
  }
  if (!visible && sidebarUiState.activeTab === "walkthrough") {
    const mode = getActiveReadingMode()
    setActiveTab(mode === "worksheet" ? getWorksheetPreferredTab() : getFlowPreferredTab(), { fromModeApply: true })
  }
}

function setWalkthroughTabProminent(prominent) {
  if (!(walkthroughTabButton instanceof HTMLElement)) {
    return
  }
  walkthroughTabButton.classList.toggle("isProminent", Boolean(prominent))
}

function setOrientationCollapsedByMode(collapsed) {
  if (modeUiState.hasAppliedMode && modeUiState.previousMode === modeUiState.mode) {
    return
  }
  const orientationState = getOrientationState()
  orientationState.collapsed = Boolean(collapsed)
}

function setModeConfig(config) {
  modeUiState.previousMode = modeUiState.hasAppliedMode ? modeUiState.mode : ""
  modeUiState.hasAppliedMode = true
  modeUiState.mode = normalizeReadingMode(config.mode)
  modeUiState.cardDetailsOpenByDefault = Boolean(config.cardDetailsOpenByDefault)
  modeUiState.maxGroundingQuotes = Math.max(1, Number(config.maxGroundingQuotes) || 1)
  modeUiState.autoGenerateOnLoad = Boolean(config.autoGenerateOnLoad)
  modeUiState.autoBuildWalkthroughOnLoad = Boolean(config.autoBuildWalkthroughOnLoad)
  modeUiState.autoPrewarmOnLoad = Boolean(config.autoPrewarmOnLoad)
  modeUiState.sidebarVisible = config.sidebarVisible !== false
  modeUiState.aiEnabled = config.aiEnabled !== false
}

function resolvePreferredTabForMode(config) {
  const modeChanged = modeUiState.previousMode !== modeUiState.mode
  if (!modeChanged && isTabVisible(sidebarUiState.activeTab)) {
    return null
  }
  const normalizedMode = normalizeReadingMode(config?.mode)
  if (normalizedMode === "structure") {
    return getStructurePreferredTab()
  }
  if (normalizedMode === "worksheet") {
    return getWorksheetPreferredTab()
  }
  if (sidebarUiState.activeTab === "walkthrough" || sidebarUiState.activeTab === "orientation") {
    return getFlowPreferredTab()
  }
  return isTabVisible(sidebarUiState.activeTab) ? sidebarUiState.activeTab : getFlowPreferredTab()
}

function refreshPanelAfterModeApply() {
  if (sidebarUiState.activeTab && isTabVisible(sidebarUiState.activeTab)) {
    renderPanel()
    return
  }
  const mode = getActiveReadingMode()
  setActiveTab(mode === "structure" ? getStructurePreferredTab() : mode === "worksheet" ? getWorksheetPreferredTab() : getFlowPreferredTab(), {
    fromModeApply: true
  })
}

function applyReadingMode(mode, settings = currentSettings || {}) {
  return applyMode(mode, {
    settings,
    state: {
      setModeConfig
    },
    toolbar: {
      setModeToggle: setToolbarModeToggle,
      setMicroActionsVisible: setModeMicroActionsVisible
    },
    sidebar: {
      setWalkthroughVisibility: setWalkthroughTabVisibility,
      setWalkthroughProminent: setWalkthroughTabProminent,
      setOrientationCollapsed: setOrientationCollapsedByMode,
      setSidebarVisible: setSidebarVisibility,
      resolvePreferredTab: resolvePreferredTabForMode,
      setActiveTab
    },
    docState: {
      docId: sidebarUiState.docId,
      currentSectionTitle: currentPdf?.currentSectionTitle || "",
      pageNumber: currentPdf?.pageNumber || 0
    },
    storage: {
      getSettings,
      setSettings
    },
    cards: {
      setCardDetailsOpenByDefault: (openByDefault) => {
        modeUiState.cardDetailsOpenByDefault = Boolean(openByDefault)
      },
      setMaxGroundingQuotes: (count) => {
        modeUiState.maxGroundingQuotes = Math.max(1, Number(count) || 1)
      }
    },
    behavior: {
      setAiEnabled
    },
    render: {
      refreshPanel: refreshPanelAfterModeApply
    }
  })
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

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light"
}

function isDarkThemeEnabled(theme = currentSettings?.theme) {
  return normalizeTheme(theme) === "dark"
}

function updateThemeSensitiveIcons(theme = currentSettings?.theme) {
  const darkThemeEnabled = isDarkThemeEnabled(theme)

  if (openFileIconEl instanceof HTMLImageElement) {
    openFileIconEl.src = darkThemeEnabled ? ICON_OPEN_DARK_THEME_URL : ICON_OPEN_LIGHT_THEME_URL
  }
  if (fitWidthIconEl instanceof HTMLImageElement) {
    fitWidthIconEl.src = darkThemeEnabled ? ICON_FIT_WIDTH_DARK_THEME_URL : ICON_FIT_WIDTH_LIGHT_THEME_URL
  }
  if (highlighterIconEl instanceof HTMLImageElement) {
    highlighterIconEl.src = darkThemeEnabled
      ? ICON_HIGHLIGHTER_DARK_THEME_URL
      : ICON_HIGHLIGHTER_LIGHT_THEME_URL
  }
  if (themeToggleIconEl instanceof HTMLImageElement) {
    themeToggleIconEl.src = darkThemeEnabled ? ICON_THEME_TO_LIGHT_URL : ICON_THEME_TO_DARK_URL
  }
  if (themeToggleBtn instanceof HTMLButtonElement) {
    const nextModeLabel = darkThemeEnabled ? "Enable light mode" : "Enable dark mode"
    themeToggleBtn.setAttribute("aria-label", nextModeLabel)
    themeToggleBtn.title = nextModeLabel
  }
}

function applyThemeToUi(theme = currentSettings?.theme) {
  const normalizedTheme = normalizeTheme(theme)
  document.body.dataset.theme = normalizedTheme
  document.documentElement.style.colorScheme = normalizedTheme
  updateThemeSensitiveIcons(normalizedTheme)
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

function getWorksheetState() {
  if (!sidebarUiState.worksheet || typeof sidebarUiState.worksheet !== "object") {
    sidebarUiState.worksheet = createWorksheetUiState()
  }
  return sidebarUiState.worksheet
}

function resetWorksheetStateForDocument(docId = "unknown") {
  const nextState = createWorksheetUiState()
  nextState.docId = sanitizeText(docId) || "unknown"
  sidebarUiState.worksheet = nextState
}

function normalizeWorksheetSearchText(value) {
  return sanitizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function normalizeWorksheetLabel(value) {
  return clampText(sanitizeText(value), 120)
}

function normalizeWorksheetQuestionType(value) {
  const type = sanitizeText(value).toLowerCase().replace(/[^a-z0-9_]+/g, "_")
  if (!type) {
    return "unknown"
  }
  const allowed = new Set([
    "mcq",
    "short_answer",
    "long_answer",
    "multi_select",
    "fill_blank",
    "true_false",
    "table_definition",
    "unknown"
  ])
  if (allowed.has(type)) {
    return type
  }
  return "unknown"
}

function normalizeWorksheetResponseTypes(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string" && value
      ? value.split(",")
      : []
  const dedupe = new Set()
  const normalized = []
  for (const entry of source) {
    const type = normalizeWorksheetQuestionType(entry)
    if (!type || type === "unknown" || dedupe.has(type)) {
      continue
    }
    dedupe.add(type)
    normalized.push(type)
  }
  if (normalized.length === 0) {
    return ["unknown"]
  }
  return normalized.slice(0, 6)
}

function normalizeWorksheetOptions(value) {
  const source = Array.isArray(value) ? value : []
  return source
    .map((entry) => clampText(entry, 120))
    .filter(Boolean)
    .slice(0, 12)
}

function normalizeWorksheetMarksValue(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null
  }
  return numeric
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

function stripWorksheetAnswerFormatting(value) {
  return normalizeWorksheetAnswerText(value, 1200).replace(/\*\*/g, "").replace(/`/g, "").trim()
}

function appendWorksheetInlineMarkdown(target, value) {
  const text = typeof value === "string" ? value : ""
  if (!text || !(target instanceof HTMLElement)) {
    return
  }
  const pattern = /\*\*([^*]+)\*\*/g
  let cursor = 0
  let match
  while ((match = pattern.exec(text))) {
    const start = match.index
    if (start > cursor) {
      target.append(document.createTextNode(text.slice(cursor, start)))
    }
    const bold = document.createElement("strong")
    bold.textContent = match[1]
    target.append(bold)
    cursor = pattern.lastIndex
  }
  if (cursor < text.length) {
    target.append(document.createTextNode(text.slice(cursor)))
  }
}

function appendWorksheetMarkdownBlock(container, text, className = "worksheetAnswerLine") {
  if (!(container instanceof HTMLElement)) {
    return
  }
  const source = normalizeWorksheetAnswerText(text, 1200)
  if (!source) {
    return
  }
  const lines = source.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  let listNode = null
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet?.[1]) {
      if (!(listNode instanceof HTMLUListElement)) {
        listNode = document.createElement("ul")
        listNode.className = "worksheetAnswerBullets"
        container.append(listNode)
      }
      const item = document.createElement("li")
      item.className = "worksheetAnswerBullet"
      appendWorksheetInlineMarkdown(item, bullet[1])
      listNode.append(item)
      continue
    }
    listNode = null
    const paragraph = document.createElement("p")
    paragraph.className = className
    appendWorksheetInlineMarkdown(paragraph, line)
    container.append(paragraph)
  }
}

function parseWorksheetOptionEntry(optionText) {
  const text = normalizeWorksheetAnswerText(optionText, 120)
  if (!text) {
    return null
  }
  const match = text.match(/^([a-z]|[ivxlcdm]+|\d+)[\)\.]\s*(.+)$/i)
  if (match?.[1] && match?.[2]) {
    return {
      key: sanitizeText(match[1]).toLowerCase(),
      text: sanitizeText(match[2]),
      raw: text
    }
  }
  return {
    key: "",
    text,
    raw: text
  }
}

function getWorksheetOptionEntries(question) {
  const rawOptions = normalizeWorksheetOptions(question?.options)
  return rawOptions.map((option) => parseWorksheetOptionEntry(option)).filter(Boolean)
}

function detectWorksheetSelectedOptions(question, answerText) {
  const options = getWorksheetOptionEntries(question)
  if (options.length === 0) {
    return []
  }
  const responseTypes = normalizeWorksheetResponseTypes(question?.responseTypes)
  const allowsMultiple = responseTypes.includes("multi_select")
  const plainAnswer = stripWorksheetAnswerFormatting(answerText).toLowerCase()
  const searchAnswer = normalizeWorksheetSearchText(plainAnswer)
  if (!searchAnswer) {
    return []
  }
  const scored = []
  for (const option of options) {
    const optionSearch = normalizeWorksheetSearchText(option.text)
    let score = 0
    if (option.key) {
      const keyPattern = new RegExp(`(?:^|\\b)(?:option\\s*)?${escapeRegExp(option.key)}(?:\\)|\\.|\\b)`, "i")
      if (keyPattern.test(plainAnswer)) {
        score += 4
      }
    }
    if (optionSearch && searchAnswer.includes(optionSearch)) {
      score += 6
    } else if (optionSearch) {
      const tokens = optionSearch.split(" ").filter((token) => token.length >= 4)
      let tokenMatches = 0
      for (const token of tokens) {
        if (searchAnswer.includes(token)) {
          tokenMatches += 1
        }
      }
      if (tokenMatches > 0) {
        score += tokenMatches
      }
    }
    if (score > 0) {
      scored.push({ option, score })
    }
  }
  if (scored.length === 0) {
    return []
  }
  scored.sort((a, b) => b.score - a.score)
  if (!allowsMultiple) {
    return [scored[0].option]
  }
  const topScore = scored[0].score
  return scored
    .filter((entry) => entry.score >= Math.max(4, topScore - 2))
    .map((entry) => entry.option)
    .slice(0, 4)
}

function parseWorksheetTrueFalseAnswer(answerText) {
  const plain = stripWorksheetAnswerFormatting(answerText)
  if (!plain) {
    return { verdict: "", explanation: "" }
  }
  const leading = plain.match(/^(?:answer\s*[:\-]\s*)?(true|false)\b[\s\.:;\-]*/i)
  if (leading?.[1]) {
    return {
      verdict: leading[1].toUpperCase(),
      explanation: plain.slice(leading[0].length).trim()
    }
  }
  const embedded = plain.match(/\b(true|false)\b/i)
  if (embedded?.[1] && plain.length <= 28) {
    return {
      verdict: embedded[1].toUpperCase(),
      explanation: ""
    }
  }
  return {
    verdict: "",
    explanation: plain
  }
}

function createWorksheetAnswerRichNode(question, options = {}) {
  const surface = options?.surface === "pdf" ? "pdf" : "sidebar"
  const compact = Boolean(options?.compact)
  const answerText = normalizeWorksheetAnswerText(question?.answerText, 1200)
  const responseTypes = normalizeWorksheetResponseTypes(question?.responseTypes)
  const optionEntries = getWorksheetOptionEntries(question)
  const hasTrueFalse = responseTypes.includes("true_false")
  const hasMcq = responseTypes.includes("mcq") || responseTypes.includes("multi_select") || optionEntries.length >= 2
  const isTermLike =
    normalizeWorksheetKind(question?.kind) === "term" ||
    normalizeWorksheetQuestionType(question?.questionType) === "table_definition"

  const rich = document.createElement("div")
  rich.className = "worksheetAnswerRich"
  rich.dataset.surface = surface
  if (compact) {
    rich.classList.add("isCompact")
  }
  if (!answerText) {
    const line = document.createElement("p")
    line.className = "worksheetAnswerLine"
    line.textContent = "No answer generated."
    rich.append(line)
    return rich
  }

  const trueFalse = hasTrueFalse ? parseWorksheetTrueFalseAnswer(answerText) : { verdict: "", explanation: answerText }
  if (trueFalse.verdict) {
    const verdict = document.createElement("span")
    verdict.className = `worksheetAnswerVerdict ${trueFalse.verdict === "TRUE" ? "isTrue" : "isFalse"}`
    verdict.textContent = trueFalse.verdict
    rich.append(verdict)
  }

  const selectedOptions = hasMcq ? detectWorksheetSelectedOptions(question, answerText) : []
  const selectedSet = new Set(selectedOptions.map((entry) => `${entry.key}|${entry.text}`))
  if (hasMcq && optionEntries.length > 0) {
    const optionsList = document.createElement("div")
    optionsList.className = "worksheetOptionList"
    for (const entry of optionEntries) {
      const optionNode = document.createElement("p")
      optionNode.className = "worksheetOptionItem"
      const identity = `${entry.key}|${entry.text}`
      if (selectedSet.has(identity)) {
        optionNode.classList.add("isCorrect")
      }
      optionNode.textContent = entry.key ? `${entry.key}) ${entry.text}` : entry.text
      optionsList.append(optionNode)
    }
    rich.append(optionsList)
  }

  if (!hasMcq && isTermLike && !trueFalse.verdict) {
    const termLine = document.createElement("p")
    termLine.className = "worksheetAnswerLine isTerm"
    appendWorksheetInlineMarkdown(termLine, answerText)
    rich.append(termLine)
    return rich
  }

  let explanation = hasTrueFalse ? trueFalse.explanation : answerText
  if (hasMcq) {
    explanation = explanation.replace(/^\*{0,2}\s*answer\s*[:\-]\s*/i, "").trim()
    const normalizedExplanation = normalizeWorksheetSearchText(explanation)
    const selectedSearches = selectedOptions.map((entry) => normalizeWorksheetSearchText(entry.text)).filter(Boolean)
    if (
      normalizedExplanation &&
      selectedSearches.some((entry) => entry === normalizedExplanation || normalizedExplanation === `${entry} only`)
    ) {
      explanation = ""
    }
  }
  if (explanation) {
    appendWorksheetMarkdownBlock(rich, explanation, "worksheetAnswerLine")
  }

  return rich
}

function hashCompactString(input) {
  let hash = 2166136261
  const value = typeof input === "string" ? input : ""
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function buildWorksheetQuestionId(questionText, pageIndex, kind = "prompt", sourceKey = "") {
  const normalizedSourceKey = sanitizeText(sourceKey)
  const key =
    normalizedSourceKey ||
    `${parseOptionalPageIndex(pageIndex) ?? 0}:${normalizeWorksheetKind(kind)}:${normalizeWorksheetSearchText(questionText)}`
  return `wsq_${hashCompactString(key).toString(36)}`
}

function normalizeWorksheetKind(value) {
  const kind = sanitizeText(value).toLowerCase()
  if (kind === "question" || kind === "part" || kind === "item" || kind === "term") {
    return kind
  }
  return "prompt"
}

function normalizeWorksheetParentSourceKey(value) {
  return clampText(sanitizeText(value), 220)
}

function makeWorksheetStableSourceKey(item) {
  const explicit = sanitizeText(item?.sourceKey)
  if (explicit) {
    return clampText(explicit, 220)
  }
  const pageIndex = parseOptionalPageIndex(item?.pageIndex) ?? 0
  const kind = normalizeWorksheetKind(item?.kind)
  const parentSourceKey = normalizeWorksheetParentSourceKey(
    item?.parentSourceKey || item?.parentKey || item?.parentId
  )
  const questionText = clampText(item?.questionText || item?.question || item?.text || item?.prompt, 360)
  return `${pageIndex}:${kind}:${normalizeWorksheetSearchText(parentSourceKey)}:${normalizeWorksheetSearchText(questionText)}`
}

function estimateWorksheetAnswerLength(answerText) {
  const text = normalizeWorksheetAnswerText(answerText, 1200)
  if (!text) {
    return "long"
  }
  return text.length <= WORKSHEET_OVERLAY_MAX_CHARS ? "short" : "long"
}

function isWorksheetAnswerShort(question) {
  if (!question || typeof question !== "object") {
    return false
  }
  if (question.answerLength === "short") {
    return true
  }
  if (question.answerLength === "long") {
    return false
  }
  return estimateWorksheetAnswerLength(question.answerText) === "short"
}

function getWorksheetQuestionById(questionId) {
  const normalizedId = sanitizeText(questionId)
  if (!normalizedId) {
    return null
  }
  const worksheetState = getWorksheetState()
  return worksheetState.questions.find((item) => item.id === normalizedId) || null
}

function getWorksheetQuestionsByIdMap() {
  const worksheetState = getWorksheetState()
  const questions = Array.isArray(worksheetState.questions) ? worksheetState.questions : []
  const byId = new Map()
  for (const question of questions) {
    if (question?.id) {
      byId.set(question.id, question)
    }
  }
  return byId
}

function getWorksheetQuestionChildren(question, byIdMap = null) {
  if (!question) {
    return []
  }
  const childIds = Array.isArray(question.childIds) ? question.childIds : []
  if (childIds.length === 0) {
    return []
  }
  const byId = byIdMap instanceof Map ? byIdMap : getWorksheetQuestionsByIdMap()
  const children = []
  for (const childId of childIds) {
    const child = byId.get(childId)
    if (child) {
      children.push(child)
    }
  }
  return children
}

function collectWorksheetLeafQuestions(question, byIdMap = null) {
  if (!question) {
    return []
  }
  const leaves = []
  const stack = [question]
  const visited = new Set()
  const byId = byIdMap instanceof Map ? byIdMap : getWorksheetQuestionsByIdMap()
  while (stack.length > 0) {
    const current = stack.shift()
    if (!current?.id || visited.has(current.id)) {
      continue
    }
    visited.add(current.id)
    const children = getWorksheetQuestionChildren(current, byId)
    if (children.length === 0) {
      leaves.push(current)
      continue
    }
    for (const child of children) {
      stack.push(child)
    }
  }
  return leaves
}

function countWorksheetAnsweredLeafQuestions(question, byIdMap = null) {
  const leaves = collectWorksheetLeafQuestions(question, byIdMap).filter((item) => item?.id !== question?.id)
  if (leaves.length === 0) {
    return { total: 0, answered: 0 }
  }
  const answered = leaves.filter((leaf) => Boolean(normalizeWorksheetAnswerText(leaf.answerText, 1200))).length
  return { total: leaves.length, answered }
}

function createWorksheetGroupAnswerSummaryNode(question, byIdMap = null) {
  const leaves = collectWorksheetLeafQuestions(question, byIdMap).filter((item) => item?.id !== question?.id)
  const answeredLeaves = leaves
    .filter((item) => Boolean(normalizeWorksheetAnswerText(item.answerText, 1200)))
    .sort((a, b) => {
      const pageDiff = (parseOptionalPageIndex(a?.pageIndex) ?? 0) - (parseOptionalPageIndex(b?.pageIndex) ?? 0)
      if (pageDiff !== 0) {
        return pageDiff
      }
      return (Number(a?.sortIndex) || 0) - (Number(b?.sortIndex) || 0)
    })
  if (answeredLeaves.length === 0) {
    return null
  }
  const summary = document.createElement("div")
  summary.className = "worksheetSubAnswerList"
  for (const leaf of answeredLeaves) {
    const row = document.createElement("div")
    row.className = "worksheetSubAnswerRow"
    const label = document.createElement("p")
    label.className = "worksheetSubAnswerLabel"
    label.textContent =
      normalizeWorksheetLabel(leaf.label) ||
      deriveWorksheetLabelForCandidate(leaf.anchorText || leaf.questionText, leaf.kind) ||
      "Answer"
    row.append(label)
    row.append(createWorksheetAnswerRichNode(leaf, { surface: "sidebar", compact: true }))
    summary.append(row)
  }
  return summary
}

function getWorksheetQuestionDepth(question, byIdMap = null) {
  if (!question?.id) {
    return 0
  }
  const byId = byIdMap instanceof Map ? byIdMap : getWorksheetQuestionsByIdMap()
  let depth = 0
  let parentId = sanitizeText(question.parentId)
  let guard = 0
  while (parentId && guard < 12) {
    guard += 1
    const parent = byId.get(parentId)
    if (!parent) {
      break
    }
    depth += 1
    parentId = sanitizeText(parent.parentId)
  }
  return depth
}

function structureWorksheetDetectionText(value) {
  const source = typeof value === "string" ? value : ""
  if (!source) {
    return ""
  }
  return source
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\b(Question\s+\d+\.?)/gi, "\n$1")
    .replace(/\b(Part\s*\([a-z]\))/gi, "\n$1")
    .replace(/(^|[^A-Za-z0-9])(\d+\.)\s+(?=[A-Z])/g, (match, prefix, marker, offset, fullText) => {
      const markerStart = Number(offset) + String(prefix).length
      const start = Math.max(0, markerStart - 24)
      const windowText = fullText.slice(start, markerStart)
      if (/Question\s*$/i.test(windowText) || /Part\s*\([a-z]\)\s*$/i.test(windowText)) {
        return match
      }
      return `${prefix}\n${marker} `
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function truncateWorksheetText(value, maxLength) {
  const text = structureWorksheetDetectionText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength).trim()
}

function inferWorksheetGradeLevel(questionText) {
  const text = sanitizeText(questionText)
  if (!text) {
    return ""
  }
  const grade = text.match(/\b(?:grade|class)\s*\d+\b/i)
  if (grade?.[0]) {
    return clampText(grade[0], 80)
  }
  const points = text.match(/\b\d+\s*(?:marks?|points?|pts?)\b/i)
  if (points?.[0]) {
    return clampText(points[0], 80)
  }
  return ""
}

function isLikelyWorksheetPromptLine(text) {
  const line = sanitizeText(text)
  if (!line || line.length < 12) {
    return false
  }
  if (isLikelyWorksheetOptionLine(line)) {
    return false
  }
  if (/^(term|definition|virtual address|physical address|notes)$/i.test(line)) {
    return false
  }
  if (isWorksheetFooterLine(line)) {
    return false
  }
  if (
    /\?|(?:\bwhich\b|\bwhat\b|\bwhy\b|\bhow\b|\bexplain\b|\bdescribe\b|\bdefine\b|\bcalculate\b|\bselect\b|\bindicate\b|\btranslate\b|\bdetermine\b|\bidentify\b|\bcomplete\b|\bjustify\b)/i.test(
      line
    )
  ) {
    return true
  }
  if (line.length >= 42 && /\b(?:true|false|statement|address|memory|register|process)\b/i.test(line)) {
    return true
  }
  return false
}

function isLikelyWorksheetOptionLine(text) {
  const line = sanitizeText(text)
  if (!line) {
    return false
  }
  return /^([a-z]|[ivxlcdm]+)\)\s+/i.test(line) || /^[A-D]\.\s+/.test(line)
}

function isWorksheetFooterLine(text) {
  const line = sanitizeText(text)
  if (!line) {
    return false
  }
  if (/^page\s+\d+\s*(?:\/|of)\s*\d+/i.test(line)) {
    return true
  }
  if (/cont'?d\.?$/i.test(line)) {
    return true
  }
  return false
}

function stripWorksheetFooterFragments(text) {
  const line = sanitizeText(text)
  if (!line) {
    return ""
  }
  return sanitizeText(
    line
      .replace(/\bpage\s+\d+\s*(?:\/|of)\s*\d+\b.*$/i, "")
      .replace(/\bcont'?d\.?\b.*$/i, "")
  )
}

function isLikelyWorksheetTermLine(text) {
  const line = stripWorksheetFooterFragments(text)
  if (!line || line.length < 3 || line.length > 84) {
    return false
  }
  if (isWorksheetFooterLine(line) || isLikelyWorksheetOptionLine(line)) {
    return false
  }
  if (/^Question\s+\d+|^Part\s*\([a-z]\)|^\d+\.\s+/i.test(line)) {
    return false
  }
  if (/^(term|definition|virtual address|physical address|notes)$/i.test(line)) {
    return false
  }
  if (/[?.:;!]/.test(line)) {
    return false
  }
  if (
    /\b(explain|describe|justify|indicate|select|calculate|determine|identify|complete|consider|translate|briefly|answer)\b/i.test(
      line
    )
  ) {
    return false
  }
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 5) {
    return false
  }
  if (words.every((word) => /^\d+$/.test(word))) {
    return false
  }
  return /[A-Za-z]/.test(line)
}

function splitPackedWorksheetTermLine(text) {
  const line = stripWorksheetFooterFragments(text)
  const cleaned = sanitizeText(
    line
      .replace(/^term\s+definition\s+/i, "")
      .replace(/^virtual\s+address\s+physical\s+address\s+notes\s+/i, "")
  )
  if (!cleaned || cleaned.length < 24 || cleaned.length > 720) {
    return []
  }
  if (/[?.:;!]/.test(cleaned.replace(/\./g, ""))) {
    return []
  }
  const segments = cleaned
    .split(/\s+(?=[A-Z][a-z])/)
    .map((entry) => sanitizeText(entry))
    .filter(Boolean)
  if (segments.length < 3) {
    return []
  }
  return segments.filter((entry) => isLikelyWorksheetTermLine(entry))
}

function deriveWorksheetLabelForCandidate(questionText, kind) {
  const text = sanitizeText(questionText)
  if (!text) {
    return ""
  }
  const normalizedKind = normalizeWorksheetKind(kind)
  if (normalizedKind === "question") {
    return normalizeWorksheetLabel(text.match(/Question\s+\d+/i)?.[0] || "Question")
  }
  if (normalizedKind === "part") {
    return normalizeWorksheetLabel(text.match(/Part\s*\([a-z]\)/i)?.[0] || "Part")
  }
  if (normalizedKind === "item") {
    return normalizeWorksheetLabel(text.match(/(?:^|\s)(\d+\.)/)?.[1] || "Item")
  }
  if (normalizedKind === "term") {
    return normalizeWorksheetLabel(text)
  }
  return normalizeWorksheetLabel(clampText(text, 42))
}

function extractWorksheetQuestionCandidatesFromStructuredPage(pageText, pageIndex) {
  const source = structureWorksheetDetectionText(pageText)
  if (!source) {
    return []
  }
  const page = Math.max(0, Number(pageIndex) || 0)
  const lines = source
    .split(/\n+/)
    .map((line) => sanitizeText(line))
    .filter(Boolean)
  const candidates = []
  const dedupe = new Set()
  let currentQuestionLabel = ""
  let currentQuestionSourceKey = ""
  let currentPartSourceKey = ""
  let pendingPartPrefix = ""
  let pendingPartParentSourceKey = ""
  let pendingPartLabel = ""
  let expectTermRows = false
  let termParentSourceKey = ""
  let seenTermRows = 0

  const pushCandidate = (item) => {
    const questionText = clampText(item?.questionText || item?.text || item?.question || item?.prompt, 360)
    if (!questionText) {
      return null
    }
    const kind = normalizeWorksheetKind(item?.kind)
    const parentSourceKey = normalizeWorksheetParentSourceKey(item?.parentSourceKey)
    const sourceKey = makeWorksheetStableSourceKey({
      sourceKey: item?.sourceKey,
      pageIndex: page,
      questionText,
      kind,
      parentSourceKey
    })
    if (!sourceKey || dedupe.has(sourceKey)) {
      return null
    }
    dedupe.add(sourceKey)
    const candidate = {
      questionText,
      pageIndex: page,
      gradeLevel: clampText(item?.gradeLevel || item?.grade || inferWorksheetGradeLevel(questionText), 80),
      kind,
      sourceKey,
      parentSourceKey,
      label: normalizeWorksheetLabel(item?.label || deriveWorksheetLabelForCandidate(questionText, kind)),
      anchorText: clampText(item?.anchorText || questionText, 240)
    }
    candidates.push(candidate)
    return candidate
  }

  for (const line of lines) {
    const isQuestionLine = /^Question\s+\d+\.?/i.test(line)
    const isPartLine = /^Part\s*\([a-z]\)/i.test(line)
    const isNumberedLine = /^\d+\.\s+/.test(line)

    if (pendingPartPrefix) {
      if (!isQuestionLine && !isPartLine && !isNumberedLine && !isWorksheetFooterLine(line)) {
        const partCandidate = pushCandidate({
          questionText: `${pendingPartPrefix} ${line}`,
          kind: "part",
          parentSourceKey: pendingPartParentSourceKey,
          label: pendingPartLabel,
          anchorText: `${pendingPartLabel} ${line}`
        })
        currentPartSourceKey = partCandidate?.sourceKey || currentPartSourceKey
        expectTermRows = /\btable\b|\bdefinitions?\b/i.test(`${pendingPartPrefix} ${line}`)
        termParentSourceKey = currentPartSourceKey || currentQuestionSourceKey
        seenTermRows = 0
        pendingPartPrefix = ""
        pendingPartParentSourceKey = ""
        pendingPartLabel = ""
        continue
      }
      const partCandidate = pushCandidate({
        questionText: pendingPartPrefix,
        kind: "part",
        parentSourceKey: pendingPartParentSourceKey,
        label: pendingPartLabel,
        anchorText: pendingPartLabel || pendingPartPrefix
      })
      currentPartSourceKey = partCandidate?.sourceKey || currentPartSourceKey
      pendingPartPrefix = ""
      pendingPartParentSourceKey = ""
      pendingPartLabel = ""
    }

    const questionMatch = line.match(/^Question\s+(\d+)\.?\s*(.*)$/i)
    if (questionMatch) {
      currentQuestionLabel = `Question ${questionMatch[1]}`
      currentPartSourceKey = ""
      expectTermRows = false
      termParentSourceKey = ""
      seenTermRows = 0
      const trailing = sanitizeText(questionMatch[2])
      const questionText = trailing ? `${currentQuestionLabel}. ${trailing}` : `${currentQuestionLabel}.`
      const questionCandidate = pushCandidate({
        questionText,
        kind: "question",
        parentSourceKey: "",
        label: currentQuestionLabel,
        anchorText: `${currentQuestionLabel}.`
      })
      currentQuestionSourceKey = questionCandidate?.sourceKey || currentQuestionSourceKey
      if (/\btable\b|\bdefinitions?\b/i.test(questionText)) {
        expectTermRows = true
        termParentSourceKey = currentQuestionSourceKey
      }
      continue
    }

    if (/^Part\s*\([a-z]\)/i.test(line)) {
      const partMatch = line.match(/^Part\s*\(([a-z])\)\s*(.*)$/i)
      const partLabel = partMatch?.[1] ? `Part (${partMatch[1].toLowerCase()})` : "Part"
      const trailing = sanitizeText(partMatch?.[2] || "")
      const prefix = currentQuestionLabel ? `${currentQuestionLabel} ${partLabel}` : partLabel
      const parentSourceKey = currentQuestionSourceKey || ""
      if (trailing) {
        const partCandidate = pushCandidate({
          questionText: `${prefix} ${trailing}`,
          kind: "part",
          parentSourceKey,
          label: partLabel,
          anchorText: `${partLabel} ${trailing}`
        })
        currentPartSourceKey = partCandidate?.sourceKey || currentPartSourceKey
        expectTermRows = /\btable\b|\bdefinitions?\b/i.test(`${prefix} ${trailing}`)
        termParentSourceKey = currentPartSourceKey || parentSourceKey
        seenTermRows = 0
      } else {
        pendingPartPrefix = prefix
        pendingPartParentSourceKey = parentSourceKey
        pendingPartLabel = partLabel
      }
      continue
    }

    if (/^(term)\b/i.test(line) && /\bdefinition\b/i.test(line)) {
      expectTermRows = true
      termParentSourceKey = currentPartSourceKey || currentQuestionSourceKey || termParentSourceKey
      seenTermRows = 0
      continue
    }

    if (expectTermRows) {
      if (isWorksheetFooterLine(line)) {
        expectTermRows = false
      } else if (isLikelyWorksheetTermLine(line)) {
        const termCandidate = pushCandidate({
          questionText: line,
          kind: "term",
          parentSourceKey: termParentSourceKey || currentPartSourceKey || currentQuestionSourceKey,
          label: line,
          anchorText: line
        })
        if (termCandidate) {
          seenTermRows += 1
          continue
        }
      } else {
        const packedTerms = splitPackedWorksheetTermLine(line)
        if (packedTerms.length > 0) {
          for (const term of packedTerms) {
            const termCandidate = pushCandidate({
              questionText: term,
              kind: "term",
              parentSourceKey: termParentSourceKey || currentPartSourceKey || currentQuestionSourceKey,
              label: term,
              anchorText: term
            })
            if (termCandidate) {
              seenTermRows += 1
            }
          }
          continue
        }
        if (seenTermRows > 0) {
          expectTermRows = false
        }
      }
    }

    if (/^\d+\.\s+/.test(line)) {
      const numberedMatch = line.match(/^(\d+)\.\s+(.*)$/)
      const itemLabel = numberedMatch?.[1] ? `${numberedMatch[1]}.` : "Item"
      const bodyRaw = sanitizeText(numberedMatch?.[2] || "")
      const body = sanitizeText(bodyRaw.replace(/\s+[a-d]\)\s+.+$/i, ""))
      if (!body || isLikelyWorksheetOptionLine(body)) {
        continue
      }
      if (!isLikelyWorksheetPromptLine(body) && body.length < 26) {
        continue
      }
      pushCandidate({
        questionText: currentQuestionLabel ? `${currentQuestionLabel} ${itemLabel} ${body}` : `${itemLabel} ${body}`,
        kind: "item",
        parentSourceKey: currentQuestionSourceKey || currentPartSourceKey,
        label: itemLabel,
        anchorText: `${itemLabel} ${body}`
      })
      continue
    }

    if (currentPartSourceKey && isLikelyWorksheetPromptLine(line)) {
      const promptCandidate = pushCandidate({
        questionText: `${currentQuestionLabel ? `${currentQuestionLabel} ` : ""}${line}`,
        kind: "prompt",
        parentSourceKey: currentPartSourceKey,
        anchorText: line
      })
      if (promptCandidate && /\btable\b|\bdefinitions?\b/i.test(line)) {
        expectTermRows = true
        termParentSourceKey = currentPartSourceKey
        seenTermRows = 0
      }
    }
  }

  if (pendingPartPrefix) {
    pushCandidate({
      questionText: pendingPartPrefix,
      kind: "part",
      parentSourceKey: pendingPartParentSourceKey,
      label: pendingPartLabel,
      anchorText: pendingPartLabel || pendingPartPrefix
    })
  }

  if (candidates.length === 0) {
    for (const line of lines) {
      if (isLikelyWorksheetPromptLine(line)) {
        pushCandidate({
          questionText: line,
          pageIndex: page,
          kind: "prompt",
          parentSourceKey: "",
          anchorText: line
        })
      }
    }
  }

  return candidates.slice(0, 72)
}

function extractWorksheetQuestionsFromPages(worksheetPages) {
  const pages = Array.isArray(worksheetPages) ? worksheetPages : []
  const extracted = []
  for (const page of pages) {
    const pageIndex = parseOptionalPageIndex(page?.pageIndex) ?? 0
    const fromPage = extractWorksheetQuestionCandidatesFromStructuredPage(page?.text, pageIndex)
    for (const question of fromPage) {
      extracted.push(question)
      if (extracted.length >= WORKSHEET_QUESTION_MAX_ITEMS) {
        return extracted
      }
    }
  }
  return extracted
}

function isQuestionCandidateUsable(candidate) {
  const questionText = sanitizeText(candidate?.questionText || candidate?.text || candidate?.question || candidate?.prompt)
  if (!questionText) {
    return false
  }
  const kind = normalizeWorksheetKind(candidate?.kind)
  if (kind === "term") {
    return isLikelyWorksheetTermLine(questionText)
  }
  if (isWorksheetFooterLine(questionText)) {
    return false
  }
  const questionMarkerCount = (questionText.match(/\bQuestion\s+\d+/gi) || []).length
  const partMarkerCount = (questionText.match(/\bPart\s*\([a-z]\)/gi) || []).length
  if (questionMarkerCount > 1 && questionText.length > 180) {
    return false
  }
  if (partMarkerCount > 1 && questionText.length > 240) {
    return false
  }
  return true
}

function mergeWorksheetQuestionCandidates(primaryQuestions, secondaryQuestions) {
  const merged = []
  const seenIndex = new Map()
  const looseSeenIndex = new Map()
  const textSeenIndex = new Map()
  const append = (item) => {
    if (!item || !isQuestionCandidateUsable(item)) {
      return
    }
    const questionText = clampText(item.questionText || item.question || item.text || item.prompt, 360)
    const pageIndex = parseOptionalPageIndex(item.pageIndex) ?? 0
    const kind = normalizeWorksheetKind(item.kind)
    const parentSourceKey = normalizeWorksheetParentSourceKey(item.parentSourceKey || item.parentKey || item.parentId)
    const sourceKey = makeWorksheetStableSourceKey({
      sourceKey: item.sourceKey,
      pageIndex,
      questionText,
      kind,
      parentSourceKey
    })
    const looseKey = `${pageIndex}:${kind}:${normalizeWorksheetSearchText(questionText)}`
    const textKey = `${pageIndex}:${normalizeWorksheetSearchText(questionText)}`
    const gradeLevel = clampText(item.gradeLevel || item.grade || item.points || inferWorksheetGradeLevel(questionText), 80)
    const label = normalizeWorksheetLabel(item.label || deriveWorksheetLabelForCandidate(questionText, kind))
    const anchorText = clampText(item.anchorText || questionText, 240)
    const questionType = normalizeWorksheetQuestionType(item.questionType || item.responseType || item.primaryResponseType)
    const responseTypes = normalizeWorksheetResponseTypes(
      item.responseTypes || item.responseTypeList || item.questionTypes || item.responseModel?.responseTypes
    )
    const marksRaw = clampText(item.marksRaw || item.marks || item.pointsLabel || "", 80)
    const marksValue = normalizeWorksheetMarksValue(item.marksValue) ?? normalizeWorksheetMarksValue(item.marks?.value)
    const marksEach = Boolean(item.marksEach || item.marks?.each)
    const options = normalizeWorksheetOptions(item.options)
    const contextWindow = clampText(item.contextWindow || item.context || "", 900)
    if (!questionText) {
      return
    }
    if (!sourceKey) {
      return
    }
    const existingIndex =
      seenIndex.get(sourceKey) ??
      (looseKey ? looseSeenIndex.get(looseKey) : undefined) ??
      (textKey ? textSeenIndex.get(textKey) : undefined)
    if (Number.isFinite(existingIndex)) {
      const existing = merged[existingIndex]
      if (!existing.gradeLevel && gradeLevel) {
        existing.gradeLevel = gradeLevel
      }
      if (existing.kind === "prompt" && kind !== "prompt") {
        existing.kind = kind
      }
      if (!existing.parentSourceKey && parentSourceKey) {
        existing.parentSourceKey = parentSourceKey
      }
      if (!existing.label && label) {
        existing.label = label
      }
      if (!existing.anchorText && anchorText) {
        existing.anchorText = anchorText
      }
      if (existing.questionType === "unknown" && questionType !== "unknown") {
        existing.questionType = questionType
      }
      if (
        responseTypes.length > 0 &&
        responseTypes[0] !== "unknown" &&
        (!Array.isArray(existing.responseTypes) ||
          existing.responseTypes.length === 0 ||
          existing.responseTypes[0] === "unknown")
      ) {
        existing.responseTypes = responseTypes
      }
      if (!existing.marksRaw && marksRaw) {
        existing.marksRaw = marksRaw
      }
      if (!Number.isFinite(normalizeWorksheetMarksValue(existing.marksValue)) && Number.isFinite(marksValue)) {
        existing.marksValue = marksValue
      }
      if (!existing.marksEach && marksEach) {
        existing.marksEach = marksEach
      }
      if ((!Array.isArray(existing.options) || existing.options.length === 0) && options.length > 0) {
        existing.options = options
      }
      if (!existing.contextWindow && contextWindow) {
        existing.contextWindow = contextWindow
      }
      return
    }
    seenIndex.set(sourceKey, merged.length)
    if (looseKey) {
      looseSeenIndex.set(looseKey, merged.length)
    }
    if (textKey) {
      textSeenIndex.set(textKey, merged.length)
    }
    merged.push({
      questionText,
      pageIndex,
      gradeLevel,
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
    })
  }
  for (const question of Array.isArray(primaryQuestions) ? primaryQuestions : []) {
    append(question)
  }
  for (const question of Array.isArray(secondaryQuestions) ? secondaryQuestions : []) {
    append(question)
  }
  return merged.slice(0, WORKSHEET_QUESTION_MAX_ITEMS)
}

function normalizeWorksheetQuestionList(questions, existingQuestions = []) {
  const source = Array.isArray(questions) ? questions : []
  const existing = Array.isArray(existingQuestions) ? existingQuestions : []
  const preserveById = new Map()
  const preserveBySourceKey = new Map()
  for (const item of existing) {
    if (item?.id) {
      preserveById.set(item.id, item)
    }
    if (item?.sourceKey) {
      preserveBySourceKey.set(item.sourceKey, item)
    }
  }
  const dedupe = new Set()
  const looseDedupe = new Set()
  const textDedupe = new Set()
  const normalized = []
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index]
    const questionText = clampText(item?.questionText || item?.question || item?.text || item?.prompt, 360)
    if (!questionText) {
      continue
    }
    const pageIndex = parseOptionalPageIndex(item?.pageIndex) ?? 0
    const gradeLevel = clampText(item?.gradeLevel || item?.grade || item?.points || "", 80)
    const kind = normalizeWorksheetKind(item?.kind)
    const parentSourceKey = normalizeWorksheetParentSourceKey(item?.parentSourceKey || item?.parentKey || item?.parentId)
    const sourceKey = makeWorksheetStableSourceKey({
      sourceKey: item?.sourceKey,
      pageIndex,
      questionText,
      kind,
      parentSourceKey
    })
    const looseKey = `${pageIndex}:${kind}:${normalizeWorksheetSearchText(questionText)}`
    const textKey = `${pageIndex}:${normalizeWorksheetSearchText(questionText)}`
    if (
      !sourceKey ||
      dedupe.has(sourceKey) ||
      (looseKey && looseDedupe.has(looseKey)) ||
      (textKey && textDedupe.has(textKey))
    ) {
      continue
    }
    dedupe.add(sourceKey)
    if (looseKey) {
      looseDedupe.add(looseKey)
    }
    if (textKey) {
      textDedupe.add(textKey)
    }
    const id = sanitizeText(item?.id) || buildWorksheetQuestionId(questionText, pageIndex, kind, sourceKey)
    const preserved = preserveById.get(id) || preserveBySourceKey.get(sourceKey)
    const preservedResponseTypes = normalizeWorksheetResponseTypes(preserved?.responseTypes)
    const incomingResponseTypes = normalizeWorksheetResponseTypes(item?.responseTypes)
    const responseTypes =
      incomingResponseTypes.length > 0 && incomingResponseTypes[0] !== "unknown"
        ? incomingResponseTypes
        : preservedResponseTypes
    const questionTypeIncoming = normalizeWorksheetQuestionType(
      item?.questionType || item?.responseType || item?.primaryResponseType
    )
    const questionTypePreserved = normalizeWorksheetQuestionType(preserved?.questionType)
    const questionType =
      questionTypeIncoming !== "unknown"
        ? questionTypeIncoming
        : responseTypes[0] && responseTypes[0] !== "unknown"
          ? responseTypes[0]
          : questionTypePreserved
    const marksValueIncoming =
      normalizeWorksheetMarksValue(item?.marksValue) ?? normalizeWorksheetMarksValue(item?.marks?.value)
    const marksValuePreserved = normalizeWorksheetMarksValue(preserved?.marksValue)
    normalized.push({
      id,
      questionText,
      pageIndex,
      gradeLevel,
      kind,
      sourceKey,
      parentSourceKey,
      parentId: "",
      childIds: [],
      hasChildren: false,
      batchChildrenOnClick: false,
      label: normalizeWorksheetLabel(item?.label || deriveWorksheetLabelForCandidate(questionText, kind)),
      anchorText: clampText(item?.anchorText || questionText, 240),
      questionType: questionType || "unknown",
      responseTypes: responseTypes || ["unknown"],
      marksRaw: clampText(item?.marksRaw || item?.marks || preserved?.marksRaw, 80),
      marksValue: Number.isFinite(marksValueIncoming) ? marksValueIncoming : marksValuePreserved,
      marksEach: Boolean(item?.marksEach || item?.marks?.each || preserved?.marksEach),
      options: normalizeWorksheetOptions(item?.options || preserved?.options),
      contextWindow: clampText(item?.contextWindow || item?.context || preserved?.contextWindow, 900),
      sortIndex: Number.isFinite(Number(item?.sortIndex)) ? Math.max(0, Math.floor(Number(item.sortIndex))) : index,
      answerText: normalizeWorksheetAnswerText(preserved?.answerText, 1200),
      answerLength:
        preserved?.answerLength === "short" || preserved?.answerLength === "long"
          ? preserved.answerLength
          : "",
      answerLoading: false,
      overlayVisible: Boolean(preserved?.overlayVisible),
      provider: sanitizeText(preserved?.provider),
      warnings: Array.isArray(preserved?.warnings) ? preserved.warnings.map((warning) => clampText(warning, 180)) : [],
      answeredAt: Number.isFinite(preserved?.answeredAt) ? Number(preserved.answeredAt) : 0
    })
    if (normalized.length >= WORKSHEET_QUESTION_MAX_ITEMS) {
      break
    }
  }
  const bySourceKey = new Map()
  const byId = new Map()
  for (const item of normalized) {
    if (item.sourceKey) {
      bySourceKey.set(item.sourceKey, item)
    }
    if (item.id) {
      byId.set(item.id, item)
    }
  }
  for (const item of normalized) {
    const parentSourceKey = sanitizeText(item.parentSourceKey)
    if (!parentSourceKey) {
      continue
    }
    const parent =
      bySourceKey.get(parentSourceKey) ||
      byId.get(parentSourceKey) ||
      normalized.find(
        (candidate) =>
          candidate !== item &&
          candidate.pageIndex === item.pageIndex &&
          normalizeWorksheetSearchText(candidate.label) === normalizeWorksheetSearchText(parentSourceKey)
      )
    if (!parent?.id || parent.id === item.id) {
      continue
    }
    item.parentId = parent.id
    if (!Array.isArray(parent.childIds)) {
      parent.childIds = []
    }
    if (!parent.childIds.includes(item.id)) {
      parent.childIds.push(item.id)
    }
  }
  for (const item of normalized) {
    item.hasChildren = Array.isArray(item.childIds) && item.childIds.length > 0
    item.batchChildrenOnClick = item.hasChildren
  }
  return normalized
}

async function collectWorksheetDetectionPages(pdfDoc) {
  if (!pdfDoc || typeof pdfDoc.numPages !== "number") {
    return []
  }
  const pages = []
  const maxPages = Math.min(Math.max(1, WORKSHEET_DETECTION_MAX_PAGES), Math.max(1, pdfDoc.numPages))
  let totalChars = 0
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const rawText = await getPageText(pdfDoc, pageIndex)
    const structuredText = structureWorksheetDetectionText(rawText)
    if (!structuredText) {
      continue
    }
    const remainingChars = WORKSHEET_DETECTION_MAX_TOTAL_CHARS - totalChars
    if (remainingChars <= 0) {
      break
    }
    const maxChars = Math.min(WORKSHEET_PAGE_SNIPPET_MAX_CHARS, remainingChars)
    const text = truncateWorksheetText(structuredText, maxChars)
    if (!text || text.length < 12) {
      continue
    }
    pages.push({
      pageIndex,
      text
    })
    totalChars += text.length
    if (totalChars >= WORKSHEET_DETECTION_MAX_TOTAL_CHARS) {
      break
    }
  }
  return pages
}

function isWorksheetDetectionCurrent(loadToken, runToken, docId) {
  const activeDocId = deriveDocId(currentPdf)
  return (
    loadToken === renderState.loadToken &&
    runToken === worksheetRunToken &&
    activeDocId === docId &&
    Boolean(currentPdf) &&
    Boolean(renderState.pdfDoc)
  )
}

async function ensureWorksheetQuestionsForCurrentDocument(options = {}) {
  if (!currentPdf || !renderState.pdfDoc) {
    return []
  }
  const force = Boolean(options?.force)
  const worksheetState = getWorksheetState()
  const docId = deriveDocId(currentPdf)
  if (!force && worksheetState.docId === docId && worksheetState.status === "ready") {
    return worksheetState.questions
  }
  if (!force && worksheetState.docId === docId && worksheetState.detectionPromise) {
    return worksheetState.detectionPromise
  }

  const preservedQuestions =
    worksheetState.docId === docId && Array.isArray(worksheetState.questions) ? worksheetState.questions : []
  const loadToken = renderState.loadToken
  const runToken = ++worksheetRunToken
  worksheetState.docId = docId
  worksheetState.status = "loading"
  worksheetState.errorMessage = ""
  worksheetState.detectionWarnings = []
  worksheetState.parserModel = null
  worksheetState.parserXml = ""
  if (force) {
    worksheetState.questions = []
  }
  if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
    renderPanel()
  }
  renderPdfWorksheetOverlays()

  const detectionPromise = (async () => {
    try {
      const worksheetPages = await collectWorksheetDetectionPages(renderState.pdfDoc)
      if (!isWorksheetDetectionCurrent(loadToken, runToken, docId)) {
        return worksheetState.questions
      }
      if (worksheetPages.length === 0) {
        worksheetState.status = "ready"
        worksheetState.questions = []
        worksheetState.errorMessage = ""
        worksheetState.detectionWarnings = []
        worksheetState.parserModel = null
        worksheetState.parserXml = ""
        return []
      }

      let parserQuestions = []
      let parserWarnings = []
      try {
        const parsedModel = parseWorksheetPagesToModel(worksheetPages, {
          title: getCurrentPdfTitleLabel(),
          maxItems: WORKSHEET_QUESTION_MAX_ITEMS
        })
        parserQuestions = flattenWorksheetModelToQuestions(parsedModel, {
          maxItems: WORKSHEET_QUESTION_MAX_ITEMS
        })
        worksheetState.parserModel = parsedModel
        worksheetState.parserXml = serializeWorksheetModelAsXml(parsedModel)
      } catch (error) {
        const reason = clampText(error?.message || "Unknown parser error", 120)
        parserWarnings.push(`Worksheet parser failed; fallback heuristics/LLM used. (${reason})`)
        worksheetState.parserModel = null
        worksheetState.parserXml = ""
        logger.warn("Worksheet parser fallback used", {
          docId,
          message: reason
        })
      }
      if (parserQuestions.length === 0 && parserWarnings.length === 0) {
        parserWarnings.push("Worksheet parser did not find tagged questions; fallback heuristics/LLM used.")
      }
      const heuristicQuestions =
        parserQuestions.length > 0 ? parserQuestions : extractWorksheetQuestionsFromPages(worksheetPages)
      let llmQuestions = []
      let llmWarnings = [...parserWarnings]

      try {
        const { response, warnings } = await generateLLM("worksheet_questions", {
          title: getCurrentPdfTitleLabel(),
          worksheetPages,
          readingMode: getReadingModeOrDefault()
        })
        llmQuestions = Array.isArray(response?.questions) ? response.questions : []
        const normalizedWarnings = Array.isArray(warnings)
          ? warnings.map((warning) => clampText(warning, 180)).filter(Boolean)
          : []
        llmWarnings = [...llmWarnings, ...normalizedWarnings]
      } catch (error) {
        const reason = clampText(error?.message || "Unknown LLM error", 120)
        llmWarnings = [...llmWarnings, `Worksheet question LLM failed; used deterministic detection. (${reason})`]
        logger.warn("Worksheet question extraction fallback used", {
          docId,
          message: reason
        })
      }

      if (!isWorksheetDetectionCurrent(loadToken, runToken, docId)) {
        return worksheetState.questions
      }

      const mergedQuestions = mergeWorksheetQuestionCandidates(heuristicQuestions, llmQuestions)
      worksheetState.questions = normalizeWorksheetQuestionList(mergedQuestions, preservedQuestions)
      worksheetState.status = "ready"
      worksheetState.errorMessage = ""
      worksheetState.detectionWarnings = llmWarnings
      return worksheetState.questions
    } catch (error) {
      if (!isWorksheetDetectionCurrent(loadToken, runToken, docId)) {
        return worksheetState.questions
      }
      worksheetState.status = "error"
      worksheetState.errorMessage = clampText(error?.message || "Failed to detect worksheet questions.", 220)
      worksheetState.detectionWarnings = []
      return worksheetState.questions
    } finally {
      if (worksheetState.detectionPromise === detectionPromise) {
        worksheetState.detectionPromise = null
      }
      if (isWorksheetDetectionCurrent(loadToken, runToken, docId)) {
        if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
          renderPanel()
        }
        renderPdfWorksheetOverlays()
      }
    }
  })()

  worksheetState.detectionPromise = detectionPromise
  return detectionPromise
}

function clearPdfWorksheetOverlays() {
  for (const pageNode of renderState.pageNodes) {
    if (!(pageNode instanceof HTMLElement)) {
      continue
    }
    const overlays = pageNode.querySelectorAll(".pdfWorksheetOverlay")
    for (const overlay of overlays) {
      overlay.remove()
    }
    const bubbles = pageNode.querySelectorAll(".pdfWorksheetBubble")
    for (const bubble of bubbles) {
      bubble.remove()
    }
    const answerCards = pageNode.querySelectorAll(".pdfWorksheetAnswerCard")
    for (const answerCard of answerCards) {
      answerCard.remove()
    }
    const inlineAnswers = pageNode.querySelectorAll(
      ".pdfWorksheetInlineAnswer, .pdfWorksheetInlineFillAnswer, .pdfWorksheetTableValue, .pdfWorksheetTableNote"
    )
    for (const inlineAnswer of inlineAnswers) {
      inlineAnswer.remove()
    }
    const highlightedOptions = pageNode.querySelectorAll(".clarify-worksheet-option-correct")
    for (const highlightedOption of highlightedOptions) {
      highlightedOption.classList.remove("clarify-worksheet-option-correct")
    }
  }
}

function findWorksheetQuestionAnchorInPage(pageNode, questionText) {
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

  const normalizedQuestion = normalizeWorksheetSearchText(questionText)
  if (!normalizedQuestion) {
    return null
  }
  const tokens = normalizedQuestion
    .split(" ")
    .filter((token) => token.length >= 3 && !RETRIEVAL_STOP_WORDS.has(token))
    .slice(0, 10)
  if (tokens.length === 0) {
    return null
  }
  const surfaceRect = pageSurface.getBoundingClientRect()
  let bestSpan = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (const span of spans) {
    const spanText = normalizeWorksheetSearchText(span.textContent || "")
    if (!spanText) {
      continue
    }

    let tokenMatches = 0
    for (const token of tokens) {
      if (spanText.includes(token)) {
        tokenMatches += 1
      }
    }
    if (tokenMatches === 0) {
      continue
    }

    const spanRect = span.getBoundingClientRect()
    const topRatio = surfaceRect.height > 0 ? (spanRect.top - surfaceRect.top) / surfaceRect.height : 0
    const overlapBonus =
      normalizedQuestion.includes(spanText) || spanText.includes(tokens[0]) ? 2 : 0
    const score = tokenMatches * 6 + overlapBonus - Math.abs(Math.max(0, topRatio)) * 0.6
    if (score > bestScore) {
      bestScore = score
      bestSpan = span
    }
  }

  if (!(bestSpan instanceof HTMLElement)) {
    const fallback = findSectionAnchorInPage(pageNode, questionText)
    if (!fallback) {
      return null
    }
    return {
      ...fallback,
      textLayer,
      anchorSpan: fallback.anchorSpan instanceof HTMLElement ? fallback.anchorSpan : null,
      surfaceRect: fallback.surfaceRect instanceof DOMRect ? fallback.surfaceRect : pageSurface.getBoundingClientRect()
    }
  }

  const spanRect = bestSpan.getBoundingClientRect()
  return {
    pageSurface,
    textLayer,
    left: Math.round(Math.max(4, spanRect.left - surfaceRect.left - 20)),
    top: Math.round(Math.max(4, spanRect.top - surfaceRect.top)),
    anchorSpan: bestSpan,
    surfaceRect
  }
}

function shouldShowWorksheetAnswerCardOnPage(question) {
  if (!question || question.hasChildren) {
    return false
  }
  if (question.answerLoading) {
    return false
  }
  if (!question.overlayVisible) {
    return false
  }
  return Boolean(normalizeWorksheetAnswerText(question.answerText, 1200))
}

function createWorksheetPdfAnswerCardNode(question, options = {}) {
  const compact = Boolean(options?.compact)
  const card = document.createElement("div")
  card.className = "pdfWorksheetAnswerCard"
  if (compact) {
    card.classList.add("isCompact")
  }
  if (question.answerLoading) {
    const loadingText = document.createElement("p")
    loadingText.className = "worksheetAnswerLine"
    loadingText.textContent = "Generating answer..."
    card.append(loadingText)
    return card
  }
  card.append(createWorksheetAnswerRichNode(question, { surface: "pdf", compact }))
  return card
}

function measureWorksheetPdfAnswerCardHeight(pageSurface, question, width, compact = false) {
  if (!(pageSurface instanceof HTMLElement)) {
    return 0
  }
  const measureNode = createWorksheetPdfAnswerCardNode(question, { compact })
  measureNode.style.left = "-10000px"
  measureNode.style.top = "0"
  measureNode.style.width = `${Math.max(160, Math.floor(Number(width) || 160))}px`
  measureNode.style.visibility = "hidden"
  pageSurface.append(measureNode)
  const measured = Math.ceil(measureNode.getBoundingClientRect().height || 0)
  measureNode.remove()
  return Math.max(0, measured)
}

function highlightWorksheetCorrectOptionOnPage(pageNode, question) {
  if (!(pageNode instanceof HTMLElement) || !question) {
    return 0
  }
  const selectedOptions = detectWorksheetSelectedOptions(question, question.answerText)
  if (selectedOptions.length === 0) {
    return 0
  }
  const textLayer = pageNode.querySelector(".textLayer")
  if (!(textLayer instanceof HTMLElement)) {
    return 0
  }
  const spans = Array.from(textLayer.querySelectorAll("span")).filter((span) => span instanceof HTMLElement)
  if (spans.length === 0) {
    return 0
  }

  const usedSpans = new Set()
  let highlightedCount = 0
  for (const target of selectedOptions) {
    const targetSearch = normalizeWorksheetSearchText(target.text)
    const targetTokens = targetSearch.split(" ").filter((token) => token.length >= 3).slice(0, 8)
    let bestSpan = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const span of spans) {
      if (usedSpans.has(span)) {
        continue
      }
      const spanText = normalizeWorksheetSearchText(span.textContent || "")
      if (!spanText) {
        continue
      }
      let score = 0
      if (target.key) {
        const keyPattern = new RegExp(`(?:^|\\b)${escapeRegExp(target.key)}(?:\\)|\\.|\\b)`, "i")
        if (keyPattern.test(span.textContent || "")) {
          score += 4
        }
      }
      if (targetSearch && spanText.includes(targetSearch)) {
        score += 6
      }
      for (const token of targetTokens) {
        if (spanText.includes(token)) {
          score += 1
        }
      }
      if (score > bestScore) {
        bestScore = score
        bestSpan = span
      }
    }
    if (bestSpan instanceof HTMLElement && bestScore > 0) {
      bestSpan.classList.add("clarify-worksheet-option-correct")
      usedSpans.add(bestSpan)
      highlightedCount += 1
    }
  }
  return highlightedCount
}

function getWorksheetPageTextContext(pageNode) {
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
  return {
    pageSurface,
    textLayer,
    spans,
    surfaceRect: pageSurface.getBoundingClientRect()
  }
}

function getWorksheetRelativeRect(target, surfaceRect) {
  if (!(target instanceof HTMLElement) || !(surfaceRect instanceof DOMRect)) {
    return null
  }
  const rect = target.getBoundingClientRect()
  return {
    left: rect.left - surfaceRect.left,
    right: rect.right - surfaceRect.left,
    top: rect.top - surfaceRect.top,
    bottom: rect.bottom - surfaceRect.top,
    width: rect.width,
    height: rect.height
  }
}

function getWorksheetInlineAnswerDisplayText(question, options = {}) {
  const maxLength = Number.isFinite(Number(options?.maxLength)) ? Math.max(24, Math.floor(Number(options.maxLength))) : 220
  const firstLineOnly = Boolean(options?.firstLineOnly)
  const verdictOnly = Boolean(options?.verdictOnly)
  const rawAnswer = options?.answerText != null ? options.answerText : question?.answerText
  const plain = stripWorksheetAnswerFormatting(rawAnswer)
  if (!plain) {
    return ""
  }
  const responseTypes = normalizeWorksheetResponseTypes(question?.responseTypes)
  if (responseTypes.includes("mcq") || responseTypes.includes("multi_select")) {
    const selectedOptions = detectWorksheetSelectedOptions(question, plain)
    if (selectedOptions.length > 0) {
      return clampText(
        selectedOptions.map((entry) => (entry.key ? `${entry.key}) ${entry.text}` : entry.text)).join(", "),
        maxLength
      )
    }
  }
  if (responseTypes.includes("true_false")) {
    const trueFalse = parseWorksheetTrueFalseAnswer(plain)
    if (verdictOnly && trueFalse.verdict) {
      return trueFalse.verdict
    }
    if (trueFalse.verdict && trueFalse.explanation) {
      return clampText(`${trueFalse.verdict}. ${trueFalse.explanation}`, maxLength)
    }
    if (trueFalse.verdict) {
      return trueFalse.verdict
    }
  }
  let text = plain.replace(/^\*{0,2}\s*answer\s*[:\-]\s*/i, "").trim()
  if (firstLineOnly) {
    const firstLine = text.split(/\n+/).map((line) => line.trim()).find(Boolean)
    if (firstLine) {
      text = firstLine
    }
  }
  return clampText(text, maxLength)
}

function createWorksheetInlineAnswerNode(question, options = {}) {
  const node = document.createElement("div")
  node.className = "pdfWorksheetInlineAnswer"
  if (options?.termLike) {
    node.classList.add("isTerm")
  }
  if (options?.compact) {
    node.classList.add("isCompact")
  }
  const answerOverride = normalizeWorksheetAnswerText(options?.answerText, 900)
  if (answerOverride) {
    const line = document.createElement("p")
    line.className = "worksheetAnswerLine"
    if (options?.termLike) {
      line.classList.add("isTerm")
    }
    appendWorksheetInlineMarkdown(line, answerOverride)
    node.append(line)
    return node
  }
  node.append(createWorksheetAnswerRichNode(question, { surface: "pdf", compact: true }))
  return node
}

function measureWorksheetInlineAnswerHeight(pageSurface, question, width, options = {}) {
  if (!(pageSurface instanceof HTMLElement)) {
    return 0
  }
  const measureNode = createWorksheetInlineAnswerNode(question, options)
  measureNode.style.left = "-10000px"
  measureNode.style.top = "0"
  measureNode.style.width = `${Math.max(160, Math.floor(Number(width) || 160))}px`
  measureNode.style.visibility = "hidden"
  pageSurface.append(measureNode)
  const measured = Math.ceil(measureNode.getBoundingClientRect().height || 0)
  measureNode.remove()
  return Math.max(0, measured)
}

function tryPlaceWorksheetTermAnswerOnPage(entry, pageContext) {
  const question = entry?.question
  const anchor = entry?.anchor
  if (!question || !anchor || !pageContext) {
    return false
  }
  const anchorSpan = anchor.anchorSpan instanceof HTMLElement ? anchor.anchorSpan : null
  if (!anchorSpan) {
    return false
  }
  const relative = getWorksheetRelativeRect(anchorSpan, pageContext.surfaceRect)
  if (!relative) {
    return false
  }
  let termAnswer = getWorksheetInlineAnswerDisplayText(question, { maxLength: 320 })
  if (!termAnswer) {
    return false
  }
  const termLabel = sanitizeText(question.anchorText || question.label)
  if (termLabel) {
    const labelPattern = new RegExp(`^${escapeRegExp(termLabel)}\\s*[:\\-]\\s*`, "i")
    termAnswer = termAnswer.replace(labelPattern, "").trim() || termAnswer
  }
  const pageWidth = Math.max(1, pageContext.pageSurface.clientWidth)
  let left = Math.round(relative.right + 14)
  if (left > pageWidth - 120) {
    left = Math.round(Math.min(pageWidth - 120, relative.left + Math.max(120, relative.width + 24)))
  }
  left = Math.max(6, left)
  const width = Math.max(92, Math.min(460, pageWidth - left - 8))
  if (width < 92) {
    return false
  }
  const top = Math.max(4, Math.round(relative.top - 2))
  const node = createWorksheetInlineAnswerNode(question, {
    answerText: termAnswer,
    termLike: true,
    compact: true
  })
  node.style.left = `${left}px`
  node.style.top = `${top}px`
  node.style.width = `${Math.floor(width)}px`
  pageContext.pageSurface.append(node)
  return true
}

function tryPlaceWorksheetFillBlankAnswerOnPage(entry, pageContext) {
  const question = entry?.question
  const anchor = entry?.anchor
  if (!question || !anchor || !pageContext) {
    return false
  }
  const fillAnswer = getWorksheetInlineAnswerDisplayText(question, {
    maxLength: 140,
    firstLineOnly: true
  })
  if (!fillAnswer) {
    return false
  }
  const anchorTop = Number(anchor.top) || 0
  let bestRect = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const span of pageContext.spans) {
    const rawText = span.textContent || ""
    if (!/_{2,}|\.{3,}|-{3,}/.test(rawText)) {
      continue
    }
    const rect = getWorksheetRelativeRect(span, pageContext.surfaceRect)
    if (!rect) {
      continue
    }
    const distance = Math.abs(rect.top - anchorTop)
    if (distance > 240) {
      continue
    }
    let score = 30 - Math.min(distance, 200) * 0.12
    score += Math.min(120, Math.max(0, rect.width)) * 0.05
    if (rect.top >= anchorTop - 10) {
      score += 4
    }
    if (score > bestScore) {
      bestScore = score
      bestRect = rect
    }
  }
  if (!bestRect || bestScore <= 0) {
    return false
  }
  const node = document.createElement("div")
  node.className = "pdfWorksheetInlineFillAnswer"
  node.textContent = fillAnswer
  node.style.left = `${Math.round(bestRect.left + 2)}px`
  node.style.top = `${Math.max(2, Math.round(bestRect.top - 2))}px`
  node.style.maxWidth = `${Math.max(96, Math.round(bestRect.width - 4))}px`
  pageContext.pageSurface.append(node)
  return true
}

function parseWorksheetAddressToken(value) {
  const source = sanitizeText(value).toLowerCase().replace(/,/g, "")
  if (!source) {
    return { text: "", bytes: null }
  }
  const tokenMatch = source.match(/-?\d+(?:\.\d+)?\s*(?:kb|mb|gb|b|bytes?)?/)
  const token = sanitizeText(tokenMatch?.[0] || source)
  const numberMatch = token.match(/-?\d+(?:\.\d+)?/)
  const numeric = Number(numberMatch?.[0])
  const unit = token.match(/\b(kb|mb|gb|b|bytes?)\b/)?.[1] || ""
  let bytes = null
  if (Number.isFinite(numeric)) {
    let multiplier = 1
    if (unit === "kb") {
      multiplier = 1024
    } else if (unit === "mb") {
      multiplier = 1024 * 1024
    } else if (unit === "gb") {
      multiplier = 1024 * 1024 * 1024
    }
    bytes = Math.round(numeric * multiplier)
  }
  return {
    text: normalizeWorksheetSearchText(token || source),
    bytes
  }
}

function normalizeWorksheetPhysicalAddressAnswer(value) {
  const source = sanitizeText(value)
  if (!source) {
    return ""
  }
  const trimmed = source.replace(/^physical(?:\s+address)?\s*(?:=|:|-)?\s*/i, "").trim()
  if (!trimmed) {
    return ""
  }
  if (/\bfault\b/i.test(trimmed)) {
    return "Fault"
  }
  const addressMatches = trimmed.match(/-?\d+(?:\.\d+)?\s*(?:kb|mb|gb|b|bytes?)/gi)
  if (Array.isArray(addressMatches) && addressMatches.length > 0) {
    return sanitizeText(addressMatches[addressMatches.length - 1])
  }
  return clampText(trimmed, 120)
}

function parseWorksheetTableEntriesFromAnswer(answerText) {
  const source = normalizeWorksheetAnswerText(answerText, 1200)
  if (!source) {
    return []
  }
  const prepared = source
    .replace(/\bvirtual\s+address\b/gi, "\nVirtual address")
    .replace(/;\s*/g, "\n")
  const lines = prepared
    .split(/\n+/)
    .map((line) => sanitizeText(line.replace(/^[-*]\s*/, "").replace(/^\d+\)\s*/, "")))
    .filter(Boolean)
  const entries = []
  const dedupe = new Set()
  for (const line of lines) {
    let virtualText = ""
    const explicitVirtual = line.match(/virtual\s+address\s*(?:=|:|-)?\s*([0-9]+(?:\.\d+)?\s*(?:kb|mb|gb|b|bytes?)?)/i)
    if (explicitVirtual?.[1]) {
      virtualText = sanitizeText(explicitVirtual[1])
    } else {
      const leadingToken = line.match(/^([0-9]+(?:\.\d+)?\s*(?:kb|mb|gb|b|bytes?)?)/i)
      if (leadingToken?.[1]) {
        virtualText = sanitizeText(leadingToken[1])
      }
    }
    if (!virtualText) {
      continue
    }
    const virtualToken = parseWorksheetAddressToken(virtualText)
    const rowKey = virtualToken.bytes != null ? `b:${virtualToken.bytes}` : `t:${virtualToken.text}`
    if (!rowKey || dedupe.has(rowKey)) {
      continue
    }
    dedupe.add(rowKey)

    let physicalText = ""
    let noteText = ""
    const faultTail = line.match(/\bfault\b([^.;]*)/i)
    if (faultTail) {
      physicalText = "Fault"
      const reason = sanitizeText(faultTail[1] || "")
      if (reason) {
        noteText = clampText(`Fault: ${reason}`, 140)
      } else {
        noteText = "Fault"
      }
    } else {
      const physicalMatch =
        line.match(/physical(?:\s+address)?\s*(?:=|:|-)?\s*([^,;]+)/i) ||
        line.match(/(?:=|->)\s*([^,;]+)/)
      if (physicalMatch?.[1]) {
        physicalText = normalizeWorksheetPhysicalAddressAnswer(physicalMatch[1])
      }
      const noteMatch = line.match(/\(([^)]+)\)/)
      if (noteMatch?.[1]) {
        noteText = clampText(sanitizeText(noteMatch[1]), 120)
      }
      if (!physicalText && !noteText) {
        const residue = sanitizeText(line.replace(/virtual\s+address[^:]*:?/i, ""))
        if (residue) {
          physicalText = normalizeWorksheetPhysicalAddressAnswer(residue)
        }
      }
    }
    if (!physicalText && !noteText) {
      continue
    }
    entries.push({
      virtualText,
      virtualBytes: virtualToken.bytes,
      physicalText: clampText(physicalText, 120),
      noteText: clampText(noteText, 140)
    })
  }
  return entries
}

function findWorksheetTableColumnStarts(pageContext, anchorTop) {
  if (!pageContext) {
    return {
      definitionStart: null,
      physicalStart: null,
      notesStart: null
    }
  }
  const best = {
    definitionStart: null,
    definitionScore: Number.NEGATIVE_INFINITY,
    physicalStart: null,
    physicalScore: Number.NEGATIVE_INFINITY,
    notesStart: null,
    notesScore: Number.NEGATIVE_INFINITY
  }
  for (const span of pageContext.spans) {
    const text = normalizeWorksheetSearchText(span.textContent || "")
    if (!text) {
      continue
    }
    const rect = getWorksheetRelativeRect(span, pageContext.surfaceRect)
    if (!rect) {
      continue
    }
    if (rect.top < anchorTop - 100 || rect.top > anchorTop + 360) {
      continue
    }
    const topDistance = Math.abs(rect.top - anchorTop)
    if (text.includes("definition")) {
      const score = 34 - Math.min(topDistance, 200) * 0.15
      if (score > best.definitionScore) {
        best.definitionScore = score
        best.definitionStart = Math.round(rect.left)
      }
    }
    if (text.includes("physical address")) {
      const score = 40 - Math.min(topDistance, 200) * 0.15
      if (score > best.physicalScore) {
        best.physicalScore = score
        best.physicalStart = Math.round(rect.left)
      }
    }
    if (text === "notes" || text.includes("notes ")) {
      const score = 38 - Math.min(topDistance, 200) * 0.15
      if (score > best.notesScore) {
        best.notesScore = score
        best.notesStart = Math.round(rect.left)
      }
    }
  }
  return {
    definitionStart: best.definitionStart,
    physicalStart: best.physicalStart,
    notesStart: best.notesStart
  }
}

function findWorksheetBestTableRowSpan(pageContext, rowEntry, anchorTop, usedSpans) {
  if (!pageContext || !rowEntry) {
    return null
  }
  const targetSearch = normalizeWorksheetSearchText(rowEntry.virtualText)
  let bestSpan = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const span of pageContext.spans) {
    if (usedSpans.has(span)) {
      continue
    }
    const spanTextRaw = sanitizeText(span.textContent || "")
    if (!spanTextRaw || spanTextRaw.length > 24) {
      continue
    }
    const rect = getWorksheetRelativeRect(span, pageContext.surfaceRect)
    if (!rect) {
      continue
    }
    if (rect.top < anchorTop + 16 || rect.top > anchorTop + 920) {
      continue
    }
    const spanSearch = normalizeWorksheetSearchText(spanTextRaw)
    const spanToken = parseWorksheetAddressToken(spanTextRaw)
    let score = 0
    if (rowEntry.virtualBytes != null && spanToken.bytes != null && rowEntry.virtualBytes === spanToken.bytes) {
      score += 14
    }
    if (targetSearch && spanSearch === targetSearch) {
      score += 10
    } else if (targetSearch && spanSearch && targetSearch.includes(spanSearch)) {
      score += 6
    }
    if (rect.left <= pageContext.pageSurface.clientWidth * 0.58) {
      score += 4
    }
    if (score > bestScore) {
      bestScore = score
      bestSpan = span
    }
  }
  if (!(bestSpan instanceof HTMLElement) || bestScore <= 0) {
    return null
  }
  return bestSpan
}

function isWorksheetTablePlacementCandidate(question) {
  const source = normalizeWorksheetSearchText(
    `${question?.questionText || ""} ${question?.anchorText || ""} ${question?.contextWindow || ""}`
  )
  if (!source) {
    return false
  }
  if (source.includes("virtual address") && (source.includes("physical address") || source.includes("translate"))) {
    return true
  }
  return source.includes("table") && source.includes("notes")
}

function tryPlaceWorksheetTableAnswersOnPage(entry, pageContext) {
  const question = entry?.question
  if (!question || !pageContext) {
    return false
  }
  const rowEntries = parseWorksheetTableEntriesFromAnswer(question.answerText)
  if (rowEntries.length === 0) {
    return false
  }
  const anchorTop = Number(entry?.anchor?.top) || 0
  const columns = findWorksheetTableColumnStarts(pageContext, anchorTop)
  const pageWidth = Math.max(1, pageContext.pageSurface.clientWidth)
  const usedSpans = new Set()
  let placed = 0
  for (const rowEntry of rowEntries) {
    const rowSpan = findWorksheetBestTableRowSpan(pageContext, rowEntry, anchorTop, usedSpans)
    if (!(rowSpan instanceof HTMLElement)) {
      continue
    }
    usedSpans.add(rowSpan)
    const rowRect = getWorksheetRelativeRect(rowSpan, pageContext.surfaceRect)
    if (!rowRect) {
      continue
    }
    const physicalLeft = Number.isFinite(columns.physicalStart)
      ? Number(columns.physicalStart)
      : Number.isFinite(columns.definitionStart)
        ? Number(columns.definitionStart)
        : Math.min(Math.max(rowRect.right + 88, pageWidth * 0.42), pageWidth - 136)
    const notesLeft = Number.isFinite(columns.notesStart)
      ? Number(columns.notesStart)
      : Math.min(Math.max(physicalLeft + Math.max(100, pageWidth * 0.16), physicalLeft + 100), pageWidth - 104)
    const rowTop = Math.max(4, Math.round(rowRect.top - 1))
    if (rowEntry.physicalText) {
      const valueNode = document.createElement("div")
      valueNode.className = "pdfWorksheetTableValue"
      valueNode.textContent = rowEntry.physicalText
      valueNode.style.left = `${Math.round(physicalLeft)}px`
      valueNode.style.top = `${rowTop}px`
      valueNode.style.maxWidth = `${Math.max(90, Math.floor(pageWidth - physicalLeft - 10))}px`
      pageContext.pageSurface.append(valueNode)
      placed += 1
    }
    if (rowEntry.noteText) {
      const noteNode = document.createElement("div")
      noteNode.className = "pdfWorksheetTableNote"
      noteNode.textContent = rowEntry.noteText
      noteNode.style.left = `${Math.round(notesLeft)}px`
      noteNode.style.top = `${rowTop}px`
      noteNode.style.maxWidth = `${Math.max(82, Math.floor(pageWidth - notesLeft - 10))}px`
      pageContext.pageSurface.append(noteNode)
      placed += 1
    }
  }
  return placed > 0
}

function tryPlaceWorksheetInlineAnswerOnPage(entry, availableBelow) {
  const question = entry?.question
  const anchor = entry?.anchor
  if (!question || !anchor) {
    return false
  }
  const pageSurface = anchor.pageSurface
  if (!(pageSurface instanceof HTMLElement)) {
    return false
  }
  const pageWidth = Math.max(1, pageSurface.clientWidth)
  const left = Math.min(anchor.left + 24, Math.max(pageWidth - 420, 8))
  const width = Math.min(420, Math.max(160, pageWidth - left - 10))
  const top = Math.max(anchor.top + 16, 4)
  const maxHeight = Number.isFinite(Number(availableBelow))
    ? Math.max(0, Math.floor(Number(availableBelow)) - 4)
    : Math.max(0, Math.floor(pageSurface.clientHeight - top - 8))
  if (maxHeight < 34) {
    return false
  }
  const measured = measureWorksheetInlineAnswerHeight(pageSurface, question, width, {
    compact: !isWorksheetAnswerShort(question)
  })
  if (!Number.isFinite(measured) || measured <= 0 || measured > maxHeight) {
    return false
  }
  const node = createWorksheetInlineAnswerNode(question, {
    compact: !isWorksheetAnswerShort(question)
  })
  node.style.left = `${Math.round(left)}px`
  node.style.top = `${Math.round(top)}px`
  node.style.width = `${Math.floor(width)}px`
  node.style.maxHeight = `${Math.floor(maxHeight)}px`
  pageSurface.append(node)
  return true
}

function tryPlaceWorksheetAnswerOnPage(entry, pageContext, availableBelow) {
  const question = entry?.question
  if (!question || question.hasChildren || question.answerLoading) {
    return false
  }
  const answerText = normalizeWorksheetAnswerText(question.answerText, 1200)
  if (!answerText) {
    return false
  }
  const responseTypes = normalizeWorksheetResponseTypes(question.responseTypes)
  if (responseTypes.includes("mcq") || responseTypes.includes("multi_select")) {
    if (highlightWorksheetCorrectOptionOnPage(entry.pageNode, question) > 0) {
      return true
    }
  }
  const isTermLike =
    normalizeWorksheetKind(question.kind) === "term" ||
    normalizeWorksheetQuestionType(question.questionType) === "table_definition"
  if (isTermLike && tryPlaceWorksheetTermAnswerOnPage(entry, pageContext)) {
    return true
  }
  const fillBlankHint =
    responseTypes.includes("fill_blank") ||
    /_{3,}/.test(sanitizeText(question.questionText)) ||
    /\bfill in the blank\b/i.test(sanitizeText(question.questionText))
  if (fillBlankHint && tryPlaceWorksheetFillBlankAnswerOnPage(entry, pageContext)) {
    return true
  }
  if (isWorksheetTablePlacementCandidate(question) && tryPlaceWorksheetTableAnswersOnPage(entry, pageContext)) {
    return true
  }
  return tryPlaceWorksheetInlineAnswerOnPage(entry, availableBelow)
}

function renderPdfWorksheetOverlays() {
  clearPdfWorksheetOverlays()
  if (!modeUiState.aiEnabled || !isWorksheetMode()) {
    return
  }
  const worksheetState = getWorksheetState()
  const questions = Array.isArray(worksheetState.questions) ? worksheetState.questions : []
  if (questions.length === 0) {
    return
  }
  const byIdMap = getWorksheetQuestionsByIdMap()
  const orderedQuestions = [...questions].sort((a, b) => {
    const pageDiff = (parseOptionalPageIndex(a?.pageIndex) ?? 0) - (parseOptionalPageIndex(b?.pageIndex) ?? 0)
    if (pageDiff !== 0) {
      return pageDiff
    }
    const depthDiff = getWorksheetQuestionDepth(a, byIdMap) - getWorksheetQuestionDepth(b, byIdMap)
    if (depthDiff !== 0) {
      return depthDiff
    }
    const sortDiff = (Number(a?.sortIndex) || 0) - (Number(b?.sortIndex) || 0)
    if (sortDiff !== 0) {
      return sortDiff
    }
    return sanitizeText(a?.questionText).localeCompare(sanitizeText(b?.questionText))
  })
  const entriesByPage = new Map()
  for (const question of orderedQuestions) {
    const pageIndex = parseOptionalPageIndex(question?.pageIndex)
    if (pageIndex == null) {
      continue
    }
    const pageNode = getPageNodeByIndex(pageIndex)
    const anchor = findWorksheetQuestionAnchorInPage(pageNode, question.anchorText || question.questionText)
    if (!anchor) {
      continue
    }
    if (!entriesByPage.has(pageIndex)) {
      entriesByPage.set(pageIndex, [])
    }
    entriesByPage.get(pageIndex).push({
      question,
      pageNode,
      anchor
    })
  }

  for (const entries of entriesByPage.values()) {
    entries.sort((a, b) => a.anchor.top - b.anchor.top)
    const pageContext = getWorksheetPageTextContext(entries[0]?.pageNode)
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const question = entry.question
      const pageNode = entry.pageNode
      const anchor = entry.anchor

      const button = document.createElement("button")
      button.type = "button"
      button.className = "pdfWorksheetOverlay"
      button.dataset.pdfWorksheetAction = "answer"
      button.dataset.questionId = question.id
      button.style.left = `${anchor.left}px`
      button.style.top = `${anchor.top}px`
      button.textContent = "A"
      if (question.answerLoading) {
        button.classList.add("isLoading")
        button.disabled = true
        button.setAttribute("aria-busy", "true")
      }
      if (question.hasChildren) {
        button.title = question.answerLoading ? "Generating sub-answers..." : "Generate all sub-answers"
        button.setAttribute("aria-label", question.answerLoading ? "Generating sub-answers" : "Generate all sub-answers")
      } else {
        const hasAnswer = Boolean(normalizeWorksheetAnswerText(question.answerText, 1200))
        button.title = hasAnswer ? "Show/hide answer on page" : "Generate answer"
        button.setAttribute("aria-label", hasAnswer ? "Show or hide answer on page" : "Generate answer")
      }
      anchor.pageSurface.append(button)

      if (!shouldShowWorksheetAnswerCardOnPage(question)) {
        continue
      }

      const pageSurface = anchor.pageSurface
      const pageWidth = Math.max(1, pageSurface.clientWidth)
      const inlineTop = Math.max(anchor.top + 18, 4)
      const nextTop = index + 1 < entries.length ? entries[index + 1].anchor.top : Math.max(pageSurface.clientHeight - 6, inlineTop)
      const availableBelow = Math.max(0, nextTop - inlineTop - 6)
      const placedNaturally = tryPlaceWorksheetAnswerOnPage(entry, pageContext, availableBelow)
      if (placedNaturally) {
        continue
      }

      const preferredLeft = Math.min(anchor.left + 24, Math.max(pageWidth - 360, 10))
      const cardWidth = Math.min(360, Math.max(140, pageWidth - preferredLeft - 8))
      const inlineHeight = measureWorksheetPdfAnswerCardHeight(pageSurface, question, cardWidth, false)
      const canInline = availableBelow >= 92 && inlineHeight > 0 && inlineHeight <= availableBelow
      const card = createWorksheetPdfAnswerCardNode(question, { compact: !canInline })
      card.style.left = `${preferredLeft}px`
      card.style.width = `${cardWidth}px`

      if (canInline) {
        card.classList.add("isInline")
        card.style.top = `${inlineTop}px`
        card.style.maxHeight = `${Math.max(92, Math.floor(availableBelow))}px`
      } else {
        card.classList.add("isAnnotation")
        const annotationTop = Math.max(4, Math.min(anchor.top - 2, Math.max(pageSurface.clientHeight - 96, 4)))
        const maxHeight = Math.max(96, Math.min(Math.max(pageSurface.clientHeight - annotationTop - 6, 96), 220))
        card.style.top = `${annotationTop}px`
        card.style.maxHeight = `${Math.floor(maxHeight)}px`
      }
      pageSurface.append(card)
    }
  }
}

function buildWorksheetAnswerPrompt(question) {
  if (!question || typeof question !== "object") {
    return ""
  }
  const kind = normalizeWorksheetKind(question.kind)
  const questionText = sanitizeText(question.questionText)
  const anchorText = sanitizeText(question.anchorText || question.questionText)
  const responseTypes = normalizeWorksheetResponseTypes(question.responseTypes)
  const options = normalizeWorksheetOptions(question.options)
  const directives = []
  if (responseTypes.includes("true_false")) {
    directives.push("Required format: **TRUE** or **FALSE** first.")
  }
  if (responseTypes.includes("true_false") && (responseTypes.includes("short_answer") || responseTypes.includes("long_answer"))) {
    directives.push("Then add one concise justification sentence.")
  }
  if (responseTypes.includes("mcq")) {
    directives.push("Required format: **Answer: <one option>**.")
  }
  if (responseTypes.includes("multi_select")) {
    directives.push("Required format: **Answer: <all correct options>**.")
  }
  if (responseTypes.includes("fill_blank")) {
    directives.push("Answer format: fill the blank directly.")
  }
  if (kind === "term" || normalizeWorksheetQuestionType(question.questionType) === "table_definition") {
    directives.push("Return exactly one direct definition line.")
  }
  if (options.length > 0) {
    directives.push(`Options: ${options.join(" | ")}`)
  }
  if (kind === "term") {
    const parent = getWorksheetQuestionById(question.parentId)
    const parentText = sanitizeText(parent?.questionText)
    if (parentText) {
      return clampText(`${parentText}. Define briefly: ${anchorText}. ${directives.join(" ")}`.trim(), 360)
    }
    return clampText(`Define briefly: ${anchorText}. ${directives.join(" ")}`.trim(), 360)
  }
  return clampText(`${questionText || anchorText}. ${directives.join(" ")}`.trim(), 360)
}

async function buildWorksheetQuestionContextSnippet(question) {
  const pageIndex = parseOptionalPageIndex(question?.pageIndex) ?? 0
  const pageText = sanitizeText(await getPageText(renderState.pdfDoc, pageIndex))
  const explicitContext = clampText(question?.contextWindow, 900)
  if (!pageText) {
    return explicitContext || ""
  }
  const questionText = sanitizeText(question?.anchorText || question?.questionText)
  if (!questionText) {
    if (explicitContext) {
      return truncateText(`${explicitContext} ${pageText}`, 1300)
    }
    return truncateText(pageText, 1200)
  }
  const questionNeedle = questionText.toLowerCase()
  const pageLower = pageText.toLowerCase()
  const hitIndex = pageLower.indexOf(questionNeedle)
  if (hitIndex < 0) {
    if (explicitContext) {
      return truncateText(`${explicitContext} ${pageText}`, 1300)
    }
    return truncateText(pageText, 1200)
  }
  const start = Math.max(0, hitIndex - 420)
  const end = Math.min(pageText.length, hitIndex + questionText.length + 760)
  const snippet = truncateText(pageText.slice(start, end), 1300)
  if (explicitContext) {
    return truncateText(`${explicitContext} ${snippet}`, 1300)
  }
  return snippet
}

async function generateWorksheetAnswersForGroup(question, options = {}) {
  if (!question || question.answerLoading || !currentPdf || !renderState.pdfDoc) {
    return
  }
  const force = Boolean(options?.force)
  const fromBatch = Boolean(options?.fromBatch)
  const byIdMap = getWorksheetQuestionsByIdMap()
  const leaves = collectWorksheetLeafQuestions(question, byIdMap).filter((item) => item?.id && item.id !== question.id)
  if (leaves.length === 0) {
    return
  }

  const pendingLeaves = force ? leaves : leaves.filter((item) => !normalizeWorksheetAnswerText(item.answerText, 1200))
  if (!force && pendingLeaves.length === 0) {
    const answeredLeaves = leaves.filter((item) => Boolean(normalizeWorksheetAnswerText(item.answerText, 1200)))
    if (answeredLeaves.length > 0) {
      const shouldShow = answeredLeaves.some((item) => !item.overlayVisible)
      for (const leaf of answeredLeaves) {
        leaf.overlayVisible = shouldShow
      }
      renderPdfWorksheetOverlays()
      if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
        renderPanel()
      }
      return
    }
    if (!fromBatch) {
      if (sidebarState.collapsed) {
        setSidebarCollapsed(false)
      }
      setActiveTab("explain")
      setStatus("Answers available in sidebar.")
    }
    return
  }

  question.answerLoading = true
  question.overlayVisible = true
  renderPdfWorksheetOverlays()
  if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
    renderPanel()
  }

  try {
    for (const leaf of pendingLeaves) {
      await generateWorksheetAnswerForQuestion(leaf, { force, fromBatch: true })
    }
    question.answeredAt = Date.now()
    question.answerText = ""
    question.answerLength = ""
    question.overlayVisible = false
    if (!fromBatch) {
      setStatus("Answers generated.")
      if (sidebarState.collapsed) {
        setSidebarCollapsed(false)
      }
      setActiveTab("explain")
    }
  } catch (error) {
    logger.warn("Worksheet group answer generation failed", {
      questionId: question.id,
      message: error?.message || "Unknown error"
    })
    if (!fromBatch) {
      setStatus("Answer generation failed.")
    }
  } finally {
    question.answerLoading = false
    renderPdfWorksheetOverlays()
    if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
      renderPanel()
    }
  }
}

async function generateWorksheetAnswerForQuestion(question, options = {}) {
  if (!question || question.answerLoading || !currentPdf || !renderState.pdfDoc) {
    return
  }
  if (question.hasChildren && question.batchChildrenOnClick) {
    await generateWorksheetAnswersForGroup(question, options)
    return
  }
  const force = Boolean(options?.force)
  const fromBatch = Boolean(options?.fromBatch)
  const existingAnswer = normalizeWorksheetAnswerText(question.answerText, 1200)
  if (!force && existingAnswer) {
    question.overlayVisible = !question.overlayVisible
    renderPdfWorksheetOverlays()
    if (!fromBatch && sidebarState.collapsed) {
      setSidebarCollapsed(false)
    }
    if (!fromBatch) {
      setActiveTab("explain")
      setStatus(question.overlayVisible ? "Answer shown on page." : "Answer hidden on page.")
    }
    if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
      renderPanel()
    }
    return
  }

  question.answerLoading = true
  question.overlayVisible = true
  renderPdfWorksheetOverlays()
  if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
    renderPanel()
  }

  try {
    const snippet = await buildWorksheetQuestionContextSnippet(question)
    const contextWindow = truncateText(`${clampText(question?.contextWindow, 900)} ${snippet}`, 1300)
    const promptQuestionText = buildWorksheetAnswerPrompt(question)
    const { providerUsed, response, warnings } = await generateLLM("worksheet_answer", {
      questionText: promptQuestionText,
      gradeLevel: question.gradeLevel,
      title: getCurrentPdfTitleLabel(),
      snippet: contextWindow || snippet,
      contextWindow: contextWindow || snippet,
      pageIndex: parseOptionalPageIndex(question.pageIndex) ?? 0,
      readingMode: getReadingModeOrDefault()
    })
    const answer =
      normalizeWorksheetAnswerText(response?.answer, 1200) || "Unable to generate an answer from the available text."
    const answerLength =
      response?.answerLength === "short" || response?.answerLength === "long"
        ? response.answerLength
        : estimateWorksheetAnswerLength(answer)
    question.answerText = answer
    question.answerLength = answerLength
    question.provider = sanitizeText(providerUsed)
    question.warnings = Array.isArray(warnings) ? warnings.map((warning) => clampText(warning, 180)) : []
    question.answeredAt = Date.now()
    question.overlayVisible = true
    if (!fromBatch) {
      setStatus("Answer generated.")
      if (sidebarState.collapsed) {
        setSidebarCollapsed(false)
      }
      setActiveTab("explain")
    }
  } catch (error) {
    question.answerText = "Unable to generate an answer right now."
    question.answerLength = "short"
    question.overlayVisible = true
    question.provider = ""
    question.warnings = []
    if (!fromBatch) {
      setStatus("Answer generation failed.")
    }
    logger.warn("Worksheet answer generation failed", {
      questionId: question.id,
      message: error?.message || "Unknown error"
    })
  } finally {
    question.answerLoading = false
    renderPdfWorksheetOverlays()
    if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
      renderPanel()
    }
  }
}

async function jumpToWorksheetQuestion(question) {
  if (!question) {
    return
  }
  const pageIndex = parseOptionalPageIndex(question.pageIndex)
  if (pageIndex == null) {
    return
  }
  const pageNode = getPageNodeByIndex(pageIndex)
  if (!pageNode) {
    return
  }
  scrollToPage(pageIndex + 1, "smooth")
  await waitForPageInView(pageNode)
  const needleText = clampText(question.anchorText || question.questionText, 220)
  if (needleText) {
    highlightOnPage({
      pdfRoot,
      pageIndex,
      needleText,
      preferExact: false
    })
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
    pageSurface,
    textLayer,
    anchorSpan: bestSpan,
    surfaceRect
  }
}

async function getSectionSnippetFromRange(range, { maxPages = FLOW_DIGEST_MAX_SCAN_PAGES, maxChars = 1400 } = {}) {
  if (!renderState.pdfDoc || !range) {
    return ""
  }
  const normalizedMaxPages = Math.max(1, Math.floor(Number(maxPages) || FLOW_DIGEST_MAX_SCAN_PAGES))
  const pageStart = Math.max(0, parseOptionalPageIndex(range.startPageIndex) ?? 0)
  const pageEnd = Math.max(pageStart, parseOptionalPageIndex(range.endPageIndex) ?? pageStart)
  const pageLimit = Math.min(pageEnd, pageStart + normalizedMaxPages - 1)
  const parts = []

  for (let pageIndex = pageStart; pageIndex <= pageLimit; pageIndex += 1) {
    const pageText = await getPageText(renderState.pdfDoc, pageIndex)
    const text = sanitizeText(pageText)
    if (text) {
      parts.push(text)
    }
  }

  return truncateText(parts.join(" "), maxChars)
}

function buildSectionDigestFallbackSummary(sectionTitle, snippet) {
  const sectionLabel = clampText(sectionTitle, 120) || "this section"
  const source = sanitizeText(snippet)
  if (!source) {
    return `This section introduces ${sectionLabel}.`
  }
  const sentence = source
    .split(/(?<=[.!?])\s+/)
    .map((item) => sanitizeText(item))
    .find(Boolean)
  return clampText(sentence || source, 220) || `This section covers ${sectionLabel}.`
}

function tokenizeDigestSignalWords(text, { minLength = 3, maxItems = 80 } = {}) {
  const normalizedMinLength = Number.isFinite(minLength) ? Math.max(2, Math.floor(Number(minLength))) : 3
  const normalizedMaxItems = Number.isFinite(maxItems) ? Math.max(1, Math.floor(Number(maxItems))) : 80
  return sanitizeText(text)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9-]+$/g, ""))
    .filter((token) => token.length >= normalizedMinLength)
    .filter((token) => !RETRIEVAL_STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, normalizedMaxItems)
}

function normalizeDigestPhraseCandidate(text, { minWords = 3, maxWords = 12, maxChars = 96 } = {}) {
  const normalizedMinWords = Number.isFinite(minWords) ? Math.max(1, Math.floor(Number(minWords))) : 3
  const normalizedMaxWords = Number.isFinite(maxWords) ? Math.max(3, Math.floor(Number(maxWords))) : 12
  const normalizedMaxChars = Number.isFinite(maxChars) ? Math.max(24, Math.floor(Number(maxChars))) : 96
  let phrase = sanitizeText(text)
  if (!phrase) {
    return ""
  }
  phrase = phrase
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\(\s*(fig(?:ure)?|table)\.?[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^in this section[:,]?\s*/i, "")
    .replace(/^this section\s+(?:presents|describes|shows|evaluates|introduces)\s+/i, "")
    .replace(/^we\s+(?:present|show|evaluate|introduce|study|analyze)\s+/i, "")
    .trim()
  if (!phrase) {
    return ""
  }
  const clauses = phrase
    .split(/[;:]/)
    .map((item) => sanitizeText(item))
    .filter(Boolean)
  if (clauses.length > 0) {
    phrase = clauses[0]
  }
  if (phrase.includes(",")) {
    const commaClauses = phrase
      .split(",")
      .map((item) => sanitizeText(item))
      .filter(Boolean)
    const candidate = commaClauses.find((item) => {
      const wordCount = item.split(/\s+/).filter(Boolean).length
      return wordCount >= 4 && wordCount <= normalizedMaxWords
    })
    if (candidate) {
      phrase = candidate
    }
  }
  const words = phrase.split(/\s+/).filter(Boolean)
  if (words.length < normalizedMinWords) {
    return ""
  }
  if (words.length > normalizedMaxWords) {
    phrase = words.slice(0, normalizedMaxWords).join(" ")
  }
  phrase = phrase.replace(/^[^a-z0-9(]+|[^a-z0-9)\]]+$/gi, "")
  return truncateText(phrase, normalizedMaxChars)
}

function scoreDigestPhrase(phrase, summaryTerms, titleTerms, sentenceIndex = 0) {
  const signalWords = tokenizeDigestSignalWords(phrase, { minLength: 3, maxItems: 40 })
  if (signalWords.length < 3) {
    return Number.NEGATIVE_INFINITY
  }
  const uniqueSignalWords = [...new Set(signalWords)]
  const summaryOverlap = uniqueSignalWords.filter((token) => summaryTerms.has(token)).length
  const titleOverlap = uniqueSignalWords.filter((token) => titleTerms.has(token)).length
  let score = uniqueSignalWords.length * 1.2 + summaryOverlap * 2.8 + titleOverlap * 3.2
  if (/\d/.test(phrase)) {
    score += 0.8
  }
  if (/[A-Z]{2,}/.test(phrase)) {
    score += 0.9
  }
  if (/\b(dataset|model|baseline|accuracy|precision|recall|loss|ablation|experiment|classification|regression)\b/i.test(phrase)) {
    score += 0.9
  }
  if (/^(it|this|that|there)\b/i.test(phrase)) {
    score -= 0.8
  }
  if (phrase.length < 20) {
    score -= 1.2
  }
  if (phrase.length > 90) {
    score -= 0.9
  }
  score += Math.max(0, 0.5 - Math.min(Math.max(sentenceIndex, 0), 8) * 0.06)
  return score
}

function tokenizeDigestPhraseSet(phrase) {
  return new Set(tokenizeDigestSignalWords(phrase, { minLength: 3, maxItems: 30 }))
}

function isDigestPhraseDuplicate(candidatePhrase, selectedPhrases) {
  const candidateTokens = tokenizeDigestPhraseSet(candidatePhrase)
  if (candidateTokens.size === 0) {
    return true
  }
  for (const selected of selectedPhrases) {
    const selectedTokens = tokenizeDigestPhraseSet(selected)
    if (selectedTokens.size === 0) {
      continue
    }
    let overlap = 0
    for (const token of candidateTokens) {
      if (selectedTokens.has(token)) {
        overlap += 1
      }
    }
    const ratio = overlap / Math.min(candidateTokens.size, selectedTokens.size)
    if (ratio >= 0.75) {
      return true
    }
  }
  return false
}

function buildSectionDigestOverviewPhrases(sectionTitle, summaryText, snippetText) {
  const summaryTerms = new Set(tokenizeDigestSignalWords(summaryText, { minLength: 3, maxItems: 48 }))
  const titleTerms = new Set(tokenizeDigestSignalWords(sectionTitle, { minLength: 3, maxItems: 24 }))
  const sentences = sanitizeText(snippetText)
    .split(/(?<=[.!?])\s+/)
    .map((item) => sanitizeText(item))
    .filter(Boolean)
    .slice(0, 40)

  const candidates = []
  const dedupe = new Set()
  sentences.forEach((sentence, sentenceIndex) => {
    const parts = sentence
      .split(/[.?!]/)
      .flatMap((chunk) => chunk.split(/[;:]/))
      .flatMap((chunk) => chunk.split(","))
      .map((item) => normalizeDigestPhraseCandidate(item))
      .filter(Boolean)
    for (const part of parts) {
      const key = part.toLowerCase()
      if (dedupe.has(key)) {
        continue
      }
      dedupe.add(key)
      const score = scoreDigestPhrase(part, summaryTerms, titleTerms, sentenceIndex)
      if (!Number.isFinite(score) || score <= 0) {
        continue
      }
      candidates.push({ text: part, score })
    }
  })

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score
    }
    return right.text.length - left.text.length
  })

  const selected = []
  for (const candidate of candidates) {
    if (selected.length >= FLOW_DIGEST_MAX_OVERVIEW_PHRASES) {
      break
    }
    if (isDigestPhraseDuplicate(candidate.text, selected)) {
      continue
    }
    selected.push(candidate.text)
  }
  return selected
}

function addDigestTermCandidate(scoreMap, term, score) {
  const text = normalizeDigestPhraseCandidate(term, { minWords: 2, maxWords: 5, maxChars: 48 })
  if (!text) {
    return
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length
  if (wordCount < 2) {
    return
  }
  const key = text.toLowerCase()
  if (key.length < 2 || RETRIEVAL_STOP_WORDS.has(key) || FLOW_DIGEST_GENERIC_TERMS.has(key)) {
    return
  }
  scoreMap.set(key, {
    text,
    score: (scoreMap.get(key)?.score || 0) + (Number.isFinite(score) ? Number(score) : 1)
  })
}

function buildSectionDigestTechnicalTerms(sectionTitle, summaryText, snippetText) {
  const scores = new Map()
  const combined = `${sanitizeText(sectionTitle)} ${sanitizeText(summaryText)} ${sanitizeText(snippetText)}`

  for (const match of combined.matchAll(/\b([A-Za-z][A-Za-z0-9-]{2,}(?:\s+[A-Za-z][A-Za-z0-9-]{2,}){1,3})\s*\(([A-Z]{2,8})\)/g)) {
    addDigestTermCandidate(scores, match[1], 4.4)
  }
  for (const match of combined.matchAll(/\b([A-Za-z][A-Za-z0-9-]{2,}\s+[A-Za-z][A-Za-z0-9-]{2,}(?:\s+[A-Za-z][A-Za-z0-9-]{2,}){0,2})\b/g)) {
    addDigestTermCandidate(scores, match[1], 1.2)
  }

  return [...scores.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      return right.text.length - left.text.length
    })
    .map((item) => item.text)
    .slice(0, FLOW_DIGEST_MAX_TECHNICAL_TERMS)
}

function buildSectionDigestKeywords(sectionTitle, summaryText, snippetText) {
  const overviewPhrases = buildSectionDigestOverviewPhrases(sectionTitle, summaryText, snippetText)
  const terms = buildSectionDigestTechnicalTerms(sectionTitle, summaryText, snippetText)
  const combined = []
  const dedupe = new Set()
  for (const phrase of [...overviewPhrases, ...terms]) {
    const text = normalizeDigestPhraseCandidate(phrase, { minWords: 2, maxWords: 12, maxChars: 96 })
    if (!text) {
      continue
    }
    const key = text.toLowerCase()
    if (dedupe.has(key)) {
      continue
    }
    dedupe.add(key)
    combined.push(text)
    if (combined.length >= FLOW_DIGEST_MAX_KEYWORDS) {
      break
    }
  }
  if (combined.length === 0) {
    const fallback = normalizeDigestPhraseCandidate(summaryText, { minWords: 2, maxWords: 12, maxChars: 96 })
    if (fallback) {
      combined.push(fallback)
    }
  }
  return combined
}

function getSectionPageIndicesFromRange(range, maxPages = FLOW_DIGEST_MAX_SCAN_PAGES) {
  const start = Math.max(0, parseOptionalPageIndex(range?.startPageIndex) ?? 0)
  const end = Math.max(start, parseOptionalPageIndex(range?.endPageIndex) ?? start)
  const pageCap = Math.max(1, Math.floor(Number(maxPages) || FLOW_DIGEST_MAX_SCAN_PAGES))
  const pageIndices = []
  for (let pageIndex = start; pageIndex <= end && pageIndices.length < pageCap; pageIndex += 1) {
    pageIndices.push(pageIndex)
  }
  return pageIndices
}

function getDigestHighlightSectionSlug(sectionKey) {
  const normalized = sanitizeText(sectionKey).toLowerCase()
  if (!normalized) {
    return ""
  }
  return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function buildDigestHighlightText(sectionKey, phrase) {
  const slug = getDigestHighlightSectionSlug(sectionKey)
  const content = truncateText(sanitizeText(phrase), 110)
  if (!slug || !content) {
    return ""
  }
  return `[flow-digest:${slug}] ${content}`
}

function clearDigestHighlightsForSection(sectionKey) {
  const slug = getDigestHighlightSectionSlug(sectionKey)
  if (!slug) {
    return
  }
  const prefix = `[flow-digest:${slug}]`
  const affectedPages = new Set()
  highlighterState.items = highlighterState.items.filter((item) => {
    if (typeof item?.textKey !== "string") {
      return true
    }
    const isDigestItem = item.textKey.startsWith(prefix)
    if (isDigestItem && Number.isFinite(item.pageIndex) && item.pageIndex >= 0) {
      affectedPages.add(item.pageIndex)
    }
    return !isDigestItem
  })
  for (const pageIndex of affectedPages) {
    renderUserHighlightsForPage(pageIndex)
  }
}

function applyDigestHighlightsForSection(sectionKey, matches) {
  clearDigestHighlightsForSection(sectionKey)
  const normalizedMatches = Array.isArray(matches) ? matches : []
  let addedCount = 0
  for (const match of normalizedMatches) {
    const selectedText = buildDigestHighlightText(sectionKey, match?.needleText)
    const didAdd = addOrMergeHighlight({
      pageIndex: match?.pageIndex,
      selectedText,
      rects: Array.isArray(match?.rects) ? match.rects : []
    })
    if (didAdd) {
      addedCount += 1
    }
  }
  return addedCount
}

function createDigestBubble(sectionKey, anchor, topOffset = 20) {
  const bubble = document.createElement("div")
  bubble.className = "pdfIntentBubble pdfIntentDigestBubble"
  bubble.style.left = `${Math.min(anchor.left + 24, Math.max(anchor.pageSurface.clientWidth - 260, 10))}px`
  bubble.style.top = `${Math.max(anchor.top + topOffset, 4)}px`

  if (isDigestLoading(sectionKey)) {
    bubble.textContent = "Summarizing section..."
    return bubble
  }

  const digest = getDigestEntry(sectionKey)
  if (!digest?.summary) {
    bubble.textContent = "No summary available yet."
    return bubble
  }

  const title = document.createElement("div")
  title.className = "pdfIntentDigestLabel"
  title.textContent = "Quick summary"

  const summary = document.createElement("p")
  summary.className = "pdfIntentDigestSummary"
  summary.textContent = digest.summary

  bubble.append(title, summary)
  if (Array.isArray(digest.keywords) && digest.keywords.length > 0) {
    const keywordsWrap = document.createElement("div")
    keywordsWrap.className = "pdfIntentDigestKeywords"
    for (const keyword of digest.keywords) {
      const chip = document.createElement("span")
      chip.className = "pdfIntentDigestKeyword"
      chip.textContent = keyword
      keywordsWrap.append(chip)
    }
    bubble.append(keywordsWrap)
  }
  return bubble
}

async function ensureDigestForSection(sectionKey) {
  const key = sanitizeText(sectionKey)
  if (!key || !currentPdf || !renderState.pdfDoc) {
    return null
  }

  const sections = getReadingMapSections()
  const range = getSectionRangeForSectionKey(key, sections, currentPdf.pageNumber || 1)
  const sectionTitle = clampText(range.sectionTitle, 180) || `Page ${Math.max(0, range.startPageIndex) + 1}`
  const snippet = await getSectionSnippetFromRange(range, {
    maxPages: FLOW_DIGEST_MAX_SCAN_PAGES,
    maxChars: 2200
  })
  if (!snippet) {
    setDigestEntry(key, {
      summary: `No text available yet for ${sectionTitle}.`,
      keywords: [],
      pageIndex: range.startPageIndex
    })
    return getDigestEntry(key)
  }

  const { response } = await generateLLM("explanation", {
    selectedText: sectionTitle,
    contextWindow: snippet,
    pageIndex: Math.max(0, range.startPageIndex),
    readingMode: getReadingModeOrDefault()
  })
  const summary = clampText(
    response?.shortAnswer || response?.eli5 || buildSectionDigestFallbackSummary(sectionTitle, snippet),
    260
  )
  const keywords = buildSectionDigestKeywords(sectionTitle, summary, snippet)
  setDigestEntry(key, {
    summary,
    keywords,
    pageIndex: range.startPageIndex
  })
  return getDigestEntry(key)
}

function renderPdfIntentOverlays() {
  clearPdfIntentOverlays()
  if (!modeUiState.aiEnabled || isWorksheetMode()) {
    return
  }
  const sections = getReadingMapSections()
  const intentMap = getSectionIntentMapFromOrientationData(getOrientationState().data?.sectionIntents)
  const showFlowDigest = modeUiState.mode === "flow"
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
    button.title = "Section intent"
    button.setAttribute("aria-label", "Section intent")
    anchor.pageSurface.append(button)

    if (showFlowDigest) {
      const digestButton = document.createElement("button")
      digestButton.type = "button"
      digestButton.className = "pdfIntentOverlay pdfIntentOverlayDigest"
      digestButton.dataset.pdfIntentAction = "digest"
      digestButton.dataset.sectionKey = sectionKey
      digestButton.textContent = "S"
      digestButton.style.left = `${anchor.left + 20}px`
      digestButton.style.top = `${anchor.top}px`
      digestButton.title = "Highlight section takeaways"
      digestButton.setAttribute("aria-label", "Highlight section takeaways")
      anchor.pageSurface.append(digestButton)
    }

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

async function handlePdfDigestOverlayClick(buttonEl) {
  const sectionKey = sanitizeText(buttonEl?.dataset?.sectionKey)
  if (!sectionKey) {
    return
  }
  setDigestVisible(sectionKey, false)

  let digest = getDigestEntry(sectionKey)
  if (!digest?.summary) {
    setDigestLoading(sectionKey, true)
    try {
      digest = await ensureDigestForSection(sectionKey)
    } catch (error) {
      logger.warn("Digest overlay generation failed", {
        sectionKey,
        message: error?.message || "Unknown error"
      })
      setDigestEntry(sectionKey, {
        summary: "Unable to summarize this section right now.",
        keywords: [],
        pageIndex: parseOptionalPageIndex(currentPdf?.pageNumber) ?? 0
      })
      digest = getDigestEntry(sectionKey)
    } finally {
      setDigestLoading(sectionKey, false)
    }
  }

  if (Array.isArray(digest?.keywords) && digest.keywords.length > 0) {
    const sections = getReadingMapSections()
    const range = getSectionRangeForSectionKey(sectionKey, sections, currentPdf?.pageNumber || 1)
    const pageIndices = getSectionPageIndicesFromRange(range, FLOW_DIGEST_MAX_SCAN_PAGES)
    let matchResult = collectHighlightMatchesOnPages({
      pdfRoot,
      pageIndices,
      needleTexts: digest.keywords,
      preferExact: true,
      maxMatches: FLOW_DIGEST_MAX_HIGHLIGHTS
    })
    if (!matchResult.success) {
      matchResult = collectHighlightMatchesOnPages({
        pdfRoot,
        pageIndices,
        needleTexts: digest.keywords,
        preferExact: false,
        maxMatches: FLOW_DIGEST_MAX_HIGHLIGHTS
      })
    }
    if (matchResult.success && Array.isArray(matchResult.matches) && matchResult.matches.length > 0) {
      applyDigestHighlightsForSection(sectionKey, matchResult.matches)
    } else {
      clearDigestHighlightsForSection(sectionKey)
    }
  } else {
    clearDigestHighlightsForSection(sectionKey)
  }
  renderPdfIntentOverlays()
}

async function handlePdfWorksheetOverlayClick(buttonEl) {
  const action = sanitizeText(buttonEl?.dataset?.pdfWorksheetAction)
  if (action && action !== "answer") {
    return
  }
  const question = getWorksheetQuestionById(buttonEl?.dataset?.questionId)
  if (!question) {
    return
  }
  await generateWorksheetAnswerForQuestion(question)
}

async function handlePdfIntentOverlayClick(buttonEl) {
  const action = sanitizeText(buttonEl?.dataset?.pdfIntentAction)
  if (action === "digest") {
    await handlePdfDigestOverlayClick(buttonEl)
    return
  }
  if (action && action !== "toggle") {
    return
  }
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
  syncSectionStatusForCurrentPage({ preferCurrent: true })
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
    updateOrientationLoadingMessage("Summarizing purpose and section outline...")

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

async function ensureOutlineSectionsForCurrentDocument(loadToken) {
  if (!isLoadTokenCurrent(loadToken) || !renderState.pdfDoc || !currentPdf) {
    return []
  }
  const docId = deriveDocId(currentPdf)
  const cachedOutline = docId && docId !== "unknown" ? await getOutline(docId) : null
  let outlineSections = normalizeReadingMapSections(cachedOutline?.sections)
  if (!isLoadTokenCurrent(loadToken)) {
    return []
  }
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
  if (!isLoadTokenCurrent(loadToken)) {
    return []
  }
  applyReadingMapToCurrentDocument(outlineSections)
  return outlineSections
}

async function applyNonGeneratingOrientationForCurrentDocument(loadToken) {
  if (!isLoadTokenCurrent(loadToken) || !currentPdf) {
    return
  }
  const docId = deriveDocId(currentPdf)
  const sections = await ensureOutlineSectionsForCurrentDocument(loadToken)
  if (!isLoadTokenCurrent(loadToken)) {
    return
  }
  if (docId && docId !== "unknown") {
    const cachedEntry = await getOrientationCache(docId)
    if (cachedEntry && isLoadTokenCurrent(loadToken)) {
      const summary = buildOrientationSummaryFromData(cachedEntry.summary)
      const cachedIntents = await loadCachedSectionIntentsForDocument(docId, sections)
      setOrientationReady({
        ...summary,
        sectionIntents: cachedIntents,
        sections
      })
      if (sidebarUiState.activeTab === "orientation") {
        renderPanel()
      }
      return
    }
  }
  setOrientationReady({
    ...createEmptyOrientationData(),
    sections
  })
  if (sidebarUiState.activeTab === "orientation") {
    renderPanel()
  }
}

function isWalkthroughPlaceholder(oneLiner, sectionTitle) {
  const text = sanitizeText(oneLiner).toLowerCase()
  const title = sanitizeText(sectionTitle).toLowerCase()
  if (!text) {
    return true
  }
  if (text.startsWith("read this section")) {
    return true
  }
  if (title && text === title) {
    return true
  }
  return false
}

async function prefillWalkthroughIntentsIfMissing(loadToken, manager, topLevelNodes) {
  if (!isLoadTokenCurrent(loadToken) || !currentPdf) {
    return
  }
  const items = normalizeWalkthroughItems(sidebarUiState.walkthrough.items)
  if (items.length === 0) {
    return
  }
  const nodeByTitle = new Map()
  for (const node of topLevelNodes) {
    nodeByTitle.set(sanitizeText(node?.title).toLowerCase(), node)
  }

  let hasChanges = false
  const nextItems = items.map((item) => ({ ...item }))
  for (const item of nextItems) {
    if (!isWalkthroughPlaceholder(item.oneLiner, item.sectionTitle)) {
      continue
    }
    const node = nodeByTitle.get(sanitizeText(item.sectionTitle).toLowerCase())
    if (!node) {
      continue
    }
    const intent = clampText(await manager.getOrGenerateIntent(node), 220)
    if (!intent || !isLoadTokenCurrent(loadToken)) {
      continue
    }
    item.oneLiner = intent
    hasChanges = true
  }
  if (!hasChanges || !isLoadTokenCurrent(loadToken)) {
    return
  }
  sidebarUiState.walkthrough.items = normalizeWalkthroughItems(nextItems)
  const docId = deriveDocId(currentPdf)
  if (docId && docId !== "unknown") {
    await setWalkthrough(docId, sidebarUiState.walkthrough.items)
  }
}

async function runStructurePrewarmForCurrentDocument(loadToken) {
  if (!modeUiState.autoPrewarmOnLoad || !isLoadTokenCurrent(loadToken) || !currentPdf) {
    return
  }
  const docId = deriveDocId(currentPdf)
  if (!docId || docId === "unknown" || structurePrewarmedDocIds.has(docId)) {
    return
  }
  const manager = ensureSectionIntentManager()
  if (!manager) {
    return
  }

  structurePrewarmedDocIds.add(docId)
  logger.info("Structure prewarm start", { docId })
  try {
    const sections = await ensureOutlineSectionsForCurrentDocument(loadToken)
    if (!isLoadTokenCurrent(loadToken)) {
      return
    }
    const topLevelNodes = buildSectionTree(sections).filter((node) => Number(node?.level) === 1).slice(0, 6)
    if (topLevelNodes.length > 0) {
      await manager.prewarmTopLevelIntents(topLevelNodes, { limit: 6 })
      for (const node of topLevelNodes) {
        const intent = clampText(await manager.getOrGenerateIntent(node), 220)
        if (intent) {
          upsertOrientationIntent(node.key, intent)
        }
      }
      await prefillWalkthroughIntentsIfMissing(loadToken, manager, topLevelNodes)
    }
    if (sidebarUiState.activeTab === "orientation" || sidebarUiState.activeTab === "walkthrough") {
      renderPanel()
    }
    logger.info("Structure prewarm complete", { docId, topLevelCount: topLevelNodes.length })
  } catch (error) {
    logger.warn("Structure prewarm failed", {
      docId,
      message: error?.message || "Unknown error"
    })
  }
}

function getReadingMapSections() {
  if (!Array.isArray(currentPdf?.readingMap?.sections)) {
    return []
  }
  return currentPdf.readingMap.sections
}

function toSectionSnapshot(section) {
  const sectionTitle = clampText(getSectionDisplayTitle(section), 180)
  const sectionPageIndex = parseOptionalPageIndex(section?.pageIndex)
  if (!sectionTitle || sectionPageIndex == null) {
    return null
  }
  return {
    key: getSectionKey(section),
    id: sanitizeText(section?.id) || null,
    title: sectionTitle,
    pageIndex: sectionPageIndex,
    section
  }
}

function getCurrentSectionSnapshotForPage(pageIndex, sections = getReadingMapSections()) {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null || !currentPdf) {
    return null
  }
  const currentSectionKey = sanitizeText(currentPdf.currentSectionKey)
  const currentSectionPageIndex = parseOptionalPageIndex(currentPdf.currentSectionPageIndex)
  if (!currentSectionKey || currentSectionPageIndex == null || currentSectionPageIndex !== normalizedPageIndex) {
    return null
  }
  for (const section of Array.isArray(sections) ? sections : []) {
    const snapshot = toSectionSnapshot(section)
    if (!snapshot) {
      continue
    }
    if (snapshot.key === currentSectionKey) {
      return snapshot
    }
  }
  return null
}

function resolveSectionForPage(pageIndex, sectionsOutline = getReadingMapSections()) {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null) {
    return null
  }
  const sections = Array.isArray(sectionsOutline) ? sectionsOutline : []
  let latest = null
  for (const section of sections) {
    const snapshot = toSectionSnapshot(section)
    if (!snapshot) {
      continue
    }
    if (snapshot.pageIndex <= normalizedPageIndex) {
      latest = section
      continue
    }
    break
  }
  return latest
}

function resolveSectionSnapshotForPage(pageIndex, options = {}) {
  const sections = Array.isArray(options?.sections) ? options.sections : getReadingMapSections()
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null) {
    return null
  }
  if (options?.preferCurrent === true) {
    const currentSnapshot = getCurrentSectionSnapshotForPage(normalizedPageIndex, sections)
    if (currentSnapshot) {
      return currentSnapshot
    }
  }
  return toSectionSnapshot(resolveSectionForPage(normalizedPageIndex, sections))
}

function getCurrentSectionTitle(pageNumber, sectionsOutline) {
  const normalizedPageNumber = Number(pageNumber)
  if (!Number.isFinite(normalizedPageNumber) || normalizedPageNumber < 1) {
    return "Unknown section"
  }
  const pageIndex = Math.max(0, Math.floor(normalizedPageNumber) - 1)
  const section = toSectionSnapshot(resolveSectionForPage(pageIndex, sectionsOutline))
  if (section?.title) {
    return section.title
  }
  return `Page ${pageIndex + 1}`
}

function getSectionRangeFromIndex(sectionIndex, sectionsOutline, fallbackPageIndex = 0) {
  const sections = Array.isArray(sectionsOutline) ? sectionsOutline : []
  const fallbackIndex = parseOptionalPageIndex(fallbackPageIndex) ?? 0
  if (sections.length === 0 || sectionIndex < 0 || sectionIndex >= sections.length) {
    return {
      sectionTitle: `Page ${fallbackIndex + 1}`,
      sectionKey: "",
      sectionId: null,
      startPageIndex: fallbackIndex,
      endPageIndex: fallbackIndex
    }
  }

  const selected = sections[sectionIndex]
  const selectedSnapshot = toSectionSnapshot(selected)
  const startPageIndex = parseOptionalPageIndex(selected?.pageIndex) ?? fallbackIndex
  let endPageIndex = startPageIndex

  for (let index = sectionIndex + 1; index < sections.length; index += 1) {
    const nextPageIndex = parseOptionalPageIndex(sections[index]?.pageIndex)
    if (nextPageIndex == null) {
      continue
    }
    endPageIndex = Math.max(startPageIndex, nextPageIndex - 1)
    break
  }

  if (endPageIndex < startPageIndex) {
    endPageIndex = startPageIndex
  }
  if (currentPdf?.numPages) {
    endPageIndex = Math.min(endPageIndex, Math.max(0, currentPdf.numPages - 1))
  }

  return {
    sectionTitle: selectedSnapshot?.title || `Page ${startPageIndex + 1}`,
    sectionKey: selectedSnapshot?.key || "",
    sectionId: selectedSnapshot?.id || null,
    startPageIndex,
    endPageIndex
  }
}

function getCurrentSectionRange(pageNumber, sectionsOutline) {
  const normalizedPageNumber = Number(pageNumber)
  const pageIndex = Number.isFinite(normalizedPageNumber) && normalizedPageNumber > 0
    ? Math.max(0, Math.floor(normalizedPageNumber) - 1)
    : 0
  const sections = Array.isArray(sectionsOutline) ? sectionsOutline : []
  if (sections.length === 0) {
    return {
      sectionTitle: `Page ${pageIndex + 1}`,
      sectionKey: "",
      sectionId: null,
      startPageIndex: pageIndex,
      endPageIndex: pageIndex
    }
  }

  const selectedIndex = getSectionIndexForPage(pageIndex, sections)
  return getSectionRangeFromIndex(selectedIndex, sections, pageIndex)
}

function getSectionRangeForSectionKey(sectionKey, sectionsOutline, fallbackPageNumber = 1) {
  const sections = Array.isArray(sectionsOutline) ? sectionsOutline : []
  const key = sanitizeText(sectionKey)
  const fallbackPageIndex = Math.max(0, Math.floor(Number(fallbackPageNumber) || 1) - 1)
  if (!key || sections.length === 0) {
    return getCurrentSectionRange(fallbackPageNumber, sections)
  }

  let selectedIndex = -1
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]
    if (getSectionKey(section) === key) {
      selectedIndex = index
      break
    }
  }
  if (selectedIndex < 0) {
    return getCurrentSectionRange(fallbackPageNumber, sections)
  }
  return getSectionRangeFromIndex(selectedIndex, sections, fallbackPageIndex)
}

function resolveSectionTitle(pageIndex, options = {}) {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null) {
    return "Unknown section"
  }
  const snapshot = resolveSectionSnapshotForPage(normalizedPageIndex, options)
  if (snapshot?.title) {
    return snapshot.title
  }
  return `Page ${normalizedPageIndex + 1}`
}

function resolveSectionId(pageIndex, options = {}) {
  const snapshot = resolveSectionSnapshotForPage(pageIndex, options)
  return snapshot?.id || null
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

function syncSectionStatusForCurrentPage(options = {}) {
  if (!currentPdf) {
    return
  }
  const pageIndex = Math.max(0, (Number(currentPdf.pageNumber) || 1) - 1)
  const snapshot = resolveSectionSnapshotForPage(pageIndex, {
    preferCurrent: options?.preferCurrent !== false
  })
  if (snapshot) {
    updateSectionStatus(snapshot.title, {
      sectionId: snapshot.id,
      sectionKey: snapshot.key,
      pageIndex: snapshot.pageIndex
    })
    return
  }
  updateSectionStatus(`Page ${pageIndex + 1}`, {
    sectionId: null,
    sectionKey: "",
    pageIndex
  })
}

function detectPageColumnLayout(pageNode, pageSurface) {
  if (!(pageNode instanceof HTMLElement) || !(pageSurface instanceof HTMLElement)) {
    return { columnCount: 1, splitX: null, pageHeight: 1 }
  }
  const textLayer = pageNode.querySelector(".textLayer")
  if (!(textLayer instanceof HTMLElement)) {
    return { columnCount: 1, splitX: null, pageHeight: Math.max(pageSurface.clientHeight, 1) }
  }
  const surfaceRect = pageSurface.getBoundingClientRect()
  const pageWidth = Math.max(surfaceRect.width, 1)
  const pageHeight = Math.max(surfaceRect.height, 1)
  const samples = []

  const spans = Array.from(textLayer.querySelectorAll("span"))
  for (const span of spans) {
    if (!(span instanceof HTMLElement)) {
      continue
    }
    const text = sanitizeText(span.textContent || "")
    if (text.length < 2) {
      continue
    }
    const rect = span.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 6 || rect.height < 4) {
      continue
    }
    const centerX = rect.left - surfaceRect.left + rect.width / 2
    if (!Number.isFinite(centerX) || centerX < 0 || centerX > pageWidth) {
      continue
    }
    samples.push(centerX)
  }

  if (samples.length < SECTION_MULTI_COLUMN_MIN_SAMPLES) {
    return { columnCount: 1, splitX: null, pageHeight }
  }

  samples.sort((a, b) => a - b)
  let bestGap = 0
  let splitIndex = -1
  for (let index = 1; index < samples.length; index += 1) {
    const gap = samples[index] - samples[index - 1]
    if (gap > bestGap) {
      bestGap = gap
      splitIndex = index
    }
  }
  if (splitIndex <= 0) {
    return { columnCount: 1, splitX: null, pageHeight }
  }

  const minGap = pageWidth * SECTION_MULTI_COLUMN_MIN_GAP_RATIO
  if (bestGap < minGap) {
    return { columnCount: 1, splitX: null, pageHeight }
  }

  const leftCount = splitIndex
  const rightCount = samples.length - splitIndex
  const minSideCount = Math.max(8, Math.floor(samples.length * 0.2))
  if (leftCount < minSideCount || rightCount < minSideCount) {
    return { columnCount: 1, splitX: null, pageHeight }
  }

  const splitX = (samples[splitIndex - 1] + samples[splitIndex]) / 2
  return {
    columnCount: 2,
    splitX: clampNumber(splitX, 0, pageWidth),
    pageHeight
  }
}

function getColumnIndexForX(xPosition, columnLayout) {
  const normalizedX = Number(xPosition)
  if (columnLayout?.columnCount !== 2 || !Number.isFinite(columnLayout?.splitX) || !Number.isFinite(normalizedX)) {
    return 0
  }
  return normalizedX >= columnLayout.splitX ? 1 : 0
}

function getSectionReadingOrderPosition(yPosition, columnIndex, columnLayout) {
  const pageHeight = Math.max(Number(columnLayout?.pageHeight) || 1, 1)
  const clampedY = clampNumber(Number(yPosition), 0, pageHeight)
  if (columnLayout?.columnCount === 2 && columnIndex > 0) {
    return pageHeight + clampedY
  }
  return clampedY
}

function resolveSectionSnapshotFromClickPoint(pageNode, pageIndex, clickX, clickY) {
  const normalizedPageIndex = parseOptionalPageIndex(pageIndex)
  if (normalizedPageIndex == null || !(pageNode instanceof HTMLElement)) {
    return null
  }

  const sections = getReadingMapSections()
  const fallback = toSectionSnapshot(resolveSectionForPage(normalizedPageIndex, sections))
  const samePageSections = sections
    .map((section) => toSectionSnapshot(section))
    .filter((snapshot) => snapshot && snapshot.pageIndex === normalizedPageIndex)
  if (samePageSections.length === 0) {
    return fallback
  }

  const pageSurface = pageNode.querySelector(".pdfPageSurface")
  if (!(pageSurface instanceof HTMLElement)) {
    return fallback
  }
  const columnLayout = detectPageColumnLayout(pageNode, pageSurface)
  const clickColumn = getColumnIndexForX(clickX, columnLayout)
  const clickOrder = getSectionReadingOrderPosition(clickY, clickColumn, columnLayout)

  let bestSnapshot = null
  let bestOrder = Number.NEGATIVE_INFINITY
  for (const snapshot of samePageSections) {
    const anchor = findSectionAnchorInPage(pageNode, snapshot.title)
    if (!anchor) {
      continue
    }
    const anchorColumn = getColumnIndexForX(anchor.left, columnLayout)
    const anchorOrder = getSectionReadingOrderPosition(anchor.top, anchorColumn, columnLayout)
    if (anchorOrder > clickOrder + SECTION_CLICK_ORDER_TOLERANCE) {
      continue
    }
    if (anchorOrder > bestOrder) {
      bestSnapshot = snapshot
      bestOrder = anchorOrder
    }
  }

  return bestSnapshot || fallback
}

function updateCurrentSectionFromPdfClick(event) {
  if (!currentPdf) {
    return
  }
  const target = event.target instanceof Element ? event.target : null
  if (!(target instanceof Element)) {
    return
  }
  const textLayer = target.closest(".textLayer")
  if (!(textLayer instanceof HTMLElement)) {
    return
  }
  const pageNode = textLayer.closest(".pdfPageShell")
  if (!(pageNode instanceof HTMLElement)) {
    return
  }
  const pageIndex = parseOptionalPageIndex(pageNode.dataset.pageIndex)
  if (pageIndex == null) {
    return
  }
  const pageSurface = pageNode.querySelector(".pdfPageSurface")
  if (!(pageSurface instanceof HTMLElement)) {
    return
  }

  const surfaceRect = pageSurface.getBoundingClientRect()
  const clickX = clampNumber(event.clientX - surfaceRect.left, 0, Math.max(surfaceRect.width, 1))
  const clickY = clampNumber(event.clientY - surfaceRect.top, 0, Math.max(surfaceRect.height, 1))
  const snapshot =
    resolveSectionSnapshotFromClickPoint(pageNode, pageIndex, clickX, clickY) ||
    resolveSectionSnapshotForPage(pageIndex, { preferCurrent: false })
  if (snapshot) {
    updateSectionStatus(snapshot.title, {
      sectionId: snapshot.id,
      sectionKey: snapshot.key,
      pageIndex: snapshot.pageIndex
    })
    return
  }

  updateSectionStatus(`Page ${pageIndex + 1}`, {
    sectionId: null,
    sectionKey: "",
    pageIndex
  })
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
  if (isViewerMode()) {
    hideSectionRail()
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
  const explicitSectionId = sanitizeText(payload?.sectionId)
  const explicitSectionTitle = clampText(payload?.sectionTitle, 180)
  return {
    pageIndex: resolvedPageIndex,
    sectionId: explicitSectionId || resolveSectionId(resolvedPageIndex, { preferCurrent: true }),
    sectionTitle: explicitSectionTitle || resolveSectionTitle(resolvedPageIndex, { preferCurrent: true }),
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
    sectionId: resolveSectionId(primary.pageIndex, { preferCurrent: true }),
    sectionTitle: resolveSectionTitle(primary.pageIndex, { preferCurrent: true }),
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
  const resolvedSectionTitle = resolveSectionTitle(resolvedGroundingPageIndex, { preferCurrent: true })
  const resolvedSectionId = resolveSectionId(resolvedGroundingPageIndex, { preferCurrent: true })

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
  if (getWorksheetState().docId !== docId) {
    resetWorksheetStateForDocument(docId)
  }
  const [cards, glossaryTerms, walkthroughItems] = await Promise.all([
    getCards(docId),
    getGlossaryTerms(docId),
    getWalkthrough(docId)
  ])
  sidebarUiState.cards = cards.map((card) => normalizeCard(card))
  sidebarUiState.glossaryTerms = glossaryTerms
  sidebarUiState.glossarySuggestions = []
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
  if (!modeUiState.aiEnabled && payload?.type !== "highlight") {
    setStatus("Viewer mode is active. Switch to another mode to use AI actions.")
    return
  }

  if (payload?.type === "highlight") {
    const didHighlight = addOrMergeHighlightFromPayload(payload) || handleManualHighlightSelection()
    setStatus(didHighlight ? "Highlight added." : "Unable to highlight selection.")
    return
  }

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
  if (modeUiState.mode === "flow") {
    pendingCardAutoScrollId = finalCard.id
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
    if (action === "summarize-section") {
      void handleSummarizeCurrentSectionAction()
      return
    }
    if (action === "key-terms") {
      void handleKeyTermsSoFarAction()
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
    if (action === "create-top-level") {
      void buildWalkthroughFromOrientation({ forceRebuild: true })
      return
    }
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
    if (action === "jump-next") {
      const nextItem = getNextWalkthroughItem(normalizeWalkthroughItems(sidebarUiState.walkthrough.items))
      if (nextItem) {
        void jumpToSection(nextItem.pageIndex, nextItem.sectionTitle, "smooth")
      }
      return
    }
  }

  const worksheetButton = eventTarget.closest("button[data-worksheet-action]")
  if (worksheetButton && panel.contains(worksheetButton)) {
    const action = sanitizeText(worksheetButton.dataset.worksheetAction)
    if (action === "detect") {
      void ensureWorksheetQuestionsForCurrentDocument({ force: true })
      return
    }
    if (action === "toggle-parser-view") {
      const worksheetState = getWorksheetState()
      worksheetState.parserDebugVisible = !worksheetState.parserDebugVisible
      renderPanel()
      return
    }
    const question = getWorksheetQuestionById(worksheetButton.dataset.questionId)
    if (!question) {
      return
    }
    if (action === "jump") {
      void jumpToWorksheetQuestion(question)
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
    isEnabled: () => Boolean(modeUiState.aiEnabled && currentPdf && renderState.pdfDoc),
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

function syncReadingModeInputs(mode) {
  const normalizedMode = normalizeReadingMode(mode)
  if (readingModeViewerRadio instanceof HTMLInputElement) {
    readingModeViewerRadio.checked = normalizedMode === "viewer"
  }
  readingModeFlowRadio.checked = normalizedMode === "flow"
  readingModeStructureRadio.checked = normalizedMode === "structure"
  if (readingModeWorksheetRadio instanceof HTMLInputElement) {
    readingModeWorksheetRadio.checked = normalizedMode === "worksheet"
  }
}

function applySettingsToUi(settings) {
  currentSettings = settings;
  applyThemeToUi(settings.theme)

  const effectiveReadingMode = modeUiState.hasAppliedMode ? getActiveReadingMode() : "viewer"
  syncReadingModeInputs(effectiveReadingMode)
  setToolbarModeToggle(effectiveReadingMode)
  applyReadingMode(effectiveReadingMode, settings)

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
  if (debugModeToggle instanceof HTMLInputElement) {
    debugModeToggle.checked = Boolean(settings.debugMode)
  }
  setApiPresenceStatus(settings);
  updateContextScopeStatus();
  if (getActiveReadingMode() === "structure" && currentPdf && renderState.pdfDoc) {
    if (getOrientationState().status === "idle") {
      void generateOrientationForCurrentDocument(renderState.loadToken)
    }
    void runStructurePrewarmForCurrentDocument(renderState.loadToken)
  }
  if (currentPdf && renderState.pageNodes.length > 0) {
    renderPdfIntentOverlays()
    renderPdfWorksheetOverlays()
  }
  if (getActiveReadingMode() === "worksheet" && currentPdf && renderState.pdfDoc) {
    void ensureWorksheetQuestionsForCurrentDocument()
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
    theme: settings.theme,
    debugMode: Boolean(settings.debugMode),
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
  const scale = currentPdf?.scale != null ? currentPdf.scale : 1;
  pdfRoot.style.setProperty("--scale-factor", String(scale));
}

function isScaleEquivalent(leftScale, rightScale, tolerance = 0.01) {
  const left = Number(leftScale)
  const right = Number(rightScale)
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
    return false
  }
  return Math.abs(left - right) <= tolerance
}

function getPageShellRenderScale(pageShell) {
  if (pageShell instanceof HTMLElement) {
    const parsed = Number(pageShell.dataset.renderScale)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  const fallback = Number(currentPdf?.renderedScale || currentPdf?.scale || 1)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1
}

function setPageShellRenderScale(pageShell, scale) {
  if (!(pageShell instanceof HTMLElement)) {
    return
  }
  const normalizedScale = Number(scale)
  if (!Number.isFinite(normalizedScale) || normalizedScale <= 0) {
    return
  }
  pageShell.dataset.renderScale = String(normalizedScale)
  const pageSurface = pageShell.querySelector(".pdfPageSurface")
  if (pageSurface instanceof HTMLElement) {
    pageSurface.style.setProperty("--scale-factor", String(normalizedScale))
  }
}

function getPageVisualScaleRatio(pageShell) {
  if (!currentPdf) {
    return 1
  }
  const renderScale = getPageShellRenderScale(pageShell)
  const currentScale = Number(currentPdf.scale)
  if (!Number.isFinite(currentScale) || currentScale <= 0 || !Number.isFinite(renderScale) || renderScale <= 0) {
    return 1
  }
  return currentScale / renderScale
}

function getCurrentPageShell() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null
  }
  const pageNumber = Math.min(
    Math.max(Math.floor(Number(currentPdf.pageNumber) || 1), 1),
    Math.max(renderState.pageNodes.length, 1)
  )
  const pageShell = renderState.pageNodes[pageNumber - 1]
  if (pageShell instanceof HTMLElement) {
    return pageShell
  }
  return getFirstRenderedPageNode()
}

function getCurrentPageQualityState() {
  const currentScale = Number(currentPdf?.scale || 1)
  const pageShell = getCurrentPageShell()
  const renderScale = getPageShellRenderScale(pageShell)
  const ratio =
    Number.isFinite(currentScale) && currentScale > 0 && Number.isFinite(renderScale) && renderScale > 0
      ? currentScale / renderScale
      : 1
  const needsRerender = ratio > ZOOM_QUALITY_UPGRADE_THRESHOLD || ratio < ZOOM_QUALITY_DOWNGRADE_THRESHOLD
  return {
    currentScale: Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1,
    renderScale,
    ratio,
    needsRerender
  }
}

function clearPendingZoomQualityRerender() {
  if (renderState.zoomQualityTimer) {
    clearTimeout(renderState.zoomQualityTimer)
    renderState.zoomQualityTimer = null
  }
  renderState.pendingZoomQualityScale = null
  renderState.pendingZoomQualityAnchor = null
  renderState.pendingZoomQualityForce = false
}

function getRenderedPageCount() {
  let count = 0;
  for (const node of renderState.pageNodes) {
    if (node instanceof HTMLElement && node.dataset.rendered === "true") {
      count += 1;
    }
  }
  return count;
}

function getFirstRenderedPageNode() {
  let fallbackNode = null
  for (const node of renderState.pageNodes) {
    if (!(node instanceof HTMLElement)) {
      continue
    }
    if (!fallbackNode) {
      fallbackNode = node
    }
    if (node.dataset.rendered === "true") {
      return node;
    }
  }
  return fallbackNode;
}

function buildReseekRenderOrder(targetPageNumber, totalPages) {
  if (!Number.isFinite(totalPages) || totalPages <= 0) {
    return [];
  }
  const clampedTarget = Math.min(Math.max(Math.floor(Number(targetPageNumber) || 1), 1), totalPages);
  const order = [clampedTarget];
  let offset = 1;
  while (order.length < totalPages) {
    const above = clampedTarget - offset;
    const below = clampedTarget + offset;
    if (above >= 1) {
      order.push(above);
    }
    if (below <= totalPages) {
      order.push(below);
    }
    offset += 1;
  }
  return order;
}

function insertPageShellByPageNumber(pageShell, pageNumber) {
  let inserted = false;
  for (const child of Array.from(pdfRoot.children)) {
    const childPageNumber = Number(child?.dataset?.pageNumber);
    if (Number.isFinite(childPageNumber) && childPageNumber > pageNumber) {
      pdfRoot.insertBefore(pageShell, child);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    pdfRoot.append(pageShell);
  }
}

function readPageShellLayout(pageShell) {
  if (!(pageShell instanceof HTMLElement)) {
    return null
  }
  const pageSurface = pageShell.querySelector(".pdfPageSurface")
  const baseWidth =
    Number(pageShell.dataset.baseWidth) ||
    Number(pageSurface?.clientWidth) ||
    Number(pageSurface?.getBoundingClientRect?.().width) ||
    0
  const baseHeight =
    Number(pageShell.dataset.baseHeight) ||
    Number(pageSurface?.clientHeight) ||
    Number(pageSurface?.getBoundingClientRect?.().height) ||
    0
  if (!Number.isFinite(baseWidth) || !Number.isFinite(baseHeight) || baseWidth <= 0 || baseHeight <= 0) {
    return null
  }
  return {
    width: Math.max(baseWidth, 1),
    height: Math.max(baseHeight, 1)
  }
}

function capturePageLayoutSnapshot() {
  const snapshot = new Map()
  for (const pageNode of renderState.pageNodes) {
    if (!(pageNode instanceof HTMLElement)) {
      continue
    }
    const pageNumber = Number(pageNode.dataset.pageNumber)
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
      continue
    }
    const layout = readPageShellLayout(pageNode)
    if (!layout) {
      continue
    }
    const visualRatio = getPageVisualScaleRatio(pageNode)
    snapshot.set(pageNumber, {
      width: Math.max(layout.width * visualRatio, 1),
      height: Math.max(layout.height * visualRatio, 1)
    })
  }
  return snapshot
}

function createPageShell(pageNumber, options = {}) {
  const normalizedPageNumber = Number.isFinite(Number(pageNumber))
    ? Math.max(1, Math.floor(Number(pageNumber)))
    : 1
  const width = Number(options?.width)
  const height = Number(options?.height)
  const renderScale = Number(options?.renderScale)
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.max(width, 1) : 0
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.max(height, 1) : 0
  const safeRenderScale = Number.isFinite(renderScale) && renderScale > 0 ? renderScale : Number(currentPdf?.scale || 1)

  const pageShell = document.createElement("section")
  pageShell.className = "pdfPageShell"
  pageShell.dataset.pageNumber = String(normalizedPageNumber)
  pageShell.dataset.pageIndex = String(normalizedPageNumber - 1)
  pageShell.dataset.renderScale = String(Math.max(safeRenderScale, 0.1))
  pageShell.dataset.rendered = String(Boolean(options?.rendered))
  pageShell.dataset.renderState = options?.rendered ? "ready" : "placeholder"
  if (safeWidth > 0) {
    pageShell.dataset.baseWidth = String(safeWidth)
  }
  if (safeHeight > 0) {
    pageShell.dataset.baseHeight = String(safeHeight)
  }

  const pageSurface = document.createElement("div")
  pageSurface.className = "page pdfPageSurface"
  if (safeWidth > 0) {
    pageSurface.style.width = `${safeWidth}px`
  }
  if (safeHeight > 0) {
    pageSurface.style.height = `${safeHeight}px`
  }
  pageSurface.style.setProperty("--user-unit", "1")
  pageSurface.style.setProperty("--scale-factor", String(Math.max(safeRenderScale, 0.1)))
  pageSurface.dataset.mainRotation = "0"

  const canvas = document.createElement("canvas")
  canvas.className = "pdfPageCanvas"
  pageSurface.append(canvas)

  const textLayerDiv = document.createElement("div")
  textLayerDiv.className = "textLayer"
  textLayerDiv.dataset.mainRotation = "0"
  pageSurface.append(textLayerDiv)

  pageShell.append(pageSurface)
  return pageShell
}

function seedPageShellPlaceholders(totalPages, layoutSnapshot = new Map(), fallbackLayout = null) {
  if (!Number.isFinite(totalPages) || totalPages <= 0) {
    renderState.pageNodes = []
    return
  }

  const fallbackWidth = Number(fallbackLayout?.width)
  const fallbackHeight = Number(fallbackLayout?.height)
  const hasFallbackLayout =
    Number.isFinite(fallbackWidth) &&
    Number.isFinite(fallbackHeight) &&
    fallbackWidth > 0 &&
    fallbackHeight > 0

  renderState.pageNodes = new Array(totalPages)
  const pageRenderScale = Number(currentPdf?.scale || currentPdf?.renderedScale || 1)
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const layout = layoutSnapshot.get(pageNumber) || (hasFallbackLayout ? fallbackLayout : null)
    const pageShell = createPageShell(pageNumber, {
      width: layout?.width,
      height: layout?.height,
      renderScale: pageRenderScale,
      rendered: false
    })
    insertPageShellByPageNumber(pageShell, pageNumber)
    renderState.pageNodes[pageNumber - 1] = pageShell
  }
}

function findPageNodeForScrollY(scrollY) {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null
  }

  let activeNode = getFirstRenderedPageNode()
  if (!(activeNode instanceof HTMLElement)) {
    return null
  }

  for (const node of renderState.pageNodes) {
    if (!(node instanceof HTMLElement)) {
      continue
    }
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (scrollY >= top && scrollY <= bottom) {
      activeNode = node
      break
    }
    if (scrollY > top) {
      activeNode = node
    }
  }
  return activeNode
}

function getPageSurfaceScrollMetrics(pageNode) {
  if (!(pageNode instanceof HTMLElement)) {
    return { pageLeft: 0, pageWidth: 1 }
  }
  const pageSurface = pageNode.firstElementChild
  const rootRect = pdfRoot.getBoundingClientRect()
  const surfaceRect = pageSurface?.getBoundingClientRect?.()
  const pageLeft =
    Number.isFinite(surfaceRect?.left) && Number.isFinite(rootRect?.left)
      ? pdfRoot.scrollLeft + (surfaceRect.left - rootRect.left)
      : pageNode.offsetLeft + (pageSurface?.offsetLeft || 0)
  const pageWidth = Math.max(surfaceRect?.width || pageSurface?.getBoundingClientRect?.().width || 1, 1)
  return { pageLeft, pageWidth }
}

function captureViewportAnchorAtRootPoint(viewportX, viewportY) {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null
  }

  const rootWidth = Math.max(pdfRoot.clientWidth, 1)
  const rootHeight = Math.max(pdfRoot.clientHeight, 1)
  const clampedViewportX = clampNumber(Number(viewportX) || 0, 0, rootWidth)
  const clampedViewportY = clampNumber(Number(viewportY) || 0, 0, rootHeight)
  const scrollX = pdfRoot.scrollLeft + clampedViewportX
  const scrollY = pdfRoot.scrollTop + clampedViewportY

  const currentPageIndex = Math.max(0, Math.floor(Number(currentPdf.pageNumber || 1)) - 1)
  const preferredPageNode = renderState.pageNodes[currentPageIndex]
  const pageNode =
    preferredPageNode instanceof HTMLElement ? preferredPageNode : findPageNodeForScrollY(scrollY)
  if (!(pageNode instanceof HTMLElement)) {
    return null
  }

  const pageNumber = Number(pageNode.dataset.pageNumber || 1)
  const pageTop = pageNode.offsetTop
  const pageHeight = Math.max(pageNode.offsetHeight, 1)
  const { pageLeft, pageWidth } = getPageSurfaceScrollMetrics(pageNode)
  const pageYRatio = clampRatio((scrollY - pageTop) / pageHeight)
  const pageXRatio = clampRatio((scrollX - pageLeft) / pageWidth)
  const viewportYRatio = clampRatio(clampedViewportY / rootHeight)
  const viewportXRatio = clampRatio(clampedViewportX / rootWidth)

  return {
    pageNumber,
    pageYRatio,
    pageXRatio,
    viewportYRatio,
    viewportXRatio
  }
}

function captureViewportAnchorAtClientPoint(clientX, clientY) {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null
  }

  const rootRect = pdfRoot.getBoundingClientRect()
  const numericX = Number(clientX)
  const numericY = Number(clientY)
  if (!Number.isFinite(numericX) || !Number.isFinite(numericY)) {
    return null
  }
  const viewportX = numericX - rootRect.left
  const viewportY = numericY - rootRect.top
  return captureViewportAnchorAtRootPoint(viewportX, viewportY)
}

function captureViewportAnchor() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return null
  }
  return captureViewportAnchorAtRootPoint(pdfRoot.clientWidth / 2, pdfRoot.clientHeight / 2)
}

function restoreViewportAnchor(anchor) {
  if (!anchor || renderState.pageNodes.length === 0) {
    return
  }

  const pageNumber = Math.min(
    Math.max(Math.floor(Number(anchor.pageNumber || 1)), 1),
    Math.max(renderState.pageNodes.length, 1)
  )
  const pageNode = renderState.pageNodes[pageNumber - 1]
  if (!(pageNode instanceof HTMLElement)) {
    return
  }

  const pageYRatio = clampRatio(
    Number.isFinite(Number(anchor.pageYRatio)) ? Number(anchor.pageYRatio) : Number(anchor.yRatio ?? 0.5)
  )
  const pageXRatio = clampRatio(
    Number.isFinite(Number(anchor.pageXRatio)) ? Number(anchor.pageXRatio) : Number(anchor.xRatio ?? 0.5)
  )
  const viewportYRatio = clampRatio(Number(anchor.viewportYRatio ?? 0.5))
  const viewportXRatio = clampRatio(Number(anchor.viewportXRatio ?? 0.5))

  const pagePointY = pageNode.offsetTop + pageYRatio * Math.max(pageNode.offsetHeight, 1)
  const { pageLeft, pageWidth } = getPageSurfaceScrollMetrics(pageNode)
  const pagePointX = pageLeft + pageXRatio * pageWidth
  const nextScrollTop = Math.max(pagePointY - viewportYRatio * pdfRoot.clientHeight, 0)
  const nextScrollLeft = Math.max(pagePointX - viewportXRatio * pdfRoot.clientWidth, 0)
  const maxScrollTop = Math.max(pdfRoot.scrollHeight - pdfRoot.clientHeight, 0)
  const maxScrollLeft = Math.max(pdfRoot.scrollWidth - pdfRoot.clientWidth, 0)

  pdfRoot.scrollTop = Math.min(nextScrollTop, maxScrollTop)
  pdfRoot.scrollLeft = Math.min(nextScrollLeft, maxScrollLeft)
  setCurrentPage(pageNumber)
}

function applyVisualScaleToPageNode(node) {
  if (!currentPdf || !(node instanceof HTMLElement)) {
    return
  }
  const pageSurface = node.firstElementChild
  if (!(pageSurface instanceof HTMLElement)) {
    return
  }

  const baseWidth = Number(node.dataset.baseWidth || 0)
  const baseHeight = Number(node.dataset.baseHeight || 0)
  const renderScale = getPageShellRenderScale(node)
  const visualRatio = getPageVisualScaleRatio(node)
  const displayHeight = baseHeight > 0 ? Math.max(baseHeight * visualRatio, 1) : 0
  const displayWidth = baseWidth > 0 ? Math.max(baseWidth * visualRatio, 1) : 0

  if (baseWidth > 0 && baseHeight > 0) {
    node.style.height = `${displayHeight}px`
    node.style.minHeight = `${displayHeight}px`
    node.style.minWidth = !renderState.fitWidthEnabled && displayWidth > 0 ? `${displayWidth}px` : "0px"
    pageSurface.style.width = `${baseWidth}px`
    pageSurface.style.height = `${baseHeight}px`
  }

  setPageShellRenderScale(node, renderScale)
  pageSurface.style.transformOrigin = renderState.fitWidthEnabled ? "top left" : "top center"
  if (Math.abs(visualRatio - 1) > 0.0001) {
    pageSurface.style.transform = `scale(${visualRatio})`
    pageSurface.style.willChange = "transform"
  } else {
    pageSurface.style.transform = "none"
    pageSurface.style.willChange = "auto"
  }
}

function applyVisualScale() {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return
  }
  for (const node of renderState.pageNodes) {
    applyVisualScaleToPageNode(node)
  }
}

function needsZoomQualityRerender(scale = currentPdf?.scale, pageShell = getCurrentPageShell()) {
  if (!currentPdf || !renderState.pdfDoc) {
    return false
  }
  const targetScale = Number(scale)
  if (!Number.isFinite(targetScale) || targetScale <= 0) {
    return false
  }
  const pageRenderScale = getPageShellRenderScale(pageShell)
  const ratio = targetScale / pageRenderScale
  return ratio > ZOOM_QUALITY_UPGRADE_THRESHOLD || ratio < ZOOM_QUALITY_DOWNGRADE_THRESHOLD
}

function scheduleZoomQualityRerender(anchor = null, options = {}) {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }

  const force = Boolean(options?.force)
  const requestedScale = Number(options?.targetScale ?? currentPdf.scale)
  const targetScale = clampScale(requestedScale)
  const referencePage =
    Number(anchor?.pageNumber) > 0 ? renderState.pageNodes[Math.floor(anchor.pageNumber) - 1] : getCurrentPageShell()

  if (!force && !needsZoomQualityRerender(targetScale, referencePage)) {
    clearPendingZoomQualityRerender()
    updatePdfControls()
    return
  }

  renderState.pendingZoomQualityScale = targetScale
  renderState.pendingZoomQualityAnchor = anchor
  renderState.pendingZoomQualityForce = force

  if (renderState.zoomQualityTimer) {
    clearTimeout(renderState.zoomQualityTimer)
  }

  renderState.zoomQualityTimer = setTimeout(() => {
    renderState.zoomQualityTimer = null
    const pendingScale = Number(renderState.pendingZoomQualityScale)
    const pendingAnchor = renderState.pendingZoomQualityAnchor
    const pendingForce = Boolean(renderState.pendingZoomQualityForce)
    renderState.pendingZoomQualityScale = null
    renderState.pendingZoomQualityAnchor = null
    renderState.pendingZoomQualityForce = false
    if (!Number.isFinite(pendingScale) || pendingScale <= 0) {
      return
    }
    void rerenderForZoomQuality(pendingScale, pendingAnchor, { force: pendingForce })
  }, ZOOM_QUALITY_DEBOUNCE_MS)

  updatePdfControls()
}

async function rerenderForZoomQuality(targetScale, anchor = null, options = {}) {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }

  const normalizedTargetScale = clampScale(targetScale)
  const effectiveAnchor = anchor || captureViewportAnchor()
  const referencePage =
    Number(effectiveAnchor?.pageNumber) > 0
      ? renderState.pageNodes[Math.floor(effectiveAnchor.pageNumber) - 1]
      : getCurrentPageShell()
  const force = Boolean(options?.force)
  if (!force && !needsZoomQualityRerender(normalizedTargetScale, referencePage)) {
    updatePdfControls()
    return
  }

  const loadToken = renderState.loadToken
  const pdfDoc = renderState.pdfDoc
  const targetPageNumber = Math.min(
    Math.max(Math.floor(Number(effectiveAnchor?.pageNumber || currentPdf.pageNumber || 1)), 1),
    Math.max(pdfDoc.numPages, 1)
  )

  currentPdf.renderedScale = normalizedTargetScale
  const renderToken = ++renderState.renderToken
  resetLazyRenderState()
  cancelActiveRenderTask()
  renderState.lazyRenderEnabled = true
  ensureScaleFactor()
  updatePdfControls()

  const pageRenderOrder = buildReseekRenderOrder(targetPageNumber, pdfDoc.numPages)
  const initialOrder = pageRenderOrder.slice(0, Math.max(1, ZOOM_QUALITY_INITIAL_RENDER_COUNT))

  renderState.initialRenderInProgress = true
  try {
    for (const pageNumber of initialOrder) {
      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }
      await renderPageShellContent({
        pdfDoc,
        pageNumber,
        renderScale: normalizedTargetScale,
        loadToken,
        renderToken,
        anchor: effectiveAnchor,
        updateStatus: false,
        force: true
      })

      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }

      renderUserHighlightsForPage(pageNumber - 1)
    }

    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return
    }

    if (effectiveAnchor) {
      restoreViewportAnchor(effectiveAnchor)
    }

    connectPageObserver()
    renderPdfIntentOverlays()
    renderPdfWorksheetOverlays()
    updatePdfControls()
    if (isWorksheetMode()) {
      void ensureWorksheetQuestionsForCurrentDocument()
    }

    const remainingOrder = pageRenderOrder.slice(initialOrder.length)
    queueLazyPages(remainingOrder, { targetRenderScale: normalizedTargetScale })
    requestLazyRenderAroundPage(currentPdf.pageNumber || targetPageNumber, LAZY_RENDER_PRIORITY_RADIUS, {
      targetRenderScale: normalizedTargetScale
    })
    scheduleLazyRenderProcessing(loadToken, renderToken)
  } finally {
    renderState.initialRenderInProgress = false
  }
}

function setScalePreservingViewport(nextScale, options = {}) {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }

  const clampedScale = clampScale(nextScale)
  if (Math.abs(clampedScale - currentPdf.scale) < 0.0001) {
    return
  }

  const hasExplicitAnchor = Object.prototype.hasOwnProperty.call(options || {}, "anchor")
  const anchor =
    options.preserveCenter === false ? null : hasExplicitAnchor ? options.anchor : captureViewportAnchor()
  currentPdf.scale = clampedScale
  cancelActiveRenderTask()
  if (renderState.lazyRenderTimer) {
    clearTimeout(renderState.lazyRenderTimer)
    renderState.lazyRenderTimer = null
  }
  renderState.lazyRenderQueue = []
  renderState.lazyRenderQueueSet.clear()
  ensureScaleFactor()
  applyVisualScale()
  if (anchor) {
    restoreViewportAnchor(anchor)
  }
  updatePdfControls()
  scheduleZoomQualityRerender(anchor, {
    force: Boolean(options?.forceQualityRerender)
  })
}

function getPdfAvailableWidth() {
  const rootStyle = window.getComputedStyle(pdfRoot);
  const paddingX =
    Number.parseFloat(rootStyle.paddingLeft || "0") +
    Number.parseFloat(rootStyle.paddingRight || "0");
  return Math.max(pdfRoot.clientWidth - paddingX, 160);
}

function getRenderedPageDisplayWidth() {
  const firstNode = getFirstRenderedPageNode();
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
  const qualityState = hasDocument ? getCurrentPageQualityState() : null

  pageIndicatorEl.textContent = numPages ? `Page ${pageNumber} / ${numPages}` : "Page - / -";
  if (zoomIndicatorEl instanceof HTMLElement) {
    const zoomPercent = hasDocument ? `${Math.round(Math.max(Number(currentPdf?.scale || 1), 0.01) * 100)}%` : "--%";
    const isPending = Boolean(hasDocument && (renderState.zoomQualityTimer || qualityState?.needsRerender))
    zoomIndicatorEl.textContent = zoomPercent
    zoomIndicatorEl.classList.toggle("isPending", isPending)
    zoomIndicatorEl.title = hasDocument
      ? isPending
        ? `Zoom ${zoomPercent} (refining render quality)`
        : `Zoom ${zoomPercent}`
      : "Zoom"
  }
  prevPageBtn.disabled = !hasDocument || pageNumber <= 1;
  nextPageBtn.disabled = !hasDocument || pageNumber >= numPages;
  zoomOutBtn.disabled = !hasDocument || currentPdf.scale <= MIN_SCALE + 0.001;
  zoomInBtn.disabled = !hasDocument || currentPdf.scale >= MAX_SCALE - 0.001;
  fitWidthBtn.disabled = !hasDocument;
  highlighterToggleBtn.disabled = !hasDocument;
  if (downloadPdfBtn instanceof HTMLButtonElement) {
    downloadPdfBtn.disabled = !hasDocument;
  }
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
  if (renderState.activeTextLayer && typeof renderState.activeTextLayer.cancel === "function") {
    try {
      renderState.activeTextLayer.cancel();
    } catch (_error) {
      // Best effort.
    }
  }
  renderState.activeTextLayer = null;

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
  clearPendingZoomQualityRerender()
  pointerState.insidePdfRoot = false
  resetLazyRenderState()
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
  const didChange = currentPdf.pageNumber !== clamped
  if (currentPdf.pageNumber !== clamped) {
    currentPdf.pageNumber = clamped;
  }
  if (didChange && renderState.lazyRenderEnabled && !renderState.initialRenderInProgress) {
    requestLazyRenderAroundPage(clamped)
    scheduleLazyRenderProcessing(renderState.loadToken, renderState.renderToken)
  }
  syncSectionStatusForCurrentPage({ preferCurrent: true })
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
    if (!(node instanceof HTMLElement)) {
      continue
    }
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

  let hasObservedNode = false
  for (const node of renderState.pageNodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    hasObservedNode = true
    renderState.pageVisibility.set(Number(node.dataset.pageNumber), 0);
    renderState.visibilityObserver.observe(node);
  }

  if (!hasObservedNode) {
    disconnectPageObserver()
    return
  }

  updateCurrentPageFromScroll();
}

function scrollToPage(pageNumber, behavior = "smooth", options = {}) {
  if (!currentPdf || renderState.pageNodes.length === 0) {
    return;
  }

  const clamped = Math.min(Math.max(pageNumber, 1), currentPdf.numPages);
  const pageNode = renderState.pageNodes[clamped - 1];
  if (!pageNode) {
    return;
  }

  const align = options?.align === "center" ? "center" : "top"
  const centeredTop = pageNode.offsetTop + pageNode.offsetHeight / 2 - pdfRoot.clientHeight / 2
  const topAlignedTop = pageNode.offsetTop - 8
  const maxScrollTop = Math.max(pdfRoot.scrollHeight - pdfRoot.clientHeight, 0)
  const targetTop = Math.min(Math.max(align === "center" ? centeredTop : topAlignedTop, 0), maxScrollTop)
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

function isEditableEventTarget(target) {
  if (!(target instanceof Element)) {
    return false
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true
  }

  if (target.isContentEditable) {
    return true
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"))
}

function handleViewerKeydown(event) {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }
  if (event.defaultPrevented || event.isComposing) {
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return
  }
  if (isEditableEventTarget(event.target)) {
    return
  }

  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
    event.preventDefault()
    handleZoom(ZOOM_STEP)
    return
  }
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
    event.preventDefault()
    handleZoom(-ZOOM_STEP)
    return
  }
  if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
    event.preventDefault()
    void handleFitWidth()
    return
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault()
    scrollToPage(currentPdf.pageNumber - 1, "instant", { align: "center" })
    return
  }
  if (event.key === "ArrowRight") {
    event.preventDefault()
    scrollToPage(currentPdf.pageNumber + 1, "instant", { align: "center" })
  }
}

function getLoadedStatusText() {
  if (!currentPdf) {
    return "No PDF loaded";
  }
  return `Loaded: ${getLoadedStatusSourceShort()}`;
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

function isRenderPassCurrent(loadToken, renderToken) {
  return (
    loadToken === renderState.loadToken &&
    renderToken === renderState.renderToken &&
    Boolean(currentPdf) &&
    Boolean(renderState.pdfDoc)
  )
}

function resetLazyRenderState() {
  if (renderState.lazyRenderTimer) {
    clearTimeout(renderState.lazyRenderTimer)
    renderState.lazyRenderTimer = null
  }
  renderState.lazyRenderEnabled = false
  renderState.lazyRenderQueue = []
  renderState.lazyRenderQueueSet.clear()
  renderState.lazyRenderRunning = false
  renderState.initialRenderInProgress = false
}

function waitForIdleRenderSlice() {
  return new Promise((resolve) => {
    const requestIdle = globalThis?.requestIdleCallback
    if (typeof requestIdle === "function") {
      requestIdle(() => resolve(), { timeout: LAZY_RENDER_IDLE_TIMEOUT_MS })
      return
    }
    setTimeout(resolve, 0)
  })
}

function queueLazyPages(pageNumbers, { prioritize = false, targetRenderScale = null } = {}) {
  if (!renderState.lazyRenderEnabled || !currentPdf) {
    return
  }

  const source = Array.isArray(pageNumbers) ? pageNumbers : [pageNumbers]
  const normalizedTargetScale =
    Number.isFinite(Number(targetRenderScale)) && Number(targetRenderScale) > 0
      ? Number(targetRenderScale)
      : Number(currentPdf.renderedScale || currentPdf.scale || 1)
  const prioritized = []
  const appended = []

  for (const rawPageNumber of source) {
    const numeric = Number(rawPageNumber)
    if (!Number.isFinite(numeric)) {
      continue
    }
    const pageNumber = Math.min(Math.max(Math.floor(numeric), 1), currentPdf.numPages || 1)
    const pageShell = renderState.pageNodes[pageNumber - 1]
    if (pageShell instanceof HTMLElement && pageShell.dataset.rendered === "true") {
      const pageRenderScale = getPageShellRenderScale(pageShell)
      if (isScaleEquivalent(pageRenderScale, normalizedTargetScale)) {
        continue
      }
    }

    if (renderState.lazyRenderQueueSet.has(pageNumber)) {
      if (!prioritize) {
        continue
      }
      const existingIndex = renderState.lazyRenderQueue.indexOf(pageNumber)
      if (existingIndex >= 0) {
        renderState.lazyRenderQueue.splice(existingIndex, 1)
        prioritized.push(pageNumber)
      }
      continue
    }

    renderState.lazyRenderQueueSet.add(pageNumber)
    if (prioritize) {
      prioritized.push(pageNumber)
    } else {
      appended.push(pageNumber)
    }
  }

  if (prioritized.length > 0) {
    renderState.lazyRenderQueue = [...prioritized, ...renderState.lazyRenderQueue]
  }
  if (appended.length > 0) {
    renderState.lazyRenderQueue.push(...appended)
  }
}

function requestLazyRenderAroundPage(pageNumber, radius = LAZY_RENDER_PRIORITY_RADIUS, options = {}) {
  if (!renderState.lazyRenderEnabled || !currentPdf || !renderState.pdfDoc) {
    return
  }
  const center = Math.min(Math.max(Math.floor(Number(pageNumber) || 1), 1), currentPdf.numPages || 1)
  const priorityOrder = buildReseekRenderOrder(center, currentPdf.numPages || 0)
  const maxPriorityPages = Math.max(radius * 2 + 1, 1)
  queueLazyPages(priorityOrder.slice(0, maxPriorityPages), {
    prioritize: true,
    targetRenderScale: Number(options?.targetRenderScale || currentPdf.renderedScale || currentPdf.scale || 1)
  })
}

async function getFallbackPageLayout(pdfDoc, pageNumber, renderScale, loadToken, renderToken) {
  if (!pdfDoc || !isRenderPassCurrent(loadToken, renderToken)) {
    return null
  }
  let page = null
  try {
    page = await pdfDoc.getPage(pageNumber)
    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return null
    }
    const viewport = page.getViewport({ scale: renderScale })
    return {
      width: Math.max(viewport.width, 1),
      height: Math.max(viewport.height, 1)
    }
  } catch (_error) {
    return null
  } finally {
    try {
      page?.cleanup?.()
    } catch (_error) {
      // Best effort.
    }
  }
}

function computeCanvasOutputScale(pageWidth, pageHeight) {
  const baseScale = Number(window.devicePixelRatio || 1)
  const safeBaseScale = Number.isFinite(baseScale) && baseScale > 0 ? Math.min(baseScale, MAX_CANVAS_OUTPUT_SCALE) : 1
  const safeWidth = Math.max(Number(pageWidth) || 1, 1)
  const safeHeight = Math.max(Number(pageHeight) || 1, 1)
  const maxScaleByPixels = Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeHeight))
  const boundedScale = Math.min(safeBaseScale, maxScaleByPixels)
  if (!Number.isFinite(boundedScale) || boundedScale <= 0) {
    return 1
  }
  const lowerBound = Math.min(MIN_CANVAS_OUTPUT_SCALE, maxScaleByPixels)
  return Math.max(Math.min(boundedScale, safeBaseScale), lowerBound)
}

async function renderPageShellContent({
  pdfDoc,
  pageNumber,
  renderScale,
  loadToken,
  renderToken,
  anchor = null,
  updateStatus = false,
  force = false
}) {
  if (!isRenderPassCurrent(loadToken, renderToken)) {
    return false
  }
  if (!pdfDoc || !Number.isFinite(Number(pageNumber)) || pageNumber < 1) {
    return false
  }
  const normalizedRenderScale = Number(renderScale)
  if (!Number.isFinite(normalizedRenderScale) || normalizedRenderScale <= 0) {
    return false
  }

  const existingPageShell = renderState.pageNodes[pageNumber - 1]
  if (existingPageShell instanceof HTMLElement && existingPageShell.dataset.rendered === "true" && !force) {
    const existingScale = getPageShellRenderScale(existingPageShell)
    if (isScaleEquivalent(existingScale, normalizedRenderScale)) {
      return false
    }
  }

  if (updateStatus) {
    setStatus(`Loading page ${Math.max(getRenderedPageCount() + 1, 1)}/${pdfDoc.numPages}`)
  }
  logger.info("Render page i", { pageNumber })

  let page = null
  try {
    page = await pdfDoc.getPage(pageNumber)
    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return false
    }

    const viewport = page.getViewport({ scale: normalizedRenderScale })
    if (!renderState.baseViewportWidth) {
      renderState.baseViewportWidth = page.getViewport({ scale: 1 }).width
    }
    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return false
    }

    const pageWidth = Math.max(viewport.width, 1)
    const pageHeight = Math.max(viewport.height, 1)

    let pageShell = renderState.pageNodes[pageNumber - 1]
    if (!(pageShell instanceof HTMLElement)) {
      pageShell = createPageShell(pageNumber, {
        width: pageWidth,
        height: pageHeight,
        renderScale: normalizedRenderScale,
        rendered: false
      })
      insertPageShellByPageNumber(pageShell, pageNumber)
      renderState.pageNodes[pageNumber - 1] = pageShell
    }

    const pageSurface = pageShell.querySelector(".pdfPageSurface")
    const canvas = pageShell.querySelector(".pdfPageCanvas")
    const textLayerDiv = pageShell.querySelector(".textLayer")
    if (!(pageSurface instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement) || !(textLayerDiv instanceof HTMLElement)) {
      throw new Error("Unable to prepare page rendering surface.")
    }

    pageShell.dataset.baseWidth = String(pageWidth)
    pageShell.dataset.baseHeight = String(pageHeight)
    setPageShellRenderScale(pageShell, normalizedRenderScale)
    pageShell.dataset.rendered = "false"
    pageShell.dataset.renderState = "rendering"
    pageSurface.style.width = `${pageWidth}px`
    pageSurface.style.height = `${pageHeight}px`
    pageSurface.style.setProperty("--user-unit", String(viewport.userUnit || 1))
    pageSurface.style.setProperty("--scale-factor", String(normalizedRenderScale))
    pageSurface.dataset.mainRotation = String(viewport.rotation)
    textLayerDiv.innerHTML = ""
    textLayerDiv.dataset.mainRotation = String(viewport.rotation)

    const outputScale = computeCanvasOutputScale(pageWidth, pageHeight)
    canvas.width = Math.max(Math.floor(pageWidth * outputScale), 1)
    canvas.height = Math.max(Math.floor(pageHeight * outputScale), 1)
    canvas.style.width = `${pageWidth}px`
    canvas.style.height = `${pageHeight}px`

    const canvasContext =
      canvas.getContext("2d", { alpha: false, desynchronized: true }) || canvas.getContext("2d", { alpha: false })
    if (!canvasContext) {
      throw new Error("Unable to get 2D rendering context.")
    }
    canvasContext.imageSmoothingEnabled = true

    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    const renderTask = page.render({
      canvasContext,
      viewport,
      transform
    })
    renderState.activeRenderTask = renderTask

    try {
      await renderTask.promise
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        throw error
      }
      return false
    } finally {
      if (renderState.activeRenderTask === renderTask) {
        renderState.activeRenderTask = null
      }
    }

    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return false
    }

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true
      }),
      container: textLayerDiv,
      viewport
    })
    renderState.activeTextLayer = textLayer
    try {
      await textLayer.render()
    } catch (error) {
      if (error?.name !== "AbortException" && error?.name !== "RenderingCancelledException") {
        throw error
      }
      return false
    } finally {
      if (renderState.activeTextLayer === textLayer) {
        renderState.activeTextLayer = null
      }
    }
    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return false
    }

    const endOfContent = document.createElement("div")
    endOfContent.className = "endOfContent"
    textLayerDiv.append(endOfContent)
    pageShell.dataset.rendered = "true"
    pageShell.dataset.renderState = "ready"
    applyVisualScaleToPageNode(pageShell)
    if (currentPdf && typeof currentPdf === "object") {
      currentPdf.retrievalBlockCache = null
    }
    if (anchor && Number(anchor?.pageNumber) === pageNumber) {
      restoreViewportAnchor(anchor)
    }
    return true
  } finally {
    try {
      page?.cleanup?.()
    } catch (_error) {
      // Best effort.
    }
  }
}

function scheduleLazyRenderProcessing(loadToken, renderToken) {
  if (!renderState.lazyRenderEnabled || renderState.lazyRenderRunning || renderState.initialRenderInProgress) {
    return
  }
  if (renderState.lazyRenderTimer || renderState.lazyRenderQueue.length === 0) {
    return
  }

  renderState.lazyRenderTimer = setTimeout(() => {
    renderState.lazyRenderTimer = null
    void processLazyRenderQueue(loadToken, renderToken)
  }, 0)
}

async function processLazyRenderQueue(loadToken, renderToken) {
  if (renderState.lazyRenderRunning || !renderState.pdfDoc || !currentPdf) {
    return
  }
  renderState.lazyRenderRunning = true

  try {
    const pdfDoc = renderState.pdfDoc
    const renderScale = currentPdf.renderedScale || currentPdf.scale
    while (renderState.lazyRenderQueue.length > 0) {
      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }

      const pageNumber = renderState.lazyRenderQueue.shift()
      renderState.lazyRenderQueueSet.delete(pageNumber)
      if (!Number.isFinite(Number(pageNumber)) || pageNumber < 1) {
        continue
      }

      await waitForIdleRenderSlice()
      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }

      await renderPageShellContent({
        pdfDoc,
        pageNumber,
        renderScale,
        loadToken,
        renderToken,
        updateStatus: false
      })

      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }

      renderUserHighlightsForPage(pageNumber - 1)
      if ((currentPdf.pageNumber || 0) === pageNumber) {
        renderPdfIntentOverlays()
        renderPdfWorksheetOverlays()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } catch (error) {
    if (isRenderPassCurrent(loadToken, renderToken)) {
      logger.warn("Background page rendering failed", {
        message: error?.message || "Unknown error"
      })
    }
  } finally {
    renderState.lazyRenderRunning = false
    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return
    }

    updatePdfControls()
    if (renderState.lazyRenderQueue.length > 0) {
      scheduleLazyRenderProcessing(loadToken, renderToken)
      return
    }

    setStatus(getLoadedStatusText(), { title: getLoadedStatusTooltipText() })
    renderPdfIntentOverlays()
    renderPdfWorksheetOverlays()
    scheduleSectionRailRender()
  }
}

async function renderAllPages(targetPageNumber, loadToken, options = {}) {
  if (!renderState.pdfDoc || !currentPdf || loadToken !== renderState.loadToken) {
    return
  }

  const pdfDoc = renderState.pdfDoc
  const clampedTargetPageNumber = Math.min(
    Math.max(Math.floor(Number(targetPageNumber) || 1), 1),
    Math.max(pdfDoc.numPages, 1)
  )
  const pageRenderOrder = buildReseekRenderOrder(clampedTargetPageNumber, pdfDoc.numPages)
  const renderScale = currentPdf.scale
  currentPdf.renderedScale = renderScale
  const renderToken = ++renderState.renderToken
  clearPendingZoomQualityRerender()
  resetLazyRenderState()

  const layoutSnapshot = capturePageLayoutSnapshot()
  const fallbackLayout =
    layoutSnapshot.size < pdfDoc.numPages
      ? await getFallbackPageLayout(pdfDoc, clampedTargetPageNumber, renderScale, loadToken, renderToken)
      : null
  if (!isRenderPassCurrent(loadToken, renderToken)) {
    return
  }

  clearRenderedPages()
  renderState.lazyRenderEnabled = pdfDoc.numPages >= LAZY_RENDER_PAGE_THRESHOLD
  seedPageShellPlaceholders(pdfDoc.numPages, layoutSnapshot, fallbackLayout)
  ensureScaleFactor()
  updatePdfControls()
  connectPageObserver()
  if (options?.anchor) {
    restoreViewportAnchor(options.anchor)
  }

  const initialRenderCount = renderState.lazyRenderEnabled
    ? Math.min(pageRenderOrder.length, LAZY_RENDER_PRIORITY_RADIUS * 2 + 1)
    : pageRenderOrder.length
  const initialOrder = pageRenderOrder.slice(0, initialRenderCount)

  renderState.initialRenderInProgress = true
  try {
    for (const pageNumber of initialOrder) {
      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }
      await renderPageShellContent({
        pdfDoc,
        pageNumber,
        renderScale,
        loadToken,
        renderToken,
        anchor: options?.anchor,
        updateStatus: true
      })
    }

    if (!isRenderPassCurrent(loadToken, renderToken)) {
      return
    }

    connectPageObserver()
    applyVisualScale()
    ensureSelectionSystemInitialized()
    renderAllUserHighlights()

    if (renderState.fitWidthEnabled) {
      const correctedFitScale = await computeFitWidthScale(loadToken)
      if (correctedFitScale && Math.abs(correctedFitScale - currentPdf.scale) > 0.005) {
        setScalePreservingViewport(correctedFitScale, {
          preserveCenter: false,
          forceQualityRerender: true
        })
        pdfRoot.scrollLeft = 0
        return
      }
    }

    let restoredJump = false
    if (hasRecentJump()) {
      restoredJump = await restoreRecentJumpHighlightAfterRender()
      if (!isRenderPassCurrent(loadToken, renderToken)) {
        return
      }
    }

    if (!restoredJump) {
      if (options?.anchor) {
        restoreViewportAnchor(options.anchor)
      } else {
        scrollToPage(clampedTargetPageNumber, "instant")
      }
    }

    syncSectionStatusForCurrentPage({ preferCurrent: true })
    updatePdfControls()
    renderPdfIntentOverlays()
    renderPdfWorksheetOverlays()
    if (isWorksheetMode()) {
      void ensureWorksheetQuestionsForCurrentDocument()
    }
    scheduleSectionRailRender()

    if (!renderState.lazyRenderEnabled) {
      setStatus(getLoadedStatusText(), { title: getLoadedStatusTooltipText() })
      return
    }

    const remainingOrder = pageRenderOrder.slice(initialOrder.length)
    queueLazyPages(remainingOrder)
    requestLazyRenderAroundPage(currentPdf.pageNumber || clampedTargetPageNumber)
    scheduleLazyRenderProcessing(loadToken, renderToken)
  } finally {
    renderState.initialRenderInProgress = false
  }
}

function scheduleRender(targetPageNumber, loadToken = renderState.loadToken, options = {}) {
  renderChain = renderChain
    .then(async () => {
      if (loadToken !== renderState.loadToken) {
        return;
      }
      await renderAllPages(targetPageNumber, loadToken, options);
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

  resetHighlighterState()
  currentPdf = null;
  updateDocumentTitle();
  clearContextScopeTransientStatus();
  renderState.pdfDoc = null;
  renderState.loadingTask = null;
  renderState.baseViewportWidth = null;
  sidebarUiState.docId = "unknown";
  sidebarUiState.cards = [];
  sidebarUiState.glossaryTerms = [];
  sidebarUiState.glossarySuggestions = [];
  sidebarUiState.walkthrough = createWalkthroughUiState()
  resetWorksheetStateForDocument("unknown")
  sidebarUiState.toastMessage = ""
  resetOrientationStateForDocument()
  updateSectionStatus("")
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
  resetHighlighterState()

  if (selectionSystem) {
    selectionSystem.destroy();
    selectionSystem = null;
  }

  await disposeCurrentDocument();
  if (loadToken !== renderState.loadToken) {
    return;
  }

  await setReadingModeSetting("viewer")
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
    currentSectionTitle: "",
    currentSectionId: null,
    currentSectionKey: "",
    currentSectionPageIndex: null,
    retrievalBlockCache: null,
    readingMap: { sections: [] },
    pdfDocRef: null
  };
  updateDocumentTitle();
  clearContextScopeTransientStatus();
  sidebarUiState.docId = deriveDocId(currentPdf);
  sidebarUiState.cards = [];
  sidebarUiState.glossaryTerms = [];
  sidebarUiState.glossarySuggestions = [];
  sidebarUiState.walkthrough = createWalkthroughUiState()
  resetWorksheetStateForDocument(sidebarUiState.docId)
  sidebarUiState.toastMessage = ""
  resetOrientationStateForDocument()
  setOrientationLoading("Loading PDF...")
  updateSectionStatus("")
  ensureScaleFactor();
  updatePdfControls();
  renderPanel();
  showPdfMessage("Loading PDF...");

  const loadingTask = pdfjsLib.getDocument({
    ...documentParams,
    wasmUrl: PDFJS_WASM_BASE_URL,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS
  });
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
  await loadCardsForCurrentDocument();
  if (modeUiState.aiEnabled) {
    await ensureOutlineSectionsForCurrentDocument(loadToken);
    if (modeUiState.autoGenerateOnLoad) {
      void generateOrientationForCurrentDocument(loadToken);
    } else {
      void applyNonGeneratingOrientationForCurrentDocument(loadToken);
    }
    if (modeUiState.autoPrewarmOnLoad) {
      void runStructurePrewarmForCurrentDocument(loadToken)
    }
  } else {
    applyReadingMapToCurrentDocument([])
    setOrientationReady(createEmptyOrientationData())
    if (sidebarUiState.activeTab === "orientation") {
      renderPanel()
    }
  }
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

  const activeMode = getActiveReadingMode()
  setActiveTab(
    activeMode === "structure" ? "orientation" : activeMode === "worksheet" ? getWorksheetPreferredTab() : getFlowPreferredTab(),
    {
    fromModeApply: true
    }
  );
  setStatus(`Loading: ${getShortStatusLabel(file.name, 44)}`, { title: `Loading: ${file.name}` });

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
  const normalizedSrcUrl = normalizeRemotePdfSourceUrl(srcUrl)
  if (!normalizedSrcUrl) {
    showPdfMessage("Unsupported PDF URL. Use http(s), file://, or blob: URL.")
    setStatus("Unsupported PDF URL")
    logger.warn("Rejected unsupported remote PDF URL")
    return;
  }

  const isFileUrl = normalizedSrcUrl.toLowerCase().startsWith("file://");
  openedPdfSource = inferOpenedPdfSourceFromSrc(normalizedSrcUrl) || "remote";
  logger.info("Loading PDF remote: url (ok), but do not log tokens", {
    url: sanitizeUrlForLog(normalizedSrcUrl)
  });

  const activeMode = getActiveReadingMode()
  setActiveTab(
    activeMode === "structure" ? "orientation" : activeMode === "worksheet" ? getWorksheetPreferredTab() : getFlowPreferredTab(),
    {
    fromModeApply: true
    }
  );
  const remoteLabel = normalizePdfFilename(getFilenameFromUrl(normalizedSrcUrl)) || sanitizeUrlForLog(normalizedSrcUrl)
  setStatus(`Loading: ${getShortStatusLabel(remoteLabel, 44)}`, {
    title: isFileUrl
      ? `Loading file URL: ${sanitizeUrlForLog(normalizedSrcUrl)}`
      : `Loading: ${sanitizeUrlForLog(normalizedSrcUrl)}`
  });

  await loadPdfSource(
    {
      sourceType: "remote",
      filename: normalizePdfFilename(getFilenameFromUrl(normalizedSrcUrl)),
      url: normalizedSrcUrl
    },
    {
      url: normalizedSrcUrl
    }
  );
}

function downloadBlobBytes(bytes, filename = "document.pdf") {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return false
  }
  const blob = new Blob([bytes], { type: "application/pdf" })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = normalizePdfFilename(filename) || "document.pdf"
  link.rel = "noopener"
  link.style.display = "none"
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 5000)
  return true
}

function openSourcePdfForDownload(url) {
  const normalizedUrl = normalizeRemotePdfSourceUrl(url)
  if (!normalizedUrl) {
    return false
  }
  const link = document.createElement("a")
  link.href = normalizedUrl
  link.target = "_blank"
  link.rel = "noopener"
  link.style.display = "none"
  document.body.append(link)
  link.click()
  link.remove()
  return true
}

async function handleDownloadPdf() {
  if (!currentPdf) {
    return
  }

  const fallbackFilename = normalizePdfFilename(getCurrentPdfTitleLabel()) || "document.pdf"
  try {
    const { bytes, filename } = await getPdfBytes(currentPdf)
    const didStartDownload = downloadBlobBytes(bytes, filename || fallbackFilename)
    if (!didStartDownload) {
      throw new Error("Download bytes unavailable.")
    }
    setStatus(`Download started: ${getShortStatusLabel(filename || fallbackFilename, 44)}`)
  } catch (error) {
    if (currentPdf.sourceType === "remote" && openSourcePdfForDownload(currentPdf.url)) {
      setStatus("Opened source PDF in a new tab for browser download.")
      return
    }
    logger.warn("Failed to download PDF", { message: error?.message || "Unknown error" })
    setStatus("Failed to download PDF")
  }
}

function handleZoom(delta) {
  if (!currentPdf || !renderState.pdfDoc) {
    return;
  }

  setFitWidthEnabled(false);
  const pointerAnchor =
    pointerState.insidePdfRoot && Number.isFinite(pointerState.clientX) && Number.isFinite(pointerState.clientY)
      ? captureViewportAnchorAtClientPoint(pointerState.clientX, pointerState.clientY)
      : null
  setScalePreservingViewport(currentPdf.scale + delta, {
    anchor: pointerAnchor || captureViewportAnchor()
  });
}

function handlePdfWheel(event) {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }
  if (!(event.ctrlKey || event.metaKey)) {
    return
  }

  const deltaY = Number(event.deltaY || 0)
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 0.01) {
    return
  }

  event.preventDefault()
  pointerState.insidePdfRoot = true
  pointerState.clientX = Number(event.clientX) || 0
  pointerState.clientY = Number(event.clientY) || 0
  const pointerAnchor = captureViewportAnchorAtClientPoint(event.clientX, event.clientY)
  setFitWidthEnabled(false)
  const zoomFactor = Math.exp(-deltaY * 0.0018)
  setScalePreservingViewport(currentPdf.scale * zoomFactor, {
    anchor: pointerAnchor || captureViewportAnchor()
  })
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

  setScalePreservingViewport(fitScale, {
    preserveCenter: false,
    forceQualityRerender: true
  });
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
    setScalePreservingViewport(fitScale, {
      preserveCenter: false,
      forceQualityRerender: true
    });
    pdfRoot.scrollLeft = 0;
  });
}

async function handleThemeToggle() {
  const nextTheme = isDarkThemeEnabled() ? "light" : "dark"
  const settings = await setSettings({ theme: nextTheme })
  currentSettings = settings
  applyThemeToUi(settings.theme)
  if (sidebarUiState.activeTab && isTabVisible(sidebarUiState.activeTab)) {
    renderPanel()
  }
  logger.info("Theme changed", { theme: settings.theme })
}

async function setReadingModeSetting(nextMode) {
  const normalizedMode = normalizeReadingMode(nextMode)
  if (getActiveReadingMode() === normalizedMode) {
    return
  }
  syncReadingModeInputs(normalizedMode)
  setToolbarModeToggle(normalizedMode)
  applyReadingMode(normalizedMode, currentSettings || {})
  if (currentPdf && renderState.pdfDoc) {
    if (normalizedMode === "structure") {
      if (getOrientationState().status === "idle") {
        void generateOrientationForCurrentDocument(renderState.loadToken)
      }
      void runStructurePrewarmForCurrentDocument(renderState.loadToken)
    }
    if (normalizedMode === "worksheet") {
      void ensureWorksheetQuestionsForCurrentDocument()
    }
  }
  logger.info("Reading mode changed", { mode: normalizedMode })
}

async function handleReadingModeChange(event) {
  if (!event.target?.checked) {
    return
  }
  await setReadingModeSetting(event.target.value)
}

async function handleToolbarModeToggle(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-mode]") : null
  if (!(target instanceof HTMLButtonElement)) {
    return
  }
  await setReadingModeSetting(target.dataset.mode)
}

async function handleSummarizeCurrentSectionAction() {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }
  const sections = getReadingMapSections()
  const activeSectionKey = sanitizeText(currentPdf.currentSectionKey)
  const range = activeSectionKey
    ? getSectionRangeForSectionKey(activeSectionKey, sections, currentPdf.pageNumber || 1)
    : getCurrentSectionRange(currentPdf.pageNumber || 1, sections)
  const pageStart = Math.max(0, range.startPageIndex)
  const sectionSnippet = await getSectionSnippetFromRange(range, { maxPages: 2, maxChars: 1400 })
  if (!sectionSnippet) {
    setStatus("No section text available yet.")
    return
  }
  const sectionTitle = clampText(range.sectionTitle, 160) || `Page ${pageStart + 1}`
  const grounding = buildGrounding({
    pageIndex: pageStart,
    sectionId: range.sectionId,
    sectionTitle,
    selectedText: sectionTitle,
    contextWindow: sectionSnippet
  })
  const { response, warnings, providerUsed } = await generateLLM("explanation", {
    selectedText: sectionTitle,
    contextWindow: sectionSnippet,
    pageIndex: pageStart,
    readingMode: getReadingModeOrDefault()
  })
  const generatedCard = normalizeCard({
    id: makeId("card"),
    type: "explanation",
    title: `Section summary: ${sectionTitle}`,
    shortAnswer: response?.shortAnswer || `Summary for ${sectionTitle}`,
    details: {
      eli5: response?.eli5,
      steps: response?.steps || [],
      paperUsage: response?.paperUsage || []
    },
    grounding: {
      pageIndex: grounding.pageIndex,
      sectionId: grounding.sectionId,
      sectionTitle: grounding.sectionTitle,
      quote: grounding.quote
    },
    selectedText: sectionTitle,
    contextWindow: sectionSnippet,
    createdAt: Date.now(),
    meta: {
      provider: providerUsed,
      warnings: Array.isArray(warnings) ? warnings : []
    }
  })
  const docId = deriveDocId(currentPdf)
  sidebarUiState.docId = docId
  const persistedCard = await appendCard(docId, generatedCard)
  const finalCard = persistedCard ? normalizeCard(persistedCard) : generatedCard
  sidebarUiState.cards = [...sidebarUiState.cards, finalCard]
  pendingCardAutoScrollId = finalCard.id
  setActiveTab("explain")
  showPanelToast("Section summary added")
  syncSectionStatusForCurrentPage({ preferCurrent: true })
}

async function handleKeyTermsSoFarAction() {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }
  const currentPageIndex = Math.max(0, (currentPdf.pageNumber || 1) - 1)
  const startPageIndex = Math.max(0, currentPageIndex - 2)
  const parts = []
  for (let pageIndex = startPageIndex; pageIndex <= currentPageIndex; pageIndex += 1) {
    const pageText = await getPageText(renderState.pdfDoc, pageIndex)
    const text = sanitizeText(pageText)
    if (text) {
      parts.push(text)
    }
  }
  const snippet = truncateText(parts.join(" "), 1400)
  if (!snippet) {
    setStatus("No text available for key terms yet.")
    return
  }
  const sections = getReadingMapSections()
  const headings = sections
    .filter((section) => (parseOptionalPageIndex(section?.pageIndex) ?? 0) <= currentPageIndex)
    .map((section) => getSectionDisplayTitle(section))
    .filter(Boolean)
    .slice(0, 16)
  const { response } = await generateLLM("orientation", {
    title: currentPdf.filename || "Document",
    contextWindow: snippet,
    headings,
    readingMode: getReadingModeOrDefault()
  })
  const terms = Array.isArray(response?.keyTerms)
    ? response.keyTerms.map((term) => clampText(term, 48)).filter(Boolean).slice(0, 8)
    : []
  if (terms.length === 0) {
    setStatus("No key terms generated.")
    return
  }
  sidebarUiState.glossarySuggestions = [...new Set([...(sidebarUiState.glossarySuggestions || []), ...terms])].slice(
    0,
    24
  )
  if (sidebarUiState.activeTab === "glossary") {
    renderPanel()
  }
  setStatus(`Added ${terms.length} key terms`)
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
  if (!settings.openaiApiKey) {
    setApiStatus("Invalid key");
    logger.warn("Rejected OpenAI key format");
    return;
  }
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
  const highlightTarget =
    event.target instanceof Element ? event.target.closest(".userHighlightRect") : null
  if (highlightTarget instanceof HTMLButtonElement) {
    removeHighlightById(highlightTarget.dataset.highlightId)
    setStatus("Highlight removed.")
    return
  }

  const worksheetTarget =
    event.target instanceof Element ? event.target.closest("button[data-pdf-worksheet-action]") : null
  if (worksheetTarget instanceof HTMLButtonElement) {
    void handlePdfWorksheetOverlayClick(worksheetTarget)
    return
  }

  const target = event.target instanceof Element ? event.target.closest("button[data-pdf-intent-action]") : null
  if (!(target instanceof HTMLButtonElement)) {
    updateCurrentSectionFromPdfClick(event)
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

reopenSidebarBtn?.addEventListener("click", () => {
  setSidebarCollapsed(!sidebarState.collapsed);
});

sidebarResizeHandle.addEventListener("pointerdown", handleSidebarResizeStart);
sidebarResizeHandle.addEventListener("lostpointercapture", handleSidebarResizeEnd);

openFileBtn.addEventListener("click", () => fileInput.click());
downloadPdfBtn?.addEventListener("click", () => {
  void handleDownloadPdf();
});

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
  scrollToPage(currentPdf.pageNumber - 1, "instant", { align: "center" });
});

nextPageBtn.addEventListener("click", () => {
  if (!currentPdf) {
    return;
  }
  scrollToPage(currentPdf.pageNumber + 1, "instant", { align: "center" });
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

highlighterToggleBtn?.addEventListener("click", () => {
  if (!currentPdf || !renderState.pdfDoc) {
    return
  }
  const didHighlight = handleManualHighlightSelection()
  if (!didHighlight) {
    setStatus("Select text, then click Highlighter.")
  }
});
themeToggleBtn?.addEventListener("click", () => {
  void handleThemeToggle()
});

pdfRoot.addEventListener("scroll", handlePdfScroll, { passive: true });
pdfRoot.addEventListener("wheel", handlePdfWheel, { passive: false });
pdfRoot.addEventListener(
  "pointermove",
  (event) => {
    pointerState.insidePdfRoot = true
    pointerState.clientX = Number(event.clientX) || 0
    pointerState.clientY = Number(event.clientY) || 0
  },
  { passive: true }
);
pdfRoot.addEventListener(
  "pointerdown",
  (event) => {
    pointerState.insidePdfRoot = true
    pointerState.clientX = Number(event.clientX) || 0
    pointerState.clientY = Number(event.clientY) || 0
  },
  { passive: true }
);
pdfRoot.addEventListener("pointerleave", () => {
  pointerState.insidePdfRoot = false
});
pdfRoot.addEventListener("pointercancel", () => {
  pointerState.insidePdfRoot = false
});
window.addEventListener("resize", handleWindowResize);
document.addEventListener("keydown", handleViewerKeydown);

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

debugModeToggle?.addEventListener("change", async () => {
  const settings = await setSettings({ debugMode: Boolean(debugModeToggle.checked) })
  applySettingsToUi(settings)
  if (sidebarUiState.activeTab === "explain" && isWorksheetMode()) {
    renderPanel()
  }
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

readingModeViewerRadio?.addEventListener("change", handleReadingModeChange);
readingModeFlowRadio.addEventListener("change", handleReadingModeChange);
readingModeStructureRadio.addEventListener("change", handleReadingModeChange);
readingModeWorksheetRadio?.addEventListener("change", handleReadingModeChange);
toolbarModeViewerBtn?.addEventListener("click", (event) => {
  void handleToolbarModeToggle(event)
});
toolbarModeFlowBtn?.addEventListener("click", (event) => {
  void handleToolbarModeToggle(event)
});
toolbarModeStructureBtn?.addEventListener("click", (event) => {
  void handleToolbarModeToggle(event)
});
toolbarModeWorksheetBtn?.addEventListener("click", (event) => {
  void handleToolbarModeToggle(event)
});
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
const srcParam = params.get("src");
const src = normalizeRemotePdfSourceUrl(srcParam);
if (src) {
  openedPdfSource = inferOpenedPdfSourceFromSrc(src);
  logger.info("?src parameter detected", { source: openedPdfSource });
  logger.debug("?src parameter present", { source: openedPdfSource });
} else if (srcParam) {
  logger.warn("Rejected unsupported ?src parameter");
}

logger.info("Viewer loaded");
const startupStatePromise = Promise.all([loadVerboseState(), loadSettingsState()]);
void startupStatePromise.catch((error) => {
  logger.warn("Startup settings load failed", { message: error?.message || "Unknown error" })
});
setActiveTab(getFlowPreferredTab(), { fromModeApply: true });
ensureScaleFactor();
initializeSidebarState();
updatePdfControls();
updateDocumentTitle();
updateSectionStatus("");
if (src) {
  void startupStatePromise.then(() => loadPdfFromRemoteUrl(src));
} else if (srcParam) {
  showPdfMessage("Unsupported PDF URL. Use http(s), file://, or blob: URL.");
  setStatus("Unsupported PDF URL");
} else {
  setStatus("No PDF loaded");
}

