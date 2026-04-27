import { createLogger } from "../shared/diagnostics.js";
import { generateLLM } from "../shared/llm/index.js";
import { uploadFileToOpenAI, uploadPdfToOpenAI } from "../shared/openai/files.js";
import {
  expandDiscoveryFromSeedPaper,
  resolveImportedPaperLinks,
  searchDiscoveryCandidates
} from "../shared/paper_lookup.js";
import {
  addProjectPaper,
  archiveProject,
  buildLocalPaperFingerprint,
  clearOpenAIKey,
  buildProjectComparisonCacheKey,
  clearProjectComparisonsForProject,
  createProject,
  deleteProject,
  getActiveProjectId,
  getOpenAIFileId,
  getOrientationCache,
  getProjectById,
  getProjectComparison,
  getProjectPapers,
  getProjectPaperAnalyses,
  getProjects,
  getSettings,
  listProjectComparisons,
  removeProjectPaper,
  setActiveProjectId,
  setOpenAIFileId,
  setSettings,
  setProjectComparison,
  setProjectPaperAnalysis,
  touchProject,
  updateProject,
  updateProjectPaper
} from "../shared/storage.js";
import {
  appendProjectCitationGraph,
  applyScreenDecisionToPaper,
  dedupeProjectDiscoveryCandidates,
  enqueueProjectPipelineJob,
  getProjectCitationGraph,
  getProjectScreenReasonLibrary,
  getProjectScreeningMetrics,
  listProjectDiscoveryCandidates,
  listProjectPipelineJobs,
  listProjectSavedSearches,
  queueDiscoveryCandidateForScreening,
  removeProjectSavedSearch,
  saveProjectSavedSearch,
  setProjectScreenReasonLibrary,
  updateProjectPipelineJob,
  upsertProjectDiscoveryCandidates
} from "../shared/pipeline_storage.js";
import {
  getProjectMatrix,
  listMatrixTemplates,
  saveMatrixTemplate,
  setProjectMatrix,
  setProjectMatrixColumns,
  upsertProjectMatrixRow
} from "../shared/matrix_storage.js";
import {
  buildMatrixExportRows,
  computeMatrixDataHash,
  deriveCanonicalPaperFields,
  parseCsvRows,
  runMatrixClustering,
  serializeCsv
} from "../shared/matrix_utils.js";
import {
  connectGoogleOAuth,
  disconnectGoogleOAuth,
  getGoogleAccessToken,
  listGoogleSpreadsheets,
  listSheetTabs,
  syncMatrixToGoogleSheet
} from "../shared/google_sheets_sync.js";
import { buildXlsxBlob } from "../shared/xlsx_export.js";
import { buildLlmRuntimeStatus, LLM_RUNTIME_STATUS_EVENT } from "../shared/llm_runtime_status.js";

const logger = createLogger("HOME");
const MAX_COMPARE_PAPERS = 6;
const MAX_IMPORT_PAPERS = 140;
const MAX_IMPORT_TEXT_CHARS = 30000;
const IMPORT_SUPPORTED_EXTENSIONS = new Set([
  "pdf",
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "xls",
  "xlsx",
  "ods",
  "json",
  "jsonl",
  "doc",
  "docx",
  "rtf",
  "html",
  "htm",
  "xml",
  "tex",
  "bib",
  "bibtex",
  "ris"
]);
const IMPORT_SUPPORTED_EXACT_MIME_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/x-bibtex",
  "text/x-bibtex",
  "application/x-research-info-systems",
  "application/x-tex"
]);
const IMPORT_SUPPORTED_MIME_PREFIXES = ["text/"];
const TEXT_IMPORT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "html",
  "htm",
  "xml",
  "tex",
  "bib",
  "bibtex",
  "ris",
  "rtf"
]);
const CHECKLIST_PANEL_SEEN_STORAGE_KEY = "clarify-home-checklist-seen-v1";
const ACTIVE_VIEW_STORAGE_KEY = "clarify-home-active-view-v1";
const MATRIX_VIEW_STATE_STORAGE_KEY = "clarify-home-matrix-view-state-v1";
const HOME_NAV_STATE_STORAGE_KEY = "clarify-home-nav-state-v1";
const HOME_CHECKLIST_PROGRESS_STORAGE_KEY = "clarify-home-checklist-progress-v1";
const MATRIX_COLUMN_WIDTH_LIMITS = Object.freeze({
  paper: { default: 280, min: 220, max: 480 },
  source: { default: 118, min: 96, max: 220 },
  state: { default: 156, min: 130, max: 260 },
  criterion: { default: 220, min: 160, max: 560 },
  actions: { default: 188, min: 188, max: 188 }
});
const HOME_ICON_REGISTRY = Object.freeze({
  "open-viewer": "assets/icons/open.png",
  refresh: "assets/icons/regenerate.png",
  close: "assets/icons/home_icons/close-light.svg",
  settings: "assets/icons/home_icons/settings.svg",
  "add-project": "assets/icons/home_icons/add-project.svg",
  "more-vertical": "assets/icons/home_icons/more-vertical.svg",
  howto: "assets/icons/home_icons/howto.svg",
  "matrix-add-row": "assets/icons/home_icons/matrix-add-row.svg",
  "matrix-add-column": "assets/icons/home_icons/matrix-add-column.svg",
  "matrix-import-csv": "assets/icons/home_icons/matrix-import-csv.svg",
  "matrix-columns": "assets/icons/home_icons/matrix-columns.svg",
  "matrix-trash": "assets/icons/home_icons/matrix-trash.svg",
  "matrix-autofill": "assets/icons/home_icons/matrix-autofill.svg",
  "matrix-details": "assets/icons/home_icons/matrix-details.svg",
  "open-source": "assets/icons/home_icons/open-source.svg",
  "open-external": "assets/icons/home_icons/open-source.svg",
  "link-source": "assets/icons/home_icons/link-source.svg",
  "project-open": "assets/icons/home_icons/matrix-details.svg",
  "project-edit": "assets/icons/home_icons/link-source.svg",
  "project-archive": "assets/icons/home_icons/matrix-trash.svg",
  "project-delete": "assets/icons/home_icons/remove.svg",
  "queue-candidate": "assets/icons/home_icons/matrix-add-row.svg",
  "full-text": "assets/icons/home_icons/matrix-details.svg",
  include: "assets/icons/home_icons/restore.svg",
  exclude: "assets/icons/home_icons/remove.svg",
  "needs-info": "assets/icons/home_icons/link-source.svg",
  reverify: "assets/icons/home_icons/reverify.svg",
  "regenerate-tags": "assets/icons/home_icons/regenerate-tags.svg",
  duplicate: "assets/icons/home_icons/duplicate.svg",
  remove: "assets/icons/home_icons/remove.svg",
  restore: "assets/icons/home_icons/restore.svg",
  "hard-delete": "assets/icons/home_icons/hard-delete.svg",
  "move-left": "assets/icons/home_icons/move-left.svg",
  "move-right": "assets/icons/home_icons/move-right.svg",
  hide: "assets/icons/home_icons/hide.svg",
  show: "assets/icons/home_icons/show.svg",
  undo: "assets/icons/home_icons/undo.svg"
});
const HOME_ICON_MISSING_IDS = new Set();
const OPENAI_MODEL_PRESETS = Object.freeze(["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"]);
const DEFAULT_OPENAI_MODEL = OPENAI_MODEL_PRESETS[0];

const ui = {
  activeProjectLabel: document.getElementById("activeProjectLabel"),
  homeStatus: document.getElementById("homeStatus"),
  llmRuntimeFlag: document.getElementById("llmRuntimeFlag"),
  topTabButtons: document.querySelectorAll(".topTab[data-top-tab]"),
  pipelineMetricsSummary: document.getElementById("pipelineMetricsSummary"),
  pipelineQueueDiscover: document.getElementById("pipelineQueueDiscover"),
  pipelineQueueScreen: document.getElementById("pipelineQueueScreen"),
  pipelineQueueExtract: document.getElementById("pipelineQueueExtract"),
  pipelineQueueCompare: document.getElementById("pipelineQueueCompare"),
  pipelineQueuePosition: document.getElementById("pipelineQueuePosition"),
  pipelineStepButtons: document.querySelectorAll(".pipelineStep[data-view-target]"),
  workflowStageBar: document.getElementById("workflowStageBar"),
  insightsStageBar: document.getElementById("insightsStageBar"),
  workflowStageButtons: document.querySelectorAll("[data-workflow-stage]"),
  insightsStageButtons: document.querySelectorAll("[data-insights-stage]"),
  openTutorial: document.getElementById("openTutorial"),
  openHomeSettings: document.getElementById("openHomeSettings"),
  closeHomeSettings: document.getElementById("closeHomeSettings"),
  homeSettingsDrawer: document.getElementById("homeSettingsDrawer"),
  homeSettingsBackdrop: document.getElementById("homeSettingsBackdrop"),
  homeDensitySetting: document.getElementById("homeDensitySetting"),
  homeAccentSetting: document.getElementById("homeAccentSetting"),
  homeAdvancedCollapsedSetting: document.getElementById("homeAdvancedCollapsedSetting"),
  homeChecklistEnabledSetting: document.getElementById("homeChecklistEnabledSetting"),
  homeDefaultWorkflowStageSetting: document.getElementById("homeDefaultWorkflowStageSetting"),
  homeDefaultInsightsStageSetting: document.getElementById("homeDefaultInsightsStageSetting"),
  homeLlmModeSelect: document.getElementById("homeLlmModeSelect"),
  homeLlmModeOpenAIOption: document.getElementById("homeLlmModeOpenAIOption"),
  homeOpenaiModelPreset: document.getElementById("homeOpenaiModelPreset"),
  homeOpenaiModelCustomWrap: document.getElementById("homeOpenaiModelCustomWrap"),
  homeOpenaiModelCustom: document.getElementById("homeOpenaiModelCustom"),
  homeOpenaiApiKeyInput: document.getElementById("homeOpenaiApiKeyInput"),
  homeSaveApiKey: document.getElementById("homeSaveApiKey"),
  homeClearApiKey: document.getElementById("homeClearApiKey"),
  homeApiKeyStatus: document.getElementById("homeApiKeyStatus"),
  openChecklistFromWorkspace: document.getElementById("openChecklistFromWorkspace"),
  checklistDrawer: document.getElementById("checklistDrawer"),
  closeChecklist: document.getElementById("closeChecklist"),
  checklistBackdrop: document.getElementById("checklistBackdrop"),
  checklistList: document.getElementById("checklistList"),
  workspaceChecklistList: document.getElementById("workspaceChecklistList"),
  workspaceActivityList: document.getElementById("workspaceActivityList"),
  openViewer: document.getElementById("openViewer"),
  refreshAll: document.getElementById("refreshAll"),
  projectPane: document.getElementById("projectPane"),
  startPanel: document.getElementById("startPanel"),
  firstPaperPanel: document.getElementById("firstPaperPanel"),
  projectHomePanel: document.getElementById("projectHomePanel"),
  projectHomeTitle: document.getElementById("projectHomeTitle"),
  projectHomeSummary: document.getElementById("projectHomeSummary"),
  projectPaperStat: document.getElementById("projectPaperStat"),
  projectScreenStat: document.getElementById("projectScreenStat"),
  projectMatrixStat: document.getElementById("projectMatrixStat"),
  nextActionButton: document.getElementById("nextActionButton"),
  openProjectCreateHero: document.getElementById("openProjectCreateHero"),
  openImportReviewStart: document.getElementById("openImportReviewStart"),
  startSearchPapers: document.getElementById("startSearchPapers"),
  openImportReviewEmpty: document.getElementById("openImportReviewEmpty"),
  projectPaperUrlInputMirror: document.getElementById("projectPaperUrlInputMirror"),
  projectPaperUrlAddMirror: document.getElementById("projectPaperUrlAddMirror"),
  projectAddLocalPaperMirror: document.getElementById("projectAddLocalPaperMirror"),
  discoverPane: document.getElementById("discoverPane"),
  screenPane: document.getElementById("screenPane"),
  libraryPane: null,
  comparePane: document.getElementById("comparePane"),
  matrixPane: document.getElementById("matrixPane"),
  synthesisPane: document.getElementById("synthesisPane"),
  synthesisOverviewBlocks: document.getElementById("synthesisOverviewBlocks"),
  contributionSection: document.getElementById("contributionSection"),
  projectList: document.getElementById("projectList"),
  projectSwitcher: document.getElementById("projectSwitcher"),
  showArchivedToggle: document.getElementById("showArchivedToggle"),
  openProjectCreate: document.getElementById("openProjectCreate"),
  projectModal: document.getElementById("projectModal"),
  closeProjectModal: document.getElementById("closeProjectModal"),
  projectForm: document.getElementById("projectForm"),
  projectFormTitle: document.getElementById("projectFormTitle"),
  projectName: document.getElementById("projectName"),
  projectQuestion: document.getElementById("projectQuestion"),
  projectObjective: document.getElementById("projectObjective"),
  projectScope: document.getElementById("projectScope"),
  projectKeyTerms: document.getElementById("projectKeyTerms"),
  projectRubric: document.getElementById("projectRubric"),
  resetProjectForm: document.getElementById("resetProjectForm"),
  discoverMeta: document.getElementById("discoverMeta"),
  discoverKeywords: document.getElementById("discoverKeywords"),
  discoverMustHave: document.getElementById("discoverMustHave"),
  discoverExcludeTerms: document.getElementById("discoverExcludeTerms"),
  discoverYearFrom: document.getElementById("discoverYearFrom"),
  discoverYearTo: document.getElementById("discoverYearTo"),
  discoverVenueFilter: document.getElementById("discoverVenueFilter"),
  discoverTypeFilter: document.getElementById("discoverTypeFilter"),
  discoverRunSearch: document.getElementById("discoverRunSearch"),
  discoverMoreButton: document.getElementById("discoverMoreButton"),
  discoverAdvanced: document.getElementById("discoverAdvanced"),
  discoverSaveSearch: document.getElementById("discoverSaveSearch"),
  discoverRunSavedSearches: document.getElementById("discoverRunSavedSearches"),
  discoverDedupe: document.getElementById("discoverDedupe"),
  discoverSavedSearchSelect: document.getElementById("discoverSavedSearchSelect"),
  discoverLoadSavedSearch: document.getElementById("discoverLoadSavedSearch"),
  discoverRunSavedSearchNow: document.getElementById("discoverRunSavedSearchNow"),
  discoverDeleteSavedSearch: document.getElementById("discoverDeleteSavedSearch"),
  discoverSavedAutoEnabled: document.getElementById("discoverSavedAutoEnabled"),
  discoverSavedIntervalDays: document.getElementById("discoverSavedIntervalDays"),
  discoverGroupFilter: document.getElementById("discoverGroupFilter"),
  discoverSeedPaperSelect: document.getElementById("discoverSeedPaperSelect"),
  discoverCitationDirection: document.getElementById("discoverCitationDirection"),
  discoverExpandCitations: document.getElementById("discoverExpandCitations"),
  discoverRunReport: document.getElementById("discoverRunReport"),
  discoverTableWrap: document.getElementById("discoverTableWrap"),
  discoverGraphWrap: document.getElementById("discoverGraphWrap"),
  screenMeta: document.getElementById("screenMeta"),
  screenReasonSelect: document.getElementById("screenReasonSelect"),
  screenQualityScore: document.getElementById("screenQualityScore"),
  screenDecisionNote: document.getElementById("screenDecisionNote"),
  screenSuggestDecision: document.getElementById("screenSuggestDecision"),
  screenMoreButton: document.getElementById("screenMoreButton"),
  screenAdvanced: document.getElementById("screenAdvanced"),
  screenDecisionInclude: document.getElementById("screenDecisionInclude"),
  screenDecisionExclude: document.getElementById("screenDecisionExclude"),
  screenDecisionNeedsInfo: document.getElementById("screenDecisionNeedsInfo"),
  screenDecisionNext: document.getElementById("screenDecisionNext"),
  screenQueueWrap: document.getElementById("screenQueueWrap"),
  screenEvidencePane: document.getElementById("screenEvidencePane"),
  screenReasonCode: document.getElementById("screenReasonCode"),
  screenReasonLabel: document.getElementById("screenReasonLabel"),
  screenReasonDescription: document.getElementById("screenReasonDescription"),
  screenAddReason: document.getElementById("screenAddReason"),
  screenReasonLibraryList: document.getElementById("screenReasonLibraryList"),
  paperUrlInput: document.getElementById("paperUrlInput"),
  addPaperUrl: document.getElementById("addPaperUrl"),
  addLocalPaper: document.getElementById("addLocalPaper"),
  importTargetMode: document.getElementById("importTargetMode"),
  importLiteratureDocument: document.getElementById("importLiteratureDocument"),
  localPaperInput: document.getElementById("localPaperInput"),
  importDocumentInput: document.getElementById("importDocumentInput"),
  paperList: document.getElementById("paperList"),
  paperCount: document.getElementById("paperCount"),
  runCompare: document.getElementById("runCompare"),
  compareMeta: document.getElementById("compareMeta"),
  compareWarnings: document.getElementById("compareWarnings"),
  compareOutput: document.getElementById("compareOutput"),
  exportMarkdown: document.getElementById("exportMarkdown"),
  exportCsv: document.getElementById("exportCsv"),
  clearCompareCache: document.getElementById("clearCompareCache"),
  matrixMeta: document.getElementById("matrixMeta"),
  matrixSetupPanel: document.getElementById("matrixSetupPanel"),
  matrixSetupImportCsv: document.getElementById("matrixSetupImportCsv"),
  matrixSetupAddColumn: document.getElementById("matrixSetupAddColumn"),
  matrixStartBlank: document.getElementById("matrixStartBlank"),
  matrixSchemaHint: document.getElementById("matrixSchemaHint"),
  matrixQuickImportCsv: document.getElementById("matrixQuickImportCsv"),
  matrixQuickAddColumn: document.getElementById("matrixQuickAddColumn"),
  matrixQuickOpenSettings: document.getElementById("matrixQuickOpenSettings"),
  matrixGlobalFilter: document.getElementById("matrixGlobalFilter"),
  matrixAddRow: document.getElementById("matrixAddRow"),
  matrixToolbarAddColumn: document.getElementById("matrixToolbarAddColumn"),
  matrixToolbarImportCsv: document.getElementById("matrixToolbarImportCsv"),
  matrixOpenColumns: document.getElementById("matrixOpenColumns"),
  matrixOpenTrash: document.getElementById("matrixOpenTrash"),
  matrixDensitySelect: document.getElementById("matrixDensitySelect"),
  matrixUndoBar: document.getElementById("matrixUndoBar"),
  matrixUndoText: document.getElementById("matrixUndoText"),
  matrixUndoRestore: document.getElementById("matrixUndoRestore"),
  matrixClearFilters: document.getElementById("matrixClearFilters"),
  matrixShowExcluded: document.getElementById("matrixShowExcluded"),
  matrixRunAutofillAll: document.getElementById("matrixRunAutofillAll"),
  matrixMoreButton: document.getElementById("matrixMoreButton"),
  matrixAdvanced: document.getElementById("matrixAdvanced"),
  matrixRunClustering: document.getElementById("matrixRunClustering"),
  matrixExportCsv: document.getElementById("matrixExportCsv"),
  matrixExportXlsx: document.getElementById("matrixExportXlsx"),
  matrixTemplateSelect: document.getElementById("matrixTemplateSelect"),
  matrixApplyTemplate: document.getElementById("matrixApplyTemplate"),
  matrixSaveTemplate: document.getElementById("matrixSaveTemplate"),
  matrixImportCsv: document.getElementById("matrixImportCsv"),
  matrixImportCsvInput: document.getElementById("matrixImportCsvInput"),
  matrixAddColumn: document.getElementById("matrixAddColumn"),
  matrixSchemaList: document.getElementById("matrixSchemaList"),
  matrixTableWrap: document.getElementById("matrixTableWrap"),
  matrixCsvImportModal: document.getElementById("matrixCsvImportModal"),
  matrixCsvImportMeta: document.getElementById("matrixCsvImportMeta"),
  matrixCsvMappingWrap: document.getElementById("matrixCsvMappingWrap"),
  matrixConfirmCsvImport: document.getElementById("matrixConfirmCsvImport"),
  matrixCancelCsvImport: document.getElementById("matrixCancelCsvImport"),
  matrixCancelCsvImportSecondary: document.getElementById("matrixCancelCsvImportSecondary"),
  matrixAutofillModal: document.getElementById("matrixAutofillModal"),
  matrixAutofillPaperTitle: document.getElementById("matrixAutofillPaperTitle"),
  matrixAutofillIgnoreFilled: document.getElementById("matrixAutofillIgnoreFilled"),
  matrixAutofillOverwriteFilled: document.getElementById("matrixAutofillOverwriteFilled"),
  matrixAutofillCancel: document.getElementById("matrixAutofillCancel"),
  matrixAutofillClose: document.getElementById("matrixAutofillClose"),
  matrixRowDrawer: document.getElementById("matrixRowDrawer"),
  matrixRowDrawerTitle: document.getElementById("matrixRowDrawerTitle"),
  matrixRowDrawerBody: document.getElementById("matrixRowDrawerBody"),
  closeMatrixRowDrawer: document.getElementById("closeMatrixRowDrawer"),
  matrixColumnsDrawer: document.getElementById("matrixColumnsDrawer"),
  matrixColumnsDrawerList: document.getElementById("matrixColumnsDrawerList"),
  matrixColumnsAddCriterion: document.getElementById("matrixColumnsAddCriterion"),
  matrixColumnsImportCsv: document.getElementById("matrixColumnsImportCsv"),
  closeMatrixColumnsDrawer: document.getElementById("closeMatrixColumnsDrawer"),
  matrixTrashDrawer: document.getElementById("matrixTrashDrawer"),
  matrixTrashDrawerBody: document.getElementById("matrixTrashDrawerBody"),
  closeMatrixTrashDrawer: document.getElementById("closeMatrixTrashDrawer"),
  matrixDrawerBackdrop: document.getElementById("matrixDrawerBackdrop"),
  matrixClusterMeta: document.getElementById("matrixClusterMeta"),
  matrixClusterFilter: document.getElementById("matrixClusterFilter"),
  matrixClusterCanvas: document.getElementById("matrixClusterCanvas"),
  matrixGoogleClientId: document.getElementById("matrixGoogleClientId"),
  matrixGoogleApiKey: document.getElementById("matrixGoogleApiKey"),
  matrixConnectGoogle: document.getElementById("matrixConnectGoogle"),
  matrixDisconnectGoogle: document.getElementById("matrixDisconnectGoogle"),
  matrixSheetSearch: document.getElementById("matrixSheetSearch"),
  matrixLoadSheets: document.getElementById("matrixLoadSheets"),
  matrixSpreadsheetSelect: document.getElementById("matrixSpreadsheetSelect"),
  matrixWorksheetSelect: document.getElementById("matrixWorksheetSelect"),
  matrixAutoSyncToggle: document.getElementById("matrixAutoSyncToggle"),
  matrixSyncNow: document.getElementById("matrixSyncNow"),
  matrixSyncReport: document.getElementById("matrixSyncReport"),
  synthesisSummary: document.getElementById("synthesisSummary"),
  synthesisConsensus: document.getElementById("synthesisConsensus"),
  synthesisContradictions: document.getElementById("synthesisContradictions"),
  synthesisGaps: document.getElementById("synthesisGaps"),
  contributionMeta: document.getElementById("contributionMeta"),
  contributionClusters: document.getElementById("contributionClusters"),
  contributionZones: document.getElementById("contributionZones"),
  contributionIdeas: document.getElementById("contributionIdeas"),
  runContributionMap: document.getElementById("runContributionMap"),
  exportContributionMd: document.getElementById("exportContributionMd"),
  exportContributionCsv: document.getElementById("exportContributionCsv"),
  advancedDisclosures: document.querySelectorAll(".advancedDisclosure")
};

const state = {
  projects: [],
  activeProjectId: "",
  activeProject: null,
  papers: [],
  analysesByDocId: {},
  compareSelection: new Set(),
  comparison: null,
  comparisonWarnings: [],
  showArchived: false,
  editingProjectId: "",
  fileIdByDocId: new Map(),
  openaiFileUploadBlockedReason: "",
  settings: null,
  importInProgress: false,
  discoveryCandidates: [],
  savedSearches: [],
  screenReasonLibrary: [],
  screeningMetrics: null,
  pipelineJobs: [],
  citationGraph: { nodes: [], edges: [], updatedAt: Date.now() },
  discoverLastRunId: "",
  discoverLastRunWarnings: [],
  discoverGroupFilter: "all",
  discoverSelectedCandidateId: "",
  discoverSearchInProgress: false,
  screenSelectedPaperId: "",
  screeningSuggestBusy: false,
  contributionMap: null,
  contributionMapDirty: true,
  matrix: null,
  matrixTemplates: [],
  matrixCsvImport: null,
  matrixSelectedRowId: "",
  matrixDrawerMode: "",
  matrixLastRemoved: null,
  matrixDensity: "comfortable",
  matrixSetupDismissedByProjectId: {},
  matrixGlobalFilterText: "",
  matrixColumnFilters: {},
  matrixColumnWidths: {},
  matrixSortBy: "paper",
  matrixSortDir: "asc",
  matrixClusterFilter: "",
  matrixFiltersByProjectId: {},
  matrixFeatureDirty: true,
  matrixSyncInProgress: false,
  matrixSuggestedAutofillColumnId: "",
  matrixOps: {
    autofillAll: false,
    autofillColumn: false,
    clustering: false,
    applyTemplate: false,
    saveTemplate: false,
    importCsv: false,
    addColumn: false,
    googleAuth: false,
    loadSheets: false,
    loadTabs: false,
    sync: false
  },
  matrixRowBusyById: {},
  matrixAutoSyncTimer: null,
  matrixAutofillDialogResolve: null,
  googleSheetChoices: [],
  googleTabChoices: [],
  projectModalOpen: false,
  settingsDrawerOpen: false,
  checklistOpen: false,
  checklistByProjectId: {},
  activeTopTab: "workspace",
  activeWorkflowStage: "discover",
  activeInsightsStage: "compare",
  matrixShowExcluded: false,
  activeView: "project"
};
let homeApiStatusTimer = null;

function setStatus(message) {
  ui.homeStatus.textContent = message || "";
}

function maskApiKey(apiKey) {
  const trimmed = normalizeText(apiKey);
  if (!trimmed) {
    return "";
  }
  const tail = trimmed.slice(-4);
  return trimmed.startsWith("sk-") ? `sk-****${tail}` : `****${tail}`;
}

function setHomeApiPresenceStatus() {
  if (!(ui.homeApiKeyStatus instanceof HTMLElement)) {
    return;
  }
  if (!state.settings?.openaiApiKey) {
    ui.homeApiKeyStatus.textContent = "No key set";
    return;
  }
  ui.homeApiKeyStatus.textContent = `Key is set (${maskApiKey(state.settings.openaiApiKey)})`;
}

function setHomeApiStatus(text) {
  if (!(ui.homeApiKeyStatus instanceof HTMLElement)) {
    return;
  }
  ui.homeApiKeyStatus.textContent = text;
  if (homeApiStatusTimer) {
    clearTimeout(homeApiStatusTimer);
  }
  homeApiStatusTimer = setTimeout(() => {
    homeApiStatusTimer = null;
    setHomeApiPresenceStatus();
  }, 1400);
}

function renderLlmRuntimeFlag(status) {
  if (!(ui.llmRuntimeFlag instanceof HTMLElement)) {
    return;
  }
  const nextStatus = status && typeof status === "object" ? status : buildLlmRuntimeStatus({ settings: state.settings });
  const label = normalizeText(nextStatus.label) || "LLM status";
  const detail = normalizeText(nextStatus.detail) || label;
  const stateName = normalizeText(nextStatus.state) || "ready";
  ui.llmRuntimeFlag.textContent = label;
  ui.llmRuntimeFlag.title = detail;
  ui.llmRuntimeFlag.dataset.state = stateName;
  ui.llmRuntimeFlag.dataset.detail = detail;
  ui.llmRuntimeFlag.dataset.provider = normalizeText(nextStatus.providerUsed);
  ui.llmRuntimeFlag.dataset.task = normalizeText(nextStatus.task);
  ui.llmRuntimeFlag.dataset.reason = normalizeText(nextStatus.reason);
  ui.llmRuntimeFlag.setAttribute("aria-label", detail);
  ui.llmRuntimeFlag.setAttribute("role", "button");
  ui.llmRuntimeFlag.tabIndex = 0;
}

function buildLlmRuntimeFlagMessage() {
  if (!(ui.llmRuntimeFlag instanceof HTMLElement)) {
    return "";
  }
  const label = normalizeText(ui.llmRuntimeFlag.textContent) || "LLM status";
  const detail = normalizeText(ui.llmRuntimeFlag.dataset.detail || ui.llmRuntimeFlag.title);
  const reason = normalizeText(ui.llmRuntimeFlag.dataset.reason);
  const provider = normalizeText(ui.llmRuntimeFlag.dataset.provider);
  const task = normalizeText(ui.llmRuntimeFlag.dataset.task);
  const lines = [label];
  if (detail && detail !== label) {
    lines.push(detail);
  }
  if (reason && reason !== detail) {
    lines.push(`Reason: ${reason}`);
  }
  if (provider) {
    lines.push(`Provider: ${provider}`);
  }
  if (task) {
    lines.push(`Task: ${task}`);
  }
  return lines.join("\n");
}

function shouldShowLlmRuntimeFlagDetails() {
  const stateName = normalizeText(ui.llmRuntimeFlag?.dataset?.state);
  const reason = normalizeText(ui.llmRuntimeFlag?.dataset?.reason);
  return Boolean(reason || ["fallback", "quota", "rate_limit", "auth", "timeout", "error"].includes(stateName));
}

function handleLlmRuntimeFlagShortcut() {
  if (shouldShowLlmRuntimeFlagDetails()) {
    const message = buildLlmRuntimeFlagMessage();
    if (message) {
      setStatus(message.replace(/\n/g, " | "));
      return;
    }
  }
  openHomeApiSettingsShortcut();
}

function openHomeApiSettingsShortcut() {
  openHomeSettingsDrawer();
  if (ui.homeOpenaiApiKeyInput instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      ui.homeOpenaiApiKeyInput.scrollIntoView({ block: "center" });
      ui.homeOpenaiApiKeyInput.focus();
    });
  }
}

function getChecklistPanelSeen() {
  try {
    return globalThis?.localStorage?.getItem(CHECKLIST_PANEL_SEEN_STORAGE_KEY) === "1";
  } catch (_error) {
    return false;
  }
}

function setChecklistPanelSeen(value = true) {
  try {
    if (value) {
      globalThis?.localStorage?.setItem(CHECKLIST_PANEL_SEEN_STORAGE_KEY, "1");
    } else {
      globalThis?.localStorage?.removeItem(CHECKLIST_PANEL_SEEN_STORAGE_KEY);
    }
  } catch (_error) {
    // Ignore storage failures; checklist still works for current session.
  }
}

function normalizeTopTabName(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "workspace" || normalized === "workflow" || normalized === "insights") {
    return normalized;
  }
  return "workspace";
}

function normalizeWorkflowStageName(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "discover" || normalized === "screen" || normalized === "matrix") {
    return normalized;
  }
  return "discover";
}

function normalizeInsightsStageName(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "compare" || normalized === "synthesis" || normalized === "contribution") {
    return normalized;
  }
  return "compare";
}

function normalizeChecklistEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  return {
    createdProject: Boolean(source.createdProject),
    addedPaper: Boolean(source.addedPaper),
    ranDiscover: Boolean(source.ranDiscover),
    screenedOne: Boolean(source.screenedOne),
    ranMatrix: Boolean(source.ranMatrix)
  };
}

function getPersistedChecklistByProject() {
  try {
    const raw = globalThis?.localStorage?.getItem(HOME_CHECKLIST_PROGRESS_STORAGE_KEY) || "";
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [projectId, entry] of Object.entries(parsed)) {
      const normalizedProjectId = normalizeText(projectId);
      if (!normalizedProjectId) {
        continue;
      }
      out[normalizedProjectId] = normalizeChecklistEntry(entry);
    }
    return out;
  } catch (_error) {
    return {};
  }
}

function persistChecklistByProject(map) {
  try {
    const source = map && typeof map === "object" && !Array.isArray(map) ? map : {};
    const out = {};
    for (const [projectId, entry] of Object.entries(source)) {
      const normalizedProjectId = normalizeText(projectId);
      if (!normalizedProjectId) {
        continue;
      }
      out[normalizedProjectId] = normalizeChecklistEntry(entry);
    }
    globalThis?.localStorage?.setItem(HOME_CHECKLIST_PROGRESS_STORAGE_KEY, JSON.stringify(out));
  } catch (_error) {
    // Ignore storage failures; in-memory state still works.
  }
}

function getChecklistForProject(projectId) {
  const normalizedProjectId = normalizeText(projectId);
  if (!normalizedProjectId) {
    return normalizeChecklistEntry({});
  }
  return normalizeChecklistEntry(state.checklistByProjectId?.[normalizedProjectId]);
}

function setChecklistForProject(projectId, patch = {}) {
  const normalizedProjectId = normalizeText(projectId);
  if (!normalizedProjectId) {
    return;
  }
  const nextEntry = {
    ...getChecklistForProject(normalizedProjectId),
    ...(patch && typeof patch === "object" ? patch : {})
  };
  state.checklistByProjectId = {
    ...(state.checklistByProjectId || {}),
    [normalizedProjectId]: normalizeChecklistEntry(nextEntry)
  };
  persistChecklistByProject(state.checklistByProjectId);
}

function getPersistedHomeNavState() {
  try {
    const raw = globalThis?.localStorage?.getItem(HOME_NAV_STATE_STORAGE_KEY) || "";
    if (!raw) {
      return {
        activeTopTab: "workspace",
        activeWorkflowStage: "discover",
        activeInsightsStage: "compare"
      };
    }
    const parsed = JSON.parse(raw);
    return {
      activeTopTab: normalizeTopTabName(parsed?.activeTopTab),
      activeWorkflowStage: normalizeWorkflowStageName(parsed?.activeWorkflowStage),
      activeInsightsStage: normalizeInsightsStageName(parsed?.activeInsightsStage)
    };
  } catch (_error) {
    return {
      activeTopTab: "workspace",
      activeWorkflowStage: "discover",
      activeInsightsStage: "compare"
    };
  }
}

function persistHomeNavState() {
  try {
    globalThis?.localStorage?.setItem(
      HOME_NAV_STATE_STORAGE_KEY,
      JSON.stringify({
        activeTopTab: normalizeTopTabName(state.activeTopTab),
        activeWorkflowStage: normalizeWorkflowStageName(state.activeWorkflowStage),
        activeInsightsStage: normalizeInsightsStageName(state.activeInsightsStage)
      })
    );
  } catch (_error) {
    // Ignore storage failures; in-memory state still works.
  }
}

function normalizeViewName(viewName) {
  const normalized = normalizeText(viewName).toLowerCase();
  if (normalized === "project" || normalized === "discover" || normalized === "screen" || normalized === "matrix" || normalized === "compare" || normalized === "synthesis" || normalized === "contribution") {
    return normalized;
  }
  if (normalized === "library") {
    return "project";
  }
  return "project";
}

function getPersistedActiveView() {
  try {
    return normalizeViewName(globalThis?.localStorage?.getItem(ACTIVE_VIEW_STORAGE_KEY) || "project");
  } catch (_error) {
    return "project";
  }
}

function getMatrixColumnWidthLimits(columnKey) {
  const normalizedKey = normalizeText(columnKey);
  return MATRIX_COLUMN_WIDTH_LIMITS[normalizedKey] || MATRIX_COLUMN_WIDTH_LIMITS.criterion;
}

function normalizeMatrixColumnWidth(columnKey, value) {
  const limits = getMatrixColumnWidthLimits(columnKey);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return limits.default;
  }
  return Math.max(limits.min, Math.min(limits.max, Math.round(numeric)));
}

function normalizeMatrixColumnWidths(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const widths = {};
  for (const [columnKey, width] of Object.entries(source)) {
    const normalizedKey = truncateText(columnKey, 80);
    if (!normalizedKey || normalizedKey === "actions") {
      continue;
    }
    widths[normalizedKey] = normalizeMatrixColumnWidth(normalizedKey, width);
  }
  return widths;
}

function normalizeMatrixViewStateEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const rawColumnFilters =
    source.columnFilters && typeof source.columnFilters === "object" && !Array.isArray(source.columnFilters)
      ? source.columnFilters
      : {};
  const columnFilters = {};
  for (const [columnId, value] of Object.entries(rawColumnFilters)) {
    const normalizedColumnId = normalizeText(columnId);
    const normalizedValue = normalizeText(value);
    if (!normalizedColumnId || !normalizedValue) {
      continue;
    }
    columnFilters[normalizedColumnId] = truncateText(normalizedValue, 140);
  }
  return {
    globalFilter: truncateText(source.globalFilter, 160),
    clusterFilter: truncateText(source.clusterFilter, 40),
    columnFilters,
    columnWidths: normalizeMatrixColumnWidths(source.columnWidths),
    sortBy: truncateText(source.sortBy, 80) || "paper",
    sortDir: source.sortDir === "desc" ? "desc" : "asc"
  };
}

function getPersistedMatrixViewStateByProject() {
  try {
    const raw = globalThis?.localStorage?.getItem(MATRIX_VIEW_STATE_STORAGE_KEY) || "";
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [projectId, entry] of Object.entries(parsed)) {
      const normalizedProjectId = normalizeText(projectId);
      if (!normalizedProjectId) {
        continue;
      }
      out[normalizedProjectId] = normalizeMatrixViewStateEntry(entry);
    }
    return out;
  } catch (_error) {
    return {};
  }
}

function persistMatrixViewStateByProject(map) {
  try {
    const source = map && typeof map === "object" && !Array.isArray(map) ? map : {};
    const out = {};
    for (const [projectId, entry] of Object.entries(source)) {
      const normalizedProjectId = normalizeText(projectId);
      if (!normalizedProjectId) {
        continue;
      }
      out[normalizedProjectId] = normalizeMatrixViewStateEntry(entry);
    }
    globalThis?.localStorage?.setItem(MATRIX_VIEW_STATE_STORAGE_KEY, JSON.stringify(out));
  } catch (_error) {
    // Ignore storage failures; in-memory state still works.
  }
}

function setPersistedActiveView(viewName) {
  try {
    globalThis?.localStorage?.setItem(ACTIVE_VIEW_STORAGE_KEY, normalizeViewName(viewName));
  } catch (_error) {
    // Ignore storage failures; view state still works for current session.
  }
}

function getTopTabForView(viewName) {
  const normalized = normalizeViewName(viewName);
  if (normalized === "discover" || normalized === "screen" || normalized === "matrix") {
    return "workflow";
  }
  if (normalized === "compare" || normalized === "synthesis" || normalized === "contribution") {
    return "insights";
  }
  return "workspace";
}

function setActiveTopTab(tabName, { persist = true } = {}) {
  const normalizedTopTab = normalizeTopTabName(tabName);
  state.activeTopTab = normalizedTopTab;
  if (normalizedTopTab === "workspace") {
    setActiveView("project", { persist });
    return;
  }
  if (normalizedTopTab === "workflow") {
    setActiveView(normalizeWorkflowStageName(state.activeWorkflowStage), { persist });
    return;
  }
  setActiveView(normalizeInsightsStageName(state.activeInsightsStage), { persist });
}

function setActiveView(viewName, { persist = true } = {}) {
  const normalized = normalizeViewName(viewName);
  const paneView = normalized === "contribution" ? "synthesis" : normalized;
  const navView = normalized === "synthesis" || normalized === "contribution" ? "compare" : paneView;
  const topTab = getTopTabForView(normalized);
  state.activeTopTab = topTab;
  if (topTab === "workflow") {
    state.activeWorkflowStage = normalizeWorkflowStageName(normalized);
  }
  if (topTab === "insights") {
    state.activeInsightsStage = normalizeInsightsStageName(normalized);
  }
  state.activeView = normalized;
  const panes = {
    project: ui.projectPane,
    discover: ui.discoverPane,
    screen: ui.screenPane,
    matrix: ui.matrixPane,
    compare: ui.comparePane,
    synthesis: ui.synthesisPane
  };
  for (const [name, pane] of Object.entries(panes)) {
    if (!pane) {
      continue;
    }
    pane.classList.toggle("isActivePane", name === paneView);
  }
  if (ui.synthesisPane) {
    ui.synthesisPane.dataset.insightsMode = normalized === "contribution" ? "contribution" : "synthesis";
  }
  if (ui.synthesisOverviewBlocks instanceof HTMLElement) {
    ui.synthesisOverviewBlocks.hidden = normalized === "contribution";
  }
  if (ui.contributionSection instanceof HTMLElement) {
    ui.contributionSection.hidden = normalized !== "contribution";
  }
  if (ui.topTabButtons?.length) {
    for (const button of ui.topTabButtons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      const isActive = normalizeTopTabName(button.dataset.topTab || "") === topTab;
      button.classList.toggle("isActive", isActive);
      button.setAttribute("aria-current", isActive ? "page" : "false");
    }
  }
  if (ui.workflowStageBar) {
    ui.workflowStageBar.hidden = topTab !== "workflow";
  }
  if (ui.insightsStageBar) {
    ui.insightsStageBar.hidden = topTab !== "insights";
  }
  if (ui.workflowStageButtons?.length) {
    for (const button of ui.workflowStageButtons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      const isActive = normalizeWorkflowStageName(button.dataset.workflowStage || "") === state.activeWorkflowStage;
      button.classList.toggle("isActive", isActive);
    }
  }
  if (ui.insightsStageButtons?.length) {
    for (const button of ui.insightsStageButtons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      const isActive = normalizeInsightsStageName(button.dataset.insightsStage || "") === state.activeInsightsStage;
      button.classList.toggle("isActive", isActive);
    }
  }
  if (ui.pipelineStepButtons?.length) {
    for (const button of ui.pipelineStepButtons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      const isActive = normalizeViewName(button.getAttribute("data-view-target") || "") === navView;
      button.classList.toggle("isActive", isActive);
    }
  }
  if (persist) {
    setPersistedActiveView(normalized);
    persistHomeNavState();
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncateText(value, maxLength = 220) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(maxLength - 3, 1)).trim()}...`;
}

function normalizeOpenAIModelId(value) {
  const text = normalizeText(value);
  if (!text || text.length > 120) {
    return "";
  }
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    return "";
  }
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : "";
}

function getOpenAIModelPreset(modelId) {
  const normalized = normalizeOpenAIModelId(modelId);
  if (!normalized) {
    return DEFAULT_OPENAI_MODEL;
  }
  return OPENAI_MODEL_PRESETS.includes(normalized) ? normalized : "custom";
}

function syncHomeOpenAIModelControls() {
  if (!(ui.homeOpenaiModelPreset instanceof HTMLSelectElement)) {
    return;
  }
  const modelId = normalizeOpenAIModelId(state.settings?.openaiModel) || DEFAULT_OPENAI_MODEL;
  const preset = getOpenAIModelPreset(modelId);
  ui.homeOpenaiModelPreset.value = preset;
  const showCustom = preset === "custom";
  if (ui.homeOpenaiModelCustomWrap instanceof HTMLElement) {
    ui.homeOpenaiModelCustomWrap.hidden = !showCustom;
  }
  if (ui.homeOpenaiModelCustom instanceof HTMLInputElement) {
    ui.homeOpenaiModelCustom.hidden = !showCustom;
    ui.homeOpenaiModelCustom.disabled = !showCustom;
    ui.homeOpenaiModelCustom.value = showCustom ? modelId : "";
  }
}

function parseCommaList(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseLineList(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parseYearInput(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const year = Math.floor(numeric);
  if (year < 1800 || year > 2100) {
    return null;
  }
  return year;
}

function parseBoundedNumber(value, min = 0, max = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function normalizeScreenState(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (
    normalized === "candidate" ||
    normalized === "title_abstract_review" ||
    normalized === "full_text_review" ||
    normalized === "included" ||
    normalized === "excluded" ||
    normalized === "needs_info"
  ) {
    return normalized;
  }
  return "title_abstract_review";
}

function normalizeScreenDecision(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "include" || normalized === "exclude" || normalized === "needs_info" || normalized === "pending") {
    return normalized;
  }
  return "pending";
}

function isPaperScreenIncluded(paper) {
  const screenState = normalizeScreenState(paper?.screenState);
  return screenState === "included" || screenState === "needs_info";
}

function shouldAutoQueueMatrixForPaper(paper) {
  return isPaperScreenIncluded(paper);
}

function getProjectBrief(project) {
  if (!project) {
    return "";
  }
  const lines = [];
  if (project.researchQuestion) {
    lines.push(`Research question: ${project.researchQuestion}`);
  }
  if (project.objective) {
    lines.push(`Objective: ${project.objective}`);
  }
  if (project.scopeNotes) {
    lines.push(`Scope: ${project.scopeNotes}`);
  }
  return lines.join("\n");
}

function safeFileNameFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const fileName = decodeURIComponent(pathSegments[pathSegments.length - 1] || "");
    return fileName || parsed.hostname || "paper.pdf";
  } catch (_error) {
    return "paper.pdf";
  }
}

function normalizeSourceUrl(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "file:" && protocol !== "blob:") {
      return "";
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function sourceTypeFromUrl(urlString) {
  return urlString.toLowerCase().startsWith("file://") ? "file" : "remote";
}

function normalizeImportTargetMode(value) {
  return value === "new_project" ? "new_project" : "active_project";
}

function fileExtensionFromName(filename) {
  const name = normalizeText(filename);
  if (!name || !name.includes(".")) {
    return "";
  }
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

function guessImportMimeType(file) {
  const explicitType = normalizeText(file?.type);
  if (explicitType) {
    return explicitType;
  }
  const extension = fileExtensionFromName(file?.name || "");
  if (extension === "pdf") {
    return "application/pdf";
  }
  if (extension === "txt" || extension === "md" || extension === "markdown" || extension === "tex") {
    return "text/plain";
  }
  if (extension === "csv" || extension === "tsv") {
    return "text/csv";
  }
  if (extension === "json" || extension === "jsonl") {
    return "application/json";
  }
  if (extension === "html" || extension === "htm") {
    return "text/html";
  }
  if (extension === "xml") {
    return "application/xml";
  }
  if (extension === "bib") {
    return "application/x-bibtex";
  }
  if (extension === "bibtex") {
    return "text/x-bibtex";
  }
  if (extension === "ris") {
    return "application/x-research-info-systems";
  }
  if (extension === "rtf") {
    return "application/rtf";
  }
  if (extension === "doc") {
    return "application/msword";
  }
  if (extension === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === "xls") {
    return "application/vnd.ms-excel";
  }
  if (extension === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (extension === "ods") {
    return "application/vnd.oasis.opendocument.spreadsheet";
  }
  return "application/octet-stream";
}

function isSupportedImportFile(file) {
  if (!file) {
    return false;
  }
  const extension = fileExtensionFromName(file?.name || "");
  if (IMPORT_SUPPORTED_EXTENSIONS.has(extension)) {
    return true;
  }
  const mimeType = normalizeText(file?.type).toLowerCase();
  if (!mimeType) {
    return false;
  }
  if (IMPORT_SUPPORTED_EXACT_MIME_TYPES.has(mimeType)) {
    return true;
  }
  return IMPORT_SUPPORTED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
}

function isTextImportFile(file) {
  const type = normalizeText(file?.type).toLowerCase();
  if (type.startsWith("text/")) {
    return true;
  }
  if (type === "application/json" || type === "application/xml" || type === "application/rtf") {
    return true;
  }
  const extension = fileExtensionFromName(file?.name || "");
  return TEXT_IMPORT_EXTENSIONS.has(extension);
}

function normalizeImportText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/\u0000/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readImportTextSnippet(file, maxChars = MAX_IMPORT_TEXT_CHARS) {
  if (!file || !isTextImportFile(file)) {
    return "";
  }
  try {
    const text = normalizeImportText(await file.text());
    if (!text) {
      return "";
    }
    if (!Number.isFinite(maxChars) || maxChars < 1 || text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars).trim();
  } catch (_error) {
    return "";
  }
}

function baseNameFromFilename(filename) {
  const name = normalizeText(filename);
  if (!name) {
    return "Imported literature review";
  }
  const extension = fileExtensionFromName(name);
  if (!extension) {
    return name;
  }
  const suffix = `.${extension}`;
  if (!name.toLowerCase().endsWith(suffix.toLowerCase())) {
    return name;
  }
  return name.slice(0, Math.max(1, name.length - suffix.length));
}

function normalizeProjectRubricList(items) {
  const source = Array.isArray(items) ? items : [];
  return source.map((item) => normalizeText(item)).filter(Boolean).slice(0, 24);
}

function normalizeProjectKeyTermsList(items) {
  const source = Array.isArray(items) ? items : [];
  return source.map((item) => normalizeText(item)).filter(Boolean).slice(0, 32);
}

function buildProjectPayloadFromImport(importProject, fallbackDocumentName) {
  const source = importProject && typeof importProject === "object" ? importProject : {};
  const fallbackName = truncateText(baseNameFromFilename(fallbackDocumentName), 140) || "Imported literature review";
  return {
    name: truncateText(source.name, 140) || fallbackName,
    researchQuestion: truncateText(source.researchQuestion, 900),
    objective: truncateText(source.objective, 900),
    scopeNotes: truncateText(source.scopeNotes, 2200),
    keyTerms: normalizeProjectKeyTermsList(source.keyTerms),
    rubric: normalizeProjectRubricList(source.rubric)
  };
}

function normalizeImportedPaperStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "queued" || normalized === "reading" || normalized === "included" || normalized === "excluded") {
    return normalized;
  }
  return "queued";
}

function normalizeImportedPaperPriority(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 2;
  }
  return Math.max(1, Math.min(5, Math.floor(numeric)));
}

function buildImportedPaperTags(paper) {
  const sourceTags = Array.isArray(paper?.tags) ? paper.tags : [];
  const tags = new Set();
  for (const tag of sourceTags) {
    const normalizedTag = truncateText(normalizeText(tag), 44);
    if (normalizedTag) {
      tags.add(normalizedTag);
    }
  }
  const numericYear = Number(paper?.year);
  if (Number.isFinite(numericYear) && numericYear >= 1800 && numericYear <= 2100) {
    tags.add(String(Math.floor(numericYear)));
  }
  const confidence = normalizeText(paper?.confidence).toLowerCase();
  if (confidence === "low") {
    tags.add("needs-verification");
  }
  const source = normalizeText(paper?.resolutionSource);
  if (source && source !== "provided" && source !== "none" && source !== "error") {
    tags.add(truncateText(source.replace(/_/g, "-"), 44));
  }
  return Array.from(tags).slice(0, 20);
}

function buildLookupSearchUrl(paper) {
  const query = normalizeText(paper?.searchQuery || paper?.title);
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("searchtype", "all");
  return `https://arxiv.org/search/?${params.toString()}`;
}

function resolveImportedPaperUrl(paper) {
  const direct = normalizeSourceUrl(paper?.resolvedUrl || paper?.url || "");
  if (direct) {
    return direct;
  }
  const fallbackLookupUrl = buildLookupSearchUrl(paper);
  return normalizeSourceUrl(fallbackLookupUrl);
}

function updateImportControlsState() {
  const mode = normalizeImportTargetMode(ui.importTargetMode?.value);
  const hasActiveProject = Boolean(state.activeProjectId);

  if (ui.importTargetMode instanceof HTMLSelectElement) {
    const activeOption = ui.importTargetMode.querySelector('option[value="active_project"]');
    if (activeOption) {
      activeOption.disabled = !hasActiveProject;
    }
    if (!hasActiveProject && mode === "active_project") {
      ui.importTargetMode.value = "new_project";
    }
  }

  if (ui.importLiteratureDocument instanceof HTMLButtonElement) {
    ui.importLiteratureDocument.disabled = state.importInProgress;
    ui.importLiteratureDocument.textContent = state.importInProgress
      ? "Importing..."
      : "Import Review Document";
  }
}

function formatDate(value) {
  const date = new Date(Number(value) || Date.now());
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
}

function getAnalysisForPaper(paper) {
  if (!paper) {
    return null;
  }
  return state.analysesByDocId?.[paper.docId] || null;
}

function clearElement(el) {
  el.innerHTML = "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getHomeIconPath(iconId) {
  const normalizedIconId = normalizeText(iconId);
  if (!normalizedIconId || HOME_ICON_MISSING_IDS.has(normalizedIconId)) {
    return "";
  }
  const registeredPath = HOME_ICON_REGISTRY[normalizedIconId];
  if (!registeredPath) {
    return "";
  }
  return `../../${registeredPath}`;
}

function decorateButtonWithIcon(button, iconId, fallbackLabel = "") {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const path = getHomeIconPath(iconId);
  if (!path) {
    return;
  }
  const icon = document.createElement("img");
  icon.src = path;
  icon.alt = "";
  icon.width = 14;
  icon.height = 14;
  icon.loading = "lazy";
  icon.decoding = "async";
  icon.onerror = () => {
    const normalizedIconId = normalizeText(iconId);
    HOME_ICON_MISSING_IDS.add(normalizedIconId);
    icon.remove();
    if (!button.textContent?.trim()) {
      if (button.dataset.iconOnly === "1") {
        button.textContent = (fallbackLabel || "?").slice(0, 1).toUpperCase();
      } else {
        button.textContent = fallbackLabel || "Action";
      }
    }
  };
  if (button.dataset.iconOnly === "1") {
    button.textContent = "";
  }
  button.prepend(icon);
}

function applyStaticIcons() {
  const targets = [
    [ui.openTutorial, "howto"],
    [ui.openViewer, "open-viewer"],
    [ui.refreshAll, "refresh"],
    [ui.openHomeSettings, "settings"],
    [ui.openProjectCreate, "add-project"],
    [ui.discoverMoreButton, "more-vertical"],
    [ui.screenMoreButton, "more-vertical"],
    [ui.matrixMoreButton, "more-vertical"],
    [ui.closeChecklist, "close"],
    [ui.closeHomeSettings, "close"],
    [ui.closeProjectModal, "close"],
    [ui.closeMatrixRowDrawer, "close"],
    [ui.closeMatrixColumnsDrawer, "close"],
    [ui.closeMatrixTrashDrawer, "close"],
    [ui.matrixCancelCsvImport, "close"],
    [ui.matrixAutofillClose, "close"]
  ];
  for (const [element, iconId] of targets) {
    if (!(element instanceof HTMLButtonElement) || element.dataset.iconApplied === "1") {
      continue;
    }
    decorateButtonWithIcon(element, iconId, element.textContent || "");
    element.dataset.iconApplied = "1";
  }
}

function applyIconOnlyToExistingButton(button, label, iconId) {
  if (!(button instanceof HTMLButtonElement) || button.dataset.iconApplied === "1") {
    return;
  }
  button.textContent = "";
  button.classList.add("iconOnlyButton");
  button.dataset.iconOnly = "1";
  button.setAttribute("aria-label", label);
  button.title = label;
  decorateButtonWithIcon(button, iconId, label);
  if (!button.querySelector("img")) {
    button.textContent = label.slice(0, 1).toUpperCase();
  }
  button.dataset.iconApplied = "1";
}

function applyIconToExistingButton(button, label, iconId) {
  if (!(button instanceof HTMLButtonElement) || button.dataset.iconApplied === "1") {
    return;
  }
  button.textContent = "";
  button.dataset.iconId = iconId;
  decorateButtonWithIcon(button, iconId, label);
  const labelSpan = document.createElement("span");
  labelSpan.className = "buttonLabel";
  labelSpan.textContent = label;
  button.append(labelSpan);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.dataset.iconApplied = "1";
}

function applyMatrixActionIcons() {
  applyIconOnlyToExistingButton(ui.matrixAddRow, "Add row", "matrix-add-row");
  applyIconToExistingButton(ui.matrixToolbarAddColumn, "Add Criterion", "matrix-add-column");
  applyIconOnlyToExistingButton(ui.matrixToolbarImportCsv, "Import CSV", "matrix-import-csv");
  applyIconToExistingButton(ui.matrixOpenColumns, "Edit Columns", "matrix-columns");
  applyIconOnlyToExistingButton(ui.matrixOpenTrash, "Trash", "matrix-trash");
  applyIconToExistingButton(ui.matrixRunAutofillAll, "Auto-fill All", "matrix-autofill");
  applyIconOnlyToExistingButton(ui.matrixSetupImportCsv, "Import CSV", "matrix-import-csv");
  applyIconToExistingButton(ui.matrixSetupAddColumn, "Add Criterion", "matrix-add-column");
  applyIconOnlyToExistingButton(ui.matrixUndoRestore, "Undo", "undo");
}

function createButton(label, { action = "", id = "", className = "", disabled = false, iconId = "", title = "", iconOnly = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = iconOnly ? "" : label;
  if (action) {
    button.dataset.action = action;
  }
  if (id) {
    button.dataset.id = id;
  }
  if (className) {
    button.className = className;
  }
  if (iconOnly) {
    button.classList.add("iconOnlyButton");
    button.dataset.iconOnly = "1";
    button.setAttribute("aria-label", label);
  }
  if (title || label) {
    button.title = title || label;
  }
  button.disabled = Boolean(disabled);
  if (iconId) {
    decorateButtonWithIcon(button, iconId, label);
  }
  return button;
}

function applyHomeSettingsToDocument() {
  const density = normalizeText(state.settings?.homeDensity || "compact").toLowerCase();
  const accent = normalizeText(state.settings?.homeAccentPreset || "ocean").toLowerCase();
  document.body.dataset.density = density === "comfortable" ? "comfortable" : "compact";
  document.body.dataset.accent = accent === "forest" || accent === "sunset" ? accent : "ocean";
}

function syncHomeSettingsControls() {
  if (ui.homeDensitySetting instanceof HTMLSelectElement) {
    ui.homeDensitySetting.value = state.settings?.homeDensity === "comfortable" ? "comfortable" : "compact";
  }
  if (ui.homeAccentSetting instanceof HTMLSelectElement) {
    const accent = normalizeText(state.settings?.homeAccentPreset || "ocean").toLowerCase();
    ui.homeAccentSetting.value = accent === "forest" || accent === "sunset" ? accent : "ocean";
  }
  if (ui.homeAdvancedCollapsedSetting instanceof HTMLInputElement) {
    ui.homeAdvancedCollapsedSetting.checked = state.settings?.homeShowAdvancedCollapsedByDefault !== false;
  }
  if (ui.homeChecklistEnabledSetting instanceof HTMLInputElement) {
    ui.homeChecklistEnabledSetting.checked = state.settings?.homeChecklistEnabled !== false;
  }
  if (ui.homeDefaultWorkflowStageSetting instanceof HTMLSelectElement) {
    ui.homeDefaultWorkflowStageSetting.value = normalizeWorkflowStageName(state.settings?.homeDefaultWorkflowStage || "discover");
  }
  if (ui.homeDefaultInsightsStageSetting instanceof HTMLSelectElement) {
    ui.homeDefaultInsightsStageSetting.value = normalizeInsightsStageName(state.settings?.homeDefaultInsightsStage || "compare");
  }
  if (ui.homeLlmModeSelect instanceof HTMLSelectElement) {
    const hasOpenAIKey = Boolean(state.settings?.openaiApiKey);
    if (ui.homeLlmModeOpenAIOption instanceof HTMLOptionElement) {
      ui.homeLlmModeOpenAIOption.disabled = !hasOpenAIKey;
    }
    ui.homeLlmModeSelect.value = hasOpenAIKey || state.settings?.llmMode !== "openai" ? state.settings?.llmMode || "auto" : "auto";
  }
  syncHomeOpenAIModelControls();
  setHomeApiPresenceStatus();
}

function applyAdvancedDisclosureDefaults({ force = false } = {}) {
  const collapseByDefault = state.settings?.homeShowAdvancedCollapsedByDefault !== false;
  for (const disclosure of ui.advancedDisclosures || []) {
    if (!(disclosure instanceof HTMLDetailsElement)) {
      continue;
    }
    if (!force && disclosure.dataset.userTouched === "1") {
      continue;
    }
    disclosure.open = !collapseByDefault;
  }
}

function openHomeSettingsDrawer() {
  if (!(ui.homeSettingsDrawer instanceof HTMLElement) || !(ui.homeSettingsBackdrop instanceof HTMLElement)) {
    return;
  }
  state.settingsDrawerOpen = true;
  ui.homeSettingsDrawer.hidden = false;
  ui.homeSettingsBackdrop.hidden = false;
  document.body.classList.add("settingsOpen");
}

function closeHomeSettingsDrawer() {
  if (!(ui.homeSettingsDrawer instanceof HTMLElement) || !(ui.homeSettingsBackdrop instanceof HTMLElement)) {
    return;
  }
  state.settingsDrawerOpen = false;
  ui.homeSettingsDrawer.hidden = true;
  ui.homeSettingsBackdrop.hidden = true;
  document.body.classList.remove("settingsOpen");
}

function openChecklistDrawer() {
  if (!(ui.checklistDrawer instanceof HTMLElement) || !(ui.checklistBackdrop instanceof HTMLElement)) {
    return;
  }
  state.checklistOpen = true;
  ui.checklistDrawer.hidden = false;
  ui.checklistBackdrop.hidden = false;
  document.body.classList.add("checklistOpen");
}

function closeChecklistDrawer({ markSeen = true } = {}) {
  if (!(ui.checklistDrawer instanceof HTMLElement) || !(ui.checklistBackdrop instanceof HTMLElement)) {
    return;
  }
  state.checklistOpen = false;
  ui.checklistDrawer.hidden = true;
  ui.checklistBackdrop.hidden = true;
  document.body.classList.remove("checklistOpen");
  if (markSeen) {
    setChecklistPanelSeen(true);
  }
}

async function updateHomeSetting(patch) {
  state.settings = await setSettings(patch);
  applyHomeSettingsToDocument();
  syncHomeSettingsControls();
  renderLlmRuntimeFlag();
  if ("homeShowAdvancedCollapsedByDefault" in (patch || {})) {
    applyAdvancedDisclosureDefaults({ force: true });
  }
  if ("homeDefaultWorkflowStage" in (patch || {})) {
    state.activeWorkflowStage = normalizeWorkflowStageName(state.settings?.homeDefaultWorkflowStage || "discover");
    if (state.activeTopTab === "workflow") {
      setActiveTopTab("workflow", { persist: true });
      return;
    }
  }
  if ("homeDefaultInsightsStage" in (patch || {})) {
    state.activeInsightsStage = normalizeInsightsStageName(state.settings?.homeDefaultInsightsStage || "compare");
    if (state.activeTopTab === "insights") {
      setActiveTopTab("insights", { persist: true });
      return;
    }
  }
  renderAll();
}

async function handleHomeLlmModeChange() {
  if (!(ui.homeLlmModeSelect instanceof HTMLSelectElement)) {
    return;
  }
  const nextMode = normalizeText(ui.homeLlmModeSelect.value || "auto");
  if (nextMode === "openai" && !state.settings?.openaiApiKey) {
    ui.homeLlmModeSelect.value = state.settings?.llmMode || "auto";
    setHomeApiStatus("Set key first");
    return;
  }
  state.settings = await setSettings({ llmMode: nextMode === "mock" || nextMode === "openai" ? nextMode : "auto" });
  syncHomeSettingsControls();
  renderLlmRuntimeFlag();
  setStatus(`LLM mode changed to ${state.settings.llmMode}.`);
}

async function handleHomeOpenAIModelPresetChange() {
  if (!(ui.homeOpenaiModelPreset instanceof HTMLSelectElement)) {
    return;
  }
  const selectedPreset = normalizeText(ui.homeOpenaiModelPreset.value);
  if (selectedPreset === "custom") {
    if (ui.homeOpenaiModelCustomWrap instanceof HTMLElement) {
      ui.homeOpenaiModelCustomWrap.hidden = false;
    }
    if (ui.homeOpenaiModelCustom instanceof HTMLInputElement) {
      const existingModel =
        getOpenAIModelPreset(state.settings?.openaiModel) === "custom"
          ? normalizeOpenAIModelId(state.settings?.openaiModel)
          : "";
      ui.homeOpenaiModelCustom.hidden = false;
      ui.homeOpenaiModelCustom.disabled = false;
      ui.homeOpenaiModelCustom.value = existingModel;
      requestAnimationFrame(() => ui.homeOpenaiModelCustom?.focus());
    }
    return;
  }
  const nextModel = OPENAI_MODEL_PRESETS.includes(selectedPreset) ? selectedPreset : DEFAULT_OPENAI_MODEL;
  state.settings = await setSettings({ openaiModel: nextModel });
  syncHomeSettingsControls();
  setStatus(`OpenAI model changed to ${state.settings.openaiModel}.`);
}

async function handleHomeOpenAICustomModelCommit() {
  if (!(ui.homeOpenaiModelPreset instanceof HTMLSelectElement) || ui.homeOpenaiModelPreset.value !== "custom") {
    return;
  }
  const customModel = normalizeOpenAIModelId(ui.homeOpenaiModelCustom?.value);
  if (!customModel) {
    setHomeApiStatus("Enter a valid custom model id");
    return;
  }
  state.settings = await setSettings({ openaiModel: customModel });
  syncHomeSettingsControls();
  setStatus(`OpenAI model changed to ${state.settings.openaiModel}.`);
}

async function handleHomeSaveApiKey() {
  if (!(ui.homeOpenaiApiKeyInput instanceof HTMLInputElement)) {
    return;
  }
  const apiKey = ui.homeOpenaiApiKeyInput.value.trim();
  if (!apiKey) {
    setHomeApiStatus("Enter a key");
    return;
  }
  state.settings = await setSettings({ openaiApiKey: apiKey });
  state.fileIdByDocId.clear();
  state.openaiFileUploadBlockedReason = "";
  ui.homeOpenaiApiKeyInput.value = "";
  syncHomeSettingsControls();
  renderLlmRuntimeFlag();
  if (!state.settings?.openaiApiKey) {
    setHomeApiStatus("Invalid key");
    return;
  }
  setHomeApiStatus("Saved");
  setStatus("OpenAI API key saved.");
}

async function handleHomeClearApiKey() {
  await clearOpenAIKey();
  state.fileIdByDocId.clear();
  state.openaiFileUploadBlockedReason = "";
  state.settings = await getSettings();
  if (state.settings.llmMode === "openai") {
    state.settings = await setSettings({ llmMode: "auto" });
  }
  if (ui.homeOpenaiApiKeyInput instanceof HTMLInputElement) {
    ui.homeOpenaiApiKeyInput.value = "";
  }
  syncHomeSettingsControls();
  renderLlmRuntimeFlag();
  setHomeApiStatus("Key cleared");
  setStatus("OpenAI API key cleared.");
}

function deriveChecklistCompletion(projectId) {
  const existing = getChecklistForProject(projectId);
  const hasProject = Boolean(projectId);
  const hasPaper = Array.isArray(state.papers) && state.papers.length > 0;
  const hasDiscover = (Array.isArray(state.discoveryCandidates) && state.discoveryCandidates.length > 0) || existing.ranDiscover;
  const hasScreened = (Array.isArray(state.papers) && state.papers.some((paper) => normalizeScreenDecision(paper.screenDecision) !== "pending")) || existing.screenedOne;
  const matrixRows = getMatrixRows();
  const hasMatrix = matrixRows.some((row) => {
    const stateLabel = normalizeText(row?.autoFillState || "").toLowerCase();
    return stateLabel === "done" || stateLabel === "pending_source" || stateLabel === "failed" || Number(row?.lastVerifiedAt || 0) > 0;
  }) || existing.ranMatrix;
  return {
    createdProject: hasProject || existing.createdProject,
    addedPaper: hasPaper || existing.addedPaper,
    ranDiscover: hasDiscover,
    screenedOne: hasScreened,
    ranMatrix: hasMatrix
  };
}

function buildChecklistItems(projectId) {
  const progress = deriveChecklistCompletion(projectId);
  if (projectId) {
    setChecklistForProject(projectId, progress);
  }
  return [
    {
      id: "createdProject",
      label: "Start project",
      done: progress.createdProject,
      hint: "Create or select your project workspace.",
      actionLabel: progress.createdProject ? "Done" : "Take me there"
    },
    {
      id: "addedPaper",
      label: "Add first paper",
      done: progress.addedPaper,
      hint: "Add a URL, local PDF, or import a literature file.",
      actionLabel: progress.addedPaper ? "Done" : "Take me there"
    },
    {
      id: "ranDiscover",
      label: "Run discover",
      done: progress.ranDiscover,
      hint: "Run a query to build discovery candidates.",
      actionLabel: progress.ranDiscover ? "Done" : "Take me there"
    },
    {
      id: "screenedOne",
      label: "Screen one paper",
      done: progress.screenedOne,
      hint: "Make one include/exclude/needs-info decision.",
      actionLabel: progress.screenedOne ? "Done" : "Take me there"
    },
    {
      id: "ranMatrix",
      label: "Autofill matrix",
      done: progress.ranMatrix,
      hint: "Run extraction to fill table properties.",
      actionLabel: progress.ranMatrix ? "Done" : "Take me there"
    }
  ];
}

function renderChecklistInto(container, items) {
  if (!(container instanceof HTMLElement)) {
    return;
  }
  clearElement(container);
  for (const item of items) {
    const li = document.createElement("li");
    li.className = `checklistItem ${item.done ? "isDone" : ""}`;
    const row = document.createElement("div");
    row.className = "checklistRow";
    const label = document.createElement("span");
    label.className = "checklistLabel";
    label.textContent = item.label;
    const action = createButton(item.actionLabel, {
      action: "checklist-jump",
      id: item.id,
      className: item.done ? "buttonGhost" : "",
      disabled: item.done
    });
    row.append(label, action);
    const hint = document.createElement("p");
    hint.className = "checklistMeta";
    hint.textContent = item.hint;
    li.append(row, hint);
    container.append(li);
  }
}

function renderHomeChecklist() {
  if (ui.openChecklistFromWorkspace instanceof HTMLButtonElement) {
    ui.openChecklistFromWorkspace.disabled = state.settings?.homeChecklistEnabled === false;
  }
  if (!state.settings?.homeChecklistEnabled) {
    if (ui.workspaceChecklistList instanceof HTMLElement) {
      clearElement(ui.workspaceChecklistList);
    }
    if (ui.checklistList instanceof HTMLElement) {
      clearElement(ui.checklistList);
    }
    return;
  }
  const items = buildChecklistItems(state.activeProjectId);
  renderChecklistInto(ui.workspaceChecklistList, items);
  renderChecklistInto(ui.checklistList, items);
}

function renderWorkspaceActivity() {
  if (!(ui.workspaceActivityList instanceof HTMLElement)) {
    return;
  }
  clearElement(ui.workspaceActivityList);
  if (!state.activeProject) {
    const item = document.createElement("li");
    item.className = "subtleText";
    item.textContent = "Create or open a project to see activity.";
    ui.workspaceActivityList.append(item);
    return;
  }
  const entries = [
    `Project updated ${formatDate(state.activeProject.updatedAt)}`,
    `Papers in library: ${state.papers.length}`,
    `Discovery candidates: ${(state.discoveryCandidates || []).length}`,
    `Screen queue: ${getScreenQueuePapers().length}`,
    `Matrix rows: ${getMatrixRows().length}`
  ];
  for (const text of entries) {
    const item = document.createElement("li");
    item.className = "subtleText";
    item.textContent = text;
    ui.workspaceActivityList.append(item);
  }
}

function getIncludedOrNeedsInfoPaperCount() {
  return (Array.isArray(state.papers) ? state.papers : []).filter((paper) => isPaperScreenIncluded(paper)).length;
}

function getRecommendedProjectAction() {
  const paperCount = Array.isArray(state.papers) ? state.papers.length : 0;
  if (!state.activeProject) {
    return {
      label: "Create project",
      view: "project",
      summary: "Create or open a project to start a focused literature review."
    };
  }
  if (paperCount === 0) {
    return {
      label: "Add papers",
      view: "project",
      summary: "Search for papers, add a URL or PDF, or import a review document."
    };
  }
  const screenQueueCount = getScreenQueuePapers().length;
  if (screenQueueCount > 0) {
    return {
      label: "Review queue",
      view: "screen",
      summary: `${screenQueueCount} paper${screenQueueCount === 1 ? "" : "s"} waiting for include, exclude, or needs-info decisions.`
    };
  }
  const includedCount = getIncludedOrNeedsInfoPaperCount();
  const matrixRowCount = getActiveMatrixRows().length;
  const staleOrQueuedRows = getActiveMatrixRows().filter((row) => {
    const fillState = normalizeText(row?.autoFillState).toLowerCase();
    const verifyState = normalizeText(row?.verificationState).toLowerCase();
    return fillState === "queued" || fillState === "running" || verifyState === "stale";
  }).length;
  if (includedCount > 0 && (matrixRowCount < includedCount || staleOrQueuedRows > 0)) {
    return {
      label: "Fill matrix",
      view: "matrix",
      summary: "Included papers are ready for structured extraction into the matrix."
    };
  }
  if (includedCount >= 2) {
    return {
      label: "Compare papers",
      view: "compare",
      summary: "You have enough included papers to compare methods, evidence, and contribution space."
    };
  }
  return {
    label: "Find more papers",
    view: "discover",
    summary: "Add or discover more candidates before running deeper insights."
  };
}

function renderStoryboardPanels() {
  const hasProject = Boolean(state.activeProject);
  const paperCount = Array.isArray(state.papers) ? state.papers.length : 0;
  const hasPapers = paperCount > 0;

  document.body.classList.toggle("hasProject", hasProject);
  document.body.classList.toggle("hasPapers", hasPapers);

  if (!hasProject && state.activeView !== "project") {
    setActiveView("project", { persist: false });
  } else if (hasProject && !hasPapers && state.activeView !== "project" && state.activeView !== "discover") {
    setActiveView("project", { persist: false });
  }

  if (ui.startPanel instanceof HTMLElement) {
    ui.startPanel.hidden = hasProject;
  }
  if (ui.firstPaperPanel instanceof HTMLElement) {
    ui.firstPaperPanel.hidden = !hasProject || hasPapers;
  }
  if (ui.projectHomePanel instanceof HTMLElement) {
    ui.projectHomePanel.hidden = !hasProject || !hasPapers;
  }

  const action = getRecommendedProjectAction();
  if (ui.projectHomeTitle instanceof HTMLElement) {
    ui.projectHomeTitle.textContent = state.activeProject?.name || "Keep moving.";
  }
  if (ui.projectHomeSummary instanceof HTMLElement) {
    ui.projectHomeSummary.textContent = action.summary;
  }
  if (ui.nextActionButton instanceof HTMLButtonElement) {
    ui.nextActionButton.textContent = action.label;
    ui.nextActionButton.dataset.viewTarget = action.view;
    ui.nextActionButton.disabled = !hasProject;
  }

  const screenQueueCount = getScreenQueuePapers().length;
  const includedCount = getIncludedOrNeedsInfoPaperCount();
  const matrixRowCount = getActiveMatrixRows().length;
  if (ui.projectPaperStat instanceof HTMLElement) {
    ui.projectPaperStat.textContent = `${paperCount} paper${paperCount === 1 ? "" : "s"}`;
  }
  if (ui.projectScreenStat instanceof HTMLElement) {
    ui.projectScreenStat.textContent = `${screenQueueCount} to screen`;
  }
  if (ui.projectMatrixStat instanceof HTMLElement) {
    ui.projectMatrixStat.textContent = `${matrixRowCount}/${includedCount} matrix`;
  }

  for (const button of ui.pipelineStepButtons || []) {
    if (!(button instanceof HTMLButtonElement)) {
      continue;
    }
    const target = normalizeViewName(button.getAttribute("data-view-target") || "");
    button.disabled = target !== "project" && !hasProject;
  }
}

function jumpToChecklistStep(stepId) {
  const normalizedStepId = normalizeText(stepId);
  if (normalizedStepId === "createdProject") {
    setActiveTopTab("workspace", { persist: true });
    if (!state.activeProjectId) {
      openProjectModal(null);
    }
    return;
  }
  if (normalizedStepId === "addedPaper") {
    setActiveTopTab("workspace", { persist: true });
    ui.paperUrlInput?.focus();
    return;
  }
  if (normalizedStepId === "ranDiscover") {
    setActiveView("discover");
    ui.discoverKeywords?.focus();
    return;
  }
  if (normalizedStepId === "screenedOne") {
    setActiveView("screen");
    return;
  }
  if (normalizedStepId === "ranMatrix") {
    setActiveView("matrix");
  }
}

function isMatrixOpRunning(opName) {
  return Boolean(state.matrixOps?.[opName]);
}

function setMatrixOpRunning(opName, isRunning) {
  if (!opName) {
    return;
  }
  state.matrixOps = {
    ...(state.matrixOps || {}),
    [opName]: Boolean(isRunning)
  };
}

function hasMatrixFiltersApplied() {
  const hasGlobal = Boolean(normalizeText(state.matrixGlobalFilterText));
  const hasCluster = Boolean(normalizeText(state.matrixClusterFilter));
  const hasColumnFilters = Object.values(state.matrixColumnFilters || {}).some((value) => Boolean(normalizeText(value)));
  return hasGlobal || hasCluster || hasColumnFilters;
}

function clearMatrixFilters({ includeSort = false } = {}) {
  state.matrixGlobalFilterText = "";
  state.matrixClusterFilter = "";
  state.matrixColumnFilters = {};
  if (includeSort) {
    state.matrixSortBy = "paper";
    state.matrixSortDir = "asc";
  }
}

function rememberMatrixFiltersForActiveProject() {
  const projectKey = normalizeText(state.activeProjectId);
  if (!projectKey) {
    return;
  }
  const entry = normalizeMatrixViewStateEntry({
    globalFilter: state.matrixGlobalFilterText || "",
    clusterFilter: state.matrixClusterFilter || "",
    columnFilters: { ...(state.matrixColumnFilters || {}) },
    columnWidths: { ...(state.matrixColumnWidths || {}) },
    sortBy: state.matrixSortBy || "paper",
    sortDir: state.matrixSortDir === "desc" ? "desc" : "asc"
  });
  state.matrixFiltersByProjectId = {
    ...(state.matrixFiltersByProjectId || {}),
    [projectKey]: entry
  };
  persistMatrixViewStateByProject(state.matrixFiltersByProjectId);
}

function restoreMatrixFiltersForProject(projectId) {
  const projectKey = normalizeText(projectId);
  if (!projectKey) {
    clearMatrixFilters({ includeSort: true });
    return;
  }
  if (!state.matrixFiltersByProjectId || Object.keys(state.matrixFiltersByProjectId).length === 0) {
    state.matrixFiltersByProjectId = getPersistedMatrixViewStateByProject();
  }
  const saved = projectKey ? normalizeMatrixViewStateEntry(state.matrixFiltersByProjectId?.[projectKey]) : null;
  state.matrixGlobalFilterText = saved?.globalFilter || "";
  state.matrixClusterFilter = saved?.clusterFilter || "";
  state.matrixColumnFilters = saved?.columnFilters && typeof saved.columnFilters === "object" ? { ...saved.columnFilters } : {};
  state.matrixColumnWidths = saved?.columnWidths && typeof saved.columnWidths === "object" ? { ...saved.columnWidths } : {};
  state.matrixSortBy = normalizeText(saved?.sortBy || "paper") || "paper";
  state.matrixSortDir = saved?.sortDir === "desc" ? "desc" : "asc";

  const validColumnIds = new Set(getMatrixColumns().map((column) => column.id));
  const validWidthIds = new Set(["paper", "source", "state", ...validColumnIds]);
  state.matrixColumnFilters = Object.fromEntries(
    Object.entries(state.matrixColumnFilters || {}).filter(
      ([columnId, value]) => validColumnIds.has(columnId) && Boolean(normalizeText(value))
    )
  );
  state.matrixColumnWidths = Object.fromEntries(
    Object.entries(state.matrixColumnWidths || {})
      .filter(([columnId]) => validWidthIds.has(columnId))
      .map(([columnId, width]) => [columnId, normalizeMatrixColumnWidth(columnId, width)])
  );
  if (
    state.matrixSortBy !== "paper" &&
    state.matrixSortBy !== "source" &&
    state.matrixSortBy !== "state" &&
    !validColumnIds.has(state.matrixSortBy)
  ) {
    state.matrixSortBy = "paper";
    state.matrixSortDir = "asc";
  }
  state.matrixFiltersByProjectId = {
    ...(state.matrixFiltersByProjectId || {}),
    [projectKey]: normalizeMatrixViewStateEntry({
      globalFilter: state.matrixGlobalFilterText,
      clusterFilter: state.matrixClusterFilter,
      columnFilters: state.matrixColumnFilters,
      columnWidths: state.matrixColumnWidths,
      sortBy: state.matrixSortBy,
      sortDir: state.matrixSortDir
    })
  };
  persistMatrixViewStateByProject(state.matrixFiltersByProjectId);
}

function setMatrixButtonState(button, { idleLabel, busyLabel, busy = false, disabled = false } = {}) {
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const nextLabel = busy ? busyLabel || idleLabel || button.textContent : idleLabel || button.textContent;
  if (button.dataset.iconOnly === "1") {
    button.title = nextLabel || button.title || "";
    if (nextLabel) {
      button.setAttribute("aria-label", nextLabel);
    }
    if (!button.querySelector("img")) {
      button.textContent = (nextLabel || "?").slice(0, 1).toUpperCase();
    }
  } else {
    const labelSpan = button.querySelector(".buttonLabel");
    if (labelSpan instanceof HTMLElement) {
      labelSpan.textContent = nextLabel;
      button.setAttribute("aria-label", nextLabel);
      button.title = nextLabel;
    } else {
      button.textContent = nextLabel;
    }
  }
  button.disabled = Boolean(disabled || busy);
}

function isProjectActive(project) {
  return Boolean(project?.id && project.id === state.activeProjectId);
}

function setProjectForm(project = null) {
  state.editingProjectId = project?.id || "";
  ui.projectFormTitle.textContent = project ? "Edit project" : "New project";
  ui.projectName.value = project?.name || "";
  ui.projectQuestion.value = project?.researchQuestion || "";
  ui.projectObjective.value = project?.objective || "";
  ui.projectScope.value = project?.scopeNotes || "";
  ui.projectKeyTerms.value = Array.isArray(project?.keyTerms) ? project.keyTerms.join(", ") : "";
  ui.projectRubric.value = Array.isArray(project?.rubric) ? project.rubric.join("\n") : "";
}

function openProjectModal(project = null) {
  if (!(ui.projectModal instanceof HTMLElement)) {
    return;
  }
  setProjectForm(project);
  state.projectModalOpen = true;
  ui.projectModal.hidden = false;
  document.body.classList.add("projectModalOpen");
  if (ui.projectName instanceof HTMLInputElement) {
    queueMicrotask(() => {
      ui.projectName.focus();
      ui.projectName.select();
    });
  }
}

function closeProjectModal({ reset = false } = {}) {
  if (!(ui.projectModal instanceof HTMLElement)) {
    return;
  }
  state.projectModalOpen = false;
  ui.projectModal.hidden = true;
  document.body.classList.remove("projectModalOpen");
  if (reset) {
    setProjectForm(null);
  }
}

async function selectProject(projectId, { persist = true } = {}) {
  const normalizedProjectId = normalizeText(projectId);
  if (!normalizedProjectId) {
    return;
  }
  if (state.activeProjectId && state.activeProjectId !== normalizedProjectId) {
    rememberMatrixFiltersForActiveProject();
  }
  if (persist) {
    await setActiveProjectId(normalizedProjectId);
  }
  await touchProject(normalizedProjectId);
  state.activeProjectId = normalizedProjectId;
  await loadActiveProjectData();
}

async function refreshProjects() {
  state.projects = await getProjects({ includeArchived: state.showArchived });
  if (!state.activeProjectId) {
    return;
  }
  const stillExists = state.projects.find((project) => project.id === state.activeProjectId);
  if (!stillExists) {
    state.activeProjectId = "";
    state.activeProject = null;
    state.papers = [];
    state.analysesByDocId = {};
    state.compareSelection = new Set();
    state.comparison = null;
    state.matrix = null;
    state.discoveryCandidates = [];
    state.savedSearches = [];
    state.screenReasonLibrary = [];
    state.screeningMetrics = null;
    state.pipelineJobs = [];
    state.citationGraph = { nodes: [], edges: [], updatedAt: Date.now() };
    state.screenSelectedPaperId = "";
    state.discoverSelectedCandidateId = "";
    state.contributionMap = null;
    clearMatrixFilters({ includeSort: true });
  }
}

async function loadActiveProjectData() {
  if (!state.activeProjectId) {
    clearMatrixFilters({ includeSort: true });
    state.activeProject = null;
    state.papers = [];
    state.analysesByDocId = {};
    state.comparison = null;
    state.matrix = null;
    state.matrixTemplates = await listMatrixTemplates();
    state.discoveryCandidates = [];
    state.savedSearches = [];
    state.screenReasonLibrary = [];
    state.screeningMetrics = null;
    state.pipelineJobs = [];
    state.citationGraph = { nodes: [], edges: [], updatedAt: Date.now() };
    state.screenSelectedPaperId = "";
    state.discoverSelectedCandidateId = "";
    state.contributionMap = null;
    state.contributionMapDirty = true;
    state.matrixCsvImport = null;
    state.matrixDrawerMode = "";
    state.matrixSelectedRowId = "";
    state.matrixLastRemoved = null;
    state.matrixSuggestedAutofillColumnId = "";
    renderAll();
    return;
  }

  const [project, papers, analyses, comparisons, matrix, templates, discoveryCandidates, savedSearches, screenReasonLibrary, screeningMetrics, pipelineJobs, citationGraph] = await Promise.all([
    getProjectById(state.activeProjectId),
    getProjectPapers(state.activeProjectId),
    getProjectPaperAnalyses(state.activeProjectId),
    listProjectComparisons(state.activeProjectId),
    getProjectMatrix(state.activeProjectId),
    listMatrixTemplates(),
    listProjectDiscoveryCandidates(state.activeProjectId),
    listProjectSavedSearches(state.activeProjectId),
    getProjectScreenReasonLibrary(state.activeProjectId),
    getProjectScreeningMetrics(state.activeProjectId),
    listProjectPipelineJobs(state.activeProjectId),
    getProjectCitationGraph(state.activeProjectId)
  ]);

  state.activeProject = project;
  state.papers = Array.isArray(papers) ? papers : [];
  state.analysesByDocId = analyses && typeof analyses === "object" ? analyses : {};
  state.comparison = Array.isArray(comparisons) && comparisons.length > 0 ? comparisons[0] : null;
  state.comparisonWarnings = state.comparison?.warnings || [];
  state.matrix = matrix && typeof matrix === "object" ? matrix : null;
  state.matrixTemplates = Array.isArray(templates) ? templates : [];
  state.discoveryCandidates = Array.isArray(discoveryCandidates) ? discoveryCandidates : [];
  state.savedSearches = Array.isArray(savedSearches) ? savedSearches : [];
  state.screenReasonLibrary = Array.isArray(screenReasonLibrary) ? screenReasonLibrary : [];
  state.screeningMetrics = screeningMetrics && typeof screeningMetrics === "object" ? screeningMetrics : null;
  state.pipelineJobs = Array.isArray(pipelineJobs) ? pipelineJobs : [];
  state.citationGraph = citationGraph && typeof citationGraph === "object"
    ? citationGraph
    : { nodes: [], edges: [], updatedAt: Date.now() };
  state.matrixFeatureDirty = true;
  state.contributionMapDirty = true;
  state.matrixCsvImport = null;
  state.matrixDrawerMode = "";
  state.matrixSelectedRowId = "";
  state.matrixLastRemoved = null;
  state.matrixSuggestedAutofillColumnId = "";
  restoreMatrixFiltersForProject(state.activeProjectId);

  if (state.matrix) {
    let didAddRows = false;
    for (const paper of state.papers) {
      if (!shouldAutoQueueMatrixForPaper(paper)) {
        continue;
      }
      const identity = deriveCanonicalPaperFields({
        ...paper,
        url: paper?.sourceRef?.url || paper?.url || paper?.docId
      });
      const existing = getMatrixRows().find(
        (row) => row.paperId === paper.id || (identity.paperKey && row.paperKey === identity.paperKey)
      );
      if (existing) {
        continue;
      }
      const created = await ensureMatrixRowForPaper(paper, { queue: true });
      if (created) {
        didAddRows = true;
      }
    }
    if (didAddRows) {
      const refreshedMatrix = await getProjectMatrix(state.activeProjectId);
      state.matrix = refreshedMatrix;
    }
  }

  if (!state.screenSelectedPaperId) {
    const screenQueue = getScreenQueuePapers();
    if (screenQueue.length > 0) {
      state.screenSelectedPaperId = screenQueue[0].id;
    }
  }

  const nextSelection = new Set();
  for (const paper of state.papers) {
    if (state.compareSelection.has(paper.id) && normalizeScreenState(paper.screenState) !== "excluded") {
      nextSelection.add(paper.id);
    }
  }
  if (nextSelection.size < 2) {
    for (const paper of state.papers) {
      if (nextSelection.size >= Math.min(3, state.papers.length)) {
        break;
      }
      const screenState = normalizeScreenState(paper.screenState);
      if (
        screenState === "included" ||
        screenState === "needs_info" ||
        (screenState !== "excluded" && nextSelection.size < 2)
      ) {
        nextSelection.add(paper.id);
      }
    }
  }
  state.compareSelection = nextSelection;
  renderAll();
  const queuedRows = getActiveMatrixRows().filter(
    (row) => row.autoFillState === "queued" && isMatrixRowEligibleForAutomation(row)
  );
  if (queuedRows.length > 0) {
    void (async () => {
      for (const row of queuedRows) {
        try {
          await refreshMatrixRowAutofill(row, { silent: true });
        } catch (_error) {
          // Keep queued/stale status on failure.
        }
      }
      renderAll();
    })();
  }
}

function renderProjectList() {
  clearElement(ui.projectList);
  if (!Array.isArray(state.projects) || state.projects.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Create your first project to start a project-centric literature review workspace.";
    ui.projectList.append(empty);
    return;
  }

  for (const project of state.projects) {
    const card = document.createElement("article");
    card.className = `projectCard ${isProjectActive(project) ? "isActive" : ""}`;
    card.dataset.projectId = project.id;

    const title = document.createElement("div");
    title.className = "projectTitle";
    title.textContent = project.name;

    const meta = document.createElement("p");
    meta.className = "projectMeta";
    meta.textContent = `Updated ${formatDate(project.updatedAt)} | Last opened ${formatDate(project.lastOpenedAt)}${
      project.archived ? " | Archived" : ""
    }`;

    const info = document.createElement("p");
    info.className = "projectMeta";
    info.textContent = truncateText(project.researchQuestion || project.objective || "No brief yet.", 160);

    const actions = document.createElement("div");
    actions.className = "cardActions";
    actions.append(
      createButton(isProjectActive(project) ? "Active" : "Open", {
        action: "project-open",
        id: project.id,
        className: isProjectActive(project) ? "buttonAccent" : "",
        iconId: "project-open"
      }),
      createButton("Edit", { action: "project-edit", id: project.id, iconId: "project-edit" }),
      createButton(project.archived ? "Unarchive" : "Archive", {
        action: "project-archive",
        id: project.id,
        iconId: "project-archive"
      }),
      createButton("Delete", {
        action: "project-delete",
        id: project.id,
        className: "buttonDanger",
        iconId: "project-delete"
      })
    );

    card.append(title, meta, info, actions);
    ui.projectList.append(card);
  }
}

function renderProjectSwitcher() {
  if (!(ui.projectSwitcher instanceof HTMLSelectElement)) {
    return;
  }
  clearElement(ui.projectSwitcher);
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = projects.length > 0 ? "Switch project" : "No projects";
  ui.projectSwitcher.append(placeholder);
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name || "Untitled project";
    option.selected = project.id === state.activeProjectId;
    ui.projectSwitcher.append(option);
  }
  ui.projectSwitcher.disabled = projects.length === 0;
}

function renderPaperList() {
  clearElement(ui.paperList);
  ui.paperCount.textContent = state.activeProject
    ? `${state.papers.length} paper${state.papers.length === 1 ? "" : "s"}`
    : "";

  if (!state.activeProject) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Select a project to manage its paper library.";
    ui.paperList.append(empty);
    return;
  }

  if (!Array.isArray(state.papers) || state.papers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Add papers manually via URL or local file.";
    ui.paperList.append(empty);
    return;
  }

  for (const paper of state.papers) {
    const card = document.createElement("article");
    card.className = "paperCard";
    card.dataset.paperId = paper.id;

    const topRow = document.createElement("div");
    topRow.className = "rowButtons";
    const compareCheckbox = document.createElement("input");
    compareCheckbox.type = "checkbox";
    const screenState = normalizeScreenState(paper.screenState);
    compareCheckbox.checked = state.compareSelection.has(paper.id);
    compareCheckbox.disabled = screenState === "excluded";
    compareCheckbox.dataset.action = "paper-toggle-compare";
    compareCheckbox.dataset.id = paper.id;
    compareCheckbox.title = "Include in comparison";
    compareCheckbox.setAttribute("aria-label", "Include in comparison");
    const compareLabel = document.createElement("label");
    compareLabel.className = "inlineToggle";
    compareLabel.append(compareCheckbox, document.createTextNode("Compare"));
    topRow.append(compareLabel);

    const title = document.createElement("div");
    title.className = "paperTitle";
    title.textContent = paper.title;

    const meta = document.createElement("p");
    meta.className = "paperMeta";
    const sourceLabel =
      paper.sourceType === "local"
        ? `Local fingerprint: ${truncateText(paper.sourceRef?.localFingerprint, 88)}`
        : truncateText(paper.sourceRef?.url, 120);
    meta.textContent = `${paper.status} | Screen ${screenState} | Priority ${paper.priority} | ${sourceLabel}`;

    const fields = document.createElement("div");
    fields.className = "paperFields";
    const statusSelect = document.createElement("select");
    statusSelect.dataset.action = "paper-status";
    statusSelect.dataset.id = paper.id;
    for (const status of ["queued", "reading", "included", "excluded"]) {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = status;
      option.selected = paper.status === status;
      statusSelect.append(option);
    }
    const prioritySelect = document.createElement("select");
    prioritySelect.dataset.action = "paper-priority";
    prioritySelect.dataset.id = paper.id;
    for (let priority = 1; priority <= 5; priority += 1) {
      const option = document.createElement("option");
      option.value = String(priority);
      option.textContent = `Priority ${priority}`;
      option.selected = Number(paper.priority) === priority;
      prioritySelect.append(option);
    }
    const tagsInput = document.createElement("input");
    tagsInput.type = "text";
    tagsInput.placeholder = "tags, comma separated";
    tagsInput.value = Array.isArray(paper.tags) ? paper.tags.join(", ") : "";
    tagsInput.dataset.action = "paper-tags";
    tagsInput.dataset.id = paper.id;
    fields.append(statusSelect, prioritySelect, tagsInput);

    const actions = document.createElement("div");
    actions.className = "cardActions";
    actions.append(
      createButton(paper.sourceType === "local" ? "Reattach local file to open" : "Open", {
        action: "paper-open",
        id: paper.id
      }),
      createButton("Refresh fit", { action: "paper-refresh-analysis", id: paper.id }),
      createButton("Remove", { action: "paper-remove", id: paper.id, className: "buttonDanger" })
    );

    card.append(topRow, title, meta, fields, actions);
    const analysis = getAnalysisForPaper(paper);
    if (analysis) {
      const analysisPanel = document.createElement("div");
      analysisPanel.className = "analysisPanel";
      const analysisTitle = document.createElement("div");
      analysisTitle.className = "analysisTitle";
      const fitBadge = document.createElement("span");
      fitBadge.className = "fitBadge";
      fitBadge.textContent = `${analysis.fitScore}% | ${analysis.recommendation}`;
      analysisTitle.append(
        fitBadge,
        document.createTextNode(`Updated ${formatDate(analysis.updatedAt)}${analysis.degraded ? " | Degraded context" : ""}`)
      );
      const summary = document.createElement("p");
      summary.className = "paperMeta";
      summary.textContent = truncateText(analysis.relevanceSummary || "No summary available.", 220);
      const method = document.createElement("p");
      method.className = "paperMeta";
      method.textContent = truncateText(analysis.methodMatch || "", 220);
      analysisPanel.append(analysisTitle, summary, method);
      card.append(analysisPanel);
    }

    ui.paperList.append(card);
  }
}

function getScreenQueuePapers() {
  const papers = Array.isArray(state.papers) ? state.papers : [];
  return papers
    .filter((paper) => {
      const screenState = normalizeScreenState(paper?.screenState);
      return (
        screenState === "candidate" ||
        screenState === "title_abstract_review" ||
        screenState === "full_text_review" ||
        screenState === "needs_info"
      );
    })
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

function getIncludedPapersForSeedExpansion() {
  const papers = Array.isArray(state.papers) ? state.papers : [];
  return papers.filter((paper) => normalizeScreenState(paper?.screenState) === "included");
}

function getDiscoveryCandidateForPaper(paper) {
  if (!paper) {
    return null;
  }
  const paperKey = normalizeText(paper.canonicalKey || "");
  if (!paperKey) {
    return null;
  }
  return (
    (Array.isArray(state.discoveryCandidates) ? state.discoveryCandidates : []).find(
      (candidate) => normalizeText(candidate?.canonicalKey) === paperKey
    ) || null
  );
}

function getFilteredDiscoveryCandidates() {
  const candidates = Array.isArray(state.discoveryCandidates) ? state.discoveryCandidates : [];
  const filterMode = normalizeText(state.discoverGroupFilter || ui.discoverGroupFilter?.value || "all");
  if (filterMode === "new_this_run") {
    const runId = normalizeText(state.discoverLastRunId);
    if (!runId) {
      return [];
    }
    return candidates.filter((candidate) => normalizeText(candidate?.runId) === runId);
  }
  if (filterMode === "likely_duplicates") {
    return candidates.filter((candidate) => Boolean(normalizeText(candidate?.duplicateOf)));
  }
  if (filterMode === "promoted") {
    return candidates.filter((candidate) => normalizeText(candidate?.retrievalState) === "promoted");
  }
  return candidates;
}

function upsertSelectOptions(selectElement, options, placeholderLabel, selectedValue = "") {
  if (!(selectElement instanceof HTMLSelectElement)) {
    return;
  }
  const selected = normalizeText(selectedValue || selectElement.value);
  clearElement(selectElement);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = placeholderLabel;
  selectElement.append(placeholder);
  for (const optionEntry of options) {
    const value = normalizeText(optionEntry?.value);
    if (!value) {
      continue;
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = optionEntry?.label || value;
    option.selected = value === selected;
    selectElement.append(option);
  }
}

function renderDiscoverPane() {
  if (!ui.discoverTableWrap) {
    return;
  }
  if (ui.discoverRunSearch instanceof HTMLButtonElement) {
    ui.discoverRunSearch.disabled = !state.activeProjectId || state.discoverSearchInProgress;
    ui.discoverRunSearch.textContent = state.discoverSearchInProgress ? "Searching..." : "Search";
  }
  if (ui.discoverSaveSearch instanceof HTMLButtonElement) {
    ui.discoverSaveSearch.disabled = !state.activeProjectId || state.discoverSearchInProgress;
  }
  if (ui.discoverRunSavedSearchNow instanceof HTMLButtonElement) {
    ui.discoverRunSavedSearchNow.disabled =
      !state.activeProjectId || state.discoverSearchInProgress || !normalizeText(ui.discoverSavedSearchSelect?.value || "");
  }
  if (ui.discoverRunSavedSearches instanceof HTMLButtonElement) {
    ui.discoverRunSavedSearches.disabled = !state.activeProjectId || state.discoverSearchInProgress;
  }
  if (ui.discoverDedupe instanceof HTMLButtonElement) {
    ui.discoverDedupe.disabled = !state.activeProjectId || state.discoverSearchInProgress;
  }
  clearElement(ui.discoverTableWrap);
  if (!state.activeProject) {
    ui.discoverTableWrap.hidden = true;
    if (ui.discoverRunReport instanceof HTMLElement) {
      ui.discoverRunReport.hidden = true;
      ui.discoverRunReport.textContent = "";
    }
    if (ui.discoverGraphWrap instanceof HTMLElement) {
      ui.discoverGraphWrap.hidden = true;
      clearElement(ui.discoverGraphWrap);
    }
    if (ui.discoverMeta) {
      ui.discoverMeta.textContent = "Create or open a project first.";
    }
    return;
  }

  const filteredCandidates = getFilteredDiscoveryCandidates();
  const duplicateCount = filteredCandidates.filter((candidate) => normalizeText(candidate?.duplicateOf)).length;
  if (ui.discoverMeta) {
    ui.discoverMeta.textContent =
      `${filteredCandidates.length} candidate${filteredCandidates.length === 1 ? "" : "s"}`
      + (duplicateCount ? ` | ${duplicateCount} duplicate` + (duplicateCount === 1 ? "" : "s") : "");
  }
  if (ui.discoverGroupFilter instanceof HTMLSelectElement) {
    const nextFilter = normalizeText(state.discoverGroupFilter || "all");
    if (ui.discoverGroupFilter.value !== nextFilter) {
      ui.discoverGroupFilter.value = nextFilter;
    }
  }

  const runWarningText = Array.isArray(state.discoverLastRunWarnings) && state.discoverLastRunWarnings.length
    ? state.discoverLastRunWarnings.slice(0, 5).join(" | ")
    : "";
  if (ui.discoverRunReport) {
    ui.discoverRunReport.textContent = runWarningText
      ? `Last run ${state.discoverLastRunId || "-"} | ${runWarningText}`
      : state.discoverLastRunId
        ? `Last run: ${state.discoverLastRunId}`
        : "";
    ui.discoverRunReport.hidden = !ui.discoverRunReport.textContent;
  }

  upsertSelectOptions(
    ui.discoverSavedSearchSelect,
    (Array.isArray(state.savedSearches) ? state.savedSearches : []).map((search) => ({
      value: search.id,
      label: `${search.name}${search.autoEnabled ? " (auto)" : ""}`
    })),
    "Saved searches"
  );
  const selectedSavedSearchId = normalizeText(ui.discoverSavedSearchSelect?.value || "");
  const selectedSavedSearch = (Array.isArray(state.savedSearches) ? state.savedSearches : []).find(
    (entry) => entry.id === selectedSavedSearchId
  ) || null;
  if (ui.discoverSavedAutoEnabled instanceof HTMLInputElement) {
    ui.discoverSavedAutoEnabled.checked = Boolean(selectedSavedSearch?.autoEnabled);
    ui.discoverSavedAutoEnabled.disabled = !selectedSavedSearch;
  }
  if (ui.discoverSavedIntervalDays instanceof HTMLInputElement) {
    const intervalDays = Number.isFinite(Number(selectedSavedSearch?.intervalDays))
      ? Math.max(1, Math.min(30, Math.floor(Number(selectedSavedSearch.intervalDays))))
      : 7;
    ui.discoverSavedIntervalDays.value = selectedSavedSearch ? String(intervalDays) : "";
    ui.discoverSavedIntervalDays.disabled = !selectedSavedSearch;
  }
  upsertSelectOptions(
    ui.discoverSeedPaperSelect,
    getIncludedPapersForSeedExpansion().map((paper) => ({
      value: paper.id,
      label: truncateText(paper.title, 120)
    })),
    "Select included seed paper"
  );

  if (filteredCandidates.length === 0) {
    ui.discoverTableWrap.hidden = true;
  } else {
    ui.discoverTableWrap.hidden = false;
    const table = document.createElement("table");
    table.className = "matrixTable";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Title", "Year", "Venue", "Source", "State", "Actions"]) {
      const th = document.createElement("th");
      th.textContent = label;
      header.append(th);
    }
    thead.append(header);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const candidate of filteredCandidates) {
      const tr = document.createElement("tr");
      tr.dataset.candidateId = candidate.id;
      if (state.discoverSelectedCandidateId && state.discoverSelectedCandidateId === candidate.id) {
        tr.classList.add("screenQueueSelected");
      }
      const titleTd = document.createElement("td");
      const title = document.createElement("div");
      title.textContent = candidate.title || "Untitled";
      const subtitle = document.createElement("div");
      subtitle.className = "paperMeta";
      subtitle.textContent = candidate.abstract
        ? truncateText(candidate.abstract, 180)
        : truncateText(candidate.url || "", 180);
      titleTd.append(title, subtitle);

      const yearTd = document.createElement("td");
      yearTd.textContent = Number.isFinite(Number(candidate.year)) ? String(candidate.year) : "-";

      const venueTd = document.createElement("td");
      venueTd.textContent = candidate.venue || "-";

      const sourceTd = document.createElement("td");
      sourceTd.textContent = candidate.source || "unknown";

      const stateTd = document.createElement("td");
      const stateBadges = [];
      stateBadges.push(matrixStatusBadge(candidate.retrievalState || "new"));
      if (candidate.duplicateOf) {
        stateBadges.push(matrixStatusBadge("duplicate"));
      }
      for (const badge of stateBadges) {
        stateTd.append(badge, document.createTextNode(" "));
      }

      const actionsTd = document.createElement("td");
      const canQueue = !candidate.duplicateOf && normalizeText(candidate.retrievalState) !== "promoted";
      actionsTd.append(
        createButton("Queue", {
          action: "discover-candidate-queue",
          id: candidate.id,
          disabled: !canQueue,
          iconId: "queue-candidate"
        }),
        createButton("Open", {
          action: "discover-candidate-open",
          id: candidate.id,
          className: "buttonGhost",
          disabled: !normalizeText(candidate.url),
          iconId: "open-external"
        })
      );

      tr.append(titleTd, yearTd, venueTd, sourceTd, stateTd, actionsTd);
      tbody.append(tr);
    }
    table.append(tbody);
    ui.discoverTableWrap.append(table);
  }

  if (ui.discoverGraphWrap) {
    clearElement(ui.discoverGraphWrap);
    const edges = Array.isArray(state.citationGraph?.edges) ? state.citationGraph.edges : [];
    ui.discoverGraphWrap.hidden = edges.length === 0;
    if (edges.length === 0) {
      const emptyGraph = document.createElement("p");
      emptyGraph.className = "emptyState";
      emptyGraph.textContent = "No citation expansion graph yet.";
      ui.discoverGraphWrap.append(emptyGraph);
    } else {
      const graphTable = document.createElement("table");
      graphTable.className = "matrixTable";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["From", "To", "Direction", "Source"]) {
        const th = document.createElement("th");
        th.textContent = label;
        headRow.append(th);
      }
      head.append(headRow);
      graphTable.append(head);
      const body = document.createElement("tbody");
      for (const edge of edges.slice(0, 200)) {
        const row = document.createElement("tr");
        const from = document.createElement("td");
        from.textContent = truncateText(edge.from, 72) || "-";
        const to = document.createElement("td");
        to.textContent = truncateText(edge.to, 72) || "-";
        const direction = document.createElement("td");
        direction.textContent = edge.direction || "-";
        const source = document.createElement("td");
        source.textContent = edge.source || "-";
        row.append(from, to, direction, source);
        body.append(row);
      }
      graphTable.append(body);
      ui.discoverGraphWrap.append(graphTable);
    }
  }
}

function renderScreenReasonLibraryList() {
  if (!ui.screenReasonLibraryList) {
    return;
  }
  clearElement(ui.screenReasonLibraryList);
  const reasons = Array.isArray(state.screenReasonLibrary) ? state.screenReasonLibrary : [];
  if (reasons.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No reasons configured.";
    ui.screenReasonLibraryList.append(empty);
    return;
  }
  for (const reason of reasons) {
    const card = document.createElement("article");
    card.className = "projectCard";
    const title = document.createElement("div");
    title.className = "projectTitle";
    title.textContent = `${reason.label || reason.code} (${reason.code || "-"})`;
    const desc = document.createElement("p");
    desc.className = "projectMeta";
    desc.textContent = reason.description || "No description";
    card.append(title, desc);
    ui.screenReasonLibraryList.append(card);
  }
}

function renderScreenPane() {
  if (!ui.screenQueueWrap) {
    return;
  }
  clearElement(ui.screenQueueWrap);
  if (!state.activeProject) {
    ui.screenQueueWrap.hidden = true;
    if (ui.screenEvidencePane instanceof HTMLElement) {
      ui.screenEvidencePane.hidden = true;
      clearElement(ui.screenEvidencePane);
    }
    if (ui.screenMeta) {
      ui.screenMeta.textContent = "Create or open a project first.";
    }
    return;
  }
  ui.screenQueueWrap.hidden = false;
  if (ui.screenEvidencePane instanceof HTMLElement) {
    ui.screenEvidencePane.hidden = false;
  }

  const queue = getScreenQueuePapers();
  if (!state.screenSelectedPaperId || !queue.some((paper) => paper.id === state.screenSelectedPaperId)) {
    state.screenSelectedPaperId = queue[0]?.id || "";
  }
  const includedCount = state.papers.filter((paper) => normalizeScreenState(paper?.screenState) === "included").length;
  const excludedCount = state.papers.filter((paper) => normalizeScreenState(paper?.screenState) === "excluded").length;
  const pendingCount = queue.length;
  if (ui.screenMeta) {
    ui.screenMeta.textContent = `Pending ${pendingCount} | Included ${includedCount} | Excluded ${excludedCount}`;
  }
  const hasSelected = Boolean(state.screenSelectedPaperId);
  if (ui.screenDecisionInclude instanceof HTMLButtonElement) {
    ui.screenDecisionInclude.disabled = !hasSelected;
  }
  if (ui.screenDecisionExclude instanceof HTMLButtonElement) {
    ui.screenDecisionExclude.disabled = !hasSelected;
  }
  if (ui.screenDecisionNeedsInfo instanceof HTMLButtonElement) {
    ui.screenDecisionNeedsInfo.disabled = !hasSelected;
  }
  if (ui.screenDecisionNext instanceof HTMLButtonElement) {
    ui.screenDecisionNext.disabled = queue.length < 2;
  }
  if (ui.screenSuggestDecision instanceof HTMLButtonElement) {
    ui.screenSuggestDecision.disabled = !hasSelected || state.screeningSuggestBusy;
    ui.screenSuggestDecision.textContent = state.screeningSuggestBusy ? "Suggesting..." : "Suggest";
  }

  upsertSelectOptions(
    ui.screenReasonSelect,
    (Array.isArray(state.screenReasonLibrary) ? state.screenReasonLibrary : []).map((reason) => ({
      value: reason.code,
      label: `${reason.label || reason.code} (${reason.code})`
    })),
    "Exclude reason (required on exclude)"
  );
  renderScreenReasonLibraryList();

  if (queue.length === 0) {
    ui.screenQueueWrap.hidden = true;
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No papers pending screening.";
    ui.screenQueueWrap.append(empty);
  } else {
    ui.screenQueueWrap.hidden = false;
    const table = document.createElement("table");
    table.className = "matrixTable";
    const thead = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Paper", "State", "Decision", "Actions"]) {
      const th = document.createElement("th");
      th.textContent = label;
      header.append(th);
    }
    thead.append(header);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const paper of queue) {
      const tr = document.createElement("tr");
      tr.dataset.paperId = paper.id;
      if (state.screenSelectedPaperId === paper.id) {
        tr.classList.add("screenQueueSelected");
      }
      const paperTd = document.createElement("td");
      const title = document.createElement("div");
      title.textContent = paper.title;
      const meta = document.createElement("div");
      meta.className = "paperMeta";
      meta.textContent = truncateText(paper.sourceRef?.url || paper.docId || "", 140);
      paperTd.append(title, meta);

      const stateTd = document.createElement("td");
      stateTd.append(matrixStatusBadge(normalizeScreenState(paper.screenState)));

      const decisionTd = document.createElement("td");
      decisionTd.append(matrixStatusBadge(normalizeScreenDecision(paper.screenDecision)));

      const actionsTd = document.createElement("td");
      actionsTd.append(
        createButton("Select", { action: "screen-select-paper", id: paper.id, className: "buttonGhost" }),
        createButton("Full Text", { action: "screen-mark-fulltext", id: paper.id, className: "buttonGhost", iconId: "full-text" }),
        createButton("Include", { action: "screen-decide-include", id: paper.id, iconId: "include" }),
        createButton("Exclude", { action: "screen-decide-exclude", id: paper.id, className: "buttonDanger", iconId: "exclude" }),
        createButton("Needs Info", { action: "screen-decide-needs-info", id: paper.id, className: "buttonGhost", iconId: "needs-info" })
      );
      tr.append(paperTd, stateTd, decisionTd, actionsTd);
      tbody.append(tr);
    }
    table.append(tbody);
    ui.screenQueueWrap.append(table);
  }

  if (ui.screenEvidencePane) {
    clearElement(ui.screenEvidencePane);
    const selectedPaper = state.papers.find((paper) => paper.id === state.screenSelectedPaperId) || null;
    if (!selectedPaper) {
      const empty = document.createElement("p");
      empty.className = "emptyState";
      empty.textContent = "Select a paper from queue to preview evidence.";
      ui.screenEvidencePane.append(empty);
    } else {
      const heading = document.createElement("div");
      heading.className = "projectTitle";
      heading.textContent = selectedPaper.title;
      const stateLine = document.createElement("p");
      stateLine.className = "paperMeta";
      stateLine.textContent = `State: ${normalizeScreenState(selectedPaper.screenState)} | Decision: ${normalizeScreenDecision(selectedPaper.screenDecision)}`;

      const candidate = getDiscoveryCandidateForPaper(selectedPaper);
      const abstract = document.createElement("p");
      abstract.className = "paperMeta";
      abstract.textContent = candidate?.abstract
        ? truncateText(candidate.abstract, 900)
        : "No abstract available from discovery sources.";

      const evidence = selectedPaper?.screenEvidence || {};
      const evidenceMeta = document.createElement("p");
      evidenceMeta.className = "paperMeta";
      evidenceMeta.textContent = evidence.decisionSuggestion
        ? `Suggestion: ${evidence.decisionSuggestion} (${Math.round(Number(evidence.confidence || 0) * 100)}%)`
        : "No screening suggestion yet.";
      const evidenceSnippet = document.createElement("p");
      evidenceSnippet.className = "paperMeta";
      evidenceSnippet.textContent = evidence.evidenceSnippet
        ? `${truncateText(evidence.evidenceSnippet, 360)}${Number.isFinite(Number(evidence.evidencePage)) ? ` (p.${Number(evidence.evidencePage) + 1})` : ""}`
        : (evidence.insufficientReason || "No extracted evidence snippet.");

      ui.screenEvidencePane.append(heading, stateLine, abstract, evidenceMeta, evidenceSnippet);
    }
  }
}

function renderPipelineShell() {
  const metrics = state.screeningMetrics || {};
  const queues = metrics.queues || {};
  const hasProject = Boolean(state.activeProject);
  if (ui.pipelineQueueDiscover) {
    ui.pipelineQueueDiscover.textContent = String(Number(queues.discover || 0));
  }
  if (ui.pipelineQueueScreen) {
    ui.pipelineQueueScreen.textContent = String(Number(queues.screen || 0));
  }
  if (ui.pipelineQueueExtract) {
    ui.pipelineQueueExtract.textContent = String(Number(queues.extract || 0));
  }
  if (ui.pipelineQueueCompare) {
    ui.pipelineQueueCompare.textContent = String(Number(queues.compare || 0));
  }
  if (ui.pipelineQueuePosition) {
    ui.pipelineQueuePosition.textContent = String(Number(queues.position || 0));
  }
  if (ui.pipelineMetricsSummary) {
    ui.pipelineMetricsSummary.textContent = hasProject
      ? `${Number(metrics.included || 0)} included | ${Number(metrics.pending || 0)} pending`
      : "";
  }
}

function renderCompareWarnings() {
  clearElement(ui.compareWarnings);
  const warnings = Array.isArray(state.comparisonWarnings) ? state.comparisonWarnings : [];
  for (const warningText of warnings) {
    const warning = document.createElement("div");
    warning.className = "warning";
    warning.textContent = warningText;
    ui.compareWarnings.append(warning);
  }
}

function renderCompareOutput() {
  clearElement(ui.compareOutput);
  const selectedPapers = getSelectedComparePapers();
  const hiddenExcludedCount = Math.max(0, state.compareSelection.size - selectedPapers.length);
  ui.compareMeta.textContent = `${selectedPapers.length} selected${hiddenExcludedCount ? ` | ${hiddenExcludedCount} excluded-hidden` : ""}`;

  if (!state.comparison?.result) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Run deep comparison to generate rubric table and cross-paper synthesis.";
    ui.compareOutput.append(empty);
    ui.exportMarkdown.disabled = true;
    ui.exportCsv.disabled = true;
    return;
  }

  const table = document.createElement("table");
  table.className = "compareTable";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const firstHeader = document.createElement("th");
  firstHeader.textContent = "Criterion";
  headerRow.append(firstHeader);
  for (const paper of selectedPapers) {
    const th = document.createElement("th");
    th.textContent = paper.title;
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  const rows = Array.isArray(state.comparison.result.rows) ? state.comparison.result.rows : [];
  for (const row of rows) {
    const tr = document.createElement("tr");
    const criterion = document.createElement("td");
    criterion.textContent = row.criterion || "Criterion";
    tr.append(criterion);
    for (const paper of selectedPapers) {
      const cellData = Array.isArray(row.cells)
        ? row.cells.find((cell) => normalizeText(cell.paperId) === normalizeText(paper.id))
        : null;
      const td = document.createElement("td");
      if (cellData?.value) {
        const citation = Number.isFinite(Number(cellData.groundingPage))
          ? ` (p.${Number(cellData.groundingPage) + 1})`
          : "";
        td.textContent = `${cellData.value}${citation}`;
      } else {
        td.textContent = "-";
      }
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  ui.compareOutput.append(table);
  ui.exportMarkdown.disabled = false;
  ui.exportCsv.disabled = false;
}

function getMatrixColumns() {
  return Array.isArray(state.matrix?.columns) ? state.matrix.columns : [];
}

function getMatrixRows() {
  return Array.isArray(state.matrix?.rows) ? state.matrix.rows : [];
}

function isMatrixColumnDeleted(column) {
  return Boolean(column?.deletedAt);
}

function isMatrixRowDeleted(row) {
  return Boolean(row?.deletedAt);
}

function isMatrixColumnVisible(column) {
  return Boolean(column) && !isMatrixColumnDeleted(column) && !column.hidden;
}

function isMatrixRowVisible(row) {
  return Boolean(row) && !isMatrixRowDeleted(row) && !row.hidden;
}

function getActiveMatrixColumns() {
  return getMatrixColumns().filter((column) => column.id !== "paper_key" && isMatrixColumnVisible(column));
}

function getConfigurableMatrixColumns() {
  return getMatrixColumns().filter((column) => column.id !== "paper_key" && !isMatrixColumnDeleted(column));
}

function getActiveMatrixRows() {
  return getMatrixRows().filter((row) => isMatrixRowVisible(row));
}

function getTrashedMatrixColumns() {
  return getMatrixColumns().filter((column) => column.id !== "paper_key" && isMatrixColumnDeleted(column));
}

function getTrashedMatrixRows() {
  return getMatrixRows().filter((row) => isMatrixRowDeleted(row));
}

function getMatrixColumnById(columnId) {
  const normalizedColumnId = normalizeText(columnId);
  return getMatrixColumns().find((column) => normalizeText(column.id) === normalizedColumnId) || null;
}

function makeMatrixStableHash(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeMatrixColumnId(label, index = 0) {
  const slug = normalizeText(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  return `col_${slug || "criterion"}_${makeMatrixStableHash(`${label}:${index}`)}`;
}

function inferMatrixColumnTypeFromValues(values) {
  const nonEmpty = (Array.isArray(values) ? values : [])
    .map((value) => normalizeText(String(value ?? "")))
    .filter(Boolean)
    .slice(0, 100);
  if (!nonEmpty.length) {
    return "categorical";
  }
  let numericCount = 0;
  let booleanCount = 0;
  for (const value of nonEmpty) {
    const lower = value.toLowerCase();
    if (["yes", "no", "true", "false", "0", "1", "y", "n"].includes(lower)) {
      booleanCount += 1;
    }
    if (Number.isFinite(Number(value))) {
      numericCount += 1;
    }
  }
  if (booleanCount / nonEmpty.length >= 0.8) {
    return "boolean";
  }
  if (numericCount / nonEmpty.length >= 0.8) {
    return "numeric";
  }
  const distinctCount = new Set(nonEmpty.map((value) => value.toLowerCase())).size;
  return distinctCount <= Math.max(6, Math.floor(nonEmpty.length * 0.4)) ? "categorical" : "text";
}

function detectCsvMatrixColumnRole(label) {
  const normalized = normalizeText(label).toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (!compact) {
    return "ignore";
  }
  if (["title", "papertitle", "paper", "name", "work", "publication"].includes(compact)) {
    return "paper_title";
  }
  if (["url", "link", "paperurl", "paperlink", "source", "sourcelink", "pdf", "pdflink", "openurl"].includes(compact)) {
    return "paper_url";
  }
  if (compact === "doi" || compact.endsWith("doi")) {
    return "doi";
  }
  if (["arxiv", "arxivid", "arxiv_id", "eprint"].includes(compact)) {
    return "arxiv_id";
  }
  if (["authors", "author"].includes(compact)) {
    return "authors";
  }
  if (["year", "publicationyear", "date"].includes(compact)) {
    return "year";
  }
  if (["venue", "journal", "conference", "conf", "publicationvenue"].includes(compact)) {
    return "venue";
  }
  return "criterion";
}

function getCsvRoleLabel(role) {
  const labels = {
    paper_title: "Paper Title",
    paper_url: "Paper URL",
    doi: "DOI",
    arxiv_id: "arXiv ID",
    authors: "Authors",
    year: "Year",
    venue: "Venue",
    criterion: "Criterion",
    ignore: "Ignore"
  };
  return labels[role] || "Criterion";
}

function getCsvRoleOptions() {
  return ["paper_title", "paper_url", "doi", "arxiv_id", "authors", "year", "venue", "criterion", "ignore"];
}

function getMatrixRowSourceUrl(row) {
  const paper = getPaperForMatrixRow(row);
  return normalizeText(row?.paperUrl || paper?.sourceRef?.url || paper?.url || "");
}

function getMatrixRowSourceLabel(row) {
  const url = getMatrixRowSourceUrl(row);
  if (url) {
    return "Linked";
  }
  if (normalizeText(row?.paperDoi || "")) {
    return "DOI";
  }
  if (normalizeText(row?.paperArxivId || "")) {
    return "arXiv";
  }
  return "Needs link";
}

function hasMatrixRowVerificationSource(row) {
  const paper = getPaperForMatrixRow(row);
  if (getMatrixRowSourceUrl(row)) {
    return true;
  }
  if (paper?.sourceType === "local" || paper?.sourceType === "file") {
    return true;
  }
  const docId = normalizeText(paper?.docId || "");
  const fileId = docId ? normalizeText(state.fileIdByDocId?.get(docId) || "") : "";
  return Boolean(fileId);
}


function normalizeMatrixCellDisplayValue(value, type) {
  if (type === "numeric") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(numeric) : "";
  }
  if (type === "boolean") {
    const text = normalizeText(String(value || "")).toLowerCase();
    if (!text) {
      return "";
    }
    return ["true", "yes", "1", "y"].includes(text) ? "Yes" : "No";
  }
  return String(value ?? "");
}

function normalizeMatrixInputValueByType(rawValue, type) {
  const text = normalizeText(rawValue);
  if (!text) {
    return "";
  }
  if (type === "numeric") {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : "";
  }
  if (type === "boolean") {
    const lowered = text.toLowerCase();
    if (["true", "yes", "1", "y"].includes(lowered)) {
      return "Yes";
    }
    if (["false", "no", "0", "n"].includes(lowered)) {
      return "No";
    }
    return "";
  }
  return text;
}

function getFilteredMatrixRows() {
  const allRows = getActiveMatrixRows();
  const globalFilter = normalizeText(state.matrixGlobalFilterText).toLowerCase();
  const clusterFilter = normalizeText(state.matrixClusterFilter);
  const columnFilters = state.matrixColumnFilters && typeof state.matrixColumnFilters === "object" ? state.matrixColumnFilters : {};
  const assignments = state.matrix?.clusterState?.assignmentsByRowId || {};
  const filtered = allRows.filter((row) => {
    if (!state.matrixShowExcluded) {
      const rowPaper = getPaperForMatrixRow(row);
      if (rowPaper && !isPaperScreenIncluded(rowPaper)) {
        return false;
      }
    }
    if (clusterFilter) {
      const clusterId = Number(clusterFilter);
      if (Number.isFinite(clusterId)) {
        if (Number(assignments[row.id]) !== clusterId) {
          return false;
        }
      }
    }
    if (!globalFilter) {
      for (const [columnId, filterTextRaw] of Object.entries(columnFilters)) {
        const filterText = normalizeText(filterTextRaw).toLowerCase();
        if (!filterText) {
          continue;
        }
        const value = normalizeText(String(row.cellsByColumnId?.[columnId]?.value || "")).toLowerCase();
        if (!value.includes(filterText)) {
          return false;
        }
      }
      return true;
    }
    const haystack = [
      row.paperTitle,
      row.paperKey,
      getMatrixRowSourceUrl(row),
      ...getActiveMatrixColumns().map((column) => row.cellsByColumnId?.[column.id]?.value || "")
    ]
      .map((item) => normalizeText(String(item || "")).toLowerCase())
      .join(" ");
    if (!haystack.includes(globalFilter)) {
      return false;
    }
    for (const [columnId, filterTextRaw] of Object.entries(columnFilters)) {
      const filterText = normalizeText(filterTextRaw).toLowerCase();
      if (!filterText) {
        continue;
      }
      const value = normalizeText(String(row.cellsByColumnId?.[columnId]?.value || "")).toLowerCase();
      if (!value.includes(filterText)) {
        return false;
      }
    }
    return true;
  });
  const sortBy = normalizeText(state.matrixSortBy || "paper");
  const direction = state.matrixSortDir === "desc" ? -1 : 1;
  filtered.sort((left, right) => {
    let leftValue = "";
    let rightValue = "";
    if (sortBy === "paper") {
      leftValue = normalizeText(left.paperTitle || left.paperKey || "");
      rightValue = normalizeText(right.paperTitle || right.paperKey || "");
    } else if (sortBy === "source") {
      leftValue = getMatrixRowSourceLabel(left);
      rightValue = getMatrixRowSourceLabel(right);
    } else if (sortBy === "state") {
      leftValue = `${left.autoFillState || ""}|${left.verificationState || ""}`;
      rightValue = `${right.autoFillState || ""}|${right.verificationState || ""}`;
    } else {
      leftValue = normalizeText(String(left.cellsByColumnId?.[sortBy]?.value || ""));
      rightValue = normalizeText(String(right.cellsByColumnId?.[sortBy]?.value || ""));
    }
    return leftValue.localeCompare(rightValue) * direction;
  });
  return filtered;
}

function matrixStatusBadge(text) {
  const badge = document.createElement("span");
  badge.className = "matrixStatusBadge";
  const label = normalizeText(text);
  const normalized = label.toLowerCase();
  if (normalized.includes("include") || normalized.includes("included") || normalized.includes("fresh")) {
    badge.classList.add("statusSuccess");
  } else if (normalized.includes("exclude") || normalized.includes("error") || normalized.includes("failed")) {
    badge.classList.add("statusDanger");
  } else if (normalized.includes("needs_info") || normalized.includes("pending") || normalized.includes("stale")) {
    badge.classList.add("statusWarning");
  } else {
    badge.classList.add("statusNeutral");
  }
  badge.textContent = label || "-";
  return badge;
}

function getMatrixColumnWidth(columnKey) {
  const normalizedKey = normalizeText(columnKey);
  if (normalizedKey === "actions") {
    return MATRIX_COLUMN_WIDTH_LIMITS.actions.default;
  }
  const storedWidth = state.matrixColumnWidths?.[normalizedKey];
  return normalizeMatrixColumnWidth(normalizedKey, storedWidth);
}

function getMatrixStickyOffsets() {
  const paperWidth = getMatrixColumnWidth("paper");
  const sourceWidth = getMatrixColumnWidth("source");
  const stateWidth = getMatrixColumnWidth("state");
  return {
    paperWidth,
    sourceWidth,
    stateWidth,
    sourceLeft: paperWidth,
    stateLeft: paperWidth + sourceWidth
  };
}

function applyMatrixTableWidthVars(table) {
  if (!(table instanceof HTMLElement)) {
    return;
  }
  const offsets = getMatrixStickyOffsets();
  table.style.setProperty("--matrix-paper-width", `${offsets.paperWidth}px`);
  table.style.setProperty("--matrix-source-width", `${offsets.sourceWidth}px`);
  table.style.setProperty("--matrix-state-width", `${offsets.stateWidth}px`);
  table.style.setProperty("--matrix-source-left", `${offsets.sourceLeft}px`);
  table.style.setProperty("--matrix-state-left", `${offsets.stateLeft}px`);
  table.style.setProperty("--matrix-actions-width", `${MATRIX_COLUMN_WIDTH_LIMITS.actions.default}px`);
}

function applyMatrixColumnWidthToElement(element, columnKey) {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const width = getMatrixColumnWidth(columnKey);
  element.style.width = `${width}px`;
  element.style.minWidth = `${width}px`;
  element.style.maxWidth = `${width}px`;
}

function updateMatrixResizeHandleAria(handle) {
  if (!(handle instanceof HTMLElement)) {
    return;
  }
  const columnKey = normalizeText(handle.dataset.columnKey || "");
  const limits = getMatrixColumnWidthLimits(columnKey);
  const width = getMatrixColumnWidth(columnKey);
  handle.setAttribute("aria-valuemin", String(limits.min));
  handle.setAttribute("aria-valuemax", String(limits.max));
  handle.setAttribute("aria-valuenow", String(width));
}

function applyMatrixColumnWidthsToRenderedTable() {
  const table = ui.matrixTableWrap?.querySelector(".matrixTable");
  if (!(table instanceof HTMLElement)) {
    return;
  }
  applyMatrixTableWidthVars(table);
  table.querySelectorAll("[data-column-key]").forEach((element) => {
    if (element instanceof HTMLElement) {
      applyMatrixColumnWidthToElement(element, element.dataset.columnKey || "");
    }
  });
  table.querySelectorAll(".matrixColumnResizeHandle").forEach((handle) => {
    updateMatrixResizeHandleAria(handle);
  });
}

function setMatrixColumnWidth(columnKey, width, { persist = true } = {}) {
  const normalizedKey = normalizeText(columnKey);
  if (!normalizedKey || normalizedKey === "actions") {
    return;
  }
  const normalizedWidth = normalizeMatrixColumnWidth(normalizedKey, width);
  state.matrixColumnWidths = {
    ...(state.matrixColumnWidths || {}),
    [normalizedKey]: normalizedWidth
  };
  applyMatrixColumnWidthsToRenderedTable();
  if (persist) {
    rememberMatrixFiltersForActiveProject();
  }
}

function createMatrixColumnResizeHandle(header) {
  if (!header?.resizable || !header.widthKey) {
    return null;
  }
  const handle = document.createElement("span");
  handle.className = "matrixColumnResizeHandle";
  handle.tabIndex = 0;
  handle.dataset.action = "matrix-column-resize";
  handle.dataset.columnKey = header.widthKey;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `Resize ${header.label} column`);
  updateMatrixResizeHandleAria(handle);
  return handle;
}

function handleMatrixColumnResizePointerDown(event) {
  const handle = event.target instanceof Element
    ? event.target.closest('[data-action="matrix-column-resize"]')
    : null;
  if (!(handle instanceof HTMLElement)) {
    return;
  }
  const columnKey = normalizeText(handle.dataset.columnKey || "");
  if (!columnKey) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startWidth = getMatrixColumnWidth(columnKey);
  const pointerId = event.pointerId;
  const previousCursor = document.body.style.cursor;
  document.body.style.cursor = "col-resize";
  handle.classList.add("isResizing");
  try {
    handle.setPointerCapture(pointerId);
  } catch (_error) {
    // Pointer capture can fail in older extension contexts; document listeners still finish the drag.
  }

  const onPointerMove = (moveEvent) => {
    const delta = Number(moveEvent.clientX) - startX;
    setMatrixColumnWidth(columnKey, startWidth + delta, { persist: false });
  };
  const finish = () => {
    handle.classList.remove("isResizing");
    document.body.style.cursor = previousCursor;
    try {
      handle.releasePointerCapture(pointerId);
    } catch (_error) {
      // Ignore release failures when capture was unavailable.
    }
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
    rememberMatrixFiltersForActiveProject();
  };

  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function handleMatrixColumnResizeKeydown(event) {
  const handle = event.target instanceof Element
    ? event.target.closest('[data-action="matrix-column-resize"]')
    : null;
  if (!(handle instanceof HTMLElement)) {
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  const columnKey = normalizeText(handle.dataset.columnKey || "");
  if (!columnKey) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const step = event.shiftKey ? 48 : 16;
  const direction = event.key === "ArrowRight" ? 1 : -1;
  setMatrixColumnWidth(columnKey, getMatrixColumnWidth(columnKey) + (step * direction));
}

function renderMatrixColumnEditorList(container, { includeAdvanced = true } = {}) {
  if (!(container instanceof HTMLElement)) {
    return;
  }
  clearElement(container);
  if (!state.activeProject || !state.matrix) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Select a project to configure matrix columns.";
    container.append(empty);
    return;
  }
  const columns = getConfigurableMatrixColumns();
  if (columns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No criteria yet. Add a criterion or import a CSV.";
    container.append(empty);
    return;
  }
  for (const column of columns) {
    const card = document.createElement("article");
    card.className = "matrixColumnCard";
    const shouldSuggestAutofill = state.matrixSuggestedAutofillColumnId === column.id;
    if (shouldSuggestAutofill) {
      card.classList.add("isAutofillSuggested");
    }
    if (column.hidden) {
      card.classList.add("isHiddenColumn");
    }
    card.dataset.columnId = column.id;
    const row = document.createElement("div");
    row.className = "matrixColumnGrid";

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = column.label || "";
    labelInput.dataset.action = "matrix-column-label";
    labelInput.dataset.id = column.id;

    const typeSelect = document.createElement("select");
    typeSelect.dataset.action = "matrix-column-type";
    typeSelect.dataset.id = column.id;
    for (const type of ["categorical", "numeric", "boolean", "text"]) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      option.selected = type === column.type;
      typeSelect.append(option);
    }

    const optionsInput = document.createElement("input");
    optionsInput.type = "text";
    optionsInput.placeholder = "options, comma separated";
    optionsInput.value = Array.isArray(column.suggestedOptions) ? column.suggestedOptions.join(", ") : "";
    optionsInput.dataset.action = "matrix-column-options";
    optionsInput.dataset.id = column.id;

    const clusterToggle = document.createElement("label");
    clusterToggle.className = "inlineToggle";
    const clusterCheckbox = document.createElement("input");
    clusterCheckbox.type = "checkbox";
    clusterCheckbox.checked = column.clusterEnabled !== false;
    clusterCheckbox.dataset.action = "matrix-column-cluster";
    clusterCheckbox.dataset.id = column.id;
    clusterToggle.append(clusterCheckbox, document.createTextNode("Cluster"));

    const actions = document.createElement("div");
    actions.className = "matrixColumnActions";
    actions.append(
      createButton("Move left", { action: "matrix-column-move-left", id: column.id, className: "buttonGhost", iconId: "move-left", iconOnly: true }),
      createButton("Move right", { action: "matrix-column-move-right", id: column.id, className: "buttonGhost", iconId: "move-right", iconOnly: true }),
      createButton(column.hidden ? "Show" : "Hide", {
        action: column.hidden ? "matrix-column-show" : "matrix-column-hide",
        id: column.id,
        className: "buttonGhost",
        iconId: column.hidden ? "show" : "hide",
        iconOnly: true
      }),
      createButton("Remove", {
        action: "matrix-column-remove",
        id: column.id,
        className: "buttonDanger",
        iconId: "remove",
        iconOnly: true
      })
    );

    row.append(labelInput, typeSelect, optionsInput, clusterToggle, actions);
    card.append(row);
    if (includeAdvanced) {
      const descInput = document.createElement("input");
      descInput.type = "text";
      descInput.placeholder = "description for autofill";
      descInput.value = column.description || "";
      descInput.dataset.action = "matrix-column-description";
      descInput.dataset.id = column.id;
      card.append(descInput);
    }
    const autofillFooter = document.createElement("div");
    autofillFooter.className = "matrixColumnFooter";
    const canAutofillColumn = getMatrixColumnsForLlm().some((entry) => entry.columnId === column.id);
    const autofillBlocked = isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn");
    const autofillDisabled = !canAutofillColumn || autofillBlocked;
    autofillFooter.append(
      createButton("Auto-fill Column", {
        action: "matrix-column-autofill",
        id: column.id,
        className: shouldSuggestAutofill ? "buttonAccent" : "",
        iconId: "matrix-autofill",
        disabled: autofillDisabled,
        title: !canAutofillColumn
          ? "Show this column before running auto-fill."
          : autofillBlocked
            ? "Wait for current auto-fill to finish."
            : "Auto-fill this column across eligible rows."
      })
    );
    if (shouldSuggestAutofill) {
      const suggestion = document.createElement("span");
      suggestion.className = "subtleText";
      suggestion.textContent = "This column changed. Auto-fill to populate existing rows.";
      autofillFooter.append(suggestion);
    }
    card.append(autofillFooter);
    container.append(card);
  }
}

function renderMatrixSchemaList() {
  renderMatrixColumnEditorList(ui.matrixSchemaList, { includeAdvanced: true });
}

function renderMatrixTable() {
  clearElement(ui.matrixTableWrap);
  if (!state.activeProject || !state.matrix) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Select a project to view matrix rows.";
    ui.matrixTableWrap.append(empty);
    return;
  }
  const columns = getActiveMatrixColumns();
  const rows = getFilteredMatrixRows();
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = getActiveMatrixRows().length
      ? "No rows match current filters."
      : "No matrix rows yet. Import a CSV, add a row, or link papers from screening.";
    ui.matrixTableWrap.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = `matrixTable matrixTable-${state.matrixDensity === "compact" ? "compact" : "comfortable"}`;
  applyMatrixTableWidthVars(table);
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const headerConfig = [
    { label: "Paper", sortBy: "paper", className: "matrixStickyPaper", widthKey: "paper", resizable: true },
    { label: "Source", sortBy: "source", className: "matrixStickySource", widthKey: "source", resizable: true },
    { label: "State", sortBy: "state", className: "matrixStickyState", widthKey: "state", resizable: true },
    ...columns.map((column) => ({
      label: column.label,
      sortBy: column.id,
      className: "matrixCriterionColumn",
      widthKey: column.id,
      resizable: true
    })),
    { label: "Actions", sortBy: "", className: "matrixStickyActions", widthKey: "actions", resizable: false }
  ];
  const colgroup = document.createElement("colgroup");
  for (const header of headerConfig) {
    const col = document.createElement("col");
    col.dataset.columnKey = header.widthKey;
    applyMatrixColumnWidthToElement(col, header.widthKey);
    colgroup.append(col);
  }
  table.append(colgroup);
  for (const header of headerConfig) {
    const th = document.createElement("th");
    if (header.className) {
      th.className = header.className;
    }
    th.dataset.columnKey = header.widthKey;
    applyMatrixColumnWidthToElement(th, header.widthKey);
    const headerContent = document.createElement("div");
    headerContent.className = "matrixHeaderCell";
    if (header.sortBy) {
      const button = createButton(header.label, {
        action: "matrix-sort",
        id: header.sortBy,
        className: "buttonGhost"
      });
      if (state.matrixSortBy === header.sortBy) {
        button.textContent = `${header.label} ${state.matrixSortDir === "desc" ? "v" : "^"}`;
      }
      headerContent.append(button);
    } else {
      const label = document.createElement("span");
      label.textContent = header.label;
      headerContent.append(label);
    }
    const resizeHandle = createMatrixColumnResizeHandle(header);
    if (resizeHandle) {
      headerContent.append(resizeHandle);
    }
    th.append(headerContent);
    hr.append(th);
  }
  thead.append(hr);
  const filterRow = document.createElement("tr");
  const hasAnyFilter = hasMatrixFiltersApplied();
  for (const header of headerConfig) {
    const th = document.createElement("th");
    if (header.className) {
      th.className = header.className;
    }
    th.dataset.columnKey = header.widthKey;
    applyMatrixColumnWidthToElement(th, header.widthKey);
    if (header.sortBy && header.sortBy !== "paper" && header.sortBy !== "state" && header.sortBy !== "source") {
      const filterWrap = document.createElement("div");
      filterWrap.className = "matrixFilterCell";
      const input = document.createElement("input");
      input.type = "search";
      input.placeholder = "filter";
      input.className = "matrixCellInput";
      input.dataset.action = "matrix-column-filter";
      input.dataset.columnId = header.sortBy;
      input.value = state.matrixColumnFilters?.[header.sortBy] || "";
      const clearColumnFilter = createButton("x", {
        action: "matrix-column-filter-clear",
        id: header.sortBy,
        className: "buttonGhost iconOnlyButton",
        disabled: !normalizeText(state.matrixColumnFilters?.[header.sortBy] || "")
      });
      clearColumnFilter.title = "Clear column filter";
      filterWrap.append(input, clearColumnFilter);
      th.append(filterWrap);
    } else if (header.sortBy === "paper") {
      th.append(
        createButton("Clear", {
          action: "matrix-clear-filters",
          className: "buttonGhost",
          disabled: !hasAnyFilter
        })
      );
    } else {
      const hint = document.createElement("span");
      hint.className = "subtleText";
      hint.textContent = header.sortBy === "paper" ? "sort only" : "";
      th.append(hint);
    }
    filterRow.append(th);
  }
  thead.append(filterRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.dataset.rowId = row.id;
    tr.dataset.action = "matrix-row-open";
    const paperCell = document.createElement("td");
    paperCell.className = "matrixStickyPaper";
    paperCell.dataset.columnKey = "paper";
    applyMatrixColumnWidthToElement(paperCell, "paper");
    const title = document.createElement("div");
    title.className = "matrixPaperTitle";
    title.textContent = row.paperTitle || row.paperId || "Unknown paper";
    const key = document.createElement("div");
    key.className = "subtleText";
    key.textContent = row.paperKey || "";
    paperCell.append(title, key);
    tr.append(paperCell);

    const sourceCell = document.createElement("td");
    sourceCell.className = "matrixStickySource";
    sourceCell.dataset.columnKey = "source";
    applyMatrixColumnWidthToElement(sourceCell, "source");
    const sourceUrl = getMatrixRowSourceUrl(row);
    if (sourceUrl) {
      const openSource = createButton("Open source", {
        action: "matrix-row-open-source",
        id: row.id,
        className: "buttonGhost",
        iconId: "open-source",
        iconOnly: true
      });
      openSource.title = sourceUrl;
      sourceCell.append(openSource);
    } else {
      sourceCell.append(matrixStatusBadge("Needs link"));
    }
    sourceCell.append(
      createButton(sourceUrl ? "Edit source link" : "Link source", {
        action: "matrix-row-link-source",
        id: row.id,
        className: "buttonGhost",
        iconId: "link-source",
        iconOnly: true
      })
    );
    tr.append(sourceCell);

    const stateCell = document.createElement("td");
    stateCell.className = "matrixStickyState";
    stateCell.dataset.columnKey = "state";
    applyMatrixColumnWidthToElement(stateCell, "state");
    stateCell.append(
      matrixStatusBadge(`fill: ${row.autoFillState || "queued"}`),
      document.createTextNode(" "),
      matrixStatusBadge(`verify: ${row.verificationState || "stale"}`)
    );
    tr.append(stateCell);

    for (const column of columns) {
      const td = document.createElement("td");
      td.className = "matrixCriterionColumn";
      td.dataset.columnKey = column.id;
      applyMatrixColumnWidthToElement(td, column.id);
      const cell = row.cellsByColumnId?.[column.id];
      const input = document.createElement("input");
      input.type = "text";
      input.className = "matrixCellInput";
      input.value = normalizeMatrixCellDisplayValue(cell?.value, column.type);
      input.dataset.action = "matrix-cell-edit";
      input.dataset.rowId = row.id;
      input.dataset.columnId = column.id;
      input.dataset.locked = String(Boolean(cell?.locked));
      input.title = cell?.evidenceSnippet
        ? `${cell.evidenceSnippet}${Number.isFinite(Number(cell?.evidencePage)) ? ` (p.${Number(cell.evidencePage) + 1})` : ""}`
        : "";
      td.append(input);
      tr.append(td);
    }
    const actionsCell = document.createElement("td");
    actionsCell.className = "matrixStickyActions";
    actionsCell.dataset.columnKey = "actions";
    applyMatrixColumnWidthToElement(actionsCell, "actions");
    const autofillState = getMatrixRowAutofillControlState(row);
    actionsCell.append(
      createButton("Row details", { action: "matrix-row-open", id: row.id, className: "buttonGhost", iconId: "matrix-details", iconOnly: true }),
      createButton(autofillState.label, {
        action: "matrix-row-autofill-columns",
        id: row.id,
        disabled: autofillState.disabled,
        iconId: "matrix-autofill",
        title: autofillState.title,
        iconOnly: true
      }),
      createButton("Duplicate row", { action: "matrix-row-duplicate", id: row.id, className: "buttonGhost", iconId: "duplicate", iconOnly: true }),
      createButton("Remove row", { action: "matrix-row-remove", id: row.id, className: "buttonDanger", iconId: "remove", iconOnly: true })
    );
    tr.append(actionsCell);
    tbody.append(tr);
  }
  table.append(tbody);
  ui.matrixTableWrap.append(table);
}

function drawMatrixClusterCanvas() {
  const canvas = ui.matrixClusterCanvas;
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  const pointsByRowId = state.matrix?.clusterState?.pointsByRowId || {};
  const assignmentsByRowId = state.matrix?.clusterState?.assignmentsByRowId || {};
  const points = Object.entries(pointsByRowId);
  if (!points.length) {
    context.fillStyle = "#9a9a9a";
    context.font = "14px sans-serif";
    context.fillText("Run clustering to render the PCA map.", 16, 26);
    return;
  }
  const xs = points.map((entry) => Number(entry[1]?.x || 0));
  const ys = points.map((entry) => Number(entry[1]?.y || 0));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const palette = ["#8bb9ff", "#9fd4ac", "#f3c97b", "#e6a2a7", "#8ad9d2", "#d1b0ff", "#f7a0b8", "#b5d56b"];
  const projected = [];
  for (const [rowId, point] of points) {
    const clusterId = Number(assignmentsByRowId[rowId] || 0);
    const px = 24 + ((Number(point.x || 0) - minX) / spanX) * (canvas.width - 48);
    const py = 24 + ((Number(point.y || 0) - minY) / spanY) * (canvas.height - 48);
    projected.push({
      rowId,
      clusterId,
      px,
      py: canvas.height - py
    });
    context.beginPath();
    context.fillStyle = palette[clusterId % palette.length];
    context.arc(px, canvas.height - py, 5, 0, Math.PI * 2);
    context.fill();
  }
  canvas.dataset.projectedPoints = JSON.stringify(projected);
}

function renderMatrixClusterMeta() {
  const clusterState = state.matrix?.clusterState || {};
  const enabledColumns = getActiveMatrixColumns().filter((column) => column.clusterEnabled !== false);
  if (!enabledColumns.length) {
    ui.matrixClusterMeta.textContent = "No cluster-enabled feature columns selected.";
    state.matrixFeatureDirty = false;
    return;
  }
  const currentHash = computeMatrixDataHash({
    columns: getMatrixColumns().map((column) => ({
      id: column.id,
      type: column.type,
      clusterEnabled: column.clusterEnabled !== false
    })),
    rows: getMatrixRows().map((row) => ({
      id: row.id,
      cellsByColumnId: row.cellsByColumnId,
      hiddenFeaturesByColumnId: row.hiddenFeaturesByColumnId
    }))
  });
  state.matrixFeatureDirty = Boolean(clusterState?.dataHash && clusterState.dataHash !== currentHash);
  if (!clusterState?.updatedAt) {
    ui.matrixClusterMeta.textContent = "No clustering run yet.";
    return;
  }
  const pointCount = Object.keys(clusterState.pointsByRowId || {}).length;
  ui.matrixClusterMeta.textContent = `k=${clusterState.k || 0} | ${pointCount} points | Updated ${formatDate(clusterState.updatedAt)}${state.matrixFeatureDirty ? " | Data changed" : ""}`;
}

function handleMatrixClusterCanvasClick(event) {
  const canvas = ui.matrixClusterCanvas;
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  const projected = (() => {
    try {
      return JSON.parse(canvas.dataset.projectedPoints || "[]");
    } catch (_error) {
      return [];
    }
  })();
  if (!Array.isArray(projected) || projected.length === 0) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(1, rect.width);
  const scaleY = canvas.height / Math.max(1, rect.height);
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  let best = null;
  for (const point of projected) {
    const dx = Number(point.px) - x;
    const dy = Number(point.py) - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (!best || dist < best.dist) {
      best = { dist, clusterId: Number(point.clusterId || 0) };
    }
  }
  if (!best || best.dist > 14) {
    state.matrixClusterFilter = "";
    if (ui.matrixClusterFilter instanceof HTMLInputElement) {
      ui.matrixClusterFilter.value = "";
    }
    rememberMatrixFiltersForActiveProject();
    renderAll();
    return;
  }
  state.matrixClusterFilter = String(best.clusterId);
  if (ui.matrixClusterFilter instanceof HTMLInputElement) {
    ui.matrixClusterFilter.value = String(best.clusterId);
  }
  rememberMatrixFiltersForActiveProject();
  renderAll();
}

function renderMatrixTemplateSelect() {
  if (!(ui.matrixTemplateSelect instanceof HTMLSelectElement)) {
    return;
  }
  clearElement(ui.matrixTemplateSelect);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select template";
  ui.matrixTemplateSelect.append(placeholder);
  for (const template of Array.isArray(state.matrixTemplates) ? state.matrixTemplates : []) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    option.selected = state.matrix?.templateId === template.id;
    ui.matrixTemplateSelect.append(option);
  }
}

function renderMatrixMeta() {
  if (!state.activeProject || !state.matrix) {
    ui.matrixMeta.textContent = "";
    return;
  }
  const rows = getFilteredMatrixRows().length;
  const totalRows = getActiveMatrixRows().length;
  const trashedRows = getTrashedMatrixRows().length;
  const criterionCount = getActiveMatrixColumns().length;
  const hiddenCriteria = getConfigurableMatrixColumns().filter((column) => column.hidden).length;
  const criteriaLabel = criterionCount === 1 ? "criterion" : "criteria";
  ui.matrixMeta.textContent = `${totalRows} row${totalRows === 1 ? "" : "s"} (${rows} visible) | ${criterionCount} visible ${criteriaLabel}${
    hiddenCriteria ? ` | ${hiddenCriteria} hidden` : ""
  }${trashedRows ? ` | ${trashedRows} in trash` : ""}`;
}

function renderMatrixSyncReport() {
  if (!(ui.matrixSyncReport instanceof HTMLElement)) {
    return;
  }
  clearElement(ui.matrixSyncReport);
  if (!state.matrix?.sheetsSync) {
    return;
  }
  const sync = state.matrix.sheetsSync;
  const report = sync.lastSyncReport || {};
  const sheetLabel = sync.spreadsheetName
    ? `${sync.spreadsheetName}${sync.sheetTitle ? ` / ${sync.sheetTitle}` : ""}`
    : "No sheet selected";
  const summary = document.createElement("div");
  summary.textContent = `${sheetLabel}${sync.lastSyncAt ? ` | Last sync ${formatDate(sync.lastSyncAt)}` : ""}${
    Number(report.successCount || 0) || Number(report.failureCount || 0)
      ? ` | Success ${Number(report.successCount || 0)} | Failed ${Number(report.failureCount || 0)}`
      : ""
  }`;
  ui.matrixSyncReport.append(summary);
  if (Array.isArray(report.errors) && report.errors.length) {
    const list = document.createElement("ul");
    list.className = "matrixSyncErrors";
    for (const error of report.errors.slice(0, 5)) {
      const item = document.createElement("li");
      item.textContent = error;
      list.append(item);
    }
    ui.matrixSyncReport.append(list);
  }
}

function renderMatrixUndoBar() {
  if (!(ui.matrixUndoBar instanceof HTMLElement)) {
    return;
  }
  const removal = state.matrixLastRemoved;
  ui.matrixUndoBar.hidden = !removal;
  if (!removal) {
    return;
  }
  const label =
    removal.type === "column"
      ? `Removed criterion "${removal.label || "Untitled"}".`
      : `Removed row "${removal.label || "Untitled paper"}".`;
  if (ui.matrixUndoText instanceof HTMLElement) {
    ui.matrixUndoText.textContent = label;
  }
}

function renderMatrixCsvImportModal() {
  if (!(ui.matrixCsvImportModal instanceof HTMLElement)) {
    return;
  }
  const importState = state.matrixCsvImport;
  ui.matrixCsvImportModal.hidden = !importState;
  if (!importState) {
    return;
  }
  if (ui.matrixCsvImportMeta instanceof HTMLElement) {
    ui.matrixCsvImportMeta.textContent = `${importState.fileName || "CSV"} | ${importState.headers.length} columns | ${importState.rows.length} data rows`;
  }
  if (!(ui.matrixCsvMappingWrap instanceof HTMLElement)) {
    return;
  }
  clearElement(ui.matrixCsvMappingWrap);
  const table = document.createElement("table");
  table.className = "matrixTable matrixCsvMappingTable";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Column", "Use as", "Preview"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement("tbody");
  importState.headers.forEach((header, index) => {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.textContent = header || `Column ${index + 1}`;
    const roleCell = document.createElement("td");
    const select = document.createElement("select");
    select.dataset.action = "matrix-csv-role";
    select.dataset.index = String(index);
    for (const role of getCsvRoleOptions()) {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = getCsvRoleLabel(role);
      option.selected = importState.roles[index] === role;
      select.append(option);
    }
    roleCell.append(select);
    const previewCell = document.createElement("td");
    previewCell.className = "subtleText";
    previewCell.textContent = importState.rows
      .slice(0, 3)
      .map((row) => normalizeText(row[index] || ""))
      .filter(Boolean)
      .join(" | ") || "-";
    tr.append(nameCell, roleCell, previewCell);
    tbody.append(tr);
  });
  table.append(tbody);
  ui.matrixCsvMappingWrap.append(table);
}

function renderMatrixRowDrawer() {
  if (!(ui.matrixRowDrawer instanceof HTMLElement) || !(ui.matrixRowDrawerBody instanceof HTMLElement)) {
    return;
  }
  const isOpen = state.matrixDrawerMode === "row" && normalizeText(state.matrixSelectedRowId);
  ui.matrixRowDrawer.hidden = !isOpen;
  if (!isOpen) {
    clearElement(ui.matrixRowDrawerBody);
    return;
  }
  const row = getMatrixRowById(state.matrixSelectedRowId);
  if (!row) {
    ui.matrixRowDrawer.hidden = true;
    return;
  }
  clearElement(ui.matrixRowDrawerBody);
  if (ui.matrixRowDrawerTitle instanceof HTMLElement) {
    ui.matrixRowDrawerTitle.textContent = row.paperTitle || "Matrix row";
  }

  const summary = document.createElement("section");
  summary.className = "matrixDrawerSection";
  const sourceUrl = getMatrixRowSourceUrl(row);
  summary.innerHTML = `
    <p class="kicker">Paper</p>
    <h4>${escapeHtml(row.paperTitle || "Untitled paper")}</h4>
    <p class="subtleText">${escapeHtml(row.paperKey || "No key")}</p>
    <p class="subtleText">Source: ${escapeHtml(sourceUrl || row.paperDoi || row.paperArxivId || "Needs link")}</p>
  `;
  const summaryActions = document.createElement("div");
  summaryActions.className = "rowButtons";
  const autofillState = getMatrixRowAutofillControlState(row);
  summaryActions.append(
    createButton(sourceUrl ? "Open source" : "Needs link", {
      action: sourceUrl ? "matrix-row-open-source" : "matrix-row-link-source",
      id: row.id,
      className: "buttonGhost",
      iconId: sourceUrl ? "open-source" : "link-source",
      iconOnly: true
    }),
    createButton("Link source", { action: "matrix-row-link-source", id: row.id, className: "buttonGhost", iconId: "link-source", iconOnly: true }),
    createButton(autofillState.label, {
      action: "matrix-row-autofill-columns",
      id: row.id,
      disabled: autofillState.disabled,
      iconId: "matrix-autofill",
      title: autofillState.title
    }),
    createButton("Duplicate", { action: "matrix-row-duplicate", id: row.id, className: "buttonGhost", iconId: "duplicate", iconOnly: true }),
    createButton("Remove", { action: "matrix-row-remove", id: row.id, className: "buttonDanger", iconId: "remove", iconOnly: true })
  );
  summary.append(summaryActions);
  ui.matrixRowDrawerBody.append(summary);

  const criteria = document.createElement("section");
  criteria.className = "matrixDrawerSection";
  const criteriaTitle = document.createElement("h4");
  criteriaTitle.textContent = "Criteria";
  criteria.append(criteriaTitle);
  const columns = getActiveMatrixColumns();
  if (!columns.length) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No active criteria columns.";
    criteria.append(empty);
  }
  for (const column of columns) {
    const field = document.createElement("label");
    field.className = "matrixDrawerField";
    const cell = row.cellsByColumnId?.[column.id];
    const label = document.createElement("span");
    label.textContent = column.label;
    const input = document.createElement("input");
    input.type = "text";
    input.value = normalizeMatrixCellDisplayValue(cell?.value, column.type);
    input.dataset.action = "matrix-cell-edit";
    input.dataset.rowId = row.id;
    input.dataset.columnId = column.id;
    const evidence = document.createElement("small");
    evidence.className = "subtleText";
    evidence.textContent = cell?.evidenceSnippet
      ? `Evidence: ${cell.evidenceSnippet}${Number.isFinite(Number(cell?.evidencePage)) ? ` (p.${Number(cell.evidencePage) + 1})` : ""}`
      : "No evidence saved yet.";
    field.append(label, input, evidence);
    criteria.append(field);
  }
  ui.matrixRowDrawerBody.append(criteria);

  const tags = Object.entries(row.hiddenFeaturesByColumnId || {})
    .flatMap(([columnId, entry]) => {
      const column = getMatrixColumnById(columnId);
      return (Array.isArray(entry?.tags) ? entry.tags : []).map((tag) => `${column?.label || columnId}: ${tag}`);
    })
    .filter(Boolean);
  const tagSection = document.createElement("section");
  tagSection.className = "matrixDrawerSection";
  const tagTitle = document.createElement("h4");
  tagTitle.textContent = "Hidden clustering tags";
  const tagActions = document.createElement("div");
  tagActions.className = "rowButtons";
  const rowBusyReason = normalizeText(state.matrixRowBusyById?.[row.id] || "");
  const canGenerateTags = isMatrixRowEligibleForAutomation(row) && hasMatrixRowVerificationSource(row);
  const hasTagColumns = getMatrixColumnsForLlm().some((column) => column.type === "text" && column.clusterEnabled !== false);
  const tagButtonLabel = rowBusyReason === "tags"
    ? "Generating tags..."
    : tags.length
      ? "Regenerate tags"
      : "Generate tags";
  tagActions.append(
    createButton(tagButtonLabel, {
      action: "matrix-row-regenerate-tags",
      id: row.id,
      className: "buttonGhost",
      disabled: Boolean(rowBusyReason) || isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn") || !canGenerateTags || !hasTagColumns,
      iconId: "regenerate-tags",
      title: !hasTagColumns
        ? "Add a text criterion with clustering enabled to generate hidden tags."
        : !canGenerateTags
          ? "Tags need an included row with a source link."
          : tagButtonLabel
    })
  );
  const tagText = document.createElement("p");
  tagText.className = "subtleText";
  tagText.textContent = tags.length ? tags.join(", ") : "No generated tags yet.";
  tagSection.append(tagTitle, tagActions, tagText);
  ui.matrixRowDrawerBody.append(tagSection);
}

function renderMatrixColumnsDrawer() {
  if (!(ui.matrixColumnsDrawer instanceof HTMLElement)) {
    return;
  }
  const isOpen = state.matrixDrawerMode === "columns";
  ui.matrixColumnsDrawer.hidden = !isOpen;
  if (isOpen) {
    renderMatrixColumnEditorList(ui.matrixColumnsDrawerList, { includeAdvanced: true });
  }
}

function renderMatrixTrashDrawer() {
  if (!(ui.matrixTrashDrawer instanceof HTMLElement) || !(ui.matrixTrashDrawerBody instanceof HTMLElement)) {
    return;
  }
  const isOpen = state.matrixDrawerMode === "trash";
  ui.matrixTrashDrawer.hidden = !isOpen;
  if (!isOpen) {
    return;
  }
  clearElement(ui.matrixTrashDrawerBody);
  const rows = getTrashedMatrixRows();
  const columns = getTrashedMatrixColumns();
  const rowSection = document.createElement("section");
  rowSection.className = "matrixDrawerSection";
  const rowTitle = document.createElement("h4");
  rowTitle.textContent = `Rows (${rows.length})`;
  rowSection.append(rowTitle);
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No removed rows.";
    rowSection.append(empty);
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "matrixTrashItem";
    const label = document.createElement("div");
    label.innerHTML = `<strong>${escapeHtml(row.paperTitle || "Untitled paper")}</strong><span class="subtleText">${escapeHtml(row.paperKey || "")}</span>`;
    const actions = document.createElement("div");
    actions.className = "rowButtons";
    actions.append(
      createButton("Restore", { action: "matrix-row-restore", id: row.id, className: "buttonGhost", iconId: "restore", iconOnly: true }),
      createButton("Delete forever", { action: "matrix-row-hard-delete", id: row.id, className: "buttonDanger", iconId: "hard-delete", iconOnly: true })
    );
    item.append(label, actions);
    rowSection.append(item);
  }
  ui.matrixTrashDrawerBody.append(rowSection);

  const columnSection = document.createElement("section");
  columnSection.className = "matrixDrawerSection";
  const columnTitle = document.createElement("h4");
  columnTitle.textContent = `Criteria (${columns.length})`;
  columnSection.append(columnTitle);
  if (!columns.length) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "No removed criteria.";
    columnSection.append(empty);
  }
  for (const column of columns) {
    const item = document.createElement("div");
    item.className = "matrixTrashItem";
    const label = document.createElement("div");
    label.innerHTML = `<strong>${escapeHtml(column.label || "Untitled criterion")}</strong><span class="subtleText">${escapeHtml(column.type || "")}</span>`;
    const actions = document.createElement("div");
    actions.className = "rowButtons";
    actions.append(
      createButton("Restore", { action: "matrix-column-restore", id: column.id, className: "buttonGhost", iconId: "restore", iconOnly: true }),
      createButton("Delete forever", { action: "matrix-column-hard-delete", id: column.id, className: "buttonDanger", iconId: "hard-delete", iconOnly: true })
    );
    item.append(label, actions);
    columnSection.append(item);
  }
  ui.matrixTrashDrawerBody.append(columnSection);
}

function renderMatrixDrawerState() {
  renderMatrixCsvImportModal();
  renderMatrixUndoBar();
  renderMatrixRowDrawer();
  renderMatrixColumnsDrawer();
  renderMatrixTrashDrawer();
  if (ui.matrixDrawerBackdrop instanceof HTMLElement) {
    ui.matrixDrawerBackdrop.hidden = !["row", "columns", "trash"].includes(state.matrixDrawerMode);
  }
}

function renderMatrixControlState() {
  const hasProjectMatrix = Boolean(state.activeProject && state.matrix);
  const totalRows = getActiveMatrixRows().length;
  const eligibleRows = getActiveMatrixRows().filter(
    (row) => isMatrixRowEligibleForAutomation(row) && hasMatrixRowVerificationSource(row)
  ).length;
  const hasSheetTarget = Boolean(state.matrix?.sheetsSync?.spreadsheetId && state.matrix?.sheetsSync?.sheetTitle);
  const hasClientId = Boolean(
    normalizeText(ui.matrixGoogleClientId?.value || state.settings?.googleClientId || "")
  );
  const hasAnyRowBusy = Object.keys(state.matrixRowBusyById || {}).length > 0;
  const fillableColumnCount = getMatrixColumnsForLlm().length;

  setMatrixButtonState(ui.matrixRunAutofillAll, {
    idleLabel: "Auto-fill All",
    busyLabel: "Autofilling...",
    busy: isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn"),
    disabled: !hasProjectMatrix || fillableColumnCount === 0 || eligibleRows === 0 || isMatrixOpRunning("clustering") || hasAnyRowBusy
  });
  setMatrixButtonState(ui.matrixRunClustering, {
    idleLabel: "Run Clustering",
    busyLabel: "Clustering...",
    busy: isMatrixOpRunning("clustering"),
    disabled: !hasProjectMatrix || eligibleRows < 3 || isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn")
  });
  setMatrixButtonState(ui.matrixApplyTemplate, {
    idleLabel: "Apply Template",
    busyLabel: "Applying...",
    busy: isMatrixOpRunning("applyTemplate"),
    disabled: !hasProjectMatrix || isMatrixOpRunning("saveTemplate")
  });
  setMatrixButtonState(ui.matrixSaveTemplate, {
    idleLabel: "Save Template",
    busyLabel: "Saving...",
    busy: isMatrixOpRunning("saveTemplate"),
    disabled: !hasProjectMatrix || isMatrixOpRunning("applyTemplate")
  });
  setMatrixButtonState(ui.matrixImportCsv, {
    idleLabel: "Bootstrap CSV",
    busyLabel: "Importing...",
    busy: isMatrixOpRunning("importCsv"),
    disabled: !hasProjectMatrix
  });
  setMatrixButtonState(ui.matrixAddColumn, {
    idleLabel: "Add Criterion",
    busyLabel: "Adding...",
    busy: isMatrixOpRunning("addColumn"),
    disabled: !hasProjectMatrix
  });
  setMatrixButtonState(ui.matrixLoadSheets, {
    idleLabel: "Load Sheets",
    busyLabel: "Loading...",
    busy: isMatrixOpRunning("loadSheets"),
    disabled: !hasClientId
  });
  setMatrixButtonState(ui.matrixConnectGoogle, {
    idleLabel: "Connect Google",
    busyLabel: "Connecting...",
    busy: isMatrixOpRunning("googleAuth"),
    disabled: !hasClientId
  });
  setMatrixButtonState(ui.matrixDisconnectGoogle, {
    idleLabel: "Disconnect",
    busyLabel: "Disconnect",
    busy: false,
    disabled: isMatrixOpRunning("googleAuth")
  });
  setMatrixButtonState(ui.matrixSyncNow, {
    idleLabel: "Sync Now",
    busyLabel: "Syncing...",
    busy: isMatrixOpRunning("sync") || state.matrixSyncInProgress,
    disabled: !hasProjectMatrix || !hasSheetTarget || totalRows === 0
  });
  if (ui.matrixExportCsv instanceof HTMLButtonElement) {
    ui.matrixExportCsv.disabled = !hasProjectMatrix || getFilteredMatrixRows().length === 0;
  }
  if (ui.matrixExportXlsx instanceof HTMLButtonElement) {
    ui.matrixExportXlsx.disabled = !hasProjectMatrix || getFilteredMatrixRows().length === 0;
  }
  for (const button of [
    ui.matrixAddRow,
    ui.matrixToolbarAddColumn,
    ui.matrixToolbarImportCsv,
    ui.matrixOpenColumns,
    ui.matrixOpenTrash,
    ui.matrixSetupImportCsv,
    ui.matrixSetupAddColumn,
    ui.matrixStartBlank,
    ui.matrixColumnsAddCriterion,
    ui.matrixColumnsImportCsv
  ]) {
    if (button instanceof HTMLButtonElement) {
      button.disabled =
        !hasProjectMatrix
        || isMatrixOpRunning("importCsv")
        || isMatrixOpRunning("addColumn")
        || isMatrixOpRunning("autofillColumn");
    }
  }
  if (ui.matrixClearFilters instanceof HTMLButtonElement) {
    ui.matrixClearFilters.disabled = !hasProjectMatrix || !hasMatrixFiltersApplied();
  }
  if (ui.matrixTemplateSelect instanceof HTMLSelectElement) {
    ui.matrixTemplateSelect.disabled = !hasProjectMatrix || isMatrixOpRunning("applyTemplate") || isMatrixOpRunning("saveTemplate");
  }
  if (ui.matrixSheetSearch instanceof HTMLInputElement) {
    ui.matrixSheetSearch.disabled = !hasClientId || isMatrixOpRunning("loadSheets");
  }
  if (ui.matrixSpreadsheetSelect instanceof HTMLSelectElement) {
    ui.matrixSpreadsheetSelect.disabled = !hasClientId || isMatrixOpRunning("loadSheets") || isMatrixOpRunning("sync");
  }
  if (ui.matrixWorksheetSelect instanceof HTMLSelectElement) {
    ui.matrixWorksheetSelect.disabled =
      !hasClientId || isMatrixOpRunning("loadTabs") || isMatrixOpRunning("sync") || !normalizeText(ui.matrixSpreadsheetSelect?.value || "");
  }
  if (ui.matrixDensitySelect instanceof HTMLSelectElement) {
    ui.matrixDensitySelect.disabled = !hasProjectMatrix;
  }
  if (ui.matrixConfirmCsvImport instanceof HTMLButtonElement) {
    ui.matrixConfirmCsvImport.disabled = !state.matrixCsvImport || isMatrixOpRunning("importCsv");
  }
  if (ui.matrixCancelCsvImport instanceof HTMLButtonElement) {
    ui.matrixCancelCsvImport.disabled = isMatrixOpRunning("importCsv");
  }
  if (ui.matrixCancelCsvImportSecondary instanceof HTMLButtonElement) {
    ui.matrixCancelCsvImportSecondary.disabled = isMatrixOpRunning("importCsv");
  }
}

function renderMatrixPane() {
  applyMatrixActionIcons();
  renderMatrixTemplateSelect();
  renderMatrixSchemaList();
  renderMatrixTable();
  renderMatrixClusterMeta();
  drawMatrixClusterCanvas();
  renderMatrixMeta();
  renderMatrixSyncReport();
  renderMatrixDrawerState();
  if (ui.matrixSetupPanel instanceof HTMLElement) {
    const hasProjectMatrix = Boolean(state.activeProject && state.matrix);
    const hasRows = getActiveMatrixRows().length > 0;
    const hasCriteria = getConfigurableMatrixColumns().length > 0;
    const dismissed = Boolean(state.matrixSetupDismissedByProjectId?.[state.activeProjectId]);
    ui.matrixSetupPanel.hidden = !hasProjectMatrix || hasRows || hasCriteria || dismissed;
  }
  if (ui.matrixSchemaHint instanceof HTMLElement) {
    const hasProjectMatrix = Boolean(state.activeProject && state.matrix);
    const criterionCount = getConfigurableMatrixColumns().length;
    ui.matrixSchemaHint.hidden = !hasProjectMatrix || criterionCount > 0;
  }
  if (ui.matrixQuickImportCsv instanceof HTMLButtonElement) {
    ui.matrixQuickImportCsv.disabled = !state.activeProject || isMatrixOpRunning("importCsv");
  }
  if (ui.matrixQuickAddColumn instanceof HTMLButtonElement) {
    ui.matrixQuickAddColumn.disabled = !state.activeProject || !state.matrix || isMatrixOpRunning("addColumn");
  }
  if (ui.matrixQuickOpenSettings instanceof HTMLButtonElement) {
    ui.matrixQuickOpenSettings.disabled = !state.activeProject;
  }
  if (ui.matrixAutoSyncToggle instanceof HTMLInputElement) {
    ui.matrixAutoSyncToggle.checked = Boolean(state.matrix?.sheetsSync?.autoSync);
    ui.matrixAutoSyncToggle.disabled = !state.activeProject || !state.matrix || isMatrixOpRunning("sync");
  }
  if (ui.matrixGoogleClientId instanceof HTMLInputElement && state.settings) {
    if (ui.matrixGoogleClientId.value !== (state.settings.googleClientId || "")) {
      ui.matrixGoogleClientId.value = state.settings.googleClientId || "";
    }
  }
  if (ui.matrixGoogleApiKey instanceof HTMLInputElement && state.settings) {
    if (ui.matrixGoogleApiKey.value !== (state.settings.googleApiKey || "")) {
      ui.matrixGoogleApiKey.value = state.settings.googleApiKey || "";
    }
  }
  if (ui.matrixGlobalFilter instanceof HTMLInputElement && ui.matrixGlobalFilter.value !== (state.matrixGlobalFilterText || "")) {
    ui.matrixGlobalFilter.value = state.matrixGlobalFilterText || "";
  }
  if (ui.matrixClusterFilter instanceof HTMLInputElement && ui.matrixClusterFilter.value !== (state.matrixClusterFilter || "")) {
    ui.matrixClusterFilter.value = state.matrixClusterFilter || "";
  }
  if (ui.matrixShowExcluded instanceof HTMLInputElement) {
    ui.matrixShowExcluded.checked = Boolean(state.matrixShowExcluded);
    ui.matrixShowExcluded.disabled = !state.activeProject || !state.matrix;
  }
  if (ui.matrixDensitySelect instanceof HTMLSelectElement && ui.matrixDensitySelect.value !== state.matrixDensity) {
    ui.matrixDensitySelect.value = state.matrixDensity;
  }
  renderMatrixControlState();
}

function parseOptionList(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, 40);
}

function mergeMatrixRowWithPaper(row, paper) {
  const identity = deriveCanonicalPaperFields({
    ...paper,
    url: paper?.sourceRef?.url || paper?.url || paper?.docId
  });
  return {
    ...(row || {}),
    paperId: paper?.id || row?.paperId || "",
    paperTitle: paper?.title || row?.paperTitle || "",
    paperKey: identity.paperKey || row?.paperKey || "",
    paperDoi: identity.paperDoi || row?.paperDoi || "",
    paperArxivId: identity.paperArxivId || row?.paperArxivId || "",
    paperUrl: identity.paperUrl || row?.paperUrl || "",
    paperTitleFingerprint: identity.paperTitleFingerprint || row?.paperTitleFingerprint || ""
  };
}

async function persistMatrix(partial, options = {}) {
  if (!state.activeProjectId) {
    return null;
  }
  const updated = await setProjectMatrix(state.activeProjectId, partial);
  if (updated) {
    state.matrix = updated;
    state.matrixFeatureDirty = true;
    state.contributionMapDirty = true;
    if (!options.skipAutoSync) {
      scheduleMatrixAutoSync();
    }
  }
  return updated;
}

function scheduleMatrixAutoSync() {
  if (!state.matrix?.sheetsSync?.autoSync || !state.matrix?.sheetsSync?.spreadsheetId || !state.matrix?.sheetsSync?.sheetTitle) {
    return;
  }
  if (isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn") || isMatrixOpRunning("sync")) {
    return;
  }
  if (state.matrixAutoSyncTimer) {
    clearTimeout(state.matrixAutoSyncTimer);
  }
  state.matrixAutoSyncTimer = setTimeout(() => {
    state.matrixAutoSyncTimer = null;
    void syncMatrixToGoogleNow({ silent: true });
  }, 1800);
}

async function ensureMatrixRowForPaper(paper, { queue = true, force = false } = {}) {
  if (!state.activeProjectId || !paper) {
    return null;
  }
  if (!force && !shouldAutoQueueMatrixForPaper(paper)) {
    return null;
  }
  const merged = mergeMatrixRowWithPaper(
    {
      projectId: state.activeProjectId,
      autoFillState: queue ? "queued" : "done",
      verificationState: "stale",
      cellsByColumnId: {},
      hiddenFeaturesByColumnId: {}
    },
    paper
  );
  const row = await upsertProjectMatrixRow(state.activeProjectId, merged);
  if (!row) {
    return null;
  }
  state.matrix = await getProjectMatrix(state.activeProjectId);
  return row;
}

function getMatrixRowById(rowId) {
  const normalizedRowId = normalizeText(rowId);
  return getMatrixRows().find((row) => row.id === normalizedRowId) || null;
}

function getPaperForMatrixRow(row) {
  if (!row) {
    return null;
  }
  const byPaperId = state.papers.find((paper) => paper.id === row.paperId);
  if (byPaperId) {
    return byPaperId;
  }
  const byCanonical = state.papers.find((paper) => {
    const identity = deriveCanonicalPaperFields({
      ...paper,
      url: paper?.sourceRef?.url || paper?.url || paper?.docId
    });
    return identity.paperKey && identity.paperKey === row.paperKey;
  });
  return byCanonical || null;
}

function isMatrixRowEligibleForAutomation(row) {
  const paper = getPaperForMatrixRow(row);
  return shouldAutoQueueMatrixForPaper(paper);
}

async function saveMatrixRow(nextRow) {
  if (!state.activeProjectId || !nextRow) {
    return null;
  }
  const saved = await upsertProjectMatrixRow(state.activeProjectId, nextRow);
  if (!saved) {
    return null;
  }
  state.matrix = await getProjectMatrix(state.activeProjectId);
  scheduleMatrixAutoSync();
  state.matrixFeatureDirty = true;
  state.contributionMapDirty = true;
  return saved;
}

function openMatrixDrawer(mode, rowId = "") {
  state.matrixDrawerMode = mode;
  state.matrixSelectedRowId = mode === "row" ? normalizeText(rowId) : "";
  renderAll();
}

function closeMatrixDrawers() {
  state.matrixDrawerMode = "";
  state.matrixSelectedRowId = "";
  renderAll();
}

function parseMatrixSourceInput(value) {
  const text = normalizeText(value);
  const identity = deriveCanonicalPaperFields({
    title: "",
    url: text,
    doi: text,
    arxivId: text,
    docId: text
  });
  const fallbackUrl = identity.paperUrl
    || (identity.paperDoi ? `https://doi.org/${identity.paperDoi}` : "")
    || (identity.paperArxivId ? `https://arxiv.org/abs/${identity.paperArxivId}` : "");
  return {
    raw: text,
    url: fallbackUrl,
    doi: identity.paperDoi,
    arxivId: identity.paperArxivId,
    paperKey: identity.paperKey
  };
}

async function upsertProjectPaperForMatrixRow(row, overrides = {}) {
  if (!state.activeProjectId || !row) {
    return null;
  }
  const title = truncateText(overrides.title || row.paperTitle || "Imported paper", 260) || "Imported paper";
  const sourceInput = parseMatrixSourceInput(overrides.source || overrides.url || row.paperUrl || row.paperDoi || row.paperArxivId || "");
  const identity = deriveCanonicalPaperFields({
    title,
    url: sourceInput.url,
    doi: overrides.doi || sourceInput.doi || row.paperDoi || "",
    arxivId: overrides.arxivId || sourceInput.arxivId || row.paperArxivId || "",
    docId: sourceInput.url || sourceInput.doi || sourceInput.arxivId || title
  });
  const docId = identity.paperUrl || identity.paperDoi || identity.paperArxivId || identity.paperKey || title;
  if (!docId) {
    return null;
  }
  return addProjectPaper(state.activeProjectId, {
    docId,
    title,
    sourceType: identity.paperUrl ? "remote" : "remote",
    sourceRef: identity.paperUrl ? { url: identity.paperUrl } : {},
    status: "included",
    priority: 2,
    screenState: "included",
    screenDecision: "include",
    decisionBy: "matrix",
    decisionAt: Date.now(),
    doi: identity.paperDoi,
    arxivId: identity.paperArxivId,
    canonicalKey: identity.paperKey,
    tags: ["matrix-import"]
  });
}

async function linkMatrixRowSource(row) {
  if (!row) {
    return;
  }
  const current = getMatrixRowSourceUrl(row) || row.paperDoi || row.paperArxivId || "";
  const source = window.prompt("Paste paper URL, DOI, or arXiv ID", current);
  if (source === null) {
    return;
  }
  const parsed = parseMatrixSourceInput(source);
  if (!parsed.url && !parsed.doi && !parsed.arxivId) {
    setStatus("Link source failed: paste a valid URL, DOI, or arXiv ID.");
    return;
  }
  const paper = await upsertProjectPaperForMatrixRow(row, { source });
  const linked = paper ? mergeMatrixRowWithPaper(row, paper) : {
    ...row,
    paperUrl: parsed.url || row.paperUrl || "",
    paperDoi: parsed.doi || row.paperDoi || "",
    paperArxivId: parsed.arxivId || row.paperArxivId || "",
    paperKey: parsed.paperKey || row.paperKey || ""
  };
  await saveMatrixRow({
    ...linked,
    autoFillState: "queued",
    verificationState: "stale",
    deletedAt: null,
    deletedBy: "",
    hidden: false,
    updatedAt: Date.now()
  });
  if (paper) {
    state.papers = await getProjectPapers(state.activeProjectId);
  }
  renderAll();
  setStatus("Paper source linked. Reverify is now available.");
}

function openMatrixRowSource(row) {
  const sourceUrl = getMatrixRowSourceUrl(row);
  if (!sourceUrl) {
    setStatus("No source link is saved for this row.");
    return;
  }
  window.open(sourceUrl, "_blank", "noopener");
}

async function addManualMatrixRow() {
  if (!state.activeProjectId || !state.matrix) {
    setStatus("Select a project first.");
    return;
  }
  const title = window.prompt("Paper title", "Untitled paper");
  if (!title) {
    return;
  }
  const source = window.prompt("Paper URL, DOI, or arXiv ID (optional)", "");
  const parsed = parseMatrixSourceInput(source || "");
  const identity = deriveCanonicalPaperFields({
    title,
    url: parsed.url,
    doi: parsed.doi,
    arxivId: parsed.arxivId,
    docId: parsed.url || parsed.doi || parsed.arxivId || title
  });
  let paper = null;
  if (parsed.url || parsed.doi || parsed.arxivId) {
    paper = await addProjectPaper(state.activeProjectId, {
      docId: identity.paperUrl || identity.paperDoi || identity.paperArxivId || identity.paperKey,
      title,
      sourceType: identity.paperUrl ? "remote" : "remote",
      sourceRef: identity.paperUrl ? { url: identity.paperUrl } : {},
      status: "included",
      priority: 2,
      screenState: "included",
      screenDecision: "include",
      decisionBy: "matrix",
      decisionAt: Date.now(),
      doi: identity.paperDoi,
      arxivId: identity.paperArxivId,
      canonicalKey: identity.paperKey
    });
  }
  const row = paper
    ? mergeMatrixRowWithPaper(
        {
          projectId: state.activeProjectId,
          cellsByColumnId: {},
          hiddenFeaturesByColumnId: {},
          autoFillState: "queued",
          verificationState: "stale"
        },
        paper
      )
    : {
        projectId: state.activeProjectId,
        paperId: "",
        paperTitle: truncateText(title, 260),
        paperKey: identity.paperKey,
        paperDoi: identity.paperDoi,
        paperArxivId: identity.paperArxivId,
        paperUrl: identity.paperUrl,
        paperTitleFingerprint: identity.paperTitleFingerprint,
        cellsByColumnId: {},
        hiddenFeaturesByColumnId: {},
        autoFillState: "pending_source",
        verificationState: "stale"
      };
  await saveMatrixRow(row);
  if (paper) {
    state.papers = await getProjectPapers(state.activeProjectId);
  }
  renderAll();
  setStatus("Matrix row added.");
}

async function duplicateMatrixRow(row) {
  if (!row || !state.activeProjectId) {
    return;
  }
  const copy = {
    ...row,
    id: `mrow_copy_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999).toString(36)}`,
    paperId: "",
    paperTitle: `${row.paperTitle || "Untitled paper"} copy`,
    paperKey: `${row.paperKey || "row"}:copy:${Date.now().toString(36)}`,
    deletedAt: null,
    deletedBy: "",
    hidden: false,
    updatedAt: Date.now(),
    lastVerifiedAt: null,
    cellsByColumnId: { ...(row.cellsByColumnId || {}) },
    hiddenFeaturesByColumnId: { ...(row.hiddenFeaturesByColumnId || {}) }
  };
  await saveMatrixRow(copy);
  renderAll();
  setStatus("Matrix row duplicated.");
}

async function softRemoveMatrixRow(row) {
  if (!row) {
    return;
  }
  await saveMatrixRow({
    ...row,
    deletedAt: Date.now(),
    deletedBy: "user",
    hidden: false,
    updatedAt: Date.now()
  });
  state.matrixLastRemoved = { type: "row", id: row.id, label: row.paperTitle || row.paperKey || "Untitled paper" };
  if (state.matrixSelectedRowId === row.id) {
    state.matrixDrawerMode = "";
    state.matrixSelectedRowId = "";
  }
  renderAll();
  setStatus("Matrix row moved to trash.");
}

async function restoreMatrixRow(rowId) {
  const row = getMatrixRowById(rowId);
  if (!row) {
    return;
  }
  await saveMatrixRow({
    ...row,
    deletedAt: null,
    deletedBy: "",
    hidden: false,
    updatedAt: Date.now()
  });
  if (state.matrixLastRemoved?.type === "row" && state.matrixLastRemoved.id === row.id) {
    state.matrixLastRemoved = null;
  }
  renderAll();
  setStatus("Matrix row restored.");
}

async function hardDeleteMatrixRow(rowId) {
  const row = getMatrixRowById(rowId);
  if (!row || !window.confirm("Permanently delete this matrix row? The linked project paper is not deleted.")) {
    return;
  }
  await persistMatrix({
    ...state.matrix,
    rows: getMatrixRows().filter((entry) => entry.id !== row.id)
  });
  if (state.matrixLastRemoved?.type === "row" && state.matrixLastRemoved.id === row.id) {
    state.matrixLastRemoved = null;
  }
  renderAll();
  setStatus("Matrix row permanently deleted.");
}

async function restoreMatrixColumn(columnId) {
  if (!state.activeProjectId || !state.matrix) {
    return;
  }
  const normalizedColumnId = normalizeText(columnId);
  if (!normalizedColumnId) {
    return;
  }
  const columns = getMatrixColumns().map((column) =>
    column.id === normalizedColumnId
      ? { ...column, deletedAt: null, deletedBy: "", hidden: false }
      : { ...column }
  );
  const updated = await setProjectMatrixColumns(state.activeProjectId, columns, {
    templateId: state.matrix.templateId
  });
  if (updated) {
    state.matrix = updated;
    state.matrixFeatureDirty = true;
    state.contributionMapDirty = true;
    if (state.matrixLastRemoved?.type === "column" && state.matrixLastRemoved.id === normalizedColumnId) {
      state.matrixLastRemoved = null;
    }
    renderAll();
    setStatus("Criterion restored.");
  }
}

async function removeMatrixRowsForPaper(paper) {
  if (!state.matrix || !paper) {
    return;
  }
  const identity = deriveCanonicalPaperFields({
    ...paper,
    url: paper?.sourceRef?.url || paper?.url || paper?.docId
  });
  const nextRows = getMatrixRows().filter(
    (row) =>
      row.paperId !== paper.id &&
      (!identity.paperKey || row.paperKey !== identity.paperKey) &&
      row.paperUrl !== identity.paperUrl
  );
  if (nextRows.length === getMatrixRows().length) {
    return;
  }
  await persistMatrix({
    ...state.matrix,
    rows: nextRows
  });
}

function getMatrixColumnsForLlm() {
  return getActiveMatrixColumns()
    .map((column) => ({
      columnId: column.id,
      label: column.label,
      type: column.type,
      description: column.description,
      clusterEnabled: column.clusterEnabled !== false
    }));
}

function isMatrixCellFilled(cell) {
  return Boolean(normalizeText(cell?.value) || normalizeText(cell?.insufficientReason));
}

function hasFilledMatrixCriteria(row) {
  return getMatrixColumnsForLlm().some((column) => isMatrixCellFilled(row?.cellsByColumnId?.[column.columnId]));
}

function hasBlankMatrixCriteria(row) {
  return getMatrixColumnsForLlm().some((column) => !isMatrixCellFilled(row?.cellsByColumnId?.[column.columnId]));
}

function getMatrixRowAutofillControlState(row) {
  const columns = getMatrixColumnsForLlm();
  const rowBusyReason = normalizeText(state.matrixRowBusyById?.[row?.id] || "");
  const rowBusy = Boolean(rowBusyReason) || row?.autoFillState === "running" || isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn");
  const automationEligible = isMatrixRowEligibleForAutomation(row);
  const hasSource = hasMatrixRowVerificationSource(row);
  const label = rowBusyReason === "autofill" || rowBusyReason === "reverify"
    ? "Auto-filling..."
    : "Auto-fill Columns";
  if (!columns.length) {
    return {
      label,
      disabled: true,
      title: "Add at least one criterion column before auto-fill."
    };
  }
  if (rowBusy) {
    return {
      label,
      disabled: true,
      title: "Row update already running."
    };
  }
  if (!automationEligible) {
    return {
      label,
      disabled: true,
      title: "Include this paper before extracting criteria."
    };
  }
  if (!hasSource) {
    return {
      label,
      disabled: true,
      title: "Link a source before auto-fill."
    };
  }
  return {
    label,
    disabled: false,
    title: "Auto-fill criteria columns for this row."
  };
}

function formatDeepContextUnavailableReason(deepResolution, fallbackReason = "missing source context") {
  const warnings = Array.isArray(deepResolution?.warnings)
    ? deepResolution.warnings.map((warning) => normalizeText(warning)).filter(Boolean)
    : [];
  const authWarning = warnings.find((warning) => {
    const normalized = warning.toLowerCase();
    return normalized.includes("401") || normalized.includes("auth") || normalized.includes("api key");
  });
  return truncateText(authWarning || warnings[0] || fallbackReason, 140);
}

function isOpenAIAuthFailureMessage(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized.includes("401") || normalized.includes("auth") || normalized.includes("api key");
}

function looksLikePdfBytes(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function buildRemotePdfFetchError(url, reason) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch (_error) {
      return "source link";
    }
  })();
  return new Error(`${host}: ${reason}`);
}

async function fetchRemotePdfBytesForUpload(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "include"
    });
  } catch (_error) {
    throw buildRemotePdfFetchError(
      url,
      "browser could not read PDF bytes from the link, likely due to CORS or site restrictions"
    );
  }
  if (!response.ok) {
    throw buildRemotePdfFetchError(url, `source returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) {
    throw buildRemotePdfFetchError(url, "source returned empty PDF bytes");
  }
  if (!looksLikePdfBytes(bytes)) {
    throw buildRemotePdfFetchError(url, "source did not return a PDF file; use a direct PDF URL or open/download it locally");
  }
  return bytes;
}

async function refreshMatrixRowAutofill(
  row,
  { isReverify = false, regenerateTagsOnly = false, fillMode = "all", targetColumnIds = [], silent = false } = {}
) {
  if (!state.activeProjectId || !row) {
    return null;
  }
  const rowId = normalizeText(row.id);
  if (!rowId) {
    return null;
  }
  const normalizedTargetColumnIds = Array.isArray(targetColumnIds)
    ? targetColumnIds.map((columnId) => normalizeText(columnId)).filter(Boolean)
    : [];
  const targetColumnIdSet = new Set(normalizedTargetColumnIds);
  const hasTargetColumns = targetColumnIdSet.size > 0;
  const normalizedFillMode = fillMode === "missing" ? "missing" : fillMode === "overwrite" ? "overwrite" : "all";
  if (state.matrixRowBusyById?.[rowId]) {
    return getMatrixRowById(rowId) || row;
  }
  state.matrixRowBusyById = {
    ...(state.matrixRowBusyById || {}),
    [rowId]: regenerateTagsOnly ? "tags" : isReverify ? "reverify" : "autofill"
  };
  if (!silent) {
    renderAll();
  }

  try {
    const paper = getPaperForMatrixRow(row);
    if (!paper) {
      const fallback = {
        ...row,
        autoFillState: "failed",
        verificationState: "error",
        updatedAt: Date.now()
      };
      await saveMatrixRow(fallback);
      if (!silent) {
        setStatus("Matrix row update failed: paper not found in project.");
      }
      return fallback;
    }
    if (!shouldAutoQueueMatrixForPaper(paper)) {
      const skippedRow = {
        ...mergeMatrixRowWithPaper(row, paper),
        autoFillState: row.autoFillState || "queued",
        verificationState: "stale",
        updatedAt: Date.now()
      };
      await saveMatrixRow(skippedRow);
      if (!silent) {
        setStatus("Row skipped: paper is not screening-approved for extraction.");
      }
      return skippedRow;
    }

    if (!silent) {
      if (regenerateTagsOnly) {
        setStatus(`Generating hidden tags: ${truncateText(paper.title || "selected paper", 90)}`);
      } else if (normalizedFillMode === "missing") {
        setStatus(`Auto-filling blank criteria: ${truncateText(paper.title || "selected paper", 90)}`);
      } else if (isReverify) {
        setStatus(`Reverifying row: ${truncateText(paper.title || "selected paper", 90)}`);
      } else {
        setStatus(`Autofilling row: ${truncateText(paper.title || "selected paper", 90)}`);
      }
    }

    const runningRow = {
      ...mergeMatrixRowWithPaper(row, paper),
      autoFillState: "running",
      updatedAt: Date.now()
    };
    await saveMatrixRow(runningRow);
    if (!silent) {
      renderAll();
    }

    const snippet = await getPaperSnippet(paper);
    const deepResolution = await ensureDeepFileIdForPaper(paper);
    const unavailableReason = deepResolution.fileId ? "" : formatDeepContextUnavailableReason(deepResolution);
    const limitedContext = snippet || paper.title || row.paperTitle || "";
    if (!deepResolution.fileId && !limitedContext) {
      const missingSourceRow = regenerateTagsOnly
        ? {
            ...runningRow,
            autoFillState: row.autoFillState || "done",
            verificationState: row.verificationState || "stale",
            updatedAt: Date.now()
          }
        : {
            ...runningRow,
            autoFillState: isReverify ? row.autoFillState || "done" : "pending_source",
            verificationState: isReverify ? "stale" : runningRow.verificationState,
            updatedAt: Date.now(),
            cellsByColumnId: isReverify
              ? Object.fromEntries(
                  Object.entries(runningRow.cellsByColumnId || {}).map(([columnId, cell]) => {
                    if (cell?.source === "manual" && cell?.locked) {
                      return [columnId, cell];
                    }
                    return [
                      columnId,
                      {
                        ...(cell || {}),
                        stale: true,
                        updatedAt: Date.now()
                      }
                    ];
                  })
                )
              : runningRow.cellsByColumnId || {}
          };
      await saveMatrixRow(missingSourceRow);
      if (!silent) {
        if (regenerateTagsOnly) {
          setStatus(`Tag regeneration skipped: ${unavailableReason}.`);
        } else {
          setStatus(
            isReverify
              ? `Reverify marked stale: ${unavailableReason}.`
              : `Autofill pending source access: ${unavailableReason}.`
          );
        }
      }
      return missingSourceRow;
    }
    if (!deepResolution.fileId && !silent) {
      setStatus(
        regenerateTagsOnly
          ? `Generating tags with limited context: ${unavailableReason}.`
          : `Running matrix fill with limited context: ${unavailableReason}.`
      );
    }

    const fillableColumns = getMatrixColumnsForLlm().filter((column) => (
      !hasTargetColumns || targetColumnIdSet.has(column.columnId)
    ));
    const llmColumns = regenerateTagsOnly
      ? getMatrixColumnsForLlm().filter((column) => column.type === "text" && column.clusterEnabled !== false)
      : normalizedFillMode === "missing"
        ? fillableColumns.filter((column) => !isMatrixCellFilled(runningRow.cellsByColumnId?.[column.columnId]))
        : fillableColumns;
    if (llmColumns.length === 0) {
      const doneRow = regenerateTagsOnly
        ? {
            ...runningRow,
            autoFillState: row.autoFillState || "done",
            verificationState: row.verificationState || "stale",
            updatedAt: Date.now()
          }
        : normalizedFillMode === "missing"
          ? {
              ...runningRow,
              autoFillState: row.autoFillState || "done",
              verificationState: row.verificationState || "stale",
              lastVerifiedAt: row.lastVerifiedAt || runningRow.lastVerifiedAt || null,
              updatedAt: Date.now()
            }
        : {
            ...runningRow,
            autoFillState: "done",
            verificationState: "fresh",
            lastVerifiedAt: Date.now(),
            updatedAt: Date.now()
          };
      await saveMatrixRow(doneRow);
      if (!silent && regenerateTagsOnly) {
        setStatus("No text columns enabled for hidden-tag generation.");
      } else if (!silent && normalizedFillMode === "missing") {
        setStatus("No blank criteria columns to auto-fill.");
      }
      return doneRow;
    }

    const { response, warnings } = await generateLLM("project_matrix_row_fill", {
      title: paper.title,
      selectedText: paper.title,
      contextWindow: limitedContext,
      snippet: snippet || limitedContext,
      projectBrief: getProjectBrief(state.activeProject),
      projectKeyTerms: Array.isArray(state.activeProject?.keyTerms) ? state.activeProject.keyTerms : [],
      projectRubric: Array.isArray(state.activeProject?.rubric) ? state.activeProject.rubric : [],
      matrixColumns: llmColumns,
      openaiFileId: deepResolution.fileId || ""
    });
    const allWarnings = [
      ...(Array.isArray(deepResolution.warnings) ? deepResolution.warnings : []),
      ...(Array.isArray(warnings) ? warnings : [])
    ];
    const nextCells = { ...(runningRow.cellsByColumnId || {}) };
    const now = Date.now();
    const responseCells = Array.isArray(response?.cells) ? response.cells : [];
    for (const payload of responseCells) {
      const columnId = normalizeText(payload?.columnId);
      if (hasTargetColumns && !targetColumnIdSet.has(columnId)) {
        continue;
      }
      const column = getMatrixColumnById(columnId);
      if (!column) {
        continue;
      }
      const previous = nextCells[columnId];
      if (normalizedFillMode === "missing" && isMatrixCellFilled(previous)) {
        continue;
      }
      if (isReverify && normalizedFillMode !== "overwrite" && previous?.source === "manual" && previous?.locked) {
        continue;
      }
      if (regenerateTagsOnly) {
        continue;
      }
      nextCells[columnId] = {
        value: normalizeMatrixInputValueByType(payload?.value, column.type),
        source: "auto",
        locked: false,
        confidence: Math.max(0, Math.min(1, Number(payload?.confidence) || 0)),
        evidenceSnippet: truncateText(payload?.evidenceSnippet, 320),
        evidencePage: Number.isFinite(Number(payload?.evidencePage)) ? Math.max(0, Math.floor(Number(payload.evidencePage))) : null,
        insufficientReason: truncateText(payload?.insufficientReason, 180),
        updatedAt: now,
        stale: false
      };
    }

    const nextHidden = { ...(runningRow.hiddenFeaturesByColumnId || {}) };
    const hiddenPayload = Array.isArray(response?.hiddenFeatures) ? response.hiddenFeatures : [];
    for (const hidden of hiddenPayload) {
      const columnId = normalizeText(hidden?.columnId);
      const column = getMatrixColumnById(columnId);
      if (!column || column.type !== "text") {
        continue;
      }
      const tags = Array.isArray(hidden?.tags)
        ? hidden.tags.map((tag) => normalizeText(tag).toLowerCase()).filter(Boolean).slice(0, 6)
        : [];
      nextHidden[columnId] = {
        tags,
        updatedAt: now
      };
    }

    const completedRow = regenerateTagsOnly
      ? {
          ...runningRow,
          cellsByColumnId: nextCells,
          hiddenFeaturesByColumnId: nextHidden,
          autoFillState: row.autoFillState || "done",
          verificationState: row.verificationState || "stale",
          lastVerifiedAt: row.lastVerifiedAt || runningRow.lastVerifiedAt || null,
          updatedAt: now
        }
      : {
          ...runningRow,
          cellsByColumnId: nextCells,
          hiddenFeaturesByColumnId: nextHidden,
          autoFillState: "done",
          verificationState: allWarnings.length ? "stale" : "fresh",
          lastVerifiedAt: now,
          updatedAt: now
        };
    await saveMatrixRow(completedRow);
    if (!silent) {
      if (regenerateTagsOnly) {
        setStatus(`Hidden tags regenerated: ${paper.title}`);
      } else if (isReverify) {
        setStatus(`Reverified row: ${paper.title}`);
      } else {
        setStatus(`Matrix autofill complete: ${paper.title}`);
      }
    }
    return completedRow;
  } catch (error) {
    logger.warn("Matrix row autofill failed", {
      rowId,
      message: error?.message || "Unknown error"
    });
    const failedBase = getMatrixRowById(rowId) || row;
    const failedRow = {
      ...failedBase,
      autoFillState: regenerateTagsOnly
        ? failedBase.autoFillState || "done"
        : isReverify
          ? failedBase.autoFillState || "done"
          : "failed",
      verificationState: regenerateTagsOnly
        ? failedBase.verificationState || "stale"
        : isReverify
          ? "error"
          : failedBase.verificationState || "stale",
      updatedAt: Date.now()
    };
    try {
      await saveMatrixRow(failedRow);
    } catch (_persistError) {
      // Ignore secondary persistence failure; status message still reports primary error.
    }
    if (!silent) {
      setStatus(`Matrix row update failed: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
    return failedRow;
  } finally {
    const nextBusy = { ...(state.matrixRowBusyById || {}) };
    delete nextBusy[rowId];
    state.matrixRowBusyById = nextBusy;
    if (!silent) {
      renderAll();
    }
  }
}

function closeMatrixAutofillDialog(result = "cancel") {
  if (ui.matrixAutofillModal instanceof HTMLElement) {
    ui.matrixAutofillModal.hidden = true;
  }
  const resolve = state.matrixAutofillDialogResolve;
  state.matrixAutofillDialogResolve = null;
  if (typeof resolve === "function") {
    resolve(result);
  }
}

function openMatrixAutofillDialog(row) {
  if (!(ui.matrixAutofillModal instanceof HTMLElement)) {
    return Promise.resolve("missing");
  }
  if (ui.matrixAutofillPaperTitle instanceof HTMLElement) {
    ui.matrixAutofillPaperTitle.textContent = row?.paperTitle || "Selected matrix row";
  }
  ui.matrixAutofillModal.hidden = false;
  return new Promise((resolve) => {
    state.matrixAutofillDialogResolve = resolve;
    queueMicrotask(() => {
      if (ui.matrixAutofillIgnoreFilled instanceof HTMLButtonElement) {
        ui.matrixAutofillIgnoreFilled.focus();
      }
    });
  });
}

async function runMatrixRowAutofill(row) {
  if (!row) {
    return null;
  }
  const controlState = getMatrixRowAutofillControlState(row);
  if (controlState.disabled) {
    setStatus(controlState.title || "Auto-fill is unavailable for this row.");
    return row;
  }
  let fillMode = "all";
  if (hasFilledMatrixCriteria(row)) {
    fillMode = await openMatrixAutofillDialog(row);
    if (fillMode === "cancel") {
      setStatus("Auto-fill canceled.");
      return row;
    }
    if (fillMode === "missing" && !hasBlankMatrixCriteria(row)) {
      setStatus("No blank criteria columns to auto-fill.");
      return row;
    }
  }
  const result = await refreshMatrixRowAutofill(row, { fillMode });
  if (result && state.activeProjectId) {
    setChecklistForProject(state.activeProjectId, { ranMatrix: true });
  }
  return result;
}

async function runMatrixColumnAutofill(columnId, { overwriteFilled = false } = {}) {
  if (!state.activeProject || !state.matrix) {
    setStatus("Select a project first.");
    return;
  }
  const normalizedColumnId = normalizeText(columnId);
  if (!normalizedColumnId) {
    return;
  }
  const targetColumn = getMatrixColumnsForLlm().find((column) => column.columnId === normalizedColumnId);
  if (!targetColumn) {
    setStatus("Column is hidden, removed, or unavailable for auto-fill.");
    return;
  }
  if (isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn")) {
    setStatus("Matrix auto-fill is already running.");
    return;
  }

  const eligibleRows = getActiveMatrixRows().filter(
    (row) => isMatrixRowEligibleForAutomation(row) && hasMatrixRowVerificationSource(row)
  );
  if (!eligibleRows.length) {
    setStatus("No included rows with source links are ready for this column.");
    return;
  }

  const filledCount = eligibleRows.filter((row) => isMatrixCellFilled(row.cellsByColumnId?.[normalizedColumnId])).length;
  let fillMode = overwriteFilled ? "overwrite" : "missing";
  if (!overwriteFilled && filledCount > 0) {
    const overwrite = window.confirm(
      `"${targetColumn.label}" already has values in ${filledCount} row${filledCount === 1 ? "" : "s"}.\n\n`
      + "OK: overwrite that column for all eligible rows\n"
      + "Cancel: fill only blank cells"
    );
    fillMode = overwrite ? "overwrite" : "missing";
  }

  const rowsToUpdate = fillMode === "overwrite"
    ? eligibleRows
    : eligibleRows.filter((row) => !isMatrixCellFilled(row.cellsByColumnId?.[normalizedColumnId]));
  if (!rowsToUpdate.length) {
    setStatus(`No blank cells remain for "${targetColumn.label}".`);
    return;
  }

  setMatrixOpRunning("autofillColumn", true);
  renderAll();
  try {
    setStatus(`Auto-filling "${targetColumn.label}" for ${rowsToUpdate.length} row${rowsToUpdate.length === 1 ? "" : "s"}...`);
    let successCount = 0;
    let failedCount = 0;
    let pendingSourceCount = 0;
    for (const row of rowsToUpdate) {
      const result = await refreshMatrixRowAutofill(row, {
        fillMode,
        targetColumnIds: [normalizedColumnId],
        silent: true
      });
      if (!result || result.autoFillState === "failed") {
        failedCount += 1;
      } else if (result.autoFillState === "pending_source") {
        pendingSourceCount += 1;
        successCount += 1;
      } else {
        successCount += 1;
      }
    }
    state.matrixSuggestedAutofillColumnId = "";
    setChecklistForProject(state.activeProjectId, { ranMatrix: true });
    renderAll();
    setStatus(
      `"${targetColumn.label}" auto-fill complete: ${successCount} updated, ${failedCount} failed`
      + `${pendingSourceCount ? `, ${pendingSourceCount} pending source` : ""}.`
    );
  } finally {
    setMatrixOpRunning("autofillColumn", false);
    scheduleMatrixAutoSync();
    renderAll();
  }
}

async function runMatrixAutofillForAll() {
  if (!state.activeProject || !state.matrix) {
    setStatus("Select a project first.");
    return;
  }
  if (isMatrixOpRunning("autofillAll") || isMatrixOpRunning("autofillColumn")) {
    setStatus("Matrix autofill already running.");
    return;
  }
  if (getMatrixColumnsForLlm().length === 0) {
    setStatus("Add at least one criterion column before auto-fill.");
    return;
  }
  const rows = getActiveMatrixRows().filter(
    (row) => isMatrixRowEligibleForAutomation(row) && hasMatrixRowVerificationSource(row)
  );
  if (!rows.length) {
    setStatus("No included matrix rows with source links to fill.");
    return;
  }
  setMatrixOpRunning("autofillAll", true);
  renderAll();
  try {
    setStatus("Running matrix autofill...");
    let successCount = 0;
    let failedCount = 0;
    let pendingSourceCount = 0;
    for (const row of rows) {
      const result = await refreshMatrixRowAutofill(row, { silent: true });
      if (!result || result.autoFillState === "failed") {
        failedCount += 1;
      } else if (result.autoFillState === "pending_source") {
        pendingSourceCount += 1;
        successCount += 1;
      } else {
        successCount += 1;
      }
    }
    renderAll();
    setStatus(`Matrix autofill completed: ${successCount} updated, ${failedCount} failed${pendingSourceCount ? `, ${pendingSourceCount} pending source` : ""}.`);
    setChecklistForProject(state.activeProjectId, { ranMatrix: true });
  } finally {
    setMatrixOpRunning("autofillAll", false);
    scheduleMatrixAutoSync();
    renderAll();
  }
}

async function runMatrixClusteringAction() {
  if (!state.activeProject || !state.matrix) {
    setStatus("Select a project first.");
    return;
  }
  if (isMatrixOpRunning("clustering")) {
    setStatus("Clustering is already running.");
    return;
  }
  const rows = getActiveMatrixRows().filter((row) => isMatrixRowEligibleForAutomation(row));
  if (rows.length < 3) {
    setStatus("Need at least 3 screening-approved rows to run clustering.");
    return;
  }
  const columns = getActiveMatrixColumns().filter((column) => column.clusterEnabled !== false);
  if (!columns.length) {
    setStatus("Select at least one cluster-enabled feature column.");
    return;
  }
  setMatrixOpRunning("clustering", true);
  renderAll();
  try {
    const clusterResult = runMatrixClustering({
      matrix: state.matrix,
      rows,
      featureColumnIds: columns.map((column) => column.id)
    });
    if (!clusterResult.ok) {
      setStatus(clusterResult.reason || "Could not run clustering.");
      return;
    }
    const clusterState = {
      dataHash: clusterResult.dataHash,
      featureColumnIds: clusterResult.selectedColumnIds,
      k: clusterResult.k,
      updatedAt: Date.now(),
      pointsByRowId: clusterResult.pointsByRowId,
      assignmentsByRowId: clusterResult.assignmentsByRowId
    };
    await persistMatrix({
      ...state.matrix,
      clusterState
    });
    state.matrixFeatureDirty = false;
    state.contributionMapDirty = true;
    renderAll();
    setStatus(`Matrix clustering complete: k=${clusterResult.k}, ${rows.length} row${rows.length === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(`Matrix clustering failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("clustering", false);
    renderAll();
  }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportMatrixCsv() {
  if (!state.matrix) {
    setStatus("No matrix to export.");
    return;
  }
  const { headers, rows } = buildMatrixExportRows(state.matrix, getFilteredMatrixRows());
  const csv = serializeCsv(headers, rows);
  if (!csv) {
    setStatus("No matrix data to export.");
    return;
  }
  downloadText("clarify-matrix.csv", csv, "text/csv;charset=utf-8");
  setStatus("Matrix CSV exported.");
}

function exportMatrixXlsx() {
  if (!state.matrix) {
    setStatus("No matrix to export.");
    return;
  }
  const { headers, rows } = buildMatrixExportRows(state.matrix, getFilteredMatrixRows());
  const xlsxBlob = buildXlsxBlob([headers, ...rows], {
    sheetName: state.activeProject?.name || "Matrix"
  });
  downloadBlob("clarify-matrix.xlsx", xlsxBlob);
  setStatus("Matrix XLSX exported.");
}

async function loadGoogleSheetChoices() {
  if (isMatrixOpRunning("loadSheets")) {
    return;
  }
  const clientId = normalizeText(ui.matrixGoogleClientId?.value || state.settings?.googleClientId || "");
  if (!clientId) {
    setStatus("Set Google OAuth Client ID first.");
    return;
  }
  setMatrixOpRunning("loadSheets", true);
  renderAll();
  try {
    const token = await getGoogleAccessToken({ clientId });
    const sheets = await listGoogleSpreadsheets({
      token,
      query: ui.matrixSheetSearch?.value || ""
    });
    state.googleSheetChoices = sheets;
    clearElement(ui.matrixSpreadsheetSelect);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select spreadsheet";
    ui.matrixSpreadsheetSelect.append(placeholder);
    for (const sheet of sheets) {
      const option = document.createElement("option");
      option.value = sheet.id;
      option.textContent = sheet.name;
      option.selected = state.matrix?.sheetsSync?.spreadsheetId === sheet.id;
      ui.matrixSpreadsheetSelect.append(option);
    }
    setStatus(`Loaded ${sheets.length} spreadsheet option${sheets.length === 1 ? "" : "s"}.`);
  } catch (error) {
    logger.warn("Google sheet list failed", { message: error?.message || "Unknown error" });
    setStatus(`Failed to load sheets: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("loadSheets", false);
    renderAll();
  }
}

async function loadGoogleTabChoices(spreadsheetId) {
  const normalizedSpreadsheetId = normalizeText(spreadsheetId);
  if (!normalizedSpreadsheetId) {
    return;
  }
  if (isMatrixOpRunning("loadTabs")) {
    return;
  }
  const clientId = normalizeText(ui.matrixGoogleClientId?.value || state.settings?.googleClientId || "");
  if (!clientId) {
    setStatus("Set Google OAuth Client ID first.");
    return;
  }
  setMatrixOpRunning("loadTabs", true);
  renderAll();
  try {
    const token = await getGoogleAccessToken({ clientId });
    const payload = await listSheetTabs({
      token,
      spreadsheetId: normalizedSpreadsheetId
    });
    state.googleTabChoices = payload.sheets;
    clearElement(ui.matrixWorksheetSelect);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select worksheet";
    ui.matrixWorksheetSelect.append(placeholder);
    for (const sheet of payload.sheets) {
      const option = document.createElement("option");
      option.value = sheet.title;
      option.textContent = sheet.title;
      option.dataset.sheetId = String(sheet.sheetId);
      option.selected = state.matrix?.sheetsSync?.sheetTitle === sheet.title;
      ui.matrixWorksheetSelect.append(option);
    }
    if (state.matrix) {
      await persistMatrix({
        ...state.matrix,
        sheetsSync: {
          ...(state.matrix.sheetsSync || {}),
          spreadsheetId: payload.spreadsheetId,
          spreadsheetName: payload.spreadsheetName || "",
          sheetTitle: state.matrix?.sheetsSync?.sheetTitle || "",
          sheetId: state.matrix?.sheetsSync?.sheetId ?? null
        }
      });
    }
    setStatus(`Loaded ${payload.sheets.length} worksheet tab${payload.sheets.length === 1 ? "" : "s"}.`);
  } catch (error) {
    logger.warn("Google worksheet list failed", { message: error?.message || "Unknown error" });
    setStatus(`Failed to load worksheet tabs: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("loadTabs", false);
    renderAll();
  }
}

async function syncMatrixToGoogleNow({ silent = false } = {}) {
  const clientId = normalizeText(ui.matrixGoogleClientId?.value || state.settings?.googleClientId || "");
  if (!state.matrix || !clientId) {
    if (!silent) {
      setStatus("Matrix or Google settings missing.");
    }
    return;
  }
  if (state.matrixSyncInProgress) {
    if (!silent) {
      setStatus("Matrix sync already in progress.");
    }
    return;
  }
  const sync = state.matrix.sheetsSync || {};
  if (!sync.spreadsheetId || !sync.sheetTitle) {
    if (!silent) {
      setStatus("Select spreadsheet and worksheet first.");
    }
    return;
  }
  setMatrixOpRunning("sync", true);
  state.matrixSyncInProgress = true;
  renderAll();
  try {
    const token = await getGoogleAccessToken({ clientId });
    const { headers, rows } = buildMatrixExportRows(state.matrix, getMatrixRows());
    const report = await syncMatrixToGoogleSheet({
      token,
      spreadsheetId: sync.spreadsheetId,
      sheetTitle: sync.sheetTitle,
      headers,
      rows,
      keyColumn: "Paper Key"
    });
    await persistMatrix({
      ...state.matrix,
      sheetsSync: {
        ...sync,
        lastSyncAt: Date.now(),
        lastSyncReport: report
      }
    }, { skipAutoSync: true });
    renderAll();
    if (!silent) {
      const errorNote = Array.isArray(report.errors) && report.errors.length ? ` (${report.errors.length} warnings)` : "";
      setStatus(`Google sync complete: ${report.successCount} success, ${report.failureCount} failed${errorNote}.`);
    }
  } catch (error) {
    const errorMessage = truncateText(error?.message || "Unknown error", 160);
    try {
      await persistMatrix(
        {
          ...state.matrix,
          sheetsSync: {
            ...sync,
            lastSyncAt: Date.now(),
            lastSyncReport: {
              successCount: 0,
              failureCount: 0,
              errors: [errorMessage]
            }
          }
        },
        { skipAutoSync: true }
      );
    } catch (_persistError) {
      // Ignore persistence issue when primary sync already failed.
    }
    if (!silent) {
      setStatus(`Google sync failed: ${errorMessage}`);
    }
  } finally {
    state.matrixSyncInProgress = false;
    setMatrixOpRunning("sync", false);
    renderAll();
  }
}

function renderSynthesis() {
  clearElement(ui.synthesisSummary);
  clearElement(ui.synthesisConsensus);
  clearElement(ui.synthesisContradictions);
  clearElement(ui.synthesisGaps);
  clearElement(ui.contributionClusters);
  clearElement(ui.contributionZones);
  clearElement(ui.contributionIdeas);

  if (!state.activeProject) {
    const empty = document.createElement("p");
    empty.className = "emptyState";
    empty.textContent = "Select a project to view synthesis.";
    ui.synthesisSummary.append(empty);
    if (ui.contributionMeta) {
      ui.contributionMeta.textContent = "";
    }
    return;
  }

  const analyses = Object.values(state.analysesByDocId || {});
  const analyzedCount = analyses.length;
  const includeCount = analyses.filter((item) => item.recommendation === "include").length;
  const excludeCount = analyses.filter((item) => item.recommendation === "exclude").length;
  const avgFit = analyzedCount
    ? Math.round(analyses.reduce((acc, item) => acc + Number(item.fitScore || 0), 0) / analyzedCount)
    : 0;

  const summary = document.createElement("p");
  summary.className = "paperMeta";
  summary.textContent = `Papers: ${state.papers.length} | Analyses: ${analyzedCount} | Include: ${includeCount} | Exclude: ${excludeCount} | Avg fit: ${avgFit}%`;
  ui.synthesisSummary.append(summary);

  const comparison = state.comparison?.result || {};
  const consensus = Array.isArray(comparison.crossPaperInsights) ? comparison.crossPaperInsights : [];
  const contradictions = Array.isArray(comparison.contradictions) ? comparison.contradictions : [];
  const gaps = Array.isArray(comparison.evidenceGaps) ? comparison.evidenceGaps : [];

  const renderList = (target, items, fallbackText) => {
    if (!items.length) {
      const empty = document.createElement("li");
      empty.textContent = fallbackText;
      target.append(empty);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      target.append(li);
    }
  };

  renderList(ui.synthesisConsensus, consensus, "Run comparison to populate consensus insights.");
  renderList(ui.synthesisContradictions, contradictions, "No contradictions available yet.");
  renderList(ui.synthesisGaps, gaps, "No evidence gaps available yet.");

  const contribution = state.contributionMap && typeof state.contributionMap === "object" ? state.contributionMap : null;
  if (ui.contributionMeta) {
    ui.contributionMeta.textContent = contribution
      ? `Updated ${formatDate(contribution.updatedAt)}${state.contributionMapDirty ? " | Data changed" : ""}`
      : "No contribution map run yet.";
  }
  const renderContributionList = (target, items, fallbackText) => {
    if (!target) {
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      const item = document.createElement("li");
      item.textContent = fallbackText;
      target.append(item);
      return;
    }
    for (const entry of items) {
      const item = document.createElement("li");
      const label = normalizeText(entry?.label);
      const summaryText = normalizeText(entry?.summary);
      item.textContent = label && summaryText ? `${label}: ${summaryText}` : (summaryText || label || "-");
      target.append(item);
    }
  };
  renderContributionList(
    ui.contributionClusters,
    contribution?.clustersSummary,
    "Run contribution map to summarize clusters."
  );
  renderContributionList(
    ui.contributionZones,
    contribution?.underexploredZones,
    "No underexplored zones yet."
  );
  renderContributionList(
    ui.contributionIdeas,
    contribution?.differentiationIdeas,
    "No differentiation ideas yet."
  );
  if (ui.runContributionMap instanceof HTMLButtonElement) {
    ui.runContributionMap.disabled = !state.activeProject || getFilteredMatrixRows().length < 2;
  }
  if (ui.exportContributionMd instanceof HTMLButtonElement) {
    ui.exportContributionMd.disabled = !contribution;
  }
  if (ui.exportContributionCsv instanceof HTMLButtonElement) {
    ui.exportContributionCsv.disabled = !contribution;
  }
}

function renderAll() {
  renderPipelineShell();
  renderProjectList();
  renderProjectSwitcher();
  renderDiscoverPane();
  renderScreenPane();
  renderPaperList();
  renderMatrixPane();
  renderStoryboardPanels();
  renderCompareWarnings();
  renderCompareOutput();
  renderSynthesis();
  renderHomeChecklist();
  renderWorkspaceActivity();
  syncHomeSettingsControls();
  applyStaticIcons();
  if (ui.activeProjectLabel instanceof HTMLElement) {
    ui.activeProjectLabel.textContent = state.activeProject
      ? state.activeProject.name
      : "No project";
  }
  updateImportControlsState();
}

async function refreshPipelineDerivedState() {
  if (!state.activeProjectId) {
    state.screeningMetrics = null;
    state.pipelineJobs = [];
    return;
  }
  const [metrics, jobs] = await Promise.all([
    getProjectScreeningMetrics(state.activeProjectId),
    listProjectPipelineJobs(state.activeProjectId)
  ]);
  state.screeningMetrics = metrics && typeof metrics === "object" ? metrics : null;
  state.pipelineJobs = Array.isArray(jobs) ? jobs : [];
}

function buildDiscoverQueryFromInputs() {
  const fallbackKeywords = Array.isArray(state.activeProject?.keyTerms)
    ? state.activeProject.keyTerms.join(" ")
    : "";
  return {
    keywords: ui.discoverKeywords?.value || fallbackKeywords,
    mustHave: ui.discoverMustHave?.value || "",
    excludeTerms: ui.discoverExcludeTerms?.value || "",
    yearFrom: parseYearInput(ui.discoverYearFrom?.value),
    yearTo: parseYearInput(ui.discoverYearTo?.value),
    venueFilter: ui.discoverVenueFilter?.value || "",
    typeFilter: ui.discoverTypeFilter?.value || "all"
  };
}

function applyDiscoverQueryToInputs(query) {
  const source = query && typeof query === "object" ? query : {};
  if (ui.discoverKeywords instanceof HTMLInputElement) {
    ui.discoverKeywords.value = source.keywords || "";
  }
  if (ui.discoverMustHave instanceof HTMLInputElement) {
    ui.discoverMustHave.value = source.mustHave || "";
  }
  if (ui.discoverExcludeTerms instanceof HTMLInputElement) {
    ui.discoverExcludeTerms.value = source.excludeTerms || "";
  }
  if (ui.discoverYearFrom instanceof HTMLInputElement) {
    ui.discoverYearFrom.value = Number.isFinite(Number(source.yearFrom)) ? String(source.yearFrom) : "";
  }
  if (ui.discoverYearTo instanceof HTMLInputElement) {
    ui.discoverYearTo.value = Number.isFinite(Number(source.yearTo)) ? String(source.yearTo) : "";
  }
  if (ui.discoverVenueFilter instanceof HTMLInputElement) {
    ui.discoverVenueFilter.value = source.venueFilter || "";
  }
  if (ui.discoverTypeFilter instanceof HTMLSelectElement) {
    const typeFilter = normalizeText(source.typeFilter).toLowerCase() || "all";
    ui.discoverTypeFilter.value = typeFilter;
  }
}

function buildSavedSearchName(query) {
  const keywords = truncateText(query.keywords, 80);
  const mustHave = truncateText(query.mustHave, 60);
  if (keywords && mustHave) {
    return `${keywords} + ${mustHave}`;
  }
  if (keywords) {
    return keywords;
  }
  if (mustHave) {
    return mustHave;
  }
  return `Search ${new Date().toLocaleDateString()}`;
}

async function runDiscoverySearch({ query = null, source = "manual", saveSearchId = "" } = {}) {
  if (!state.activeProjectId || state.discoverSearchInProgress) {
    return;
  }
  const finalQuery = query && typeof query === "object" ? query : buildDiscoverQueryFromInputs();
  const runId = `run_${Date.now().toString(36)}`;
  const keywordText = normalizeText(finalQuery.keywords || "");
  if (!keywordText) {
    setStatus("Enter discovery keywords first.");
    return;
  }
  state.discoverSearchInProgress = true;
  renderAll();
  const ingestJob = await enqueueProjectPipelineJob(state.activeProjectId, "candidate_ingest", {
    runId,
    source,
    query: finalQuery
  });
  setStatus("Running discovery search...");
  try {
    const result = await searchDiscoveryCandidates(finalQuery, { maxResults: 60, runId });
    await upsertProjectDiscoveryCandidates(state.activeProjectId, result.candidates || [], { runId });
    const dedupeResult = await dedupeProjectDiscoveryCandidates(state.activeProjectId);
    if (saveSearchId) {
      const existing = (state.savedSearches || []).find((entry) => entry.id === saveSearchId);
      if (existing) {
        const intervalDays = Number.isFinite(Number(existing.intervalDays))
          ? Math.max(1, Math.min(30, Math.floor(Number(existing.intervalDays))))
          : 7;
        await saveProjectSavedSearch(state.activeProjectId, {
          ...existing,
          lastRunAt: Date.now(),
          nextRunAt: Date.now() + intervalDays * 24 * 60 * 60 * 1000
        });
      }
    }
    if (ingestJob) {
      await updateProjectPipelineJob(state.activeProjectId, ingestJob.id, {
        state: "done",
        payload: {
          ...(ingestJob.payload || {}),
          resultCount: Array.isArray(result.candidates) ? result.candidates.length : 0,
          duplicateCount: Number(dedupeResult.duplicateCount || 0)
        }
      });
    }
    state.discoveryCandidates = await listProjectDiscoveryCandidates(state.activeProjectId);
    state.savedSearches = await listProjectSavedSearches(state.activeProjectId);
    state.discoverLastRunId = runId;
    state.discoverLastRunWarnings = Array.isArray(result.warnings) ? result.warnings : [];
    await refreshPipelineDerivedState();
    state.contributionMapDirty = true;
    setChecklistForProject(state.activeProjectId, { ranDiscover: true });
    const createdCount = Array.isArray(result.candidates) ? result.candidates.length : 0;
    setStatus(
      `Discovery run complete: ${createdCount} candidate${createdCount === 1 ? "" : "s"}`
      + (dedupeResult.duplicateCount ? ` | ${dedupeResult.duplicateCount} duplicates` : "")
    );
  } catch (error) {
    if (ingestJob) {
      await updateProjectPipelineJob(state.activeProjectId, ingestJob.id, {
        state: "failed",
        lastError: truncateText(error?.message || "Unknown error", 220)
      });
    }
    setStatus(`Discovery search failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    state.discoverSearchInProgress = false;
    renderAll();
  }
}

async function saveCurrentDiscoverSearch() {
  if (!state.activeProjectId) {
    setStatus("Select a project first.");
    return;
  }
  const query = buildDiscoverQueryFromInputs();
  if (!normalizeText(query.keywords)) {
    setStatus("Enter keywords before saving search.");
    return;
  }
  const selectedId = normalizeText(ui.discoverSavedSearchSelect?.value || "");
  const existing = selectedId ? (state.savedSearches || []).find((entry) => entry.id === selectedId) : null;
  const autoEnabled = ui.discoverSavedAutoEnabled instanceof HTMLInputElement
    ? Boolean(ui.discoverSavedAutoEnabled.checked)
    : Boolean(existing?.autoEnabled);
  const intervalDays = ui.discoverSavedIntervalDays instanceof HTMLInputElement
    ? parseBoundedNumber(ui.discoverSavedIntervalDays.value, 1, 30) ?? (existing?.intervalDays || 7)
    : (existing?.intervalDays || 7);
  const saved = await saveProjectSavedSearch(state.activeProjectId, {
    ...(existing || {}),
    name: existing?.name || buildSavedSearchName(query),
    keywords: query.keywords,
    mustHave: query.mustHave,
    excludeTerms: query.excludeTerms,
    yearFrom: query.yearFrom,
    yearTo: query.yearTo,
    venueFilter: query.venueFilter,
    typeFilter: query.typeFilter,
    autoEnabled,
    intervalDays,
    nextRunAt: autoEnabled
      ? Number.isFinite(Number(existing?.nextRunAt))
        ? Number(existing.nextRunAt)
        : Date.now() + intervalDays * 24 * 60 * 60 * 1000
      : null
  });
  state.savedSearches = await listProjectSavedSearches(state.activeProjectId);
  if (saved && ui.discoverSavedSearchSelect instanceof HTMLSelectElement) {
    ui.discoverSavedSearchSelect.value = saved.id;
  }
  renderAll();
  setStatus("Saved search updated.");
}

async function runDueSavedSearches() {
  if (!state.activeProjectId) {
    return;
  }
  const now = Date.now();
  const dueSearches = (Array.isArray(state.savedSearches) ? state.savedSearches : []).filter((search) => {
    if (!search.autoEnabled) {
      return false;
    }
    if (!Number.isFinite(Number(search.nextRunAt))) {
      return true;
    }
    return Number(search.nextRunAt) <= now;
  });
  if (dueSearches.length === 0) {
    setStatus("No due saved searches.");
    return;
  }
  for (const search of dueSearches.slice(0, 8)) {
    await runDiscoverySearch({
      source: "saved_search",
      saveSearchId: search.id,
      query: {
        keywords: search.keywords,
        mustHave: search.mustHave,
        excludeTerms: search.excludeTerms,
        yearFrom: search.yearFrom,
        yearTo: search.yearTo,
        venueFilter: search.venueFilter,
        typeFilter: search.typeFilter
      }
    });
  }
}

async function runSelectedSavedSearchNow() {
  const selectedId = normalizeText(ui.discoverSavedSearchSelect?.value || "");
  if (!selectedId) {
    setStatus("Select a saved search first.");
    return;
  }
  const search = (Array.isArray(state.savedSearches) ? state.savedSearches : []).find((entry) => entry.id === selectedId);
  if (!search) {
    setStatus("Saved search not found.");
    return;
  }
  await runDiscoverySearch({
    source: "saved_search_manual",
    saveSearchId: search.id,
    query: {
      keywords: search.keywords,
      mustHave: search.mustHave,
      excludeTerms: search.excludeTerms,
      yearFrom: search.yearFrom,
      yearTo: search.yearTo,
      venueFilter: search.venueFilter,
      typeFilter: search.typeFilter
    }
  });
}

function loadSelectedSavedSearchIntoInputs() {
  const selectedId = normalizeText(ui.discoverSavedSearchSelect?.value || "");
  if (!selectedId) {
    return;
  }
  const search = (Array.isArray(state.savedSearches) ? state.savedSearches : []).find((entry) => entry.id === selectedId);
  if (!search) {
    return;
  }
  applyDiscoverQueryToInputs({
    keywords: search.keywords,
    mustHave: search.mustHave,
    excludeTerms: search.excludeTerms,
    yearFrom: search.yearFrom,
    yearTo: search.yearTo,
    venueFilter: search.venueFilter,
    typeFilter: search.typeFilter
  });
  setStatus(`Loaded saved search: ${search.name}`);
}

async function deleteSelectedSavedSearch() {
  if (!state.activeProjectId) {
    return;
  }
  const selectedId = normalizeText(ui.discoverSavedSearchSelect?.value || "");
  if (!selectedId) {
    setStatus("Select a saved search first.");
    return;
  }
  await removeProjectSavedSearch(state.activeProjectId, selectedId);
  state.savedSearches = await listProjectSavedSearches(state.activeProjectId);
  renderAll();
  setStatus("Saved search removed.");
}

async function updateSelectedSavedSearchSchedule() {
  if (!state.activeProjectId) {
    return;
  }
  const selectedId = normalizeText(ui.discoverSavedSearchSelect?.value || "");
  if (!selectedId) {
    return;
  }
  const existing = (Array.isArray(state.savedSearches) ? state.savedSearches : []).find((entry) => entry.id === selectedId);
  if (!existing) {
    return;
  }
  const autoEnabled = ui.discoverSavedAutoEnabled instanceof HTMLInputElement
    ? Boolean(ui.discoverSavedAutoEnabled.checked)
    : Boolean(existing.autoEnabled);
  const intervalDays = ui.discoverSavedIntervalDays instanceof HTMLInputElement
    ? parseBoundedNumber(ui.discoverSavedIntervalDays.value, 1, 30) ?? (existing.intervalDays || 7)
    : (existing.intervalDays || 7);
  const nextRunAt = autoEnabled
    ? Number.isFinite(Number(existing.nextRunAt))
      ? Number(existing.nextRunAt)
      : Date.now() + intervalDays * 24 * 60 * 60 * 1000
    : null;
  await saveProjectSavedSearch(state.activeProjectId, {
    ...existing,
    autoEnabled,
    intervalDays,
    nextRunAt
  });
  state.savedSearches = await listProjectSavedSearches(state.activeProjectId);
  renderAll();
}

async function dedupeDiscoveryCandidatesAction() {
  if (!state.activeProjectId) {
    return;
  }
  const dedupeJob = await enqueueProjectPipelineJob(state.activeProjectId, "dedup_pass", {
    source: "discover_view"
  });
  try {
    const result = await dedupeProjectDiscoveryCandidates(state.activeProjectId);
    if (dedupeJob) {
      await updateProjectPipelineJob(state.activeProjectId, dedupeJob.id, {
        state: "done",
        payload: { duplicateCount: Number(result.duplicateCount || 0) }
      });
    }
    state.discoveryCandidates = await listProjectDiscoveryCandidates(state.activeProjectId);
    await refreshPipelineDerivedState();
    renderAll();
    setStatus(`Dedupe complete: ${Number(result.duplicateCount || 0)} duplicates marked.`);
  } catch (error) {
    if (dedupeJob) {
      await updateProjectPipelineJob(state.activeProjectId, dedupeJob.id, {
        state: "failed",
        lastError: truncateText(error?.message || "Unknown error", 220)
      });
    }
    setStatus(`Dedupe failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

async function queueCandidateToScreening(candidateId) {
  if (!state.activeProjectId) {
    return;
  }
  const normalizedCandidateId = normalizeText(candidateId);
  if (!normalizedCandidateId) {
    return;
  }
  const queuedPaper = await queueDiscoveryCandidateForScreening(state.activeProjectId, normalizedCandidateId, {
    decisionBy: "user"
  });
  if (!queuedPaper) {
    setStatus("Candidate could not be queued (duplicate or invalid).");
    return;
  }
  state.discoveryCandidates = await listProjectDiscoveryCandidates(state.activeProjectId);
  state.papers = await getProjectPapers(state.activeProjectId);
  state.screenSelectedPaperId = queuedPaper.id;
  await refreshPipelineDerivedState();
  setActiveView("screen");
  renderAll();
  setStatus("Candidate moved to screening queue.");
}

async function expandCitationsFromSelectedSeed() {
  if (!state.activeProjectId) {
    return;
  }
  const seedPaperId = normalizeText(ui.discoverSeedPaperSelect?.value || "");
  if (!seedPaperId) {
    setStatus("Select an included seed paper first.");
    return;
  }
  const seedPaper = state.papers.find((paper) => paper.id === seedPaperId);
  if (!seedPaper) {
    setStatus("Seed paper no longer exists.");
    return;
  }
  const direction = normalizeText(ui.discoverCitationDirection?.value || "both");
  setStatus("Running citation expansion...");
  try {
    const expansion = await expandDiscoveryFromSeedPaper(seedPaper, {
      direction,
      maxResults: 30,
      runId: `cit_${Date.now().toString(36)}`
    });
    const runId = `cit_${Date.now().toString(36)}`;
    await upsertProjectDiscoveryCandidates(state.activeProjectId, expansion.candidates || [], { runId });
    const seedIdentity = deriveCanonicalPaperFields({
      ...seedPaper,
      url: seedPaper?.sourceRef?.url || seedPaper?.url || seedPaper?.docId
    });
    const seedKey = seedIdentity.paperKey || seedPaper.canonicalKey || `paper:${seedPaper.id}`;
    await appendProjectCitationGraph(state.activeProjectId, {
      nodes: [
        {
          id: seedKey,
          label: seedPaper.title,
          canonicalKey: seedKey,
          url: seedPaper?.sourceRef?.url || "",
          type: "seed",
          paperId: seedPaper.id
        },
        ...(Array.isArray(expansion.candidates) ? expansion.candidates : []).map((candidate) => ({
          id: candidate.canonicalKey,
          label: candidate.title,
          canonicalKey: candidate.canonicalKey,
          url: candidate.url,
          type: "candidate"
        }))
      ],
      edges: (Array.isArray(expansion.edges) ? expansion.edges : []).map((edge, index) => ({
        id: `${Date.now()}_${index}`,
        from: edge.from || seedKey,
        to: edge.to,
        direction: edge.direction || "forward",
        source: edge.source || "openalex"
      })),
      updatedAt: Date.now()
    });
    state.discoveryCandidates = await listProjectDiscoveryCandidates(state.activeProjectId);
    state.citationGraph = await getProjectCitationGraph(state.activeProjectId);
    await refreshPipelineDerivedState();
    state.discoverLastRunWarnings = Array.isArray(expansion.warnings) ? expansion.warnings : [];
    renderAll();
    setStatus(
      `Citation expansion complete: ${Number(expansion.candidates?.length || 0)} candidate`
      + `${Number(expansion.candidates?.length || 0) === 1 ? "" : "s"} added.`
    );
  } catch (error) {
    setStatus(`Citation expansion failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

function getScreenPaperById(paperId) {
  const normalizedPaperId = normalizeText(paperId);
  if (!normalizedPaperId) {
    return null;
  }
  return state.papers.find((paper) => paper.id === normalizedPaperId) || null;
}

function moveScreenSelection(step = 1) {
  const queue = getScreenQueuePapers();
  if (queue.length === 0) {
    state.screenSelectedPaperId = "";
    return;
  }
  const currentIndex = queue.findIndex((paper) => paper.id === state.screenSelectedPaperId);
  if (currentIndex < 0) {
    state.screenSelectedPaperId = queue[0].id;
    return;
  }
  const nextIndex = Math.min(queue.length - 1, Math.max(0, currentIndex + Number(step || 1)));
  state.screenSelectedPaperId = queue[nextIndex]?.id || queue[0].id;
}

async function applyScreenDecisionAction(decision, paperId = "") {
  if (!state.activeProjectId) {
    return;
  }
  const targetPaper = getScreenPaperById(paperId || state.screenSelectedPaperId);
  if (!targetPaper) {
    setStatus("Select a screening row first.");
    return;
  }
  const normalizedDecision = normalizeText(decision).toLowerCase();
  const selectedReason = normalizeText(ui.screenReasonSelect?.value || "");
  if (normalizedDecision === "exclude" && !selectedReason) {
    if (ui.screenAdvanced instanceof HTMLDetailsElement) {
      ui.screenAdvanced.open = true;
      ui.screenAdvanced.dataset.userTouched = "1";
    }
    ui.screenReasonSelect?.focus();
    setStatus("Choose an exclusion reason in More before excluding.");
    return;
  }
  const decisionNotes = normalizeText(ui.screenDecisionNote?.value || "");
  const qualityScore = parseBoundedNumber(ui.screenQualityScore?.value, 0, 100);
  try {
    const updatedPaper = await applyScreenDecisionToPaper(state.activeProjectId, targetPaper.id, normalizedDecision, {
      reasonCodes: normalizedDecision === "exclude" ? [selectedReason] : [],
      screenNotes: decisionNotes,
      decisionBy: "user",
      qualityScore: qualityScore === null ? undefined : qualityScore
    });
    if (!updatedPaper) {
      setStatus("Screening decision failed.");
      return;
    }
    if (shouldAutoQueueMatrixForPaper(updatedPaper)) {
      const matrixJob = await enqueueProjectPipelineJob(state.activeProjectId, "matrix_fill", {
        paperId: updatedPaper.id,
        source: "screen_decision"
      });
      const row = await ensureMatrixRowForPaper(updatedPaper, { queue: true });
      if (matrixJob) {
        await updateProjectPipelineJob(state.activeProjectId, matrixJob.id, {
          state: "done",
          payload: {
            ...(matrixJob.payload || {}),
            rowId: row?.id || "",
            queued: Boolean(row)
          }
        });
      }
      if (row) {
        void refreshMatrixRowAutofill(row, { silent: true });
      }
    }
    state.papers = await getProjectPapers(state.activeProjectId);
    state.matrix = await getProjectMatrix(state.activeProjectId);
    state.contributionMapDirty = true;
    setChecklistForProject(state.activeProjectId, { screenedOne: true });
    await refreshPipelineDerivedState();
    moveScreenSelection(1);
    renderAll();
    setStatus(`Screen decision saved: ${updatedPaper.title} -> ${normalizedDecision}.`);
  } catch (error) {
    setStatus(`Screen decision failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

async function runScreeningSuggestionForSelectedPaper() {
  if (!state.activeProjectId || state.screeningSuggestBusy) {
    return;
  }
  const paper = getScreenPaperById(state.screenSelectedPaperId);
  if (!paper || !state.activeProject) {
    setStatus("Select a screening paper first.");
    return;
  }
  state.screeningSuggestBusy = true;
  const suggestJob = await enqueueProjectPipelineJob(state.activeProjectId, "screening_suggest", {
    paperId: paper.id
  });
  setStatus("Running screening suggestion...");
  renderAll();
  try {
    const candidate = getDiscoveryCandidateForPaper(paper);
    const context = [
      candidate?.abstract || "",
      candidate?.venue ? `Venue: ${candidate.venue}` : "",
      candidate?.year ? `Year: ${candidate.year}` : ""
    ].filter(Boolean).join("\n");
    const { response, warnings } = await generateLLM("project_screening_suggest", {
      title: paper.title,
      selectedText: paper.title,
      contextWindow: context || paper.title,
      snippet: context || "",
      projectBrief: getProjectBrief(state.activeProject),
      projectKeyTerms: state.activeProject.keyTerms || [],
      projectRubric: state.activeProject.rubric || [],
      screenReasonLibrary: state.screenReasonLibrary
    });
    await updateProjectPaper(state.activeProjectId, paper.id, {
      screenEvidence: {
        ...response,
        updatedAt: Date.now()
      }
    });
    const suggestedReason = normalizeText(Array.isArray(response?.reasonCandidates) ? response.reasonCandidates[0] : "");
    if (suggestedReason && ui.screenReasonSelect instanceof HTMLSelectElement) {
      const hasOption = Array.from(ui.screenReasonSelect.options || []).some((option) => option.value === suggestedReason);
      if (hasOption) {
        ui.screenReasonSelect.value = suggestedReason;
      }
    }
    if (suggestJob) {
      await updateProjectPipelineJob(state.activeProjectId, suggestJob.id, {
        state: "done",
        payload: {
          ...(suggestJob.payload || {}),
          decisionSuggestion: response?.decisionSuggestion || "review",
          warningCount: Array.isArray(warnings) ? warnings.length : 0
        }
      });
    }
    state.papers = await getProjectPapers(state.activeProjectId);
    renderAll();
    setStatus(
      `Suggestion ready: ${response?.decisionSuggestion || "review"} (${Math.round(Number(response?.confidence || 0) * 100)}%).`
    );
  } catch (error) {
    if (suggestJob) {
      await updateProjectPipelineJob(state.activeProjectId, suggestJob.id, {
        state: "failed",
        lastError: truncateText(error?.message || "Unknown error", 220)
      });
    }
    setStatus(`Screening suggestion failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    state.screeningSuggestBusy = false;
    await refreshPipelineDerivedState();
    renderAll();
  }
}

async function addScreenReasonAction() {
  if (!state.activeProjectId) {
    return;
  }
  const code = normalizeText(ui.screenReasonCode?.value || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const label = normalizeText(ui.screenReasonLabel?.value || "");
  const description = normalizeText(ui.screenReasonDescription?.value || "");
  if (!code || !label) {
    setStatus("Reason code and label are required.");
    return;
  }
  const existing = Array.isArray(state.screenReasonLibrary) ? state.screenReasonLibrary : [];
  const deduped = existing.filter((entry) => normalizeText(entry.code) !== code);
  deduped.unshift({ code, label, description, isDefault: false });
  state.screenReasonLibrary = await setProjectScreenReasonLibrary(state.activeProjectId, deduped);
  if (ui.screenReasonCode instanceof HTMLInputElement) {
    ui.screenReasonCode.value = "";
  }
  if (ui.screenReasonLabel instanceof HTMLInputElement) {
    ui.screenReasonLabel.value = "";
  }
  if (ui.screenReasonDescription instanceof HTMLInputElement) {
    ui.screenReasonDescription.value = "";
  }
  renderAll();
  setStatus("Reason added.");
}

function buildContributionMapInput() {
  const matrixColumns = getMatrixColumns().map((column) => ({
    columnId: column.id,
    label: column.label,
    type: column.type,
    clusterEnabled: column.clusterEnabled !== false
  }));
  const candidateColumns = matrixColumns.filter((column) => column.columnId !== "paper_key");
  const prioritizedColumns = candidateColumns.filter((column) => column.clusterEnabled);
  const selectedColumns = (prioritizedColumns.length ? prioritizedColumns : candidateColumns).slice(0, 18);
  const assignments = state.matrix?.clusterState?.assignmentsByRowId || {};
  const matrixRows = getFilteredMatrixRows().slice(0, 180).map((row) => ({
    rowId: row.id,
    paperKey: row.paperKey,
    clusterId: Number.isFinite(Number(assignments[row.id])) ? Number(assignments[row.id]) : null,
    cells: selectedColumns.map((column) => ({
      columnId: column.columnId,
      label: column.label,
      value: String(row.cellsByColumnId?.[column.columnId]?.value || "")
    })).filter((cell) => normalizeText(cell.value))
  }));
  const papers = getSelectedComparePapers().map((paper) => ({
    paperId: paper.id,
    title: paper.title,
    summary: getAnalysisForPaper(paper)?.relevanceSummary || "",
    notes: getAnalysisForPaper(paper)?.methodMatch || "",
    tags: paper.tags || []
  }));
  const comparisonContext = [
    ...(Array.isArray(state.comparison?.result?.crossPaperInsights) ? state.comparison.result.crossPaperInsights.slice(0, 8) : []),
    ...(Array.isArray(state.comparison?.result?.contradictions) ? state.comparison.result.contradictions.slice(0, 6) : []),
    ...(Array.isArray(state.comparison?.result?.evidenceGaps) ? state.comparison.result.evidenceGaps.slice(0, 6) : [])
  ].join(" | ");
  return {
    matrixColumns,
    matrixRows,
    papers,
    contextWindow: truncateText(comparisonContext, 1400)
  };
}

async function runContributionMapAction() {
  if (!state.activeProject || !state.activeProjectId) {
    setStatus("Select a project first.");
    return;
  }
  const input = buildContributionMapInput();
  if (!Array.isArray(input.matrixRows) || input.matrixRows.length < 2) {
    setStatus("Need at least 2 matrix rows to build contribution map.");
    return;
  }
  setStatus("Building contribution map...");
  try {
    const { response } = await generateLLM("project_contribution_map", {
      projectBrief: getProjectBrief(state.activeProject),
      projectKeyTerms: state.activeProject.keyTerms || [],
      projectRubric: state.activeProject.rubric || [],
      matrixColumns: input.matrixColumns,
      matrixRows: input.matrixRows,
      papers: input.papers,
      contextWindow: input.contextWindow
    });
    state.contributionMap = {
      ...response,
      updatedAt: Date.now()
    };
    state.contributionMapDirty = false;
    renderAll();
    setStatus("Contribution map updated.");
  } catch (error) {
    setStatus(`Contribution map failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

function contributionMapToMarkdown() {
  const contribution = state.contributionMap;
  if (!contribution) {
    return "";
  }
  const lines = ["# Contribution Map", ""];
  const pushSection = (title, items) => {
    lines.push(`## ${title}`);
    if (!Array.isArray(items) || items.length === 0) {
      lines.push("- None");
      lines.push("");
      return;
    }
    for (const item of items) {
      const label = normalizeText(item?.label);
      const summary = normalizeText(item?.summary);
      lines.push(`- ${label ? `${label}: ` : ""}${summary || "-"}`);
    }
    lines.push("");
  };
  pushSection("Cluster Summaries", contribution.clustersSummary);
  pushSection("Underexplored Zones", contribution.underexploredZones);
  pushSection("Differentiation Ideas", contribution.differentiationIdeas);
  return lines.join("\n").trim();
}

function contributionMapToCsv() {
  const contribution = state.contributionMap;
  if (!contribution) {
    return "";
  }
  const rows = [];
  const appendRows = (section, items) => {
    for (const item of Array.isArray(items) ? items : []) {
      rows.push({
        section,
        label: normalizeText(item?.label),
        summary: normalizeText(item?.summary),
        confidence: Number.isFinite(Number(item?.confidence)) ? String(item.confidence) : ""
      });
    }
  };
  appendRows("clustersSummary", contribution.clustersSummary);
  appendRows("underexploredZones", contribution.underexploredZones);
  appendRows("differentiationIdeas", contribution.differentiationIdeas);
  return serializeCsv(rows, ["section", "label", "summary", "confidence"]);
}

async function ensureDeepFileIdForPaper(paper) {
  const warnings = [];
  if (!paper) {
    return { fileId: null, warnings: ["Paper is unavailable."] };
  }
  state.settings = await getSettings();
  const blockedReason = normalizeText(state.openaiFileUploadBlockedReason || "");
  if (blockedReason) {
    warnings.push(blockedReason);
    return { fileId: null, warnings };
  }
  if (!state.settings?.openaiApiKey) {
    warnings.push("OpenAI key missing. Deep context unavailable.");
    return { fileId: null, warnings };
  }

  const docId = normalizeText(paper.docId);
  if (docId && state.fileIdByDocId.has(docId)) {
    return { fileId: state.fileIdByDocId.get(docId), warnings };
  }
  if (docId) {
    const remembered = await getOpenAIFileId(docId);
    if (remembered) {
      state.fileIdByDocId.set(docId, remembered);
      return { fileId: remembered, warnings };
    }
  }

  if (paper.sourceType === "local") {
    warnings.push(`${paper.title}: local paper requires re-open in viewer for deep file upload.`);
    return { fileId: null, warnings };
  }

  const url = normalizeText(paper.sourceRef?.url);
  if (!url) {
    warnings.push(`${paper.title}: missing source URL for deep upload.`);
    return { fileId: null, warnings };
  }

  try {
    const bytes = await fetchRemotePdfBytesForUpload(url);
    const { fileId } = await uploadPdfToOpenAI({
      apiKey: state.settings.openaiApiKey,
      filename: paper.title || safeFileNameFromUrl(url),
      bytes
    });
    if (docId && docId !== "unknown") {
      state.fileIdByDocId.set(docId, fileId);
      await setOpenAIFileId(docId, fileId);
    }
    return { fileId, warnings };
  } catch (error) {
    const message = truncateText(error?.message, 140);
    if (isOpenAIAuthFailureMessage(message)) {
      state.openaiFileUploadBlockedReason = message || "OpenAI file upload blocked: API key was rejected.";
    }
    warnings.push(`${paper.title}: deep upload failed (${message}).`);
    return { fileId: null, warnings };
  }
}

async function getPaperSnippet(paper) {
  if (!paper?.docId || paper.docId === "unknown") {
    return "";
  }
  const orientation = await getOrientationCache(paper.docId);
  if (!orientation?.summary) {
    return "";
  }
  const lines = [];
  if (orientation.summary.purpose) {
    lines.push(orientation.summary.purpose);
  }
  if (orientation.summary.contribution) {
    lines.push(orientation.summary.contribution);
  }
  return truncateText(lines.join(" "), 1200);
}

async function refreshPaperAnalysis(paper, { silent = false } = {}) {
  if (!state.activeProject || !paper) {
    return null;
  }
  try {
    const project = state.activeProject;
    const projectBrief = getProjectBrief(project);
    const snippet = await getPaperSnippet(paper);
    const deepResolution = await ensureDeepFileIdForPaper(paper);
    const { response, warnings, providerUsed } = await generateLLM("project_relevance", {
      title: paper.title,
      selectedText: paper.title,
      contextWindow: snippet || paper.title,
      snippet,
      projectBrief,
      projectKeyTerms: project.keyTerms,
      projectRubric: project.rubric,
      openaiFileId: deepResolution.fileId
    });
    const mergedWarnings = [...deepResolution.warnings, ...(Array.isArray(warnings) ? warnings : [])];
    const entry = await setProjectPaperAnalysis(project.id, paper.docId, {
      ...response,
      provider: providerUsed,
      warnings: mergedWarnings,
      degraded: !deepResolution.fileId || mergedWarnings.length > 0,
      deepAttempted: true
    });
    if (entry) {
      state.analysesByDocId[paper.docId] = entry;
    }
    if (!silent) {
      setStatus(`Updated project fit: ${paper.title}`);
    }
    return entry;
  } catch (error) {
    logger.warn("Project relevance refresh failed", {
      paperId: paper?.id || "",
      message: error?.message || "Unknown error"
    });
    if (!silent) {
      setStatus(`Project fit failed: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
    return null;
  }
}

function getSelectedComparePapers() {
  return state.papers
    .filter((paper) => state.compareSelection.has(paper.id))
    .filter((paper) => normalizeScreenState(paper?.screenState) !== "excluded")
    .slice(0, MAX_COMPARE_PAPERS);
}

async function runComparison() {
  if (!state.activeProject) {
    setStatus("Select a project first.");
    return;
  }
  const selectedPapers = getSelectedComparePapers();
  if (selectedPapers.length < 2) {
    setStatus("Select at least 2 papers to compare.");
    return;
  }
  setStatus("Running deep comparison...");
  try {
    const project = state.activeProject;
    const projectBrief = getProjectBrief(project);
    const paperVersions = {};
    for (const paper of selectedPapers) {
      const analysis = getAnalysisForPaper(paper);
      const version = Number(paper.updatedAt || 0) + Number(analysis?.updatedAt || 0);
      paperVersions[paper.id] = version;
    }
    const cacheKey = buildProjectComparisonCacheKey({
      projectId: project.id,
      paperIds: selectedPapers.map((paper) => paper.id),
      rubric: project.rubric,
      paperVersions
    });
    const cached = await getProjectComparison(cacheKey);
    if (cached) {
      state.comparison = cached;
      state.comparisonWarnings = Array.isArray(cached.warnings) ? cached.warnings : [];
      state.contributionMapDirty = true;
      renderAll();
      setStatus("Loaded cached comparison.");
      return;
    }

    const fileResolutions = await Promise.all(selectedPapers.map((paper) => ensureDeepFileIdForPaper(paper)));
    const deepWarnings = fileResolutions.flatMap((resolution) => resolution.warnings || []);
    const openaiFileIds = fileResolutions.map((resolution) => resolution.fileId).filter(Boolean).slice(0, MAX_COMPARE_PAPERS);
    const papersInput = selectedPapers.map((paper) => {
      const analysis = getAnalysisForPaper(paper);
      return {
        paperId: paper.id,
        title: paper.title,
        summary: analysis?.relevanceSummary || "",
        status: paper.status,
        tags: paper.tags,
        notes: analysis?.methodMatch || ""
      };
    });

    const { response, warnings } = await generateLLM("project_compare_table", {
      title: project.name,
      projectBrief,
      projectKeyTerms: project.keyTerms,
      projectRubric: project.rubric,
      papers: papersInput,
      openaiFileIds
    });
    const allWarnings = [...deepWarnings, ...(Array.isArray(warnings) ? warnings : [])];
    const saved = await setProjectComparison({
      key: cacheKey,
      projectId: project.id,
      paperIds: selectedPapers.map((paper) => paper.id),
      rubric: project.rubric,
      paperVersions,
      warnings: allWarnings,
      result: response
    });
    state.comparison = saved;
    state.comparisonWarnings = allWarnings;
    state.contributionMapDirty = true;
    renderAll();
    setStatus("Deep comparison ready.");
  } catch (error) {
    logger.warn("Deep comparison failed", {
      message: error?.message || "Unknown error"
    });
    setStatus(`Deep comparison failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

function comparisonToMarkdown(comparison, selectedPapers) {
  const result = comparison?.result;
  if (!result) {
    return "";
  }
  const papers = Array.isArray(selectedPapers) ? selectedPapers : [];
  const headers = ["Criterion", ...papers.map((paper) => paper.title)];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    const values = [row.criterion || ""];
    for (const paper of papers) {
      const cell = Array.isArray(row.cells) ? row.cells.find((entry) => entry.paperId === paper.id) : null;
      values.push(cell?.value || "-");
    }
    lines.push(`| ${values.map((value) => String(value).replace(/\|/g, "\\|")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function comparisonToCsv(comparison, selectedPapers) {
  const result = comparison?.result;
  if (!result) {
    return "";
  }
  const papers = Array.isArray(selectedPapers) ? selectedPapers : [];
  const headers = ["Criterion", ...papers.map((paper) => paper.title)];
  const encode = (value) => `"${String(value || "").replace(/"/g, '""')}"`;
  const rows = [headers.map(encode).join(",")];
  for (const row of Array.isArray(result.rows) ? result.rows : []) {
    const values = [row.criterion || ""];
    for (const paper of papers) {
      const cell = Array.isArray(row.cells) ? row.cells.find((entry) => entry.paperId === paper.id) : null;
      values.push(cell?.value || "");
    }
    rows.push(values.map(encode).join(","));
  }
  return rows.join("\n");
}

function downloadText(filename, contents, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function openPaperInViewer(paper) {
  if (!state.activeProjectId || !paper) {
    return;
  }
  if (paper.sourceType === "local") {
    await chrome.runtime.sendMessage({ type: "OPEN_VIEWER", projectId: state.activeProjectId });
    setStatus("Viewer opened. Use Open PDF in viewer and choose the same local file.");
    return;
  }
  const sourceUrl = normalizeText(paper.sourceRef?.url);
  if (!sourceUrl) {
    setStatus("Paper source URL is missing.");
    return;
  }
  await chrome.runtime.sendMessage({
    type: "OPEN_VIEWER_WITH_SOURCE",
    src: sourceUrl,
    projectId: state.activeProjectId
  });
}

async function addPaperFromUrl() {
  if (!state.activeProjectId) {
    setStatus("Select a project first.");
    return;
  }
  const normalizedUrl = normalizeSourceUrl(ui.paperUrlInput.value);
  if (!normalizedUrl) {
    setStatus("Enter a valid http(s), file, or blob URL.");
    return;
  }
  const sourceType = sourceTypeFromUrl(normalizedUrl);
  const added = await addProjectPaper(state.activeProjectId, {
    docId: normalizedUrl,
    title: safeFileNameFromUrl(normalizedUrl),
    sourceType,
    sourceRef: { url: normalizedUrl },
    status: "queued",
    priority: 2,
    screenState: "title_abstract_review",
    screenDecision: "pending"
  });
  if (!added) {
    setStatus("Could not add this paper.");
    return;
  }
  ui.paperUrlInput.value = "";
  if (ui.projectPaperUrlInputMirror instanceof HTMLInputElement) {
    ui.projectPaperUrlInputMirror.value = "";
  }
  await loadActiveProjectData();
  state.screenSelectedPaperId = added.id;
  setChecklistForProject(state.activeProjectId, { createdProject: true, addedPaper: true });
  renderAll();
  setStatus("Paper added to screening queue.");
}

async function addPaperFromLocalFile(file) {
  if (!state.activeProjectId) {
    setStatus("Select a project first.");
    return;
  }
  if (!file) {
    return;
  }
  const fingerprint = buildLocalPaperFingerprint(file.name, file.size, file.lastModified);
  const added = await addProjectPaper(state.activeProjectId, {
    docId: fingerprint,
    title: file.name,
    sourceType: "local",
    sourceRef: {
      localFingerprint: fingerprint,
      filename: file.name,
      fileSize: file.size,
      fileLastModified: file.lastModified
    },
    status: "queued",
    priority: 2,
    screenState: "title_abstract_review",
    screenDecision: "pending"
  });
  if (!added) {
    setStatus("Could not add local paper.");
    return;
  }
  await loadActiveProjectData();
  state.screenSelectedPaperId = added.id;
  setChecklistForProject(state.activeProjectId, { createdProject: true, addedPaper: true });
  renderAll();
  setStatus("Local paper added to screening queue.");
}

async function ensureImportTargetProject(importMode, importProjectPayload, documentName) {
  if (importMode === "active_project") {
    if (!state.activeProjectId) {
      return null;
    }
    const existing = await getProjectById(state.activeProjectId);
    return existing || null;
  }

  const payload = buildProjectPayloadFromImport(importProjectPayload, documentName);
  const created = await createProject(payload);
  if (!created) {
    return null;
  }
  await setActiveProjectId(created.id);
  state.activeProjectId = created.id;
  state.activeProject = created;
  return created;
}

async function importLiteratureDocument(file) {
  if (!file || state.importInProgress) {
    return;
  }

  state.importInProgress = true;
  updateImportControlsState();
  setStatus("Preparing literature import...");

  try {
    if (!isSupportedImportFile(file)) {
      setStatus("Unsupported import file type. Use txt, Word docs, spreadsheets, BibTeX, PDF, or similar text-based research formats.");
      return;
    }

    const importMode = normalizeImportTargetMode(ui.importTargetMode?.value);
    if (importMode === "active_project" && !state.activeProjectId) {
      setStatus("Select an active project first, or switch import mode to create a new project.");
      return;
    }

    state.settings = await getSettings();
    if (!state.settings?.openaiApiKey) {
      setStatus("OpenAI API key is required for literature import parsing.");
      return;
    }

    const mimeType = guessImportMimeType(file);
    const textSnippet = await readImportTextSnippet(file, MAX_IMPORT_TEXT_CHARS);
    const snippet = truncateText(textSnippet, 1400);
    const bytes = new Uint8Array(await file.arrayBuffer());

    setStatus("Uploading document to OpenAI...");
    const { fileId } = await uploadFileToOpenAI({
      apiKey: state.settings.openaiApiKey,
      filename: file.name || "literature-import",
      bytes,
      mimeType
    });

    const activeProject = importMode === "active_project" ? state.activeProject : null;
    const activeProjectBrief = activeProject ? getProjectBrief(activeProject) : "";

    setStatus("Extracting project and papers from document...");
    const { response, warnings: llmWarnings, providerUsed } = await generateLLM("literature_import", {
      title: file.name || "Literature review document",
      contextWindow: textSnippet || truncateText(file.name || "Imported document", 280),
      snippet,
      openaiFileId: fileId,
      importMode,
      importDocumentName: file.name || "",
      importDocumentType: mimeType,
      existingProjectName: activeProject?.name || "",
      maxImportedPapers: MAX_IMPORT_PAPERS,
      projectBrief: activeProjectBrief,
      projectKeyTerms: Array.isArray(activeProject?.keyTerms) ? activeProject.keyTerms : [],
      projectRubric: Array.isArray(activeProject?.rubric) ? activeProject.rubric : []
    });

    const parsedPapers = Array.isArray(response?.papers) ? response.papers.slice(0, MAX_IMPORT_PAPERS) : [];
    if (parsedPapers.length === 0) {
      setStatus("No papers were extracted from this document.");
      return;
    }

    const importWarnings = [];
    if (Array.isArray(response?.warnings)) {
      importWarnings.push(...response.warnings);
    }
    if (Array.isArray(llmWarnings)) {
      importWarnings.push(...llmWarnings);
    }

    setStatus("Resolving missing paper links...");
    const { resolvedPapers, warnings: lookupWarnings } = await resolveImportedPaperLinks(parsedPapers, {
      maxLookups: MAX_IMPORT_PAPERS,
      concurrency: 4
    });
    if (Array.isArray(lookupWarnings)) {
      importWarnings.push(...lookupWarnings);
    }

    const targetProject = await ensureImportTargetProject(importMode, response?.project, file.name || "");
    if (!targetProject?.id) {
      setStatus("Could not resolve target project for import.");
      return;
    }

    let importedCount = 0;
    let skippedCount = 0;
    let lookupPendingCount = 0;
    for (const paper of resolvedPapers) {
      const finalUrl = resolveImportedPaperUrl(paper);
      if (!finalUrl) {
        skippedCount += 1;
        importWarnings.push(`${paper?.title || "Untitled paper"}: missing URL after lookup.`);
        continue;
      }

      const sourceType = sourceTypeFromUrl(finalUrl);
      const sourceRef = { url: finalUrl };
      const title = truncateText(
        normalizeText(paper?.title) || safeFileNameFromUrl(finalUrl) || "Imported paper",
        260
      );
      const tags = buildImportedPaperTags(paper);
      if (paper?.resolutionSource === "none" || paper?.resolutionSource === "error") {
        tags.push("lookup-pending");
        lookupPendingCount += 1;
      }
      const importedStatus = normalizeImportedPaperStatus(paper?.status);
      const importedScreenState =
        importedStatus === "included"
          ? "included"
          : importedStatus === "excluded"
            ? "excluded"
            : importedStatus === "reading"
              ? "full_text_review"
              : "title_abstract_review";
      const importedScreenDecision =
        importedStatus === "included" ? "include" : importedStatus === "excluded" ? "exclude" : "pending";
      const added = await addProjectPaper(targetProject.id, {
        docId: finalUrl,
        title,
        sourceType,
        sourceRef,
        doi: normalizeText(paper?.doi || ""),
        arxivId: normalizeText(paper?.arxivId || ""),
        canonicalKey: deriveCanonicalPaperFields({
          title,
          doi: paper?.doi,
          arxivId: paper?.arxivId,
          url: finalUrl
        }).paperKey,
        status: importedStatus,
        priority: normalizeImportedPaperPriority(paper?.priority),
        tags: tags.slice(0, 20),
        screenState: importedScreenState,
        screenDecision: importedScreenDecision
      });

      if (added) {
        importedCount += 1;
      } else {
        skippedCount += 1;
      }
    }

    await refreshProjects();
    state.activeProjectId = targetProject.id;
    await loadActiveProjectData();
    setChecklistForProject(targetProject.id, {
      createdProject: true,
      addedPaper: importedCount > 0
    });

    if (importWarnings.length > 0) {
      logger.warn("Literature import warnings", {
        providerUsed,
        projectId: targetProject.id,
        warningCount: importWarnings.length,
        warnings: importWarnings.slice(0, 60)
      });
    }

    const warningSummary =
      importWarnings.length > 0
        ? ` ${importWarnings.length} warning${importWarnings.length === 1 ? "" : "s"} logged.`
        : "";
    if (lookupPendingCount > 0) {
      setStatus(
        `Imported ${importedCount} paper${importedCount === 1 ? "" : "s"} into "${targetProject.name}". ${lookupPendingCount} pending lookup.${warningSummary}`
      );
      return;
    }
    setStatus(
      `Imported ${importedCount} paper${importedCount === 1 ? "" : "s"} into "${targetProject.name}".${skippedCount > 0 ? ` ${skippedCount} skipped.` : ""}${warningSummary}`
    );
  } catch (error) {
    logger.error("Literature import failed", {
      message: error?.message || "Unknown error"
    });
    setStatus(`Literature import failed: ${truncateText(error?.message || "Unknown error", 120)}`);
  } finally {
    state.importInProgress = false;
    updateImportControlsState();
    if (ui.importDocumentInput instanceof HTMLInputElement) {
      ui.importDocumentInput.value = "";
    }
  }
}

async function refreshAllProjectAnalyses() {
  if (!state.activeProject || state.papers.length === 0) {
    setStatus("No papers to analyze.");
    return;
  }
  setStatus("Refreshing project analyses...");
  for (const paper of state.papers) {
    try {
      await refreshPaperAnalysis(paper, { silent: true });
    } catch (error) {
      logger.warn("Paper analysis refresh failed", {
        paperId: paper.id,
        message: error?.message || "Unknown error"
      });
    }
  }
  renderAll();
  setStatus("Project analyses refreshed.");
}

function getPaperById(paperId) {
  const normalizedId = normalizeText(paperId);
  return state.papers.find((paper) => paper.id === normalizedId) || null;
}

async function handleDiscoverTableClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-action], tr[data-candidate-id]") : null;
  if (!target) {
    return;
  }
  if (target instanceof HTMLTableRowElement && target.dataset.candidateId) {
    state.discoverSelectedCandidateId = target.dataset.candidateId;
    renderAll();
    return;
  }
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const action = normalizeText(target.dataset.action);
  const candidateId = normalizeText(target.dataset.id);
  if (!candidateId) {
    return;
  }
  state.discoverSelectedCandidateId = candidateId;
  if (action === "discover-candidate-open") {
    const candidate = (state.discoveryCandidates || []).find((entry) => entry.id === candidateId);
    if (candidate?.url) {
      await chrome.runtime.sendMessage({
        type: "OPEN_VIEWER_WITH_SOURCE",
        src: candidate.url,
        projectId: state.activeProjectId || ""
      });
    }
    return;
  }
  if (action === "discover-candidate-queue") {
    await queueCandidateToScreening(candidateId);
  }
}

async function handleScreenQueueClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-action], tr[data-paper-id]") : null;
  if (!target) {
    return;
  }
  if (target instanceof HTMLTableRowElement && target.dataset.paperId) {
    state.screenSelectedPaperId = target.dataset.paperId;
    renderAll();
    return;
  }
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const action = normalizeText(target.dataset.action);
  const paperId = normalizeText(target.dataset.id || state.screenSelectedPaperId);
  if (!paperId) {
    return;
  }
  if (action === "screen-select-paper") {
    state.screenSelectedPaperId = paperId;
    renderAll();
    return;
  }
  if (action === "screen-mark-fulltext") {
    const fulltextJob = await enqueueProjectPipelineJob(state.activeProjectId, "fulltext_fetch", {
      paperId,
      source: "screen_queue"
    });
    await updateProjectPaper(state.activeProjectId, paperId, {
      screenState: "full_text_review",
      screenDecision: "pending",
      status: "reading",
      decisionAt: Date.now()
    });
    if (fulltextJob) {
      await updateProjectPipelineJob(state.activeProjectId, fulltextJob.id, {
        state: "done",
        payload: { ...(fulltextJob.payload || {}), transitioned: true }
      });
    }
    state.papers = await getProjectPapers(state.activeProjectId);
    await refreshPipelineDerivedState();
    renderAll();
    setStatus("Paper moved to full-text review.");
    return;
  }
  if (action === "screen-decide-include") {
    await applyScreenDecisionAction("include", paperId);
    return;
  }
  if (action === "screen-decide-exclude") {
    await applyScreenDecisionAction("exclude", paperId);
    return;
  }
  if (action === "screen-decide-needs-info") {
    await applyScreenDecisionAction("needs_info", paperId);
  }
}

async function handleProjectListClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const action = target.dataset.action;
  const projectId = target.dataset.id;
  if (!projectId) {
    return;
  }
  if (action === "project-open") {
    await selectProject(projectId);
    return;
  }
  if (action === "project-edit") {
    const project = await getProjectById(projectId);
    openProjectModal(project);
    return;
  }
  if (action === "project-archive") {
    const project = await getProjectById(projectId);
    if (!project) {
      return;
    }
    await archiveProject(project.id, !project.archived);
    await refreshProjects();
    await loadActiveProjectData();
    setStatus(project.archived ? "Project unarchived." : "Project archived.");
    return;
  }
  if (action === "project-delete") {
    const project = await getProjectById(projectId);
    if (!project) {
      return;
    }
    const confirmed = window.confirm(`Delete project "${project.name}"?`);
    if (!confirmed) {
      return;
    }
    await deleteProject(project.id);
    const activeProjectId = await getActiveProjectId();
    state.activeProjectId = activeProjectId || "";
    await refreshProjects();
    await loadActiveProjectData();
    closeProjectModal({ reset: true });
    setStatus("Project deleted.");
  }
}

async function handlePaperListClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!target) {
    return;
  }
  const action = target.getAttribute("data-action");
  const paperId = target.getAttribute("data-id");

  if (action === "paper-toggle-compare" && target instanceof HTMLInputElement) {
    if (target.checked) {
      if (state.compareSelection.size >= MAX_COMPARE_PAPERS) {
        target.checked = false;
        setStatus(`Select up to ${MAX_COMPARE_PAPERS} papers.`);
        return;
      }
      state.compareSelection.add(paperId);
    } else {
      state.compareSelection.delete(paperId);
    }
    renderCompareOutput();
    return;
  }

  if (!paperId) {
    return;
  }
  const paper = getPaperById(paperId);
  if (!paper) {
    return;
  }

  if (action === "paper-open") {
    await openPaperInViewer(paper);
    return;
  }
  if (action === "paper-refresh-analysis") {
    setStatus("Refreshing project fit...");
    await refreshPaperAnalysis(paper);
    renderAll();
    return;
  }
  if (action === "paper-remove") {
    const confirmed = window.confirm(`Remove "${paper.title}" from this project?`);
    if (!confirmed) {
      return;
    }
    await removeMatrixRowsForPaper(paper);
    await removeProjectPaper(state.activeProjectId, paper.id);
    delete state.analysesByDocId[paper.docId];
    state.compareSelection.delete(paper.id);
    await loadActiveProjectData();
    setStatus("Paper removed.");
  }
}

async function handlePaperListChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.dataset.action;
  const paperId = target.dataset.id;
  if (!action || !paperId) {
    return;
  }
  const paper = getPaperById(paperId);
  if (!paper) {
    return;
  }
  if (action === "paper-status" && target instanceof HTMLSelectElement) {
    await updateProjectPaper(state.activeProjectId, paper.id, { status: target.value });
    await loadActiveProjectData();
    return;
  }
  if (action === "paper-priority" && target instanceof HTMLSelectElement) {
    await updateProjectPaper(state.activeProjectId, paper.id, { priority: Number(target.value) });
    await loadActiveProjectData();
    return;
  }
  if (action === "paper-tags" && target instanceof HTMLInputElement) {
    await updateProjectPaper(state.activeProjectId, paper.id, { tags: parseCommaList(target.value) });
    await loadActiveProjectData();
  }
}

async function handleProjectFormSubmit(event) {
  event.preventDefault();
  const payload = {
    name: ui.projectName.value,
    researchQuestion: ui.projectQuestion.value,
    objective: ui.projectObjective.value,
    scopeNotes: ui.projectScope.value,
    keyTerms: parseCommaList(ui.projectKeyTerms.value),
    rubric: parseLineList(ui.projectRubric.value)
  };

  if (state.editingProjectId) {
    const updated = await updateProject(state.editingProjectId, payload);
    if (!updated) {
      setStatus("Failed to update project.");
      return;
    }
    setStatus("Project updated.");
    closeProjectModal({ reset: true });
    await refreshProjects();
    await selectProject(updated.id, { persist: true });
    return;
  }

  const created = await createProject(payload);
  if (!created) {
    setStatus("Failed to create project.");
    return;
  }
  await setActiveProjectId(created.id);
  state.activeProjectId = created.id;
  await refreshProjects();
  await loadActiveProjectData();
  setChecklistForProject(created.id, { createdProject: true });
  closeProjectModal({ reset: true });
  setStatus("Project created.");
}

async function handleMatrixSchemaInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !state.matrix) {
    return;
  }
  const action = target.dataset.action;
  const columnId = target.dataset.id;
  if (!action || !columnId) {
    return;
  }
  const columns = getMatrixColumns().map((column) => ({ ...column }));
  const index = columns.findIndex((column) => column.id === columnId);
  if (index < 0) {
    return;
  }
  const nextColumn = { ...columns[index] };
  let changed = false;
  let suggestAutofill = false;
  if (action === "matrix-column-label" && target instanceof HTMLInputElement) {
    const nextLabel = truncateText(target.value, 120) || nextColumn.label;
    changed = nextLabel !== nextColumn.label;
    nextColumn.label = nextLabel;
    suggestAutofill = changed;
  } else if (action === "matrix-column-type" && target instanceof HTMLSelectElement) {
    const nextType = target.value;
    changed = nextType !== nextColumn.type;
    nextColumn.type = nextType;
    suggestAutofill = changed;
  } else if (action === "matrix-column-options" && target instanceof HTMLInputElement) {
    const nextOptions = parseOptionList(target.value);
    const previousOptions = Array.isArray(nextColumn.suggestedOptions) ? nextColumn.suggestedOptions : [];
    changed = JSON.stringify(previousOptions) !== JSON.stringify(nextOptions);
    nextColumn.suggestedOptions = nextOptions;
    suggestAutofill = changed;
  } else if (action === "matrix-column-description" && target instanceof HTMLInputElement) {
    const nextDescription = truncateText(target.value, 220);
    changed = nextDescription !== nextColumn.description;
    nextColumn.description = nextDescription;
    suggestAutofill = changed;
  } else if (action === "matrix-column-cluster" && target instanceof HTMLInputElement) {
    changed = nextColumn.clusterEnabled !== target.checked;
    nextColumn.clusterEnabled = target.checked;
  } else {
    return;
  }
  if (!changed) {
    return;
  }
  columns[index] = nextColumn;
  try {
    const updated = await setProjectMatrixColumns(state.activeProjectId, columns, {
      templateId: state.matrix.templateId
    });
    if (updated) {
      state.matrix = updated;
      state.matrixFeatureDirty = true;
      state.contributionMapDirty = true;
      if (suggestAutofill) {
        state.matrixSuggestedAutofillColumnId = columnId;
      }
      renderAll();
    }
  } catch (error) {
    setStatus(`Matrix schema update failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

async function handleMatrixSchemaClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!(target instanceof HTMLButtonElement) || !state.matrix) {
    return;
  }
  const action = target.dataset.action;
  const columnId = target.dataset.id;
  if (!columnId) {
    return;
  }
  const columns = getMatrixColumns().map((column) => ({ ...column }));
  const index = columns.findIndex((column) => column.id === columnId);
  if (index < 0 || columns[index].id === "paper_key") {
    return;
  }
  const current = columns[index];
  if (action === "matrix-column-autofill") {
    await runMatrixColumnAutofill(columnId);
    return;
  }
  if (action === "matrix-column-move-left" || action === "matrix-column-move-right") {
    const direction = action === "matrix-column-move-left" ? -1 : 1;
    const targetIndex = index + direction;
    if (targetIndex <= 0 || targetIndex >= columns.length) {
      return;
    }
    const nextColumns = [...columns];
    const [moved] = nextColumns.splice(index, 1);
    nextColumns.splice(targetIndex, 0, moved);
    try {
      const updated = await setProjectMatrixColumns(state.activeProjectId, nextColumns, {
        templateId: state.matrix.templateId
      });
      if (updated) {
        state.matrix = updated;
        state.matrixFeatureDirty = true;
        renderAll();
      }
    } catch (error) {
      setStatus(`Matrix column reorder failed: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
    return;
  }
  if (action === "matrix-column-hide" || action === "matrix-column-show" || action === "matrix-column-remove" || action === "matrix-column-restore") {
    const now = Date.now();
    const nextColumns = columns.map((column) => {
      if (column.id !== columnId) {
        return column;
      }
      if (action === "matrix-column-hide") {
        return { ...column, hidden: true };
      }
      if (action === "matrix-column-show") {
        return { ...column, hidden: false };
      }
      if (action === "matrix-column-restore") {
        return { ...column, hidden: false, deletedAt: null, deletedBy: "" };
      }
      return { ...column, hidden: false, deletedAt: now, deletedBy: "user" };
    });
    try {
      const updated = await setProjectMatrixColumns(state.activeProjectId, nextColumns, {
        templateId: state.matrix.templateId
      });
      if (updated) {
        state.matrix = updated;
        state.matrixFeatureDirty = true;
        state.contributionMapDirty = true;
        if (action === "matrix-column-remove" && state.matrixSuggestedAutofillColumnId === columnId) {
          state.matrixSuggestedAutofillColumnId = "";
        }
        if (action === "matrix-column-remove") {
          state.matrixLastRemoved = { type: "column", id: columnId, label: current.label };
        } else if (state.matrixLastRemoved?.type === "column" && state.matrixLastRemoved.id === columnId) {
          state.matrixLastRemoved = null;
        }
        renderAll();
        setStatus(
          action === "matrix-column-remove"
            ? "Criterion moved to trash."
            : action === "matrix-column-restore"
              ? "Criterion restored."
              : action === "matrix-column-hide"
                ? "Criterion hidden."
                : "Criterion shown."
        );
      }
    } catch (error) {
      setStatus(`Matrix column update failed: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
    return;
  }
  if (action === "matrix-column-hard-delete") {
    if (!window.confirm("Permanently delete this criterion and its cell values? This cannot be undone.")) {
      return;
    }
    const nextColumns = columns.filter((column) => column.id !== columnId);
    const nextRows = getMatrixRows().map((row) => {
      const nextCells = { ...(row.cellsByColumnId || {}) };
      delete nextCells[columnId];
      const nextHidden = { ...(row.hiddenFeaturesByColumnId || {}) };
      delete nextHidden[columnId];
      return {
        ...row,
        cellsByColumnId: nextCells,
        hiddenFeaturesByColumnId: nextHidden,
        updatedAt: Date.now()
      };
    });
    try {
      const updated = await persistMatrix({
        ...state.matrix,
        columns: nextColumns,
        rows: nextRows
      });
      if (updated) {
        if (state.matrixLastRemoved?.type === "column" && state.matrixLastRemoved.id === columnId) {
          state.matrixLastRemoved = null;
        }
        if (state.matrixSuggestedAutofillColumnId === columnId) {
          state.matrixSuggestedAutofillColumnId = "";
        }
        renderAll();
        setStatus("Criterion permanently deleted.");
      }
    } catch (error) {
      setStatus(`Permanent delete failed: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
  }
}

async function handleMatrixTableInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.dataset.action !== "matrix-cell-edit") {
    return;
  }
  const rowId = target.dataset.rowId;
  const columnId = target.dataset.columnId;
  if (!rowId || !columnId || !state.matrix) {
    return;
  }
  const row = getMatrixRowById(rowId);
  const column = getMatrixColumnById(columnId);
  if (!row || !column) {
    return;
  }
  const value = normalizeMatrixInputValueByType(target.value, column.type);
  const nextCells = { ...(row.cellsByColumnId || {}) };
  nextCells[columnId] = {
    value,
    source: "manual",
    locked: true,
    confidence: 1,
    evidenceSnippet: "",
    evidencePage: null,
    insufficientReason: "",
    updatedAt: Date.now(),
    stale: false
  };
  await saveMatrixRow({
    ...row,
    cellsByColumnId: nextCells,
    verificationState: row.verificationState === "fresh" ? "fresh" : "stale",
    updatedAt: Date.now()
  });
  renderAll();
}

async function handleMatrixTableClick(event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!(target instanceof HTMLButtonElement)) {
    const rowTrigger = event.target instanceof Element ? event.target.closest("tr[data-row-id]") : null;
    if (rowTrigger instanceof HTMLTableRowElement) {
      const selectionBlocked = event.target instanceof Element
        ? Boolean(event.target.closest("input,button,select,textarea,a,label"))
        : false;
      if (!selectionBlocked) {
        openMatrixDrawer("row", rowTrigger.dataset.rowId || "");
      }
    }
    return;
  }
  const action = target.dataset.action;
  if (action === "matrix-clear-filters") {
    clearMatrixFilters();
    rememberMatrixFiltersForActiveProject();
    renderAll();
    return;
  }
  if (action === "matrix-column-filter-clear") {
    const columnId = normalizeText(target.dataset.id || "");
    if (!columnId) {
      return;
    }
    const nextFilters = { ...(state.matrixColumnFilters || {}) };
    delete nextFilters[columnId];
    state.matrixColumnFilters = nextFilters;
    rememberMatrixFiltersForActiveProject();
    renderAll();
    return;
  }
  if (action === "matrix-sort") {
    const sortBy = normalizeText(target.dataset.id || "paper");
    if (!sortBy) {
      return;
    }
    if (state.matrixSortBy === sortBy) {
      state.matrixSortDir = state.matrixSortDir === "asc" ? "desc" : "asc";
    } else {
      state.matrixSortBy = sortBy;
      state.matrixSortDir = "asc";
    }
    rememberMatrixFiltersForActiveProject();
    renderAll();
    return;
  }

  const rowId = normalizeText(target.dataset.id || "");
  if (!rowId) {
    return;
  }
  const row = getMatrixRowById(rowId);
  if (!row) {
    return;
  }
  const busySafeActions = new Set(["matrix-row-open", "matrix-row-open-source", "matrix-row-link-source"]);
  if (state.matrixRowBusyById?.[row.id] && !busySafeActions.has(action)) {
    setStatus("Row update already running.");
    return;
  }
  if (action === "matrix-row-open") {
    openMatrixDrawer("row", row.id);
    return;
  }
  if (action === "matrix-row-open-source") {
    openMatrixRowSource(row);
    return;
  }
  if (action === "matrix-row-link-source") {
    await linkMatrixRowSource(row);
    return;
  }
  if (action === "matrix-row-duplicate") {
    await duplicateMatrixRow(row);
    return;
  }
  if (action === "matrix-row-remove") {
    await softRemoveMatrixRow(row);
    return;
  }
  if (action === "matrix-row-restore") {
    await restoreMatrixRow(row.id);
    return;
  }
  if (action === "matrix-row-hard-delete") {
    await hardDeleteMatrixRow(row.id);
    return;
  }
  if (action === "matrix-row-autofill-columns") {
    await runMatrixRowAutofill(row);
    renderAll();
    return;
  }
  if (action === "matrix-row-reverify") {
    await refreshMatrixRowAutofill(row, { isReverify: true });
    renderAll();
    return;
  }
  if (action === "matrix-row-regenerate-tags") {
    await refreshMatrixRowAutofill(row, { isReverify: true, regenerateTagsOnly: true });
    renderAll();
  }
}

async function applySelectedMatrixTemplate() {
  const templateId = normalizeText(ui.matrixTemplateSelect?.value || "");
  if (!state.activeProjectId || !templateId) {
    setStatus("Select a template first.");
    return;
  }
  if (isMatrixOpRunning("applyTemplate")) {
    return;
  }
  const template = state.matrixTemplates.find((entry) => entry.id === templateId);
  if (!template) {
    setStatus("Template not found.");
    return;
  }
  setMatrixOpRunning("applyTemplate", true);
  renderAll();
  try {
    const updated = await persistMatrix({
      ...state.matrix,
      templateId: template.id,
      columns: template.columns
    });
    if (updated) {
      state.matrix = updated;
      renderAll();
      setStatus("Template applied.");
    }
  } catch (error) {
    setStatus(`Failed to apply template: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("applyTemplate", false);
    renderAll();
  }
}

async function saveCurrentMatrixAsTemplate() {
  if (!state.activeProjectId || !state.matrix) {
    setStatus("Select a project first.");
    return;
  }
  if (isMatrixOpRunning("saveTemplate")) {
    return;
  }
  const suggestedName = `${state.activeProject?.name || "Project"} Matrix`;
  const name = window.prompt("Template name", suggestedName);
  if (!name) {
    return;
  }
  setMatrixOpRunning("saveTemplate", true);
  renderAll();
  try {
    const saved = await saveMatrixTemplate({
      name,
      columns: getMatrixColumns()
    });
    if (!saved) {
      setStatus("Failed to save template.");
      return;
    }
    state.matrixTemplates = await listMatrixTemplates();
    state.matrix = await persistMatrix({
      ...state.matrix,
      templateId: saved.id
    });
    renderAll();
    setStatus("Template saved.");
  } catch (error) {
    setStatus(`Failed to save template: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("saveTemplate", false);
    renderAll();
  }
}

async function importMatrixCsvFile(file) {
  if (!file || !state.activeProjectId || !state.matrix) {
    return;
  }
  try {
    const text = await file.text();
    const parsed = parseCsvRows(text);
    if (!Array.isArray(parsed) || parsed.length < 2) {
      setStatus("CSV import failed: file is empty.");
      return;
    }
    const headers = (parsed[0] || []).map((cell, index) => normalizeText(cell) || `Column ${index + 1}`);
    const rows = parsed.slice(1).filter((row) => Array.isArray(row) && row.some((cell) => normalizeText(cell)));
    if (!rows.length) {
      setStatus("CSV import failed: no data rows found.");
      return;
    }
    const roles = headers.map((header) => detectCsvMatrixColumnRole(header));
    state.matrixCsvImport = {
      fileName: truncateText(file.name || "import.csv", 120),
      headers,
      rows,
      roles
    };
    renderAll();
  } catch (error) {
    setStatus(`CSV import failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
}

function closeMatrixCsvImport() {
  state.matrixCsvImport = null;
  renderAll();
}

async function confirmMatrixCsvImport() {
  if (!state.activeProjectId || !state.matrix || !state.matrixCsvImport) {
    return;
  }
  if (isMatrixOpRunning("importCsv")) {
    return;
  }
  const importState = state.matrixCsvImport;
  setMatrixOpRunning("importCsv", true);
  renderAll();
  try {
    const existingColumns = getMatrixColumns().map((column) => ({ ...column }));
    const criteriaHeaderIndexes = importState.headers
      .map((header, index) => ({ header, index, role: importState.roles[index] }))
      .filter((entry) => entry.role === "criterion");
    const nextColumns = [...existingColumns];
    const criterionColumnIdByIndex = new Map();
    for (const entry of criteriaHeaderIndexes) {
      const existing = nextColumns.find(
        (column) => column.id !== "paper_key" && normalizeText(column.label).toLowerCase() === normalizeText(entry.header).toLowerCase()
      );
      if (existing) {
        existing.deletedAt = null;
        existing.deletedBy = "";
        const sampleValues = importState.rows.map((row) => normalizeText(row[entry.index] || "")).filter(Boolean);
        existing.type = existing.type || inferMatrixColumnTypeFromValues(sampleValues);
        criterionColumnIdByIndex.set(entry.index, existing.id);
        continue;
      }
      const values = importState.rows.map((row) => normalizeText(row[entry.index] || "")).filter(Boolean);
      const inferredType = inferMatrixColumnTypeFromValues(values);
      const options =
        inferredType === "categorical" || inferredType === "boolean"
          ? [...new Set(values.map((value) => value.toLowerCase()))]
              .map((value) => {
                const matched = values.find((entryValue) => entryValue.toLowerCase() === value);
                return matched || value;
              })
              .slice(0, 30)
          : [];
      const id = makeMatrixColumnId(entry.header, entry.index);
      nextColumns.push({
        id,
        label: truncateText(entry.header, 120) || `Criterion ${entry.index + 1}`,
        type: inferredType,
        description: "",
        suggestedOptions: options,
        clusterEnabled: inferredType !== "text",
        hidden: false,
        deletedAt: null,
        deletedBy: ""
      });
      criterionColumnIdByIndex.set(entry.index, id);
    }

    const savedColumns = await setProjectMatrixColumns(state.activeProjectId, nextColumns, {
      templateId: state.matrix.templateId
    });
    if (!savedColumns) {
      setStatus("CSV import failed: unable to update criteria columns.");
      return;
    }
    state.matrix = savedColumns;

    const metadataIndex = {};
    importState.roles.forEach((role, index) => {
      if (!metadataIndex[role]) {
        metadataIndex[role] = index;
      }
    });

    let importedCount = 0;
    let linkedCount = 0;
    let pendingSourceCount = 0;
    for (const [rowIndex, rowCells] of importState.rows.entries()) {
      const getRoleValue = (role) => {
        const index = metadataIndex[role];
        if (!Number.isFinite(index)) {
          return "";
        }
        return normalizeText(rowCells[index] || "");
      };
      const fallbackTitle = `Imported paper ${rowIndex + 1}`;
      const title = truncateText(
        getRoleValue("paper_title") || getRoleValue("doi") || getRoleValue("arxiv_id") || getRoleValue("paper_url") || fallbackTitle,
        260
      );
      const sourceRaw = getRoleValue("paper_url") || getRoleValue("doi") || getRoleValue("arxiv_id");
      const sourceIdentity = parseMatrixSourceInput(sourceRaw);
      const canonical = deriveCanonicalPaperFields({
        title,
        url: sourceIdentity.url,
        doi: sourceIdentity.doi || getRoleValue("doi"),
        arxivId: sourceIdentity.arxivId || getRoleValue("arxiv_id"),
        docId: sourceIdentity.url || sourceIdentity.doi || sourceIdentity.arxivId || title
      });
      const authors = getRoleValue("authors");
      const yearValue = getRoleValue("year");
      const venue = getRoleValue("venue");

      const cellsByColumnId = {};
      for (const [indexRaw, columnId] of criterionColumnIdByIndex.entries()) {
        const value = normalizeText(rowCells[indexRaw] || "");
        if (!value) {
          continue;
        }
        cellsByColumnId[columnId] = {
          value,
          source: "manual",
          locked: true,
          confidence: 1,
          evidenceSnippet: "",
          evidencePage: null,
          insufficientReason: "",
          updatedAt: Date.now(),
          stale: false
        };
      }

      let linkedPaper = null;
      if (canonical.paperDoi || canonical.paperArxivId || canonical.paperUrl || canonical.paperTitleFingerprint) {
        linkedPaper = await addProjectPaper(state.activeProjectId, {
          docId: canonical.paperUrl || canonical.paperDoi || canonical.paperArxivId || canonical.paperKey || title,
          title,
          sourceType: "remote",
          sourceRef: canonical.paperUrl ? { url: canonical.paperUrl } : {},
          status: "included",
          screenState: "included",
          screenDecision: "include",
          decisionBy: "matrix_import",
          decisionAt: Date.now(),
          priority: 2,
          doi: canonical.paperDoi,
          arxivId: canonical.paperArxivId,
          canonicalKey: canonical.paperKey,
          tags: ["matrix-import", authors ? `authors:${authors.slice(0, 40)}` : ""].filter(Boolean)
        });
      }

      await upsertProjectMatrixRow(state.activeProjectId, {
        projectId: state.activeProjectId,
        paperId: linkedPaper?.id || "",
        paperTitle: linkedPaper?.title || title,
        paperKey: linkedPaper?.canonicalKey || canonical.paperKey,
        paperDoi: linkedPaper?.doi || canonical.paperDoi,
        paperArxivId: linkedPaper?.arxivId || canonical.paperArxivId,
        paperUrl: linkedPaper?.sourceRef?.url || canonical.paperUrl,
        autoFillState: canonical.paperUrl || canonical.paperDoi || canonical.paperArxivId ? "queued" : "pending_source",
        verificationState: "stale",
        cellsByColumnId,
        hiddenFeaturesByColumnId: {},
        deletedAt: null,
        deletedBy: "",
        hidden: false,
        updatedAt: Date.now(),
        importMeta: {
          authors,
          year: yearValue,
          venue
        }
      });
      importedCount += 1;
      if (linkedPaper) {
        linkedCount += 1;
      }
      if (!canonical.paperUrl && !canonical.paperDoi && !canonical.paperArxivId) {
        pendingSourceCount += 1;
      }
    }
    state.papers = await getProjectPapers(state.activeProjectId);
    state.matrix = await getProjectMatrix(state.activeProjectId);
    state.matrixCsvImport = null;
    renderAll();
    setStatus(
      `CSV import complete: ${importedCount} rows, ${linkedCount} linked papers${pendingSourceCount ? `, ${pendingSourceCount} need source links` : ""}.`
    );
  } catch (error) {
    setStatus(`CSV import failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("importCsv", false);
    renderAll();
  }
}

function updateMatrixCsvRole(index, role) {
  if (!state.matrixCsvImport) {
    return;
  }
  const normalizedIndex = Number(index);
  if (!Number.isFinite(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= state.matrixCsvImport.roles.length) {
    return;
  }
  const nextRole = getCsvRoleOptions().includes(role) ? role : "criterion";
  state.matrixCsvImport = {
    ...state.matrixCsvImport,
    roles: state.matrixCsvImport.roles.map((entry, entryIndex) => (entryIndex === normalizedIndex ? nextRole : entry))
  };
  renderMatrixCsvImportModal();
}

async function addMatrixColumn() {
  if (!state.matrix) {
    return;
  }
  if (isMatrixOpRunning("addColumn")) {
    return;
  }
  const name = window.prompt("Column name", "New Criterion");
  if (!name) {
    return;
  }
  setMatrixOpRunning("addColumn", true);
  renderAll();
  try {
    const id = `col_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999).toString(36)}`;
    const columns = [
      ...getMatrixColumns(),
      {
        id,
        label: truncateText(name, 120),
        type: "categorical",
        description: "",
        suggestedOptions: [],
        clusterEnabled: true
      }
    ];
    const updated = await setProjectMatrixColumns(state.activeProjectId, columns, {
      templateId: state.matrix.templateId
    });
    if (updated) {
      state.matrix = updated;
      state.matrixFeatureDirty = true;
      state.contributionMapDirty = true;
      state.matrixSuggestedAutofillColumnId = id;
      renderAll();
      setStatus("Matrix column added. Use Auto-fill Column to populate existing rows.");
      const shouldRunNow = window.confirm(
        `Auto-fill "${truncateText(name, 120)}" for existing eligible rows now?`
      );
      if (shouldRunNow) {
        await runMatrixColumnAutofill(id);
      }
    }
  } catch (error) {
    setStatus(`Failed to add matrix column: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("addColumn", false);
    renderAll();
  }
}

async function initialize() {
  const searchParams = new URLSearchParams(location.search);
  const requestedProjectId = normalizeText(searchParams.get("project"));

  state.settings = await getSettings();
  state.checklistByProjectId = getPersistedChecklistByProject();
  applyHomeSettingsToDocument();
  syncHomeSettingsControls();
  renderLlmRuntimeFlag();
  applyAdvancedDisclosureDefaults({ force: true });
  state.matrixFiltersByProjectId = getPersistedMatrixViewStateByProject();
  state.discoverGroupFilter = normalizeText(ui.discoverGroupFilter?.value || "all");
  if (ui.matrixGoogleClientId instanceof HTMLInputElement) {
    ui.matrixGoogleClientId.value = state.settings?.googleClientId || "";
  }
  if (ui.matrixGoogleApiKey instanceof HTMLInputElement) {
    ui.matrixGoogleApiKey.value = state.settings?.googleApiKey || "";
  }
  state.showArchived = Boolean(ui.showArchivedToggle.checked);
  await refreshProjects();

  const persistedActiveProjectId = await getActiveProjectId();
  let activeProjectId = requestedProjectId || persistedActiveProjectId || "";
  if (activeProjectId) {
    await setActiveProjectId(activeProjectId);
    state.activeProjectId = activeProjectId;
  }
  await loadActiveProjectData();
  setProjectForm(null);
  const persistedNavState = getPersistedHomeNavState();
  state.activeTopTab = normalizeTopTabName(persistedNavState.activeTopTab);
  state.activeWorkflowStage = normalizeWorkflowStageName(
    persistedNavState.activeWorkflowStage || state.settings?.homeDefaultWorkflowStage || "discover"
  );
  state.activeInsightsStage = normalizeInsightsStageName(
    persistedNavState.activeInsightsStage || state.settings?.homeDefaultInsightsStage || "compare"
  );
  const viewFromTopTab = state.activeTopTab === "workflow"
    ? state.activeWorkflowStage
    : state.activeTopTab === "insights"
      ? state.activeInsightsStage
      : "project";
  const persistedActiveView = getPersistedActiveView();
  let initialView = persistedActiveView === "project" ? viewFromTopTab : persistedActiveView;
  if (!state.activeProjectId || (state.papers.length === 0 && initialView !== "discover")) {
    initialView = "project";
  }
  setActiveView(initialView, { persist: false });
}

ui.openViewer?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "OPEN_VIEWER", projectId: state.activeProjectId || "" });
});

for (const button of ui.pipelineStepButtons || []) {
  button.addEventListener("click", () => {
    const targetView = normalizeViewName(button.getAttribute("data-view-target") || "");
    setActiveView(targetView);
  });
}

ui.openTutorial?.addEventListener("click", () => {
  openChecklistDrawer();
  setStatus("Checklist opened.");
});

ui.openChecklistFromWorkspace?.addEventListener("click", () => {
  openChecklistDrawer();
});

ui.closeChecklist?.addEventListener("click", () => {
  closeChecklistDrawer({ markSeen: true });
});

ui.checklistBackdrop?.addEventListener("click", () => {
  closeChecklistDrawer({ markSeen: true });
});

ui.openHomeSettings?.addEventListener("click", () => {
  syncHomeSettingsControls();
  openHomeSettingsDrawer();
});

ui.closeHomeSettings?.addEventListener("click", () => {
  closeHomeSettingsDrawer();
});

ui.homeSettingsBackdrop?.addEventListener("click", () => {
  closeHomeSettingsDrawer();
});

ui.homeDensitySetting?.addEventListener("change", () => {
  const nextDensity = normalizeText(ui.homeDensitySetting?.value || "compact");
  void updateHomeSetting({ homeDensity: nextDensity === "comfortable" ? "comfortable" : "compact" });
});

ui.homeAccentSetting?.addEventListener("change", () => {
  const nextAccent = normalizeText(ui.homeAccentSetting?.value || "ocean").toLowerCase();
  const safeAccent = nextAccent === "forest" || nextAccent === "sunset" ? nextAccent : "ocean";
  void updateHomeSetting({ homeAccentPreset: safeAccent });
});

ui.homeAdvancedCollapsedSetting?.addEventListener("change", () => {
  void updateHomeSetting({ homeShowAdvancedCollapsedByDefault: Boolean(ui.homeAdvancedCollapsedSetting?.checked) });
});

ui.homeChecklistEnabledSetting?.addEventListener("change", () => {
  const enabled = Boolean(ui.homeChecklistEnabledSetting?.checked);
  void updateHomeSetting({ homeChecklistEnabled: enabled });
  if (!enabled) {
    closeChecklistDrawer({ markSeen: true });
  }
});

ui.homeDefaultWorkflowStageSetting?.addEventListener("change", () => {
  void updateHomeSetting({ homeDefaultWorkflowStage: normalizeWorkflowStageName(ui.homeDefaultWorkflowStageSetting?.value) });
});

ui.homeDefaultInsightsStageSetting?.addEventListener("change", () => {
  void updateHomeSetting({ homeDefaultInsightsStage: normalizeInsightsStageName(ui.homeDefaultInsightsStageSetting?.value) });
});

ui.homeLlmModeSelect?.addEventListener("change", () => {
  void handleHomeLlmModeChange();
});

ui.homeOpenaiModelPreset?.addEventListener("change", () => {
  void handleHomeOpenAIModelPresetChange();
});

ui.homeOpenaiModelCustom?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void handleHomeOpenAICustomModelCommit();
  }
});

ui.homeOpenaiModelCustom?.addEventListener("blur", () => {
  void handleHomeOpenAICustomModelCommit();
});

ui.homeSaveApiKey?.addEventListener("click", () => {
  void handleHomeSaveApiKey();
});

ui.homeClearApiKey?.addEventListener("click", () => {
  void handleHomeClearApiKey();
});

ui.homeOpenaiApiKeyInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void handleHomeSaveApiKey();
  }
});

ui.llmRuntimeFlag?.addEventListener("click", () => {
  handleLlmRuntimeFlagShortcut();
});

ui.llmRuntimeFlag?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    handleLlmRuntimeFlagShortcut();
  }
});

for (const button of ui.workflowStageButtons || []) {
  button.addEventListener("click", () => {
    setActiveView(normalizeWorkflowStageName(button.dataset.workflowStage || "discover"));
  });
}

for (const button of ui.insightsStageButtons || []) {
  button.addEventListener("click", () => {
    setActiveView(normalizeInsightsStageName(button.dataset.insightsStage || "compare"));
  });
}

function triggerImportReview(importMode = "active_project") {
  if (ui.importTargetMode instanceof HTMLSelectElement) {
    ui.importTargetMode.value = normalizeImportTargetMode(importMode);
  }
  updateImportControlsState();
  if (state.importInProgress) {
    return;
  }
  ui.importLiteratureDocument?.click();
}

if (ui.checklistDrawer) {
  ui.checklistDrawer.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action='checklist-jump']") : null;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    jumpToChecklistStep(button.dataset.id || "");
    closeChecklistDrawer({ markSeen: true });
  });
}

if (ui.workspaceChecklistList) {
  ui.workspaceChecklistList.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action='checklist-jump']") : null;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    jumpToChecklistStep(button.dataset.id || "");
  });
}

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-toggle-advanced]") : null;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const targetId = normalizeText(button.dataset.toggleAdvanced || "");
  const disclosure = targetId ? document.getElementById(targetId) : null;
  if (!(disclosure instanceof HTMLDetailsElement)) {
    return;
  }
  disclosure.open = !disclosure.open;
  disclosure.dataset.userTouched = "1";
  if (disclosure.open) {
    disclosure.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

ui.refreshAll?.addEventListener("click", () => {
  void refreshAllProjectAnalyses();
});

ui.discoverRunSearch?.addEventListener("click", () => {
  void runDiscoverySearch({ source: "manual" });
});

ui.discoverKeywords?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runDiscoverySearch({ source: "manual" });
  }
});

ui.discoverSaveSearch?.addEventListener("click", () => {
  void saveCurrentDiscoverSearch();
});

ui.discoverRunSavedSearches?.addEventListener("click", () => {
  void runDueSavedSearches();
});

ui.discoverDedupe?.addEventListener("click", () => {
  void dedupeDiscoveryCandidatesAction();
});

ui.discoverLoadSavedSearch?.addEventListener("click", () => {
  loadSelectedSavedSearchIntoInputs();
  renderAll();
});

ui.discoverRunSavedSearchNow?.addEventListener("click", () => {
  void runSelectedSavedSearchNow();
});

ui.discoverDeleteSavedSearch?.addEventListener("click", () => {
  void deleteSelectedSavedSearch();
});

ui.discoverSavedSearchSelect?.addEventListener("change", () => {
  renderAll();
});

ui.discoverSavedAutoEnabled?.addEventListener("change", () => {
  void updateSelectedSavedSearchSchedule();
});

ui.discoverSavedIntervalDays?.addEventListener("change", () => {
  void updateSelectedSavedSearchSchedule();
});

ui.discoverGroupFilter?.addEventListener("change", () => {
  state.discoverGroupFilter = normalizeText(ui.discoverGroupFilter?.value || "all");
  renderAll();
});

ui.discoverTableWrap?.addEventListener("click", (event) => {
  void handleDiscoverTableClick(event);
});

ui.discoverExpandCitations?.addEventListener("click", () => {
  void expandCitationsFromSelectedSeed();
});

ui.screenQueueWrap?.addEventListener("click", (event) => {
  void handleScreenQueueClick(event);
});

ui.screenDecisionInclude?.addEventListener("click", () => {
  void applyScreenDecisionAction("include");
});

ui.screenDecisionExclude?.addEventListener("click", () => {
  void applyScreenDecisionAction("exclude");
});

ui.screenDecisionNeedsInfo?.addEventListener("click", () => {
  void applyScreenDecisionAction("needs_info");
});

ui.screenDecisionNext?.addEventListener("click", () => {
  moveScreenSelection(1);
  renderAll();
});

ui.screenSuggestDecision?.addEventListener("click", () => {
  void runScreeningSuggestionForSelectedPaper();
});

ui.screenAddReason?.addEventListener("click", () => {
  void addScreenReasonAction();
});

ui.showArchivedToggle?.addEventListener("change", async () => {
  state.showArchived = Boolean(ui.showArchivedToggle.checked);
  await refreshProjects();
  renderAll();
});

ui.projectList?.addEventListener("click", (event) => {
  void handleProjectListClick(event);
});

ui.projectSwitcher?.addEventListener("change", async () => {
  const nextProjectId = normalizeText(ui.projectSwitcher?.value || "");
  if (!nextProjectId || nextProjectId === state.activeProjectId) {
    return;
  }
  await selectProject(nextProjectId);
  setActiveView("project");
});

ui.openProjectCreate?.addEventListener("click", () => {
  openProjectModal(null);
});

ui.openProjectCreateHero?.addEventListener("click", () => {
  openProjectModal(null);
});

ui.openImportReviewStart?.addEventListener("click", () => {
  triggerImportReview("new_project");
});

ui.openImportReviewEmpty?.addEventListener("click", () => {
  triggerImportReview(state.activeProjectId ? "active_project" : "new_project");
});

ui.startSearchPapers?.addEventListener("click", () => {
  setActiveView("discover");
  ui.discoverKeywords?.focus();
});

ui.nextActionButton?.addEventListener("click", () => {
  setActiveView(ui.nextActionButton?.dataset.viewTarget || "project");
});

ui.projectForm?.addEventListener("submit", (event) => {
  void handleProjectFormSubmit(event);
});

ui.resetProjectForm?.addEventListener("click", () => {
  setProjectForm(null);
});

ui.closeProjectModal?.addEventListener("click", () => {
  closeProjectModal({ reset: true });
});

ui.projectModal?.addEventListener("pointerdown", (event) => {
  if (event.target === ui.projectModal) {
    closeProjectModal({ reset: true });
  }
});

ui.addPaperUrl?.addEventListener("click", () => {
  void addPaperFromUrl();
});

ui.paperUrlInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void addPaperFromUrl();
  }
});

ui.addLocalPaper?.addEventListener("click", () => {
  ui.localPaperInput?.click();
});

ui.projectPaperUrlAddMirror?.addEventListener("click", () => {
  if (ui.paperUrlInput instanceof HTMLInputElement && ui.projectPaperUrlInputMirror instanceof HTMLInputElement) {
    ui.paperUrlInput.value = ui.projectPaperUrlInputMirror.value;
  }
  void addPaperFromUrl();
});

ui.projectPaperUrlInputMirror?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (ui.paperUrlInput instanceof HTMLInputElement && ui.projectPaperUrlInputMirror instanceof HTMLInputElement) {
      ui.paperUrlInput.value = ui.projectPaperUrlInputMirror.value;
    }
    void addPaperFromUrl();
  }
});

ui.projectAddLocalPaperMirror?.addEventListener("click", () => {
  ui.localPaperInput?.click();
});

ui.localPaperInput?.addEventListener("change", async () => {
  const file = ui.localPaperInput.files?.[0];
  ui.localPaperInput.value = "";
  if (!file) {
    return;
  }
  await addPaperFromLocalFile(file);
});

ui.importTargetMode?.addEventListener("change", () => {
  updateImportControlsState();
});

ui.importLiteratureDocument?.addEventListener("click", () => {
  if (state.importInProgress) {
    return;
  }
  ui.importDocumentInput?.click();
});

ui.importDocumentInput?.addEventListener("change", async () => {
  const file = ui.importDocumentInput.files?.[0];
  if (!file) {
    return;
  }
  await importLiteratureDocument(file);
});

ui.paperList?.addEventListener("click", (event) => {
  void handlePaperListClick(event);
});

ui.paperList?.addEventListener("change", (event) => {
  void handlePaperListChange(event);
});

ui.runCompare?.addEventListener("click", () => {
  void runComparison();
});

ui.exportMarkdown?.addEventListener("click", () => {
  const selectedPapers = getSelectedComparePapers();
  const markdown = comparisonToMarkdown(state.comparison, selectedPapers);
  if (!markdown) {
    setStatus("No comparison to export.");
    return;
  }
  downloadText("clarify-comparison.md", markdown, "text/markdown;charset=utf-8");
  setStatus("Markdown export ready.");
});

ui.exportCsv?.addEventListener("click", () => {
  const selectedPapers = getSelectedComparePapers();
  const csv = comparisonToCsv(state.comparison, selectedPapers);
  if (!csv) {
    setStatus("No comparison to export.");
    return;
  }
  downloadText("clarify-comparison.csv", csv, "text/csv;charset=utf-8");
  setStatus("CSV export ready.");
});

ui.clearCompareCache?.addEventListener("click", async () => {
  if (!state.activeProjectId) {
    return;
  }
  await clearProjectComparisonsForProject(state.activeProjectId);
  state.comparison = null;
  state.comparisonWarnings = [];
  state.contributionMapDirty = true;
  renderAll();
  setStatus("Comparison cache cleared.");
});

ui.runContributionMap?.addEventListener("click", () => {
  void runContributionMapAction();
});

ui.exportContributionMd?.addEventListener("click", () => {
  const markdown = contributionMapToMarkdown();
  if (!markdown) {
    setStatus("No contribution map to export.");
    return;
  }
  downloadText("clarify-contribution-map.md", markdown, "text/markdown;charset=utf-8");
  setStatus("Contribution map Markdown export ready.");
});

ui.exportContributionCsv?.addEventListener("click", () => {
  const csv = contributionMapToCsv();
  if (!csv) {
    setStatus("No contribution map to export.");
    return;
  }
  downloadText("clarify-contribution-map.csv", csv, "text/csv;charset=utf-8");
  setStatus("Contribution map CSV export ready.");
});

ui.matrixSchemaList?.addEventListener("input", (event) => {
  void handleMatrixSchemaInput(event);
});

ui.matrixSchemaList?.addEventListener("change", (event) => {
  void handleMatrixSchemaInput(event);
});

ui.matrixSchemaList?.addEventListener("click", (event) => {
  void handleMatrixSchemaClick(event);
});

ui.matrixTableWrap?.addEventListener("change", (event) => {
  void handleMatrixTableInput(event);
});

ui.matrixTableWrap?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  if (target.dataset.action !== "matrix-column-filter") {
    return;
  }
  const columnId = normalizeText(target.dataset.columnId || "");
  if (!columnId) {
    return;
  }
  const next = {
    ...(state.matrixColumnFilters || {})
  };
  if (normalizeText(target.value || "")) {
    next[columnId] = target.value || "";
  } else {
    delete next[columnId];
  }
  state.matrixColumnFilters = next;
  rememberMatrixFiltersForActiveProject();
  renderAll();
});

ui.matrixTableWrap?.addEventListener("click", (event) => {
  void handleMatrixTableClick(event);
});

ui.matrixTableWrap?.addEventListener("pointerdown", (event) => {
  handleMatrixColumnResizePointerDown(event);
});

ui.matrixTableWrap?.addEventListener("keydown", (event) => {
  handleMatrixColumnResizeKeydown(event);
});

ui.matrixGlobalFilter?.addEventListener("input", () => {
  state.matrixGlobalFilterText = ui.matrixGlobalFilter.value || "";
  rememberMatrixFiltersForActiveProject();
  renderAll();
});

ui.matrixShowExcluded?.addEventListener("change", () => {
  state.matrixShowExcluded = Boolean(ui.matrixShowExcluded.checked);
  renderAll();
});

ui.matrixClusterFilter?.addEventListener("input", () => {
  state.matrixClusterFilter = ui.matrixClusterFilter.value || "";
  rememberMatrixFiltersForActiveProject();
  renderAll();
});

ui.matrixClusterCanvas?.addEventListener("click", (event) => {
  handleMatrixClusterCanvasClick(event);
});

ui.matrixRunAutofillAll?.addEventListener("click", () => {
  void runMatrixAutofillForAll();
});

ui.matrixRunClustering?.addEventListener("click", () => {
  void runMatrixClusteringAction();
});

ui.matrixAutofillIgnoreFilled?.addEventListener("click", () => {
  closeMatrixAutofillDialog("missing");
});

ui.matrixAutofillOverwriteFilled?.addEventListener("click", () => {
  closeMatrixAutofillDialog("overwrite");
});

ui.matrixAutofillCancel?.addEventListener("click", () => {
  closeMatrixAutofillDialog("cancel");
});

ui.matrixAutofillClose?.addEventListener("click", () => {
  closeMatrixAutofillDialog("cancel");
});

ui.matrixAutofillModal?.addEventListener("click", (event) => {
  if (event.target === ui.matrixAutofillModal) {
    closeMatrixAutofillDialog("cancel");
  }
});

ui.matrixClearFilters?.addEventListener("click", () => {
  clearMatrixFilters();
  rememberMatrixFiltersForActiveProject();
  renderAll();
});

ui.matrixExportCsv?.addEventListener("click", () => {
  exportMatrixCsv();
});

ui.matrixExportXlsx?.addEventListener("click", () => {
  exportMatrixXlsx();
});

ui.matrixApplyTemplate?.addEventListener("click", () => {
  void applySelectedMatrixTemplate();
});

ui.matrixSaveTemplate?.addEventListener("click", () => {
  void saveCurrentMatrixAsTemplate();
});

ui.matrixImportCsv?.addEventListener("click", () => {
  ui.matrixImportCsvInput?.click();
});

ui.matrixQuickImportCsv?.addEventListener("click", () => {
  ui.matrixImportCsvInput?.click();
});

ui.matrixToolbarImportCsv?.addEventListener("click", () => {
  ui.matrixImportCsvInput?.click();
});

ui.matrixSetupImportCsv?.addEventListener("click", () => {
  ui.matrixImportCsvInput?.click();
});

ui.matrixImportCsvInput?.addEventListener("change", async () => {
  const file = ui.matrixImportCsvInput.files?.[0];
  ui.matrixImportCsvInput.value = "";
  if (!file) {
    return;
  }
  await importMatrixCsvFile(file);
});

ui.matrixAddColumn?.addEventListener("click", () => {
  void addMatrixColumn();
});

ui.matrixQuickAddColumn?.addEventListener("click", () => {
  void addMatrixColumn();
});

ui.matrixToolbarAddColumn?.addEventListener("click", () => {
  void addMatrixColumn();
});

ui.matrixSetupAddColumn?.addEventListener("click", () => {
  void addMatrixColumn();
});

ui.matrixColumnsAddCriterion?.addEventListener("click", () => {
  void addMatrixColumn();
});

ui.matrixColumnsImportCsv?.addEventListener("click", () => {
  ui.matrixImportCsvInput?.click();
});

ui.matrixAddRow?.addEventListener("click", () => {
  void addManualMatrixRow();
});

ui.matrixStartBlank?.addEventListener("click", () => {
  if (!state.activeProjectId) {
    return;
  }
  state.matrixSetupDismissedByProjectId = {
    ...(state.matrixSetupDismissedByProjectId || {}),
    [state.activeProjectId]: true
  };
  renderAll();
});

ui.matrixOpenColumns?.addEventListener("click", () => {
  openMatrixDrawer("columns");
});

ui.matrixOpenTrash?.addEventListener("click", () => {
  openMatrixDrawer("trash");
});

ui.matrixQuickOpenSettings?.addEventListener("click", () => {
  openMatrixDrawer("columns");
});

ui.matrixDensitySelect?.addEventListener("change", () => {
  const next = normalizeText(ui.matrixDensitySelect?.value || "comfortable");
  state.matrixDensity = next === "compact" ? "compact" : "comfortable";
  renderAll();
});

ui.matrixUndoRestore?.addEventListener("click", () => {
  const removal = state.matrixLastRemoved;
  if (!removal) {
    return;
  }
  if (removal.type === "row") {
    void restoreMatrixRow(removal.id);
    return;
  }
  if (removal.type === "column") {
    void restoreMatrixColumn(removal.id);
  }
});

ui.matrixRowDrawerBody?.addEventListener("change", (event) => {
  void handleMatrixTableInput(event);
});

ui.matrixRowDrawerBody?.addEventListener("click", (event) => {
  void handleMatrixTableClick(event);
});

ui.closeMatrixRowDrawer?.addEventListener("click", () => {
  closeMatrixDrawers();
});

ui.closeMatrixColumnsDrawer?.addEventListener("click", () => {
  closeMatrixDrawers();
});

ui.closeMatrixTrashDrawer?.addEventListener("click", () => {
  closeMatrixDrawers();
});

ui.matrixDrawerBackdrop?.addEventListener("click", () => {
  closeMatrixDrawers();
});

ui.matrixColumnsDrawerList?.addEventListener("input", (event) => {
  void handleMatrixSchemaInput(event);
});

ui.matrixColumnsDrawerList?.addEventListener("change", (event) => {
  void handleMatrixSchemaInput(event);
});

ui.matrixColumnsDrawerList?.addEventListener("click", (event) => {
  void handleMatrixSchemaClick(event);
});

ui.matrixTrashDrawerBody?.addEventListener("click", (event) => {
  const actionButton = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!(actionButton instanceof HTMLButtonElement)) {
    return;
  }
  const action = normalizeText(actionButton.dataset.action || "");
  if (action.startsWith("matrix-column-")) {
    void handleMatrixSchemaClick(event);
    return;
  }
  void handleMatrixTableClick(event);
});

ui.matrixConfirmCsvImport?.addEventListener("click", () => {
  void confirmMatrixCsvImport();
});

ui.matrixCancelCsvImport?.addEventListener("click", () => {
  closeMatrixCsvImport();
});

ui.matrixCancelCsvImportSecondary?.addEventListener("click", () => {
  closeMatrixCsvImport();
});

ui.matrixCsvImportModal?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.dataset.action !== "matrix-csv-role") {
    return;
  }
  updateMatrixCsvRole(target.dataset.index || "", target.value);
});

ui.matrixCsvImportModal?.addEventListener("pointerdown", (event) => {
  if (event.target === ui.matrixCsvImportModal) {
    closeMatrixCsvImport();
  }
});

ui.matrixGoogleClientId?.addEventListener("change", async () => {
  const nextClientId = normalizeText(ui.matrixGoogleClientId.value);
  const nextApiKey = normalizeText(ui.matrixGoogleApiKey?.value || state.settings?.googleApiKey || "");
  state.settings = await setSettings({ googleClientId: nextClientId || null, googleApiKey: nextApiKey || null });
  renderAll();
  setStatus("Google client ID saved.");
});

ui.matrixGoogleApiKey?.addEventListener("change", async () => {
  const nextApiKey = normalizeText(ui.matrixGoogleApiKey.value);
  const nextClientId = normalizeText(ui.matrixGoogleClientId?.value || state.settings?.googleClientId || "");
  state.settings = await setSettings({ googleClientId: nextClientId || null, googleApiKey: nextApiKey || null });
  renderAll();
  setStatus("Google API key saved.");
});

ui.matrixConnectGoogle?.addEventListener("click", async () => {
  if (isMatrixOpRunning("googleAuth")) {
    return;
  }
  try {
    const clientId = normalizeText(ui.matrixGoogleClientId?.value || state.settings?.googleClientId || "");
    const apiKey = normalizeText(ui.matrixGoogleApiKey?.value || state.settings?.googleApiKey || "");
    if (!clientId) {
      setStatus("Enter Google OAuth Client ID first.");
      return;
    }
    setMatrixOpRunning("googleAuth", true);
    renderAll();
    state.settings = await setSettings({ googleClientId: clientId, googleApiKey: apiKey || null });
    await connectGoogleOAuth({ clientId });
    setStatus("Google OAuth connected.");
  } catch (error) {
    setStatus(`Google OAuth failed: ${truncateText(error?.message || "Unknown error", 140)}`);
  } finally {
    setMatrixOpRunning("googleAuth", false);
    renderAll();
  }
});

ui.matrixDisconnectGoogle?.addEventListener("click", () => {
  disconnectGoogleOAuth();
  renderAll();
  setStatus("Google OAuth disconnected.");
});

ui.matrixLoadSheets?.addEventListener("click", () => {
  void loadGoogleSheetChoices();
});

ui.matrixSpreadsheetSelect?.addEventListener("change", async () => {
  const spreadsheetId = normalizeText(ui.matrixSpreadsheetSelect.value);
  if (!state.matrix) {
    return;
  }
  if (!spreadsheetId) {
    try {
      await persistMatrix({
        ...state.matrix,
        sheetsSync: {
          ...(state.matrix.sheetsSync || {}),
          spreadsheetId: "",
          spreadsheetName: "",
          sheetTitle: "",
          sheetId: null
        }
      });
      clearElement(ui.matrixWorksheetSelect);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select worksheet";
      ui.matrixWorksheetSelect.append(placeholder);
      state.googleTabChoices = [];
      renderAll();
    } catch (error) {
      setStatus(`Failed to clear spreadsheet selection: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
    return;
  }
  try {
    const selected = state.googleSheetChoices.find((entry) => entry.id === spreadsheetId);
    await persistMatrix({
      ...state.matrix,
      sheetsSync: {
        ...(state.matrix.sheetsSync || {}),
        spreadsheetId,
        spreadsheetName: selected?.name || "",
        sheetTitle: "",
        sheetId: null
      }
    });
    await loadGoogleTabChoices(spreadsheetId);
    renderAll();
  } catch (error) {
    setStatus(`Failed to update spreadsheet selection: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
});

ui.matrixWorksheetSelect?.addEventListener("change", async () => {
  const sheetTitle = normalizeText(ui.matrixWorksheetSelect.value);
  if (!state.matrix) {
    return;
  }
  if (!sheetTitle) {
    try {
      await persistMatrix({
        ...state.matrix,
        sheetsSync: {
          ...(state.matrix.sheetsSync || {}),
          sheetTitle: "",
          sheetId: null
        }
      });
      renderAll();
    } catch (error) {
      setStatus(`Failed to clear worksheet selection: ${truncateText(error?.message || "Unknown error", 140)}`);
    }
    return;
  }
  try {
    const selected = state.googleTabChoices.find((entry) => entry.title === sheetTitle);
    await persistMatrix({
      ...state.matrix,
      sheetsSync: {
        ...(state.matrix.sheetsSync || {}),
        sheetTitle,
        sheetId: selected?.sheetId ?? null
      }
    });
    renderAll();
  } catch (error) {
    setStatus(`Failed to update worksheet selection: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
});

ui.matrixAutoSyncToggle?.addEventListener("change", async () => {
  if (!state.matrix) {
    return;
  }
  try {
    await persistMatrix({
      ...state.matrix,
      sheetsSync: {
        ...(state.matrix.sheetsSync || {}),
        autoSync: Boolean(ui.matrixAutoSyncToggle.checked)
      }
    });
    renderAll();
  } catch (error) {
    setStatus(`Failed to update auto-sync setting: ${truncateText(error?.message || "Unknown error", 140)}`);
  }
});

ui.matrixSyncNow?.addEventListener("click", () => {
  void syncMatrixToGoogleNow();
});

for (const disclosure of ui.advancedDisclosures || []) {
  disclosure?.addEventListener("toggle", () => {
    if (disclosure instanceof HTMLDetailsElement) {
      disclosure.dataset.userTouched = "1";
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (ui.matrixAutofillModal instanceof HTMLElement && !ui.matrixAutofillModal.hidden) {
      event.preventDefault();
      closeMatrixAutofillDialog("cancel");
      return;
    }
    if (state.projectModalOpen) {
      event.preventDefault();
      closeProjectModal({ reset: true });
      return;
    }
    if (state.settingsDrawerOpen) {
      event.preventDefault();
      closeHomeSettingsDrawer();
      return;
    }
    if (state.checklistOpen) {
      event.preventDefault();
      closeChecklistDrawer({ markSeen: true });
      return;
    }
  }

  if (state.projectModalOpen || state.settingsDrawerOpen || state.checklistOpen) {
    return;
  }

  if (state.activeView !== "screen") {
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const target = event.target;
  const isTypingTarget =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
  if (isTypingTarget) {
    return;
  }
  const key = normalizeText(event.key).toLowerCase();
  if (key === "i") {
    event.preventDefault();
    void applyScreenDecisionAction("include");
    return;
  }
  if (key === "e") {
    event.preventDefault();
    void applyScreenDecisionAction("exclude");
    return;
  }
  if (key === "m") {
    event.preventDefault();
    void applyScreenDecisionAction("needs_info");
    return;
  }
  if (key === "n") {
    event.preventDefault();
    moveScreenSelection(1);
    renderAll();
  }
});

globalThis.addEventListener?.(LLM_RUNTIME_STATUS_EVENT, (event) => {
  renderLlmRuntimeFlag(event?.detail);
});

logger.info("Research home loaded");
void initialize().catch((error) => {
  logger.error("Failed to initialize home", { message: error?.message || "Unknown error" });
  setStatus("Failed to initialize research home.");
});
