import { createLogger } from "../../diagnostics.js"

const DEFAULT_MODEL = "gpt-4.1-mini"
const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses"
const REQUEST_TIMEOUT_MS = 12000
const RATE_LIMIT_COOLDOWN_FALLBACK_MS = 60000
const MAX_SELECTED_TEXT_LENGTH = 200
const MAX_CONTEXT_WINDOW_LENGTH = 1600
const MAX_TITLE_LENGTH = 220
const MAX_SECTION_TITLE_LENGTH = 160
const MAX_QUOTE_LENGTH = 300
const MAX_OUTPUT_TOKENS = 500
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
    task === "worksheet_answer"
  ) {
    return task
  }
  return "explanation"
}

function normalizeInput(input) {
  const source = input && typeof input === "object" ? input : {}
  const grounding = source.grounding && typeof source.grounding === "object" ? source.grounding : {}
  const openaiFileId = normalizeText(source.openaiFileId).slice(0, 120)
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
  if (task === "quant") {
    return `{"shortAnswer":"<=35 words","whatItShows":"string","takeaway":"string","supportsClaim":["string"],"whatToLookAt":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
  }
  return `{"shortAnswer":"<=35 words","eli5":"string","steps":["string"],"paperUsage":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
}

function buildUserPrompt(task, input, limits) {
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

function readApiErrorMessage(payload) {
  const message = payload?.error?.message
  return clampText(message, 180)
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

function extractResponseText(payload) {
  if (!payload || typeof payload !== "object") {
    return ""
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text
  }

  const output = Array.isArray(payload.output) ? payload.output : []
  for (const block of output) {
    const contentItems = Array.isArray(block?.content) ? block.content : []
    for (const item of contentItems) {
      if (typeof item?.text === "string" && item.text.trim()) {
        return item.text
      }
      if (typeof item?.output_text === "string" && item.output_text.trim()) {
        return item.output_text
      }
      if (typeof item?.content === "string" && item.content.trim()) {
        return item.content
      }
      if (typeof item?.text?.value === "string" && item.text.value.trim()) {
        return item.text.value
      }
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

function buildUserContent(userPrompt, openaiFileId) {
  const content = [{ type: "input_text", text: userPrompt }]
  if (openaiFileId) {
    content.push({ type: "input_file", file_id: openaiFileId })
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

function buildRequestPayload(task, input, config, useRetention) {
  const limits = {
    maxQuoteChars: normalizeNumber(config?.maxQuoteChars, DEFAULT_MAX_QUOTE_CHARS, 80, 480),
    maxCitations: normalizeNumber(config?.maxCitations, DEFAULT_MAX_CITATIONS, 1, 6)
  }
  const userPrompt = buildUserPrompt(task, input, limits)
  const payload = {
    model: normalizeText(config?.model) || DEFAULT_MODEL,
    temperature: 0,
    max_output_tokens: MAX_OUTPUT_TOKENS,
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
        content: buildUserContent(userPrompt, input.openaiFileId)
      }
    ]
  }
  if (useRetention) {
    payload.prompt_cache_retention = "24h"
  }
  return payload
}

function buildJsonRepairPayload(task, rawText, config) {
  const payload = {
    model: normalizeText(config?.model) || DEFAULT_MODEL,
    temperature: 0,
    max_output_tokens: MAX_OUTPUT_TOKENS,
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
    try {
      json = await response.json()
    } catch (_error) {
      throw new Error("OpenAI Responses API response could not be parsed.")
    }

    if (!response.ok) {
      if (response.status === 429) {
        const cooldownMs = parseRetryAfterMs(response)
        rateLimitUntilMs = Date.now() + cooldownMs
        const retryInSec = Math.max(1, Math.ceil(cooldownMs / 1000))
        const apiMessage = readApiErrorMessage(json)
        const reason = apiMessage ? ` ${apiMessage}` : ""
        throw new Error(`OpenAI rate limit hit (429). Retry in about ${retryInSec}s.${reason}`)
      }
      const apiMessage = readApiErrorMessage(json)
      const reason = apiMessage ? `: ${apiMessage}` : ""
      throw new Error(`OpenAI request failed (${response.status})${reason}`)
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

async function repairMalformedJson({ apiKey, task, rawText, config }) {
  const repairPayload = buildJsonRepairPayload(task, rawText, config)
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

  let useRetention = wantsRetention
  let attempts = 0

  while (attempts < 2) {
    attempts += 1
    const requestPayload = buildRequestPayload(normalizedTask, normalizedInput, config, useRetention)
    logger.info("OpenAI request", {
      endpoint: OPENAI_RESPONSES_API_URL,
      task: normalizedTask,
      model: requestPayload.model,
      hasOpenAIFile: Boolean(normalizedInput.openaiFileId),
      retention: useRetention ? "24h" : "default",
      selectedTextLength: normalizedInput.selectedText.length,
      contextWindowLength: normalizedInput.contextWindow.length,
      snippetLength: normalizedInput.snippet.length,
      headingCount: normalizedInput.headings.length,
      sectionCount: normalizedInput.sections.length,
      worksheetPageCount: normalizedInput.worksheetPages.length,
      questionTextLength: normalizedInput.questionText.length
    })

    try {
      const { response, payload } = await callResponsesApi({
        apiKey,
        payload: requestPayload
      })

      const rawText = extractResponseText(payload)
      if (!rawText) {
        throw new Error("OpenAI response was empty.")
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
            config
          })
          usedJsonRepair = true
        } catch (repairError) {
          const repairMessage = sanitizeLogString(repairError?.message || "Unknown repair error")
          throw new Error(`OpenAI returned invalid JSON payload. Repair failed: ${repairMessage}`)
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
        retention: useRetention ? "24h" : "default"
      })

      if (shouldRetryWithoutRetention(errorMessage, useRetention)) {
        useRetention = false
        continue
      }
      throw error
    }
  }

  throw new Error("OpenAI request failed after retry.")
}
