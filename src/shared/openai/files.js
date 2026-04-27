const FILES_API_URL = "https://api.openai.com/v1/files"
const FILE_UPLOAD_PURPOSE = "user_data"
const FILE_UPLOAD_PURPOSE_FALLBACK = "assistants"
const FILE_UPLOAD_TIMEOUT_MS = 24000
const FILE_UPLOAD_MAX_ATTEMPTS = 3
const RETRY_DELAY_BASE_MS = 500
const RETRY_DELAY_CAP_MS = 2600

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function sanitizeFilename(value, options = {}) {
  const source = options && typeof options === "object" ? options : {}
  const fallbackName = normalizeText(source.fallbackName) || "document.pdf"
  const ensurePdf = source.ensurePdf === true
  const normalized = normalizeText(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .slice(0, 120)
  const safeName = normalized || fallbackName
  if (ensurePdf) {
    return safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`
  }
  return safeName
}

function readApiErrorMessage(payload) {
  const error = payload?.error && typeof payload.error === "object" ? payload.error : {}
  const message = typeof error.message === "string" && error.message.trim()
    ? error.message
        .trim()
        .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    : ""
  const code = normalizeText(error.code).slice(0, 80)
  const type = normalizeText(error.type).slice(0, 80)
  const metadata = [code ? `code=${code}` : "", type ? `type=${type}` : ""].filter(Boolean).join(", ")
  if (message && metadata) {
    return `${metadata}; ${message}`
  }
  return message || metadata
}

function buildUploadError(status, payload) {
  const apiMessage = readApiErrorMessage(payload)
  if (status === 401) {
    const reason = apiMessage ? ` ${apiMessage}` : ""
    const error = new Error(`OpenAI authentication failed (401). Save a valid OpenAI API key in settings.${reason}`)
    error.status = status
    return error
  }
  if (status === 403) {
    const reason = apiMessage ? ` ${apiMessage}` : ""
    const error = new Error(`OpenAI Files upload was forbidden (403). Check API key permissions and project access.${reason}`)
    error.status = status
    return error
  }
  const reason = apiMessage ? `: ${apiMessage}` : ""
  const error = new Error(`OpenAI Files upload failed (${status})${reason}`)
  error.status = status
  return error
}

function isPurposeError(message) {
  const text = normalizeText(message).toLowerCase()
  return text.includes("purpose") && (text.includes("invalid") || text.includes("unsupported"))
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

function extractErrorStatus(error) {
  const status = Number(error?.status)
  if (Number.isFinite(status) && status >= 100) {
    return status
  }
  const message = normalizeText(error?.message)
  const match = message.match(/\((\d{3})\)/)
  if (!match?.[1]) {
    return null
  }
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function shouldRetryUploadError(error) {
  const status = extractErrorStatus(error)
  if (Number.isFinite(status)) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
  }
  const message = normalizeText(error?.message).toLowerCase()
  if (!message) {
    return false
  }
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("failed to fetch") ||
    message.includes("network error") ||
    message.includes("response could not be parsed")
  )
}

async function uploadWithPurposeOnce({ apiKey, filename, bytes, purpose, mimeType, ensurePdfFilename = false }) {
  const body = new FormData()
  const safeFilename = sanitizeFilename(filename, {
    fallbackName: ensurePdfFilename ? "document.pdf" : "document",
    ensurePdf: ensurePdfFilename
  })
  const normalizedMimeType = normalizeText(mimeType) || "application/octet-stream"
  const blob = new Blob([bytes], { type: normalizedMimeType })
  body.append("purpose", purpose)
  body.append("file", blob, safeFilename)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, FILE_UPLOAD_TIMEOUT_MS)

  try {
    const response = await fetch(FILES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body,
      signal: controller.signal
    })

    let payload = null
    let rawBodyText = ""
    try {
      rawBodyText = await response.text()
    } catch (_error) {
      rawBodyText = ""
    }
    if (rawBodyText) {
      try {
        payload = JSON.parse(rawBodyText)
      } catch (_error) {
        payload = null
      }
    }

    if (!response.ok) {
      throw buildUploadError(response.status, payload)
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const parseError = new Error("OpenAI Files API response could not be parsed.")
      parseError.status = response.status
      throw parseError
    }

    const fileId = normalizeText(payload?.id)
    if (!fileId) {
      throw new Error("OpenAI Files upload did not return a file id.")
    }

    return { fileId }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`OpenAI Files upload timed out after ${FILE_UPLOAD_TIMEOUT_MS}ms.`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

async function uploadWithPurpose(params) {
  let attempt = 0
  while (attempt < FILE_UPLOAD_MAX_ATTEMPTS) {
    attempt += 1
    try {
      return await uploadWithPurposeOnce(params)
    } catch (error) {
      if (!shouldRetryUploadError(error) || attempt >= FILE_UPLOAD_MAX_ATTEMPTS) {
        throw error
      }
      await wait(retryDelayMsForAttempt(attempt))
    }
  }
  throw new Error("OpenAI Files upload failed after retries.")
}

export async function uploadPdfToOpenAI({ apiKey, filename, bytes }) {
  const normalizedKey = normalizeText(apiKey)
  if (!normalizedKey) {
    throw new Error("Missing OpenAI API key.")
  }

  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("Missing PDF bytes for upload.")
  }

  try {
    return await uploadWithPurpose({
      apiKey: normalizedKey,
      filename,
      bytes,
      purpose: FILE_UPLOAD_PURPOSE,
      mimeType: "application/pdf",
      ensurePdfFilename: true
    })
  } catch (error) {
    const message = normalizeText(error?.message)
    if (!isPurposeError(message)) {
      throw error
    }
    return uploadWithPurpose({
      apiKey: normalizedKey,
      filename,
      bytes,
      purpose: FILE_UPLOAD_PURPOSE_FALLBACK,
      mimeType: "application/pdf",
      ensurePdfFilename: true
    })
  }
}

export async function uploadFileToOpenAI({ apiKey, filename, bytes, mimeType }) {
  const normalizedKey = normalizeText(apiKey)
  if (!normalizedKey) {
    throw new Error("Missing OpenAI API key.")
  }
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error("Missing file bytes for upload.")
  }

  try {
    return await uploadWithPurpose({
      apiKey: normalizedKey,
      filename,
      bytes,
      purpose: FILE_UPLOAD_PURPOSE,
      mimeType,
      ensurePdfFilename: false
    })
  } catch (error) {
    const message = normalizeText(error?.message)
    if (!isPurposeError(message)) {
      throw error
    }
    return uploadWithPurpose({
      apiKey: normalizedKey,
      filename,
      bytes,
      purpose: FILE_UPLOAD_PURPOSE_FALLBACK,
      mimeType,
      ensurePdfFilename: false
    })
  }
}

// Backward-compatible alias.
export const uploadPdfFile = uploadPdfToOpenAI
