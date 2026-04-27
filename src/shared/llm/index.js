import { createLogger } from "../diagnostics.js"
import { getSettings } from "../storage.js"
import { normalizeLLMResponse, TASKS } from "./schema.js"
import { generate as generateMock } from "./providers/mock.js"
import { generate as generateOpenAI } from "./providers/openai.js"
import { buildLlmRuntimeStatus, publishLlmRuntimeStatus } from "../llm_runtime_status.js"

const logger = createLogger("LLM")
const TASK_SET = new Set(TASKS)

function normalizeTask(task) {
  return TASK_SET.has(task) ? task : "explanation"
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function normalizeWorksheetText(value) {
  if (typeof value !== "string") {
    return ""
  }
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function clampText(value, maxLength) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(maxLength - 3, 1)).trim()}...`
}

function clampWorksheetText(value, maxLength) {
  const text = normalizeWorksheetText(value)
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
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function normalizeStringList(value, maxItems = 12, maxLength = 180) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return source
    .map((item) => clampText(item, maxLength))
    .filter(Boolean)
    .slice(0, Math.max(1, maxItems))
}

function normalizeInput(input) {
  const source = input && typeof input === "object" ? input : {}
  const grounding = source.grounding && typeof source.grounding === "object" ? source.grounding : {}
  const openaiFileId = normalizeText(source.openaiFileId).slice(0, 120)
  const openaiFileIds = Array.isArray(source.openaiFileIds)
    ? source.openaiFileIds.map((item) => normalizeText(item).slice(0, 120)).filter(Boolean).slice(0, 6)
    : []
  const headings = Array.isArray(source.headings)
    ? source.headings.map((item) => clampText(item, 140)).filter(Boolean).slice(0, 24)
    : []
  const sections = Array.isArray(source.sections)
    ? source.sections
        .map((section) => ({
          sectionKey: clampText(section?.sectionKey, 220),
          title: clampText(section?.title, 160),
          snippet: clampText(section?.snippet, 1000),
          pageIndex: Number.isFinite(Number(section?.pageIndex))
            ? Math.max(0, Math.floor(Number(section.pageIndex)))
            : 0
        }))
        .filter((section) => section.sectionKey && section.title)
        .slice(0, 24)
    : []
  const worksheetPages = Array.isArray(source.worksheetPages)
    ? source.worksheetPages
        .map((entry) => ({
          pageIndex: Number.isFinite(Number(entry?.pageIndex))
            ? Math.max(0, Math.floor(Number(entry.pageIndex)))
            : 0,
          text: clampWorksheetText(entry?.text, 1800)
        }))
        .filter((entry) => entry.text)
        .slice(0, 48)
    : []
  const readingMode =
    source.readingMode === "structure" || source.readingMode === "worksheet" ? source.readingMode : "flow"
  const pageIndex = Number.isFinite(Number(source.pageIndex))
    ? Math.max(0, Math.floor(Number(source.pageIndex)))
    : 0
  const papers = Array.isArray(source.papers)
    ? source.papers
        .map((paper, index) => {
          const paperObj = paper && typeof paper === "object" ? paper : {}
          return {
            paperId: clampText(paperObj.paperId || `paper_${index + 1}`, 120),
            title: clampText(paperObj.title, 220),
            summary: clampText(paperObj.summary, 900),
            status: clampText(paperObj.status, 32),
            tags: normalizeStringList(paperObj.tags, 12, 48),
            notes: clampText(paperObj.notes, 700)
          }
        })
        .filter((paper) => paper.paperId)
        .slice(0, 8)
    : []
  const matrixColumns = Array.isArray(source.matrixColumns)
    ? source.matrixColumns
        .map((column, index) => {
          const columnObj = column && typeof column === "object" ? column : {}
          return {
            columnId: clampText(columnObj.columnId || columnObj.id || `col_${index + 1}`, 80),
            label: clampText(columnObj.label || columnObj.name || "", 120),
            type: clampText(columnObj.type || "categorical", 24),
            description: clampText(columnObj.description || "", 220),
            clusterEnabled: columnObj.clusterEnabled !== false
          }
        })
        .filter((column) => column.columnId)
        .slice(0, 220)
    : []
  const importMode = source.importMode === "new_project" ? "new_project" : "active_project"
  const maxImportedPapers = normalizeNumber(source.maxImportedPapers, 120, 10, 220)
  const screenReasonLibrary = Array.isArray(source.screenReasonLibrary)
    ? source.screenReasonLibrary
        .map((reason, index) => {
          const reasonObj = reason && typeof reason === "object" ? reason : {}
          return {
            code: clampText(reasonObj.code || `reason_${index + 1}`, 80),
            label: clampText(reasonObj.label || "", 120),
            description: clampText(reasonObj.description || "", 220)
          }
        })
        .filter((reason) => reason.code || reason.label)
        .slice(0, 48)
    : []
  const matrixRows = Array.isArray(source.matrixRows)
    ? source.matrixRows
        .map((row, index) => {
          const rowObj = row && typeof row === "object" ? row : {}
          return {
            rowId: clampText(rowObj.rowId || rowObj.id || `row_${index + 1}`, 80),
            paperKey: clampText(rowObj.paperKey || "", 420),
            clusterId: Number.isFinite(Number(rowObj.clusterId))
              ? Math.max(0, Math.floor(Number(rowObj.clusterId)))
              : null,
            cells: Array.isArray(rowObj.cells)
              ? rowObj.cells
                  .map((cell) => ({
                    columnId: clampText(cell?.columnId || "", 80),
                    label: clampText(cell?.label || "", 120),
                    value: clampText(cell?.value, 280)
                  }))
                  .filter((cell) => cell.columnId || cell.value)
                  .slice(0, 36)
              : []
          }
        })
        .filter((row) => row.rowId)
        .slice(0, 220)
    : []
  return {
    selectedText: clampText(source.selectedText, 200),
    contextWindow: clampText(source.contextWindow, 1600),
    title: clampText(source.title, 220),
    snippet: clampText(source.snippet, 1000),
    pageIndex,
    headings,
    sections,
    worksheetPages,
    questionText: clampText(source.questionText, 360),
    gradeLevel: clampText(source.gradeLevel, 80),
    readingMode,
    openaiFileId,
    openaiFileIds,
    projectBrief: clampText(source.projectBrief, 2200),
    projectKeyTerms: normalizeStringList(source.projectKeyTerms, 32, 80),
    projectRubric: normalizeStringList(source.projectRubric, 24, 120),
    matrixColumns,
    papers,
    importMode,
    importDocumentName: clampText(source.importDocumentName || source.title, 220),
    importDocumentType: clampText(source.importDocumentType, 48),
    existingProjectName: clampText(source.existingProjectName, 140),
    maxImportedPapers,
    screenReasonLibrary,
    matrixRows,
    grounding: {
      pageIndex: Number.isFinite(grounding.pageIndex) ? Math.max(0, Number(grounding.pageIndex)) : 0,
      sectionTitle: clampText(grounding.sectionTitle, 160),
      quote: clampText(grounding.quote, 300)
    }
  }
}

function resolveOpenAIModel(optionsModel, settingsModel) {
  const preferred = normalizeText(optionsModel)
  if (preferred) {
    return preferred
  }
  const fromSettings = normalizeText(settingsModel)
  return fromSettings || ""
}

async function runWithFallback(task, input, settings, options) {
  const hasApiKey = Boolean(settings?.openaiApiKey)
  const mode = settings?.llmMode ?? "auto"

  if (mode === "mock") {
    return { providerUsed: "mock", rawResponse: await generateMock(task, input) }
  }

  if (mode === "openai" && !hasApiKey) {
    throw new Error("OpenAI mode requires a saved API key.")
  }

  if ((mode === "openai" && hasApiKey) || (mode === "auto" && hasApiKey)) {
    const rawResponse = await generateOpenAI(task, input, {
      apiKey: settings.openaiApiKey,
      model: resolveOpenAIModel(options?.model, settings?.openaiModel),
      promptCacheRetention: settings?.promptCacheRetention,
      maxQuoteChars: settings?.maxQuoteChars,
      maxCitations: settings?.maxCitations
    })
    return { providerUsed: "openai", rawResponse }
  }

  return { providerUsed: "mock", rawResponse: await generateMock(task, input) }
}

export async function generateLLM(task, input, options = {}) {
  const normalizedTask = normalizeTask(task)
  const normalizedInput = normalizeInput(input)
  const warnings = []
  const settings = await getSettings()

  let providerUsed = ""
  let rawResponse = null
  try {
    const result = await runWithFallback(normalizedTask, normalizedInput, settings, options)
    providerUsed = result.providerUsed
    rawResponse = result.rawResponse
  } catch (error) {
    const message = clampText(
      normalizeText(error?.message)
        .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]"),
      220
    )
    const openAIAttempted = settings?.llmMode !== "mock" && Boolean(settings?.openaiApiKey)
    logger.warn(`LLM generate failed: task=${normalizedTask}`, {
      mode: settings?.llmMode || "auto",
      openAIAttempted,
      message: message || "Unknown error"
    })
    publishLlmRuntimeStatus(
      buildLlmRuntimeStatus({
        settings,
        providerUsed: openAIAttempted ? "openai" : "",
        warnings,
        task: normalizedTask,
        errorMessage: message || "OpenAI request failed."
      })
    )
    throw error
  }
  logger.info(`LLM generate: task=${normalizedTask}, provider=${providerUsed}`, {
    selectedTextLength: normalizedInput.selectedText.length,
    contextWindowLength: normalizedInput.contextWindow.length,
    headingCount: normalizedInput.headings.length,
    sectionCount: normalizedInput.sections.length,
    worksheetPageCount: normalizedInput.worksheetPages.length,
    questionTextLength: normalizedInput.questionText.length,
    snippetLength: normalizedInput.snippet.length,
    hasOpenAIFile: Boolean(normalizedInput.openaiFileId),
    openaiFileIdCount: normalizedInput.openaiFileIds.length,
    projectBriefLength: normalizedInput.projectBrief.length,
    projectTermCount: normalizedInput.projectKeyTerms.length,
    projectRubricCount: normalizedInput.projectRubric.length,
    comparePaperCount: normalizedInput.papers.length,
    matrixColumnCount: normalizedInput.matrixColumns.length,
    importMode: normalizedInput.importMode,
    openaiModel: settings?.openaiModel || "",
    importDocumentNameLength: normalizedInput.importDocumentName.length,
    importDocumentTypeLength: normalizedInput.importDocumentType.length,
    existingProjectNameLength: normalizedInput.existingProjectName.length,
    maxImportedPapers: normalizedInput.maxImportedPapers,
    screenReasonCount: normalizedInput.screenReasonLibrary.length,
    matrixRowCount: normalizedInput.matrixRows.length
  })

  const fullRawText = typeof rawResponse?.rawText === "string" ? rawResponse.rawText : ""
  const extractedJsonText =
    typeof rawResponse?.extractedJsonText === "string" ? rawResponse.extractedJsonText : ""

  const result = {
    providerUsed,
    response: normalizeLLMResponse(normalizedTask, rawResponse, {
      maxQuoteChars: settings?.maxQuoteChars,
      maxCitations: settings?.maxCitations
    }),
    warnings,
    rawText: fullRawText,
    extractedJsonText
  }
  publishLlmRuntimeStatus(
    buildLlmRuntimeStatus({
      settings,
      providerUsed,
      warnings,
      task: normalizedTask
    })
  )
  return result
}
