import { createLogger } from "../../diagnostics.js"

const DEFAULT_MODEL = "gpt-4.1-mini"
const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses"
const REQUEST_TIMEOUT_MS = 12000
const RATE_LIMIT_COOLDOWN_FALLBACK_MS = 60000
const TASK_REQUEST_TIMEOUT_MS = Object.freeze({
  project_matrix_row_fill: 28000,
  project_compare_table: 42000,
  project_relevance: 22000,
  project_contribution_map: 28000,
  literature_import: 42000
})
const TASK_TRANSIENT_RETRY_SET = new Set([
  "project_matrix_row_fill",
  "project_compare_table",
  "project_relevance",
  "project_contribution_map",
  "literature_import"
])
const DEFAULT_MAX_ATTEMPTS = 3
const MAX_MAX_ATTEMPTS = 6
const RETRY_DELAY_BASE_MS = 500
const RETRY_DELAY_CAP_MS = 2500
const MAX_SELECTED_TEXT_LENGTH = 200
const MAX_CONTEXT_WINDOW_LENGTH = 1600
const MAX_TITLE_LENGTH = 220
const MAX_SECTION_TITLE_LENGTH = 160
const MAX_QUOTE_LENGTH = 300
const MAX_OUTPUT_TOKENS = 500
const MAX_OUTPUT_TOKEN_CAP = 4200
const DEFAULT_MAX_QUOTE_CHARS = 240
const DEFAULT_MAX_CITATIONS = 3
const MAX_JSON_REPAIR_INPUT_CHARS = 6000
const JSON_REPAIR_TIMEOUT_MS = 18000
const STABLE_DEVELOPER_PROMPT = [
  "You are Clarify, a grounded research-paper reading assistant.",
  "Use only provided context and attached file content.",
  "Do not use external knowledge.",
  "Return strict JSON only. No markdown or extra prose.",
  "If context is insufficient, say so in shortAnswer and keep other fields minimal."
].join(" ")

let rateLimitUntilMs = 0
const logger = createLogger("OPENAI")

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

function sanitizeLogString(value) {
  return normalizeText(value)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
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

function normalizeTask(task) {
  if (
    task === "definition" ||
    task === "explanation" ||
    task === "quant" ||
    task === "orientation" ||
    task === "section_intents" ||
    task === "section_intent" ||
    task === "worksheet_questions" ||
    task === "worksheet_answer" ||
    task === "project_relevance" ||
    task === "project_compare_table" ||
    task === "literature_import" ||
    task === "project_matrix_row_fill" ||
    task === "project_screening_suggest" ||
    task === "project_contribution_map"
  ) {
    return task
  }
  return "explanation"
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
  const snippet = clampText(source.snippet, 1000)
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
            tags: Array.isArray(paperObj.tags)
              ? paperObj.tags.map((tag) => clampText(tag, 48)).filter(Boolean).slice(0, 12)
              : [],
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
            label: clampText(columnObj.label || "", 120),
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
          const rowId = clampText(rowObj.rowId || rowObj.id || `row_${index + 1}`, 80)
          const paperKey = clampText(rowObj.paperKey || rowObj.key || "", 420)
          const clusterId = Number.isFinite(Number(rowObj.clusterId))
            ? Math.max(0, Math.floor(Number(rowObj.clusterId)))
            : null
          const cells = Array.isArray(rowObj.cells)
            ? rowObj.cells
                .map((cell) => {
                  const cellObj = cell && typeof cell === "object" ? cell : {}
                  return {
                    columnId: clampText(cellObj.columnId || "", 80),
                    label: clampText(cellObj.label || "", 120),
                    value: clampText(cellObj.value, 280)
                  }
                })
                .filter((cell) => cell.columnId || cell.value)
                .slice(0, 36)
            : []
          return {
            rowId,
            paperKey,
            clusterId,
            cells
          }
        })
        .filter((row) => row.rowId)
        .slice(0, 220)
    : []
  return {
    selectedText: clampText(source.selectedText, MAX_SELECTED_TEXT_LENGTH),
    contextWindow: clampText(source.contextWindow, MAX_CONTEXT_WINDOW_LENGTH),
    title: clampText(source.title, MAX_TITLE_LENGTH),
    headings,
    sections,
    worksheetPages,
    questionText: clampText(source.questionText, 360),
    gradeLevel: clampText(source.gradeLevel, 80),
    snippet,
    pageIndex,
    readingMode,
    openaiFileId,
    openaiFileIds,
    projectBrief: clampText(source.projectBrief, 2200),
    projectKeyTerms: Array.isArray(source.projectKeyTerms)
      ? source.projectKeyTerms.map((term) => clampText(term, 80)).filter(Boolean).slice(0, 32)
      : [],
    projectRubric: Array.isArray(source.projectRubric)
      ? source.projectRubric.map((item) => clampText(item, 120)).filter(Boolean).slice(0, 24)
      : [],
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
      sectionTitle: clampText(grounding.sectionTitle, MAX_SECTION_TITLE_LENGTH),
      quote: clampText(grounding.quote, MAX_QUOTE_LENGTH)
    }
  }
}

function taskLabel(task) {
  if (task === "definition") {
    return "definition"
  }
  if (task === "quant") {
    return "figure/quant translation"
  }
  if (task === "orientation") {
    return "paper orientation"
  }
  if (task === "section_intents") {
    return "section intents"
  }
  if (task === "section_intent") {
    return "section intent"
  }
  if (task === "worksheet_questions") {
    return "worksheet question extraction"
  }
  if (task === "worksheet_answer") {
    return "worksheet direct answer"
  }
  if (task === "project_relevance") {
    return "project relevance analysis"
  }
  if (task === "project_compare_table") {
    return "project paper comparison table"
  }
  if (task === "literature_import") {
    return "literature review import extraction"
  }
  if (task === "project_matrix_row_fill") {
    return "project matrix row fill"
  }
  if (task === "project_screening_suggest") {
    return "project screening suggestion"
  }
  if (task === "project_contribution_map") {
    return "project contribution map"
  }
  return "explanation"
}

