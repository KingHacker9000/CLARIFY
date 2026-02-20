import { createLogger } from "../../diagnostics.js"

const DEFAULT_MODEL = "gpt-4.1-mini"
const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses"
const REQUEST_TIMEOUT_MS = 12000
const RATE_LIMIT_COOLDOWN_FALLBACK_MS = 60000
const MAX_SELECTED_TEXT_LENGTH = 200
const MAX_CONTEXT_WINDOW_LENGTH = 800
const MAX_TITLE_LENGTH = 180
const MAX_SECTION_TITLE_LENGTH = 160
const MAX_QUOTE_LENGTH = 300
const MAX_OUTPUT_TOKENS = 500
const DEFAULT_MAX_QUOTE_CHARS = 240
const DEFAULT_MAX_CITATIONS = 3
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

function normalizeNumber(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function normalizeTask(task) {
  if (task === "definition" || task === "explanation" || task === "quant") {
    return task
  }
  return "explanation"
}

function normalizeInput(input) {
  const source = input && typeof input === "object" ? input : {}
  const grounding = source.grounding && typeof source.grounding === "object" ? source.grounding : {}
  const openaiFileId = normalizeText(source.openaiFileId).slice(0, 120)
  return {
    selectedText: clampText(source.selectedText, MAX_SELECTED_TEXT_LENGTH),
    contextWindow: clampText(source.contextWindow, MAX_CONTEXT_WINDOW_LENGTH),
    title: clampText(source.title, MAX_TITLE_LENGTH),
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
  return "explanation"
}

function buildSchemaForTask(task) {
  if (task === "quant") {
    return `{"shortAnswer":"<=35 words","whatItShows":"string","takeaway":"string","supportsClaim":["string"],"whatToLookAt":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
  }
  return `{"shortAnswer":"<=35 words","eli5":"string","steps":["string"],"paperUsage":["string"],"groundingPages":[0],"groundingQuotes":["short quote"]}`
}

function buildUserPrompt(task, input, limits) {
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
    return payload.output_text.trim()
  }

  const output = Array.isArray(payload.output) ? payload.output : []
  for (const block of output) {
    const contentItems = Array.isArray(block?.content) ? block.content : []
    for (const item of contentItems) {
      if (typeof item?.text === "string" && item.text.trim()) {
        return item.text.trim()
      }
      if (typeof item?.output_text === "string" && item.output_text.trim()) {
        return item.output_text.trim()
      }
      if (typeof item?.content === "string" && item.content.trim()) {
        return item.content.trim()
      }
      if (typeof item?.text?.value === "string" && item.text.value.trim()) {
        return item.text.value.trim()
      }
    }
  }
  return ""
}

function extractJsonObject(rawText) {
  const text = typeof rawText === "string" ? rawText.trim() : ""
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("OpenAI response did not contain a JSON object.")
  }
  const candidate = text.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch (_error) {
    throw new Error("OpenAI returned invalid JSON payload.")
  }
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

function buildRequestPayload(task, input, config, useRetention) {
  const limits = {
    maxQuoteChars: normalizeNumber(config?.maxQuoteChars, DEFAULT_MAX_QUOTE_CHARS, 80, 480),
    maxCitations: normalizeNumber(config?.maxCitations, DEFAULT_MAX_CITATIONS, 1, 6)
  }
  const userPrompt = buildUserPrompt(task, input, limits)
  const payload = {
    model: normalizeText(config?.model) || DEFAULT_MODEL,
    temperature: 0.2,
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

async function callResponsesApi({ apiKey, payload, signal }) {
  const response = await fetch(OPENAI_RESPONSES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  let useRetention = wantsRetention
  let attempts = 0

  try {
    while (attempts < 2) {
      attempts += 1
      const requestPayload = buildRequestPayload(normalizedTask, normalizedInput, config, useRetention)
      logger.info("OpenAI request", {
        endpoint: OPENAI_RESPONSES_API_URL,
        task: normalizedTask,
        hasOpenAIFile: Boolean(normalizedInput.openaiFileId),
        retention: useRetention ? "24h" : "default",
        body: {
          ...requestPayload,
          input: Array.isArray(requestPayload.input)
            ? requestPayload.input.map((item) => ({
                ...item,
                content: Array.isArray(item?.content)
                  ? item.content.map((contentItem) =>
                      contentItem?.type === "input_file"
                        ? { ...contentItem, file_id: "[attached]" }
                        : contentItem
                    )
                  : item?.content
              }))
            : requestPayload.input
        }
      })

      try {
        const { response, payload } = await callResponsesApi({
          apiKey,
          payload: requestPayload,
          signal: controller.signal
        })

        const rawText = extractResponseText(payload)
        if (!rawText) {
          throw new Error("OpenAI response was empty.")
        }
        const parsed = extractJsonObject(rawText)
        logger.info("OpenAI response ok", {
          status: response.status,
          rawText: clampText(sanitizeLogString(rawText), 1200),
          parsed
        })
        return parsed
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
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${REQUEST_TIMEOUT_MS}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
