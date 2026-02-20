import { createLogger } from "../diagnostics.js"
import { getSettings } from "../storage.js"
import { normalizeLLMResponse, TASKS } from "./schema.js"
import { generate as generateMock } from "./providers/mock.js"
import { generate as generateOpenAI } from "./providers/openai.js"

const logger = createLogger("LLM")
const TASK_SET = new Set(TASKS)

function normalizeTask(task) {
  return TASK_SET.has(task) ? task : "explanation"
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
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

function shortErrorReason(error) {
  const message = error?.message
  const normalized = normalizeText(message)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
  if (!normalized) {
    return "unknown error"
  }
  return clampText(normalized, 120)
}

function normalizeInput(input) {
  const source = input && typeof input === "object" ? input : {}
  const grounding = source.grounding && typeof source.grounding === "object" ? source.grounding : {}
  const openaiFileId = normalizeText(source.openaiFileId).slice(0, 120)
  return {
    selectedText: clampText(source.selectedText, 200),
    contextWindow: clampText(source.contextWindow, 800),
    title: clampText(source.title, 180),
    openaiFileId,
    grounding: {
      pageIndex: Number.isFinite(grounding.pageIndex) ? Math.max(0, Number(grounding.pageIndex)) : 0,
      sectionTitle: clampText(grounding.sectionTitle, 160),
      quote: clampText(grounding.quote, 300)
    }
  }
}

async function runWithFallback(task, input, settings, warnings, options) {
  const hasApiKey = Boolean(settings?.openaiApiKey)
  const mode = settings?.llmMode ?? "auto"

  if (mode === "mock") {
    return { providerUsed: "mock", rawResponse: await generateMock(task, input) }
  }

  if (mode === "openai" && !hasApiKey) {
    warnings.push("OpenAI key missing. Used mock provider.")
    return { providerUsed: "mock", rawResponse: await generateMock(task, input) }
  }

  if ((mode === "openai" && hasApiKey) || (mode === "auto" && hasApiKey)) {
    try {
      const rawResponse = await generateOpenAI(task, input, {
        apiKey: settings.openaiApiKey,
        model: options?.model,
        promptCacheRetention: settings?.promptCacheRetention,
        maxQuoteChars: settings?.maxQuoteChars,
        maxCitations: settings?.maxCitations
      })
      return { providerUsed: "openai", rawResponse }
    } catch (error) {
      warnings.push(`OpenAI failed, used mock instead: ${shortErrorReason(error)}`)
      return { providerUsed: "mock", rawResponse: await generateMock(task, input) }
    }
  }

  return { providerUsed: "mock", rawResponse: await generateMock(task, input) }
}

export async function generateLLM(task, input, options = {}) {
  const normalizedTask = normalizeTask(task)
  const normalizedInput = normalizeInput(input)
  const warnings = []
  const settings = await getSettings()

  const { providerUsed, rawResponse } = await runWithFallback(
    normalizedTask,
    normalizedInput,
    settings,
    warnings,
    options
  )
  logger.info(`LLM generate: task=${normalizedTask}, provider=${providerUsed}`, {
    selectedTextLength: normalizedInput.selectedText.length,
    contextWindowLength: normalizedInput.contextWindow.length,
    hasOpenAIFile: Boolean(normalizedInput.openaiFileId)
  })

  return {
    providerUsed,
    response: normalizeLLMResponse(normalizedTask, rawResponse, {
      maxQuoteChars: settings?.maxQuoteChars,
      maxCitations: settings?.maxCitations
    }),
    warnings
  }
}