function buildSchemaForTask(task) {
  if (task === "section_intents") {
    return `{"intents":[{"sectionKey":"string","intent":"<=25 words"}]}`
  }
  if (task === "section_intent") {
    return `{"intent":"<=25 words"}`
  }
  if (task === "worksheet_questions") {
    return `{"questions":[{"questionText":"string","pageIndex":0,"gradeLevel":"string|optional","kind":"question|part|item|term|prompt","label":"string|optional","sourceKey":"string|optional","parentSourceKey":"string|optional","anchorText":"string|optional","questionType":"mcq|short_answer|long_answer|multi_select|fill_blank|true_false|table_definition|unknown","responseTypes":["mcq|short_answer|long_answer|multi_select|fill_blank|true_false|table_definition"],"marksRaw":"string|optional","marksValue":null,"marksEach":false,"options":["string"],"contextWindow":"string|optional"}]}`
  }
  if (task === "worksheet_answer") {
    return `{"answer":"string","answerLength":"short|long"}`
  }
  if (task === "orientation") {
    return `{"purpose":"string","contribution":"string","focusBullets":["string"],"keyTerms":["string"]}`
  }
  if (task === "project_relevance") {
    return `{"fitScore":0,"recommendation":"include|exclude|review","relevanceSummary":"string","methodMatch":"string","gapsOrRisks":["string"],"recommendedSections":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
  }
  if (task === "project_compare_table") {
    return `{"columns":["string"],"rows":[{"criterion":"string","cells":[{"paperId":"string","value":"string","groundingPage":0,"groundingQuote":"string"}]}],"crossPaperInsights":["string"],"contradictions":["string"],"evidenceGaps":["string"]}`
  }
  if (task === "literature_import") {
    return `{"project":{"name":"string","researchQuestion":"string","objective":"string","scopeNotes":"string","keyTerms":["string"],"rubric":["string"]},"papers":[{"title":"string","url":"https://...|optional","authors":["string"],"year":2024,"venue":"string","tags":["string"],"status":"queued|reading|included|excluded","priority":2,"notes":"string","arxivId":"string|optional","doi":"string|optional","confidence":"high|medium|low|unknown","searchQuery":"string|optional"}],"warnings":["string"]}`
  }
  if (task === "project_matrix_row_fill") {
    return `{"cells":[{"columnId":"string","value":"string","confidence":0.0,"evidenceSnippet":"string","evidencePage":0,"insufficientReason":"string|optional"}],"hiddenFeatures":[{"columnId":"string","tags":["string"]}],"warnings":["string"]}`
  }
  if (task === "project_screening_suggest") {
    return `{"decisionSuggestion":"include|exclude|needs_info|review","confidence":0.0,"reasonCandidates":["string"],"evidenceSnippet":"string","evidencePage":0,"insufficientReason":"string|optional"}`
  }
  if (task === "project_contribution_map") {
    return `{"clustersSummary":[{"label":"string","summary":"string","confidence":0.0}],"underexploredZones":[{"label":"string","summary":"string","confidence":0.0}],"differentiationIdeas":[{"label":"string","summary":"string","confidence":0.0}],"evidenceLinks":[{"label":"string","rowId":"string","clusterId":0,"columnId":"string","value":"string"}]}`
  }
  if (task === "quant") {
    return `{"shortAnswer":"<=35 words","whatItShows":"string","takeaway":"string","supportsClaim":["string"],"whatToLookAt":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
  }
  return `{"shortAnswer":"<=35 words","eli5":"string","steps":["string"],"paperUsage":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
}

function buildUserPrompt(task, input, limits) {
  if (task === "literature_import") {
    const projectMode =
      input.importMode === "new_project" ? "Create new project from this document." : "Add papers to an existing project."
    const existingProjectHint = input.existingProjectName
      ? `Existing project name: "${input.existingProjectName}"`
      : "Existing project name: (none)"
    return [
      "Task: extract and reformat a literature-review document into project metadata + paper list",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      projectMode,
      existingProjectHint,
      "Use only the provided text and attached file content.",
      "Do not invent papers not present in the source document.",
      "If a link is missing, still include the paper and provide arxivId/doi/searchQuery when possible.",
      "Prefer direct PDF URLs when explicitly present.",
      "status should usually be queued unless the source clearly indicates inclusion/exclusion state.",
      "priority should default to 2 unless source provides stronger ordering cues.",
      "project fields should summarize the source document so migration into Clarify is easy.",
      `Limit papers to at most ${input.maxImportedPapers}.`,
      `Document name: "${input.importDocumentName || input.title || ""}"`,
      `Document type hint: "${input.importDocumentType || ""}"`,
      `Source text snippet: "${input.contextWindow || input.snippet || ""}"`
    ].join("\n")
  }

  if (task === "project_relevance") {
    return [
      "Task: project relevance analysis for one paper",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Ground all claims in provided paper context and attached file content only.",
      "fitScore is 0-100 based on project alignment and evidence quality.",
      "recommendation must be include, exclude, or review.",
      "relevanceSummary should state why this paper matters (or not) for the project in 2-4 sentences.",
      "methodMatch should focus on method/data/task alignment to project goals.",
      "gapsOrRisks should list limitations, missing evidence, or mismatch risks.",
      "recommendedSections should list sections to prioritize for deeper reading.",
      `Use at most ${limits.maxCitations} grounding quotes and each quote <= ${limits.maxQuoteChars} chars.`,
      "If evidence is weak, set recommendation to review and lower fitScore.",
      `Project brief: "${input.projectBrief || ""}"`,
      `Project key terms: "${input.projectKeyTerms.join(" | ")}"`,
      `Project rubric criteria: "${input.projectRubric.join(" | ")}"`,
      `Paper title: "${input.title || ""}"`,
      `Current section context: "${input.contextWindow || input.snippet || ""}"`
    ].join("\n")
  }

  if (task === "project_compare_table") {
    const papersPayload = JSON.stringify(
      input.papers.map((paper) => ({
        paperId: paper.paperId,
        title: paper.title,
        summary: paper.summary,
        status: paper.status,
        tags: paper.tags
      }))
    )
    const rubricPayload = JSON.stringify(input.projectRubric)
    return [
      "Task: compare multiple papers for one project",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Use one row per rubric criterion whenever possible.",
      "Each row must contain cells and each cell must include paperId and value.",
      "Keep value concise and evidence-grounded.",
      "Include groundingPage and groundingQuote when evidence is available.",
      "crossPaperInsights should capture consensus patterns across papers.",
      "contradictions should capture direct disagreements and uncertainty.",
      "evidenceGaps should call out missing evaluations or unclear claims.",
      "Do not invent papers beyond provided paperId values.",
      `Project brief: "${input.projectBrief || ""}"`,
      `Project key terms: "${input.projectKeyTerms.join(" | ")}"`,
      `Rubric criteria JSON: ${rubricPayload}`,
      `Papers JSON: ${papersPayload}`
    ].join("\n")
  }

  if (task === "project_matrix_row_fill") {
    const columnsPayload = JSON.stringify(
      input.matrixColumns.map((column) => ({
        columnId: column.columnId,
        label: column.label,
        type: column.type,
        description: column.description,
        clusterEnabled: column.clusterEnabled
      }))
    )
    return [
      "Task: fill one project matrix row from paper evidence",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Use only provided context and attached file content.",
      "Return one cells item per provided columnId except paper_key.",
      "value should be concise and normalized for table use.",
      "confidence must be 0..1 and reflect evidence quality.",
      "If insufficient evidence for a column, set value empty and fill insufficientReason.",
      "For text-type columns that are cluster-enabled, emit hiddenFeatures tags (1-3 concise categories).",
      "Do not invent column IDs not present in input.",
      `Project brief: "${input.projectBrief || ""}"`,
      `Project key terms: "${input.projectKeyTerms.join(" | ")}"`,
      `Project rubric criteria: "${input.projectRubric.join(" | ")}"`,
      `Paper title: "${input.title || ""}"`,
      `Paper context: "${input.contextWindow || input.snippet || ""}"`,
      `Matrix columns JSON: ${columnsPayload}`
    ].join("\n")
  }

  if (task === "project_screening_suggest") {
    const reasonPayload = JSON.stringify(input.screenReasonLibrary || [])
    return [
      "Task: suggest a screening decision for one paper",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Use only provided context and attached file content.",
      "Decision should be include, exclude, needs_info, or review.",
      "Use include only if title/abstract evidence strongly matches project scope.",
      "Use exclude only if mismatch is clear and specific.",
      "Use needs_info when full text or key evidence is missing.",
      "reasonCandidates should be short reason codes/labels aligned with provided reason library.",
      "If insufficient context, set decisionSuggestion to review and explain in insufficientReason.",
      `Project brief: "${input.projectBrief || ""}"`,
      `Project key terms: "${input.projectKeyTerms.join(" | ")}"`,
      `Project rubric criteria: "${input.projectRubric.join(" | ")}"`,
      `Paper title: "${input.title || ""}"`,
      `Paper context: "${input.contextWindow || input.snippet || ""}"`,
      `Screen reason library JSON: ${reasonPayload}`
    ].join("\n")
  }

  if (task === "project_contribution_map") {
    const matrixColumnsPayload = JSON.stringify(
      input.matrixColumns.map((column) => ({
        columnId: column.columnId,
        label: column.label,
        type: column.type,
        clusterEnabled: column.clusterEnabled
      }))
    )
    const matrixRowsPayload = JSON.stringify(input.matrixRows || [])
    const comparePayload = JSON.stringify(
      input.papers.map((paper) => ({
        paperId: paper.paperId,
        title: paper.title,
        summary: paper.summary,
        notes: paper.notes,
        tags: paper.tags
      }))
    )
    return [
      "Task: produce a contribution positioning map from structured table data",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Use matrix rows + comparison summary only; do not rely on raw PDF assumptions.",
      "clustersSummary should explain what each cluster trend represents.",
      "underexploredZones should identify sparse method-task-data combinations.",
      "differentiationIdeas should be concrete and tied to observed gaps/contradictions.",
      "evidenceLinks should reference rowId/clusterId/columnId when available.",
      "Keep each summary concise and actionable.",
      `Project brief: "${input.projectBrief || ""}"`,
      `Project key terms: "${input.projectKeyTerms.join(" | ")}"`,
      `Project rubric criteria: "${input.projectRubric.join(" | ")}"`,
      `Matrix columns JSON: ${matrixColumnsPayload}`,
      `Matrix rows JSON: ${matrixRowsPayload}`,
      `Comparison papers JSON: ${comparePayload}`,
      `Context summary: "${input.contextWindow || input.snippet || ""}"`
    ].join("\n")
  }

  if (task === "worksheet_questions") {
    const pagesPayload = JSON.stringify(
      input.worksheetPages.map((entry) => ({
        pageIndex: entry.pageIndex,
        text: entry.text
      }))
    )
    return [
      "Task: worksheet question extraction",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Extract only real worksheet/test/assignment questions from provided pages.",
      "Keep each question text concise but faithful to the source wording.",
      "Split compound blocks: each Part (a)/(b)/... and each numbered item should be a separate questionText.",
      "For table-definition prompts (e.g., Term/Definition tables), emit one item per term as kind='term'.",
      "Use kind values: question, part, item, term, prompt.",
      "When an item belongs under another item, set parentSourceKey to that parent's sourceKey.",
      "Provide stable short sourceKey values so the same worksheet yields consistent hierarchy on refresh.",
      "label is optional display text (e.g., 'Question 2', 'Part (a)').",
      "anchorText should be the exact text likely visible on the page for overlay anchoring.",
      "Infer questionType and responseTypes from wording and option patterns.",
      "Use questionType/responseTypes from: mcq, short_answer, long_answer, multi_select, fill_blank, true_false, table_definition, unknown.",
      "If prompt mixes types (e.g., True/False + justify), include both in responseTypes and set questionType to the dominant first action.",
      "If marks/points are present nearby, fill marksRaw and marksValue; marksEach=true only if clearly per item.",
      "If marks are not stated, leave marksRaw empty and marksValue null.",
      "If options are present, include concise option strings (e.g., 'a) Base').",
      "contextWindow should include nearby text around the tagged prompt for precise answer placement.",
      "Set pageIndex to the source page (0-based).",
      "gradeLevel: include grade/marks/point hints only when explicitly present near the question; else empty string.",
      "Do not generate answers.",
      "Do not include duplicates.",
      `Pages JSON: ${pagesPayload}`
    ].join("\n")
  }

  if (task === "worksheet_answer") {
    return [
      "Task: worksheet direct answer",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Answer as if writing a final assignment/test response.",
      "No introductions, no filler, no extra commentary.",
      "Use simplified markdown only when useful: **KEY ANSWER** and short bullets.",
      "For True/False prompts: start with **TRUE** or **FALSE**, then one short justification sentence.",
      "For MCQ prompts: start with **Answer: <option>** and keep it direct.",
      "For term-definition prompts: return one direct definition line only.",
      "If gradeLevel exists, match expected depth for that grade.",
      "If context is insufficient, give the most concise accurate answer possible from available text.",
      `Question: "${input.questionText || ""}"`,
      `Grade hint: "${input.gradeLevel || ""}"`,
      `Page index (0-based): ${input.pageIndex}`,
      `Context snippet: "${input.snippet || input.contextWindow || ""}"`
    ].join("\n")
  }

  if (task === "section_intent") {
    return [
      "Task: section intent",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Write one sentence, <= 25 words, for a time-constrained reader.",
      "Ground only in provided title/snippet.",
      "If snippet is weak, keep a cautious title-based intent.",
      `Section title: "${input.title || ""}"`,
      `Page index (0-based): ${input.pageIndex}`,
      `Snippet: "${input.snippet || ""}"`
    ].join("\n")
  }

  if (task === "section_intents") {
    const sectionPayload = JSON.stringify(
      input.sections.map((section) => ({
        sectionKey: section.sectionKey,
        title: section.title,
        pageIndex: section.pageIndex,
        snippet: section.snippet
      }))
    )
    return [
      "Task: section intents",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Rules: include one entry per provided sectionKey.",
      "intent must be one sentence and <= 25 words.",
      "Audience: time-constrained reader optimizing reading strategy.",
      "Prioritize high-value sections first: problem, method, experiments/results, limitations.",
      "For low-value sections (references, bibliography, acknowledgments, appendix), state they are usually skippable unless needed.",
      "Be grounded in title/snippet. If snippet is weak, use a cautious title-based intent.",
      "Do not invent section keys.",
      `Sections JSON: ${sectionPayload}`
    ].join("\n")
  }

  if (task === "orientation") {
    return [
      "Task: paper orientation summary",
      `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
      "Style: concise, grounded, and paper-specific.",
      "purpose and contribution should be short prose sentences.",
      "focusBullets: 3-5 items, actionable reading guidance.",
      "keyTerms: up to 8 short terms/phrases.",
      `Reading mode preference: ${input.readingMode}`,
      `Title guess: "${input.title || ""}"`,
      `Abstract-ish context: "${input.contextWindow || ""}"`,
      `Headings: "${input.headings.join(" | ")}"`,
      "If evidence is limited, keep statements cautious and explicit."
    ].join("\n")
  }

  return [
    `Task: ${taskLabel(task)}`,
    `Return JSON schema exactly: ${buildSchemaForTask(task)}`,
    `Constraints: groundingQuotes max ${limits.maxCitations} items; each <= ${limits.maxQuoteChars} chars.`,
    "groundingPages should list page indices (0-based) when known; else empty list.",
    `Selected text: "${input.selectedText || ""}"`,
    `Context window: "${input.contextWindow || ""}"`,
    `Paper title: "${input.title || ""}"`,
    `Grounding page index: ${Number.isFinite(input.grounding.pageIndex) ? input.grounding.pageIndex : 0}`,
    `Grounding section: "${input.grounding.sectionTitle || ""}"`,
    `Grounding quote: "${input.grounding.quote || ""}"`,
    "If there is not enough evidence in the provided material, say that briefly in shortAnswer."
  ].join("\n")
}

