const HIGHLIGHT_CLASS = "clarify-highlight";
const OVERLAY_CLASS = "clarify-highlight-overlay";
const OVERLAY_APPROX_CLASS = "clarify-highlight-overlay-approx";
const AUTO_CLEAR_MS = 2000;
const FALLBACK_OVERLAY_MS = 700;

let activeMarks = [];
let activeOverlays = [];
let clearTimer = null;

function sanitizeNeedle(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateNeedle(value, maxLength = 260) {
  const normalized = sanitizeNeedle(value);
  if (!normalized) {
    return "";
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength).trim();
}

function addNeedleCandidate(candidates, dedupeSet, value) {
  const normalized = truncateNeedle(value);
  if (!normalized) {
    return;
  }

  const queue = [normalized];
  const withoutPrefix = normalized.replace(/^(citation|quote)\s*\d*\s*:\s*/i, "");
  if (withoutPrefix !== normalized) {
    queue.push(withoutPrefix);
  }

  const fragments = normalized
    .split(/\.\.\.+/)
    .map((part) => sanitizeNeedle(part))
    .filter((part) => part.length >= 14)
    .sort((a, b) => b.length - a.length);
  queue.push(...fragments.slice(0, 3));

  for (const candidate of queue) {
    const trimmed = truncateNeedle(candidate);
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (!dedupeSet.has(key)) {
      dedupeSet.add(key);
      candidates.push(trimmed);
    }

    if (trimmed.length > 180) {
      const slices = [trimmed.slice(0, 180).trim(), trimmed.slice(-180).trim()];
      for (const sliceCandidate of slices) {
        const sliceKey = sliceCandidate.toLowerCase();
        if (sliceCandidate && !dedupeSet.has(sliceKey)) {
          dedupeSet.add(sliceKey);
          candidates.push(sliceCandidate);
        }
      }
    }
  }
}

function buildNeedleCandidates(needleText) {
  const candidates = [];
  const dedupeSet = new Set();
  addNeedleCandidate(candidates, dedupeSet, needleText);
  return candidates;
}

function removeOverlay(overlay) {
  if (!(overlay instanceof HTMLElement)) {
    return;
  }
  overlay.remove();
  activeOverlays = activeOverlays.filter((item) => item !== overlay);
}

function unwrapMark(mark) {
  if (!(mark instanceof HTMLElement) || !mark.parentNode) {
    return;
  }

  const parent = mark.parentNode;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  if (parent instanceof HTMLElement) {
    parent.normalize();
  }
}

function startAutoClear(pdfRoot) {
  if (clearTimer) {
    clearTimeout(clearTimer);
  }
  clearTimer = setTimeout(() => {
    clearTimer = null;
    clearHighlights(pdfRoot);
  }, AUTO_CLEAR_MS);
}

function collapseTextWithMap(text) {
  let collapsed = "";
  const map = [];
  let lastWasWhitespace = true;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (!lastWasWhitespace) {
        collapsed += " ";
        map.push(index);
        lastWasWhitespace = true;
      }
      continue;
    }

    collapsed += char;
    map.push(index);
    lastWasWhitespace = false;
  }

  if (collapsed.endsWith(" ")) {
    collapsed = collapsed.slice(0, -1);
    map.pop();
  }

  return { collapsed, map };
}

function isAlphaNumeric(char) {
  return /^[a-z0-9]$/i.test(char);
}

function collapseSearchTextWithMap(text) {
  let collapsed = "";
  const map = [];
  let lastWasWhitespace = true;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const lower = char.toLowerCase();

    if (isAlphaNumeric(lower)) {
      collapsed += lower;
      map.push(index);
      lastWasWhitespace = false;
      continue;
    }

    if (
      char === "-" &&
      index > 0 &&
      index + 1 < text.length &&
      isAlphaNumeric(text[index - 1]) &&
      isAlphaNumeric(text[index + 1])
    ) {
      continue;
    }

    if (/\s/.test(char) || /[^\w\s]/.test(char)) {
      if (!lastWasWhitespace) {
        collapsed += " ";
        map.push(index);
        lastWasWhitespace = true;
      }
      continue;
    }
  }

  if (collapsed.endsWith(" ")) {
    collapsed = collapsed.slice(0, -1);
    map.pop();
  }

  return { collapsed, map };
}

