export const REMOTE_BYTES_BLOCKED = "REMOTE_BYTES_BLOCKED"

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname || ""
    const segment = pathname.split("/").filter(Boolean).pop() || ""
    if (segment.toLowerCase().endsWith(".pdf")) {
      return segment
    }
  } catch (_error) {
    // Ignore and fall back.
  }
  return "document.pdf"
}

function ensurePdfFilename(filename, fallbackUrl = "") {
  const normalized = normalizeText(filename)
  if (normalized && normalized.toLowerCase().endsWith(".pdf")) {
    return normalized
  }
  if (normalized) {
    return `${normalized}.pdf`
  }
  return filenameFromUrl(fallbackUrl)
}

function makeRemoteBlockedError() {
  const error = new Error(REMOTE_BYTES_BLOCKED)
  error.code = REMOTE_BYTES_BLOCKED
  return error
}

function looksLikePdfBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) {
    return false
  }
  // PDF files start with "%PDF-".
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  )
}

export async function getPdfBytes(currentPdf) {
  const source = currentPdf && typeof currentPdf === "object" ? currentPdf : {}
  const sourceType = source.sourceType

  if (sourceType === "local") {
    const localFile = source.localFile
    if (localFile instanceof File) {
      const arrayBuffer = await localFile.arrayBuffer()
      return {
        bytes: new Uint8Array(arrayBuffer),
        filename: ensurePdfFilename(localFile.name)
      }
    }
    throw new Error("Local PDF file bytes are unavailable in this session.")
  }

  if (sourceType === "remote") {
    const srcUrl = normalizeText(source.url)
    if (!srcUrl) {
      throw new Error("Remote PDF URL is missing.")
    }

    let response
    try {
      response = await fetch(srcUrl, {
        method: "GET",
        mode: "cors",
        credentials: "include"
      })
    } catch (_error) {
      throw makeRemoteBlockedError()
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw makeRemoteBlockedError()
      }
      throw new Error(`Failed to download remote PDF bytes (${response.status}).`)
    }

    const arrayBuffer = await response.arrayBuffer()
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error("Remote PDF returned empty bytes.")
    }
    const bytes = new Uint8Array(arrayBuffer)
    if (!looksLikePdfBytes(bytes)) {
      throw makeRemoteBlockedError()
    }

    return {
      bytes,
      filename: ensurePdfFilename(source.filename, srcUrl)
    }
  }

  throw new Error("No PDF is currently loaded.")
}