function maxOutputTokensForTask(task) {
  if (task === "literature_import") {
    return 1800
  }
  if (task === "project_compare_table") {
    return 2200
  }
  if (task === "project_matrix_row_fill") {
    return 1400
  }
  if (task === "project_contribution_map") {
    return 1600
  }
  if (task === "project_screening_suggest") {
    return 800
  }
  return MAX_OUTPUT_TOKENS
}

function readApiErrorMessage(payload) {
  const error = payload?.error && typeof payload.error === "object" ? payload.error : {}
  const message = clampText(error.message, 180)
  const code = clampText(error.code, 80)
  const type = clampText(error.type, 80)
  const metadata = [code ? `code=${code}` : "", type ? `type=${type}` : ""].filter(Boolean).join(", ")
  if (message && metadata) {
    return `${metadata}; ${message}`
  }
  return message || metadata
}

function parseRetryAfterMs(response) {
  const retryAfterRaw = response?.headers?.get?.("retry-after")
  if (!retryAfterRaw) {
    return RATE_LIMIT_COOLDOWN_FALLBACK_MS
  }

  const seconds = Number(retryAfterRaw)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(1000, Math.floor(seconds * 1000))
  }

  const retryDate = Date.parse(retryAfterRaw)
  if (Number.isFinite(retryDate)) {
    const delta = retryDate - Date.now()
    if (delta > 0) {
      return Math.floor(delta)
    }
  }

  return RATE_LIMIT_COOLDOWN_FALLBACK_MS
}