function mapCollapsedRangeToOriginal(map, start, end) {
  if (!Array.isArray(map) || map.length === 0) {
    return null;
  }
  const clampedStart = Math.min(Math.max(start, 0), map.length - 1);
  const clampedEnd = Math.min(Math.max(end - 1, clampedStart), map.length - 1);
  const originalStart = map[clampedStart] ?? 0;
  const originalEnd = (map[clampedEnd] ?? originalStart) + 1;
  return { start: originalStart, end: originalEnd };
}

function findTokenWindowRange(haystack, needle) {
  const normalizedHaystack = typeof haystack === "string" ? haystack : "";
  const normalizedNeedle = typeof needle === "string" ? needle : "";
  if (!normalizedHaystack || !normalizedNeedle) {
    return null;
  }

  const tokens = Array.from(
    new Set(normalizedNeedle.split(" ").map((token) => token.trim()).filter((token) => token.length >= 3))
  );
  if (tokens.length < 2) {
    return null;
  }

  const anchorToken = [...tokens].sort((a, b) => b.length - a.length)[0];
  if (!anchorToken) {
    return null;
  }

  const threshold = Math.max(2, Math.ceil(tokens.length * 0.5));
  const targetLength = Math.max(normalizedNeedle.length, 40);
  let best = null;
  let cursor = 0;
  let occurrenceCount = 0;

  while (occurrenceCount < 80) {
    const hitIndex = normalizedHaystack.indexOf(anchorToken, cursor);
    if (hitIndex < 0) {
      break;
    }
    occurrenceCount += 1;
    cursor = hitIndex + Math.max(anchorToken.length, 1);

    const windowStart = Math.max(0, hitIndex - Math.floor(targetLength * 0.3));
    const windowEnd = Math.min(normalizedHaystack.length, hitIndex + targetLength + Math.floor(targetLength * 0.35));
    const segment = normalizedHaystack.slice(windowStart, windowEnd);
    if (!segment) {
      continue;
    }

    const matchedTokenIndices = [];
    for (const token of tokens) {
      const localIndex = segment.indexOf(token);
      if (localIndex >= 0) {
        matchedTokenIndices.push({ token, localIndex });
      }
    }

    if (matchedTokenIndices.length < threshold) {
      continue;
    }

    const localStart = Math.min(...matchedTokenIndices.map((item) => item.localIndex));
    const localEnd = Math.max(...matchedTokenIndices.map((item) => item.localIndex + item.token.length));
    const candidateStart = windowStart + localStart;
    const candidateEnd = Math.max(windowStart + localEnd, candidateStart + 1);
    const candidateLength = candidateEnd - candidateStart;
    const distanceFromTarget = Math.abs(candidateLength - targetLength);
    const score = matchedTokenIndices.length;

    if (
      !best ||
      score > best.score ||
      (score === best.score && distanceFromTarget < best.distanceFromTarget)
    ) {
      best = {
        score,
        distanceFromTarget,
        start: candidateStart,
        end: candidateEnd
      };
    }
  }

  if (!best) {
    return null;
  }
  return { start: best.start, end: best.end };
}

function findMatchIndex(haystack, needle, caseInsensitive) {
  if (!haystack || !needle) {
    return -1;
  }
  if (caseInsensitive) {
    return haystack.toLowerCase().indexOf(needle.toLowerCase());
  }
  return haystack.indexOf(needle);
}

function collectTextMap(textLayer) {
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const positions = [];
  let text = "";

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node?.textContent ?? "";
    if (!value.trim()) {
      continue;
    }

    text += value;
    for (let offset = 0; offset < value.length; offset += 1) {
      positions.push({ node, offset });
    }
  }

  return { text, positions };
}

