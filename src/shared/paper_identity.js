function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function stripArxivVersion(value) {
  return normalizeText(value).replace(/v\d+$/i, "");
}

export function normalizeDoi(value) {
  const text = normalizeText(value).replace(/^doi:\s*/i, "");
  if (!text) {
    return "";
  }
  const match = text.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  return match?.[0] ? match[0].toLowerCase() : "";
}

export function normalizeArxivId(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const urlMatch = text.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i);
  if (urlMatch?.[1]) {
    return stripArxivVersion(urlMatch[1].replace(/\.pdf$/i, ""));
  }
  const direct = text.match(/^(\d{4}\.\d{4,5}(?:v\d+)?)$/i);
  if (direct?.[1]) {
    return stripArxivVersion(direct[1]);
  }
  const legacy = text.match(/^([a-z\-]+\/\d{7}(?:v\d+)?)$/i);
  if (legacy?.[1]) {
    return stripArxivVersion(legacy[1]);
  }
  return "";
}

export function normalizePaperUrl(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "file:" && protocol !== "blob:") {
      return "";
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

export function buildTitleFingerprint(title) {
  const normalized = normalizeText(title).toLowerCase();
  if (!normalized) {
    return "";
  }
  const tokenized = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokenized.length === 0) {
    return "";
  }
  return tokenized.slice(0, 20).join("-");
}

export function buildCanonicalPaperKey(entity = {}) {
  const doi = normalizeDoi(entity?.doi);
  if (doi) {
    return `doi:${doi}`;
  }
  const arxivId = normalizeArxivId(entity?.arxivId || entity?.url || entity?.docId);
  if (arxivId) {
    return `arxiv:${arxivId.toLowerCase()}`;
  }
  const url = normalizePaperUrl(entity?.url || entity?.docId || entity?.sourceRef?.url);
  if (url) {
    return `url:${url.toLowerCase()}`;
  }
  const fingerprint = buildTitleFingerprint(entity?.title);
  if (fingerprint) {
    return `title:${fingerprint}`;
  }
  return "";
}