function pushResponseTextFragment(fragments, value) {
  if (typeof value !== "string") {
    return
  }
  const text = value.trim()
  if (!text) {
    return
  }
  if (!fragments.includes(text)) {
    fragments.push(text)
  }
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== "object") {
    return ""
  }
  const fragments = []
  pushResponseTextFragment(fragments, payload.output_text)

  const output = Array.isArray(payload.output) ? payload.output : []
  for (const block of output) {
    pushResponseTextFragment(fragments, block?.text)
    pushResponseTextFragment(fragments, block?.output_text)
    const contentItems = Array.isArray(block?.content) ? block.content : []
    for (const item of contentItems) {
      pushResponseTextFragment(fragments, item?.text)
      pushResponseTextFragment(fragments, item?.output_text)
      pushResponseTextFragment(fragments, item?.content)
      pushResponseTextFragment(fragments, item?.text?.value)
    }
  }
  return fragments.join("\n").trim()
}

function readIncompleteReason(payload) {
  if (!payload || typeof payload !== "object") {
    return ""
  }
  const status = normalizeText(payload.status).toLowerCase()
  const incompleteReason = normalizeText(payload?.incomplete_details?.reason || payload?.incomplete_details?.type)
  if (status === "incomplete" && incompleteReason) {
    return incompleteReason
  }
  if (status === "incomplete") {
    return "incomplete"
  }
  const output = Array.isArray(payload.output) ? payload.output : []
  for (const block of output) {
    const blockStatus = normalizeText(block?.status).toLowerCase()
    const blockReason = normalizeText(block?.incomplete_details?.reason || block?.incomplete_details?.type)
    if (blockStatus === "incomplete" && blockReason) {
      return blockReason
    }
    if (blockStatus === "incomplete") {
      return "incomplete"
    }
  }
  return ""
}

