import { getIntent, setIntent } from "../shared/storage.js"
import { generateLLM } from "../shared/llm/index.js"
import { getPageText } from "./page_text.js"

const SNIPPET_MAX_CHARS = 1000
const INTENT_MAX_WORDS = 25
const INTENT_MAX_CHARS = 220
const REQUEST_DEBOUNCE_MS = 200

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
  return text.slice(0, maxLength).trim()
}

function clampIntent(text) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return ""
  }
  const words = normalized.split(" ")
  if (words.length <= INTENT_MAX_WORDS) {
    return clampText(normalized, INTENT_MAX_CHARS)
  }
  return clampText(words.slice(0, INTENT_MAX_WORDS).join(" "), INTENT_MAX_CHARS)
}

function toPageIndex(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0
  }
  return Math.floor(numeric)
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0))
  })
}

export function createIntentManager({ docId, pdfDoc, logger }) {
  const inFlight = new Map()
  let lastRequestAtMs = 0

  async function generateAndStore(node) {
    const sectionKey = normalizeText(node?.key)
    if (!sectionKey) {
      return ""
    }

    const now = Date.now()
    const elapsed = now - lastRequestAtMs
    if (elapsed >= 0 && elapsed < REQUEST_DEBOUNCE_MS) {
      await wait(REQUEST_DEBOUNCE_MS - elapsed)
    }
    lastRequestAtMs = Date.now()

    const pageIndex = toPageIndex(node?.pageIndex)
    const pageText = await getPageText(pdfDoc, pageIndex)
    const snippet = clampText(pageText, SNIPPET_MAX_CHARS)
    logger?.info?.("Section intent request", {
      docId: normalizeText(docId),
      sectionKey,
      pageIndex,
      snippetLength: snippet.length
    })

    const { response } = await generateLLM("section_intent", {
      title: clampText(node?.title, 160),
      snippet,
      pageIndex
    })

    const intent = clampIntent(response?.intent)
    if (!intent) {
      return ""
    }

    if (docId && docId !== "unknown") {
      await setIntent(docId, sectionKey, intent)
    }
    return intent
  }

  async function getOrGenerateIntent(node) {
    const sectionKey = normalizeText(node?.key)
    if (!sectionKey) {
      return ""
    }

    if (docId && docId !== "unknown") {
      const cached = clampIntent(await getIntent(docId, sectionKey))
      if (cached) {
        return cached
      }
    }

    const pending = inFlight.get(sectionKey)
    if (pending) {
      return pending
    }

    const promise = generateAndStore(node)
      .catch((error) => {
        logger?.warn?.("Section intent generation failed", {
          docId: normalizeText(docId),
          sectionKey,
          message: normalizeText(error?.message || "Unknown error")
        })
        return ""
      })
      .finally(() => {
        inFlight.delete(sectionKey)
      })
    inFlight.set(sectionKey, promise)
    return promise
  }

  async function prewarmTopLevelIntents(nodes, options = {}) {
    const source = Array.isArray(nodes) ? nodes : []
    let remaining = Number.isFinite(Number(options?.limit))
      ? Math.max(1, Math.floor(Number(options.limit)))
      : source.length
    for (const node of source) {
      if (remaining <= 0) {
        break
      }
      if (!node || Number(node?.level) !== 1) {
        continue
      }
      await getOrGenerateIntent(node)
      remaining -= 1
    }
  }

  return {
    getOrGenerateIntent,
    prewarmTopLevelIntents
  }
}