function findMatchRange(text, needle, preferExact) {
  const normalizedNeedle = sanitizeNeedle(needle);
  if (!text || !normalizedNeedle) {
    return null;
  }

  const directMatchIndex = findMatchIndex(text, normalizedNeedle, false);
  if (directMatchIndex >= 0 && preferExact) {
    return { start: directMatchIndex, end: directMatchIndex + normalizedNeedle.length };
  }

  const directCaseInsensitiveIndex = findMatchIndex(text, normalizedNeedle, true);
  if (directCaseInsensitiveIndex >= 0) {
    return {
      start: directCaseInsensitiveIndex,
      end: directCaseInsensitiveIndex + normalizedNeedle.length
    };
  }

  const { collapsed, map } = collapseTextWithMap(text);
  if (!collapsed || !map.length) {
    return null;
  }

  const collapsedNeedle = normalizedNeedle.replace(/\s+/g, " ").trim();
  if (!collapsedNeedle) {
    return null;
  }

  const collapsedCaseSensitiveIndex = findMatchIndex(collapsed, collapsedNeedle, false);
  if (collapsedCaseSensitiveIndex >= 0 && preferExact) {
    const start = map[Math.min(collapsedCaseSensitiveIndex, map.length - 1)] ?? 0;
    const endMapIndex = Math.min(
      collapsedCaseSensitiveIndex + Math.max(collapsedNeedle.length - 1, 0),
      map.length - 1
    );
    const end = (map[endMapIndex] ?? start) + 1;
    return { start, end };
  }

  const collapsedCaseInsensitiveIndex = findMatchIndex(collapsed, collapsedNeedle, true);
  if (collapsedCaseInsensitiveIndex >= 0) {
    const start = map[Math.min(collapsedCaseInsensitiveIndex, map.length - 1)] ?? 0;
    const endMapIndex = Math.min(
      collapsedCaseInsensitiveIndex + Math.max(collapsedNeedle.length - 1, 0),
      map.length - 1
    );
    const end = (map[endMapIndex] ?? start) + 1;
    return { start, end };
  }

  const normalizedHaystack = collapseSearchTextWithMap(text);
  const normalizedNeedleMap = collapseSearchTextWithMap(normalizedNeedle);
  if (!normalizedHaystack.collapsed || !normalizedHaystack.map.length || !normalizedNeedleMap.collapsed) {
    return null;
  }

  const normalizedIndex = normalizedHaystack.collapsed.indexOf(normalizedNeedleMap.collapsed);
  if (normalizedIndex >= 0) {
    return mapCollapsedRangeToOriginal(
      normalizedHaystack.map,
      normalizedIndex,
      normalizedIndex + normalizedNeedleMap.collapsed.length
    );
  }

  if (preferExact) {
    return null;
  }

  const tokenWindowMatch = findTokenWindowRange(normalizedHaystack.collapsed, normalizedNeedleMap.collapsed);
  if (!tokenWindowMatch) {
    return null;
  }

  return mapCollapsedRangeToOriginal(
    normalizedHaystack.map,
    tokenWindowMatch.start,
    tokenWindowMatch.end
  );
}

function buildRangesForMatch(positions, start, end) {
  if (!Array.isArray(positions) || !positions.length || start < 0 || end <= start) {
    return [];
  }

  const clampedEnd = Math.min(end, positions.length);
  const ranges = [];
  let cursor = start;

  while (cursor < clampedEnd) {
    const point = positions[cursor];
    if (!point?.node) {
      break;
    }

    const node = point.node;
    const startOffset = point.offset;
    let endOffset = startOffset + 1;
    cursor += 1;

    while (cursor < clampedEnd) {
      const nextPoint = positions[cursor];
      if (!nextPoint || nextPoint.node !== node || nextPoint.offset !== endOffset) {
        break;
      }
      endOffset += 1;
      cursor += 1;
    }

    ranges.push({ node, startOffset, endOffset });
  }

  return ranges;
}

function wrapRange({ node, startOffset, endOffset }) {
  if (!node || startOffset < 0 || endOffset <= startOffset) {
    return null;
  }

  try {
    const range = document.createRange();
    range.setStart(node, startOffset);
    range.setEnd(node, endOffset);
    const mark = document.createElement("mark");
    mark.className = HIGHLIGHT_CLASS;
    range.surroundContents(mark);
    range.detach?.();
    return mark;
  } catch (_error) {
    return null;
  }
}

function createOverlay(textLayer, rect, durationMs = AUTO_CLEAR_MS, approx = false) {
  if (!(textLayer instanceof HTMLElement)) {
    return null;
  }

  const bounds = {
    left: Math.max(rect?.left ?? 0, 0),
    top: Math.max(rect?.top ?? 0, 0),
    width: Math.max(rect?.width ?? textLayer.clientWidth, 1),
    height: Math.max(rect?.height ?? textLayer.clientHeight, 1)
  };

  const overlay = document.createElement("div");
  overlay.className = approx ? `${OVERLAY_CLASS} ${OVERLAY_APPROX_CLASS}` : OVERLAY_CLASS;
  overlay.style.left = `${Math.round(bounds.left)}px`;
  overlay.style.top = `${Math.round(bounds.top)}px`;
  overlay.style.width = `${Math.round(bounds.width)}px`;
  overlay.style.height = `${Math.round(bounds.height)}px`;
  textLayer.append(overlay);
  activeOverlays.push(overlay);

  if (durationMs > 0) {
    setTimeout(() => {
      removeOverlay(overlay);
    }, durationMs);
  }

  return overlay;
}