function stripCodeFences(text) {
  const source = typeof text === "string" ? text : ""
  const trimmed = source.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  return trimmed
}

function collectBalancedJsonObjects(text) {
  const source = typeof text === "string" ? text : ""
  const objects = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === "\"") {
        inString = false
      }
      continue
    }

    if (char === "\"") {
      inString = true
      continue
    }

    if (char === "{") {
      if (depth === 0) {
        start = index
      }
      depth += 1
      continue
    }

    if (char === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(source.slice(start, index + 1))
        start = -1
      }
    }
  }

  return objects
}

function tryParseJsonObject(candidate) {
  const source = typeof candidate === "string" ? candidate : ""
  if (!source.trim()) {
    return null
  }
  const attempts = [
    source.trim(),
    stripCodeFences(source),
    stripCodeFences(source).replace(/,\s*([}\]])/g, "$1")
  ]
  for (const attempt of attempts) {
    if (!attempt) {
      continue
    }
    try {
      const parsed = JSON.parse(attempt)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          parsed,
          extractedJsonText: attempt
        }
      }
    } catch (_error) {
      // Try next candidate.
    }
  }
  return null
}

function extractJsonObject(rawText) {
  const text = typeof rawText === "string" ? rawText : ""
  if (!text.trim()) {
    throw new Error("OpenAI response did not contain a JSON object.")
  }

  const candidates = []
  const pushCandidate = (candidate) => {
    const normalized = typeof candidate === "string" ? candidate.trim() : ""
    if (!normalized) {
      return
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized)
    }
  }

  pushCandidate(text)
  pushCandidate(stripCodeFences(text))
  const fencedOnly = stripCodeFences(text)
  for (const candidate of collectBalancedJsonObjects(text)) {
    pushCandidate(candidate)
  }
  for (const candidate of collectBalancedJsonObjects(fencedOnly)) {
    pushCandidate(candidate)
  }
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) {
    pushCandidate(text.slice(start, end + 1))
  }

  for (const candidate of candidates) {
    const parsedResult = tryParseJsonObject(candidate)
    if (parsedResult) {
      return parsedResult
    }
  }

  throw new Error("OpenAI returned invalid JSON payload.")
}

function shouldRetryWithoutRetention(errorMessage, usedRetention) {
  if (!usedRetention) {
    return false
  }
  const msg = normalizeText(errorMessage).toLowerCase()
  if (!msg) {
    return false
  }
  return (
    msg.includes("prompt_cache_retention") ||
    msg.includes("retention") ||
    msg.includes("unknown parameter") ||
    msg.includes("unsupported")
  )
}

