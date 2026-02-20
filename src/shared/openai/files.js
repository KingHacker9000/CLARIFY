const FILES_API_URL = "https://api.openai.com/v1/files"
const FILE_UPLOAD_PURPOSE = "user_data"
const FILE_UPLOAD_PURPOSE_FALLBACK = "assistants"

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function sanitizeFilename(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    return "document.pdf"
  }
  return normalized
}

function readApiErrorMessage(payload) {
  const message = payload?.error?.message
  return typeof message === "string" && message.trim() ? message.trim() : ""
}

function isPurposeError(message) {
  const text = normalizeText(message).toLowerCase()
  return text.includes("purpose") && (text.includes("invalid") || text.includes("unsupported"))
}

async function uploadWithPurpose({ apiKey, filename, bytes, purpose }) {
  const body = new FormData()
  const safeFilename = sanitizeFilename(filename)
  const pdfBlob = new Blob([bytes], { type: "application/pdf" })
  body.append("purpose", purpose)
  body.append("file", pdfBlob, safeFilename)

  const response = await fetch(FILES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body
  })

  let payload = null
  try {
    payload = await response.json()
  } catch (_error) {
    throw new Error("OpenAI Files API response could not be parsed.")
  }

  if (!response.ok) {
    const apiMessage = readApiErrorMessage(payload)
    const reason = apiMessage ? `: ${apiMessage}` : ""
    throw new Error(`OpenAI Files upload failed (${response.status})${reason}`)
  }

  const fileId = normalizeText(payload?.id)
  if (!fileId) {
    throw new Error("OpenAI Files upload did not return a file id.")
  }

  return { fileId }
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
      purpose: FILE_UPLOAD_PURPOSE
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
      purpose: FILE_UPLOAD_PURPOSE_FALLBACK
    })
  }
}

// Backward-compatible alias.
export const uploadPdfFile = uploadPdfToOpenAI
