const HIGHLIGHT_CLASS = "clarify-highlight";
const OVERLAY_CLASS = "clarify-highlight-overlay";
const OVERLAY_APPROX_CLASS = "clarify-highlight-overlay-approx";
const AUTO_CLEAR_MS = 2000;
const FALLBACK_OVERLAY_MS = 700;

let activeMarks = [];
let activeOverlays = [];
let clearTimer = null;

function sanitizeNeedle(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
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
  if (collapsedCaseInsensitiveIndex < 0) {
    return null;
  }

  const start = map[Math.min(collapsedCaseInsensitiveIndex, map.length - 1)] ?? 0;
  const endMapIndex = Math.min(
    collapsedCaseInsensitiveIndex + Math.max(collapsedNeedle.length - 1, 0),
    map.length - 1
  );
  const end = (map[endMapIndex] ?? start) + 1;
  return { start, end };
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
  for (const span of spans) {
    const spanText = sanitizeNeedle(span.textContent || "").toLowerCase();
    if (!spanText) {
      continue;
    }
    if (tokens.some((token) => spanText.includes(token))) {
      matchedSpans.push(span);
      if (matchedSpans.length >= 4) {
        break;
      }
    }
  }

  if (!matchedSpans.length) {
    return null;
  }

  const layerRect = textLayer.getBoundingClientRect();
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const span of matchedSpans) {
    const rect = span.getBoundingClientRect();
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

  const needle = sanitizeNeedle(needleText);
  if (!needle) {
    createOverlay(textLayer, null, FALLBACK_OVERLAY_MS, true);
    startAutoClear(pdfRoot);
    return { success: false, matchesCount: 0 };
  }

  const { text, positions } = collectTextMap(textLayer);
  const match = findMatchRange(text, needle, Boolean(preferExact));

  if (match) {
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

  const approxRect = buildApproxOverlayRect(textLayer, needle);
  createOverlay(textLayer, approxRect, FALLBACK_OVERLAY_MS, true);
  startAutoClear(pdfRoot);
  return { success: false, matchesCount: 0 };
}