function shouldRetryWithoutFiles(errorMessage, hasAttachedFiles) {
  if (!hasAttachedFiles) {
    return false
  }
  const msg = normalizeText(errorMessage).toLowerCase()
  if (!msg) {
    return false
  }
  return (
    msg.includes("file_id") ||
    msg.includes("input_file") ||
    (msg.includes("file") &&
      (msg.includes("not found") ||
        msg.includes("no file found") ||
        msg.includes("invalid") ||
        msg.includes("no such file") ||
        msg.includes("does not exist") ||
        msg.includes("deleted")))
  )
}

function shouldRetryJsonOutputError(errorMessage) {
  const msg = normalizeText(errorMessage).toLowerCase()
  if (!msg) {
    return false
  }
  return (
    msg.includes("invalid json payload") ||
    msg.includes("did not contain a json object") ||
    msg.includes("json repair returned empty output") ||
    msg.includes("response was empty") ||
    msg.includes("responses api response could not be parsed")
  )
}

function shouldRetryIncompleteOutput(errorMessage) {
  const msg = normalizeText(errorMessage).toLowerCase()
  if (!msg) {
    return false
  }
  return msg.includes("response incomplete") || msg.includes("max_output_tokens") || msg.includes("truncated")
}

function extractHttpStatusCode(errorMessage) {
  const message = normalizeText(errorMessage)
  if (!message) {
    return null
  }
  const match = message.match(/\((\d{3})\)/)
  if (!match?.[1]) {
    return null
  }
  const status = Number(match[1])
  return Number.isFinite(status) ? status : null
}

function shouldRetryTransientError(errorMessage) {
  const msg = normalizeText(errorMessage).toLowerCase()
  if (!msg) {
    return false
  }
  if (msg.includes("timed out") || msg.includes("timeout")) {
    return true
  }
  if (msg.includes("failed to fetch") || msg.includes("network error") || msg.includes("network")) {
    return true
  }
  const status = extractHttpStatusCode(msg)
  return Number.isFinite(status)
    ? status >= 500 || status === 408 || status === 409 || status === 425 || status === 429
    : false
}

function taskSupportsTransientRetries(task) {
  return TASK_TRANSIENT_RETRY_SET.has(task)
}

function resolveRequestTimeoutMs(task, config) {
  const explicitTimeout = normalizeNumber(config?.timeoutMs, 0, 0, 120000)
  if (explicitTimeout > 0) {
    return Math.max(1000, explicitTimeout)
  }
  const taskTimeout = Number(TASK_REQUEST_TIMEOUT_MS[task])
  if (Number.isFinite(taskTimeout) && taskTimeout > 0) {
    return taskTimeout
  }
  return REQUEST_TIMEOUT_MS
}

function resolveMaxAttempts(task, config, wantsRetention) {
  const canRetryTransient = taskSupportsTransientRetries(task)
  const fallback = canRetryTransient || wantsRetention ? DEFAULT_MAX_ATTEMPTS : 2
  const configured = normalizeNumber(config?.maxAttempts, fallback, 1, MAX_MAX_ATTEMPTS)
  if (wantsRetention) {
    return Math.max(2, configured)
  }
  return configured
}

function parseRetryDelayMsFromMessage(errorMessage) {
  const msg = normalizeText(errorMessage).toLowerCase()
  if (!msg) {
    return 0
  }
  const secondsMatch = msg.match(/retry in about\s+(\d+)\s*s/)
  if (secondsMatch?.[1]) {
    const seconds = Number(secondsMatch[1])
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000
    }
  }
  return 0
}

function nextOutputTokenBudget(currentTokens) {
  const current = Math.max(1, normalizeNumber(currentTokens, MAX_OUTPUT_TOKENS, 1, MAX_OUTPUT_TOKEN_CAP))
  const boosted = Math.max(current + 220, Math.round(current * 1.45))
  return Math.min(MAX_OUTPUT_TOKEN_CAP, boosted)
}

function retryDelayMsForAttempt(attempt) {
  const safeAttempt = Math.max(1, Number(attempt) || 1)
  const delay = RETRY_DELAY_BASE_MS * Math.pow(2, safeAttempt - 1)
  return Math.min(RETRY_DELAY_CAP_MS, delay)
}