function buildApproxOverlayRect(textLayer, needleText) {
  const spans = Array.from(textLayer.querySelectorAll("span"));
  if (!spans.length) {
    return null;
  }

  const normalizedNeedle = sanitizeNeedle(needleText).toLowerCase();
  if (!normalizedNeedle) {
    return null;
  }

  const tokens = normalizedNeedle.split(" ").filter((token) => token.length >= 3).slice(0, 6);
  if (!tokens.length) {
    return null;
  }

  const matchedSpans = [];
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    const spanText = sanitizeNeedle(span.textContent || "").toLowerCase();
    if (!spanText) {
      continue;
    }
    const tokenHits = tokens.filter((token) => spanText.includes(token));
    if (tokenHits.length > 0) {
      matchedSpans.push({ span, index, tokenHits: tokenHits.length });
    }
  }

  if (!matchedSpans.length) {
    return null;
  }

  let bestCluster = null;
  for (let start = 0; start < matchedSpans.length; start += 1) {
    const cluster = [matchedSpans[start]];
    let score = matchedSpans[start].tokenHits;
    let end = start + 1;

    while (end < matchedSpans.length) {
      const previous = matchedSpans[end - 1];
      const current = matchedSpans[end];
      if (current.index - previous.index > 2 || cluster.length >= 10) {
        break;
      }
      cluster.push(current);
      score += current.tokenHits;
      end += 1;
    }

    const spanCount = cluster.length;
    const widthPenalty = spanCount > 1 ? (spanCount - 1) * 0.08 : 0;
    const clusterScore = score - widthPenalty;
    if (!bestCluster || clusterScore > bestCluster.score) {
      bestCluster = { score: clusterScore, cluster };
    }
  }

  const targetCluster = bestCluster?.cluster ?? [];
  if (!targetCluster.length) {
    return null;
  }

  const layerRect = textLayer.getBoundingClientRect();
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const item of targetCluster) {
    const rect = item.span.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }

  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null;
  }

  return {
    left: left - layerRect.left,
    top: top - layerRect.top,
    width: Math.max(right - left, 1),
    height: Math.max(bottom - top, 1)
  };
}

export function clearHighlights(_pdfRoot) {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  for (const mark of activeMarks) {
    unwrapMark(mark);
  }
  activeMarks = [];

  for (const overlay of activeOverlays) {
    removeOverlay(overlay);
  }
  activeOverlays = [];
}

export function highlightOnPage({ pdfRoot, pageIndex, needleText, preferExact = true }) {
  clearHighlights(pdfRoot);

  if (!(pdfRoot instanceof HTMLElement)) {
    return { success: false, matchesCount: 0 };
  }

  const normalizedPageIndex = Number.isFinite(pageIndex) ? Math.max(0, Number(pageIndex)) : null;
  if (normalizedPageIndex == null) {
    return { success: false, matchesCount: 0 };
  }

  const pageNode = pdfRoot.querySelector(`.pdfPageShell[data-page-index="${normalizedPageIndex}"]`);
  if (!(pageNode instanceof HTMLElement)) {
    return { success: false, matchesCount: 0 };
  }

  const textLayer = pageNode.querySelector(".textLayer");
  if (!(textLayer instanceof HTMLElement)) {
    return { success: false, matchesCount: 0 };
  }

  const needleCandidates = buildNeedleCandidates(needleText);
  if (needleCandidates.length === 0) {
    createOverlay(textLayer, null, FALLBACK_OVERLAY_MS, true);
    startAutoClear(pdfRoot);
    return { success: false, matchesCount: 0 };
  }

  const { text, positions } = collectTextMap(textLayer);
  for (const needle of needleCandidates) {
    const match = findMatchRange(text, needle, Boolean(preferExact));
    if (!match) {
      continue;
    }

    const ranges = buildRangesForMatch(positions, match.start, match.end);
    const marks = [];
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const mark = wrapRange(ranges[index]);
      if (mark) {
        mark.classList.add("clarify-highlight-pulse");
        marks.push(mark);
      }
    }

    if (marks.length > 0) {
      activeMarks = marks;
      startAutoClear(pdfRoot);
      return { success: true, matchesCount: 1 };
    }
  }

  const approxRect = buildApproxOverlayRect(textLayer, needleCandidates[0]);
  createOverlay(textLayer, approxRect, FALLBACK_OVERLAY_MS, true);
  startAutoClear(pdfRoot);
  return { success: false, matchesCount: 0 };
}