async function wait(delayMs) {
  const ms = Math.max(0, Number(delayMs) || 0)
  if (ms <= 0) {
    return
  }
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function buildUserContent(userPrompt, openaiFileId, openaiFileIds = []) {
  const content = [{ type: "input_text", text: userPrompt }]
  if (openaiFileId) {
    content.push({ type: "input_file", file_id: openaiFileId })
  }
  if (Array.isArray(openaiFileIds)) {
    for (const fileId of openaiFileIds) {
      const normalized = normalizeText(fileId)
      if (!normalized || normalized === openaiFileId) {
        continue
      }
      content.push({ type: "input_file", file_id: normalized })
    }
  }
  return content
}

function buildJsonRepairPrompt(task, rawText) {
  const schema = buildSchemaForTask(task)
  const malformed = clampWorksheetText(rawText, MAX_JSON_REPAIR_INPUT_CHARS)
  return [
    "Task: repair malformed JSON from a previous model output.",
    `Target schema: ${schema}`,
    "Return one strict JSON object only.",
    "Do not include markdown fences.",
    "Preserve meaning from the malformed text as closely as possible.",
    "If a field is missing, fill with an empty string/empty list/null as appropriate.",
    `Malformed model output: ${malformed}`
  ].join("\n")
}

function buildRequestPayload(task, input, config, useRetention, maxOutputTokens) {
  const limits = {
    maxQuoteChars: normalizeNumber(config?.maxQuoteChars, DEFAULT_MAX_QUOTE_CHARS, 80, 480),
    maxCitations: normalizeNumber(config?.maxCitations, DEFAULT_MAX_CITATIONS, 1, 6)
  }
  const userPrompt = buildUserPrompt(task, input, limits)
  const payload = {
    model: normalizeText(config?.model) || DEFAULT_MODEL,
    temperature: 0,
    max_output_tokens: normalizeNumber(maxOutputTokens, maxOutputTokensForTask(task), 80, MAX_OUTPUT_TOKEN_CAP),
    text: {
      format: { type: "json_object" }
    },
    input: [
      {
        role: "developer",
        content: [{ type: "input_text", text: STABLE_DEVELOPER_PROMPT }]
      },
      {
        role: "user",
        content: buildUserContent(userPrompt, input.openaiFileId, input.openaiFileIds)
      }
    ]
  }
  if (useRetention) {
    payload.prompt_cache_retention = "24h"
  }
  return payload
}

function buildJsonRepairPayload(task, rawText, config, maxOutputTokens) {
  const payload = {
    model: normalizeText(config?.model) || DEFAULT_MODEL,
    temperature: 0,
    max_output_tokens: normalizeNumber(maxOutputTokens, maxOutputTokensForTask(task), 80, MAX_OUTPUT_TOKEN_CAP),
    text: {
      format: { type: "json_object" }
    },
    input: [
      {
        role: "developer",
        content: [{ type: "input_text", text: STABLE_DEVELOPER_PROMPT }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: buildJsonRepairPrompt(task, rawText) }]
      }
    ]
  }
  return payload
}

async function callResponsesApi({ apiKey, payload, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS))

  try {
    const response = await fetch(OPENAI_RESPONSES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    let json = null
    let rawBodyText = ""
    try {
      rawBodyText = await response.text()
    } catch (_error) {
      rawBodyText = ""
    }
    if (rawBodyText) {
      try {
        json = JSON.parse(rawBodyText)
      } catch (_error) {
        json = null
      }
    }

    if (!response.ok) {
      if (response.status === 429) {
        const cooldownMs = parseRetryAfterMs(response)
        rateLimitUntilMs = Date.now() + cooldownMs
        const retryInSec = Math.max(1, Math.ceil(cooldownMs / 1000))
        const apiMessage = readApiErrorMessage(json) || clampWorksheetText(rawBodyText, 180)
        const reason = apiMessage ? ` ${apiMessage}` : ""
        throw new Error(`OpenAI rate limit hit (429). Retry in about ${retryInSec}s.${reason}`)
      }
      const apiMessage = readApiErrorMessage(json) || clampWorksheetText(rawBodyText, 180)
      const reason = apiMessage ? `: ${apiMessage}` : ""
      throw new Error(`OpenAI request failed (${response.status})${reason}`)
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error(`OpenAI Responses API response could not be parsed (${response.status}).`)
    }

    return { response, payload: json }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS)}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

async function repairMalformedJson({ apiKey, task, rawText, config, maxOutputTokens }) {
  const repairPayload = buildJsonRepairPayload(task, rawText, config, maxOutputTokens)
  const { payload } = await callResponsesApi({
    apiKey,
    payload: repairPayload,
    timeoutMs: JSON_REPAIR_TIMEOUT_MS
  })
  const repairText = extractResponseText(payload)
  if (!repairText) {
    throw new Error("OpenAI JSON repair returned empty output.")
  }
  return extractJsonObject(repairText)
}

export async function generate(task, input, config = {}) {
  const now = Date.now()
  if (rateLimitUntilMs > now) {
    const remainingSec = Math.ceil((rateLimitUntilMs - now) / 1000)
    throw new Error(`OpenAI rate-limited. Retry in about ${remainingSec}s.`)
  }

  const apiKey = normalizeText(config.apiKey)
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.")
  }

  const normalizedTask = normalizeTask(task)
  const normalizedInput = normalizeInput(input)
  const wantsRetention = config.promptCacheRetention === "24h"
  const requestTimeoutMs = resolveRequestTimeoutMs(normalizedTask, config)
  const maxAttempts = resolveMaxAttempts(normalizedTask, config, wantsRetention)
  const canRetryTransient = taskSupportsTransientRetries(normalizedTask)

  let useRetention = wantsRetention
  let maxOutputTokens = maxOutputTokensForTask(normalizedTask)
  let activeOpenAIFileId = normalizedInput.openaiFileId
  let activeOpenAIFileIds = [...normalizedInput.openaiFileIds]
  let removedFileAttachmentsForRetry = false
  let attempts = 0

  while (attempts < maxAttempts) {
    attempts += 1
    const requestInput = {
      ...normalizedInput,
      openaiFileId: activeOpenAIFileId,
      openaiFileIds: activeOpenAIFileIds
    }
    const requestPayload = buildRequestPayload(normalizedTask, requestInput, config, useRetention, maxOutputTokens)
    logger.info("OpenAI request", {
      endpoint: OPENAI_RESPONSES_API_URL,
      task: normalizedTask,
      attempt: attempts,
      maxAttempts,
      timeoutMs: requestTimeoutMs,
      model: requestPayload.model,
      maxOutputTokens: requestPayload.max_output_tokens,
      hasOpenAIFile: Boolean(requestInput.openaiFileId),
      openaiFileIdCount: requestInput.openaiFileIds.length,
      removedFileAttachmentsForRetry,
      retention: useRetention ? "24h" : "default",
      selectedTextLength: normalizedInput.selectedText.length,
      contextWindowLength: normalizedInput.contextWindow.length,
      snippetLength: normalizedInput.snippet.length,
      headingCount: normalizedInput.headings.length,
      sectionCount: normalizedInput.sections.length,
      worksheetPageCount: normalizedInput.worksheetPages.length,
      questionTextLength: normalizedInput.questionText.length,
      projectBriefLength: normalizedInput.projectBrief.length,
      projectTermCount: normalizedInput.projectKeyTerms.length,
      projectRubricCount: normalizedInput.projectRubric.length,
      matrixColumnCount: normalizedInput.matrixColumns.length,
      comparePaperCount: normalizedInput.papers.length,
      importMode: normalizedInput.importMode,
      importDocumentNameLength: normalizedInput.importDocumentName.length,
      importDocumentTypeLength: normalizedInput.importDocumentType.length,
      existingProjectNameLength: normalizedInput.existingProjectName.length,
      maxImportedPapers: normalizedInput.maxImportedPapers
    })

    try {
      const { response, payload } = await callResponsesApi({
        apiKey,
        payload: requestPayload,
        timeoutMs: requestTimeoutMs
      })
      const incompleteReason = readIncompleteReason(payload)
      if (incompleteReason) {
        const incompleteError = new Error(`OpenAI response incomplete (${incompleteReason}).`)
        incompleteError.code = "incomplete_output"
        throw incompleteError
      }

      const rawText = extractResponseText(payload)
      if (!rawText) {
        const emptyOutputError = new Error("OpenAI response was empty.")
        emptyOutputError.code = "empty_output"
        throw emptyOutputError
      }
      let parsedEnvelope = null
      let usedJsonRepair = false
      try {
        parsedEnvelope = extractJsonObject(rawText)
      } catch (parseError) {
        const parseMessage = sanitizeLogString(parseError?.message || "Unknown parse error")
        logger.info("OpenAI JSON parse failed; attempting repair", {
          task: normalizedTask,
          message: parseMessage,
          rawTextLength: rawText.length
        })
        try {
          parsedEnvelope = await repairMalformedJson({
            apiKey,
            task: normalizedTask,
            rawText,
            config,
            maxOutputTokens
          })
          usedJsonRepair = true
        } catch (repairError) {
          const repairMessage = sanitizeLogString(repairError?.message || "Unknown repair error")
          const invalidJsonError = new Error(`OpenAI returned invalid JSON payload. Repair failed: ${repairMessage}`)
          invalidJsonError.code = "invalid_json"
          throw invalidJsonError
        }
      }
      const { parsed, extractedJsonText } = parsedEnvelope
      logger.info("OpenAI response ok", {
        status: response.status,
        rawTextLength: rawText.length,
        extractedJsonLength: extractedJsonText.length,
        responseFields: Object.keys(parsed || {}).slice(0, 12),
        jsonRepairUsed: usedJsonRepair
      })
      return {
        ...parsed,
        rawText,
        extractedJsonText,
        jsonRepairUsed: usedJsonRepair
      }
    } catch (error) {
      const errorMessage = sanitizeLogString(error?.message || "Unknown error")
      logger.info("OpenAI response error", {
        message: errorMessage,
        retention: useRetention ? "24h" : "default",
        maxOutputTokens
      })

      if (shouldRetryWithoutRetention(errorMessage, useRetention)) {
        useRetention = false
        continue
      }
      if (shouldRetryWithoutFiles(errorMessage, Boolean(activeOpenAIFileId || activeOpenAIFileIds.length))) {
        if (attempts < maxAttempts) {
          activeOpenAIFileId = ""
          activeOpenAIFileIds = []
          removedFileAttachmentsForRetry = true
          const retryDelayMs = retryDelayMsForAttempt(attempts)
          logger.info("OpenAI file attachment failed; retrying without files", {
            task: normalizedTask,
            attempt: attempts,
            maxAttempts,
            retryDelayMs
          })
          await wait(retryDelayMs)
          continue
        }
      }
      if (shouldRetryIncompleteOutput(errorMessage) && attempts < maxAttempts) {
        maxOutputTokens = nextOutputTokenBudget(maxOutputTokens)
        const retryDelayMs = retryDelayMsForAttempt(attempts)
        logger.info("OpenAI output truncated; retrying with larger token budget", {
          task: normalizedTask,
          attempt: attempts,
          maxAttempts,
          retryDelayMs,
          nextMaxOutputTokens: maxOutputTokens
        })
        await wait(retryDelayMs)
        continue
      }
      if (shouldRetryJsonOutputError(errorMessage) && attempts < maxAttempts) {
        maxOutputTokens = nextOutputTokenBudget(maxOutputTokens)
        const retryDelayMs = retryDelayMsForAttempt(attempts)
        logger.info("OpenAI JSON output issue; retrying", {
          task: normalizedTask,
          attempt: attempts,
          maxAttempts,
          retryDelayMs,
          nextMaxOutputTokens: maxOutputTokens
        })
        await wait(retryDelayMs)
        continue
      }
      if (canRetryTransient && shouldRetryTransientError(errorMessage) && attempts < maxAttempts) {
        const retryDelayMs = Math.max(retryDelayMsForAttempt(attempts), parseRetryDelayMsFromMessage(errorMessage))
        logger.info("OpenAI transient error; retrying", {
          task: normalizedTask,
          attempt: attempts,
          maxAttempts,
          retryDelayMs
        })
        await wait(retryDelayMs)
        continue
      }
      throw error
    }
  }

  throw new Error("OpenAI request failed after retry.")
}
