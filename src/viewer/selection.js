import { createLogger } from "../shared/diagnostics.js";

const logger = createLogger("SELECTION");

const MAX_SELECTION_LENGTH = 500;
const CONTEXT_RADIUS = 400;
const CAPTURE_DEBOUNCE_MS = 50;
const POPOVER_OFFSET = 8;
const POPOVER_MARGIN = 8;

const HIGHLIGHT_ICON_LIGHT_THEME_URL = new URL("../../assets/icons/highlighter.png", import.meta.url).toString();
const HIGHLIGHT_ICON_DARK_THEME_URL = new URL(
  "../../assets/icons/highlighter-dark.png",
  import.meta.url
).toString();

const ACTIONS = [
  { type: "highlight", label: "Highlight", iconName: "highlight" },
  { type: "define", label: "Define term", icon: "\uD83D\uDCD6" },
  { type: "explain", label: "Explain text", icon: "\uD83D\uDCA1" },
  { type: "translate", label: "Translate figure/table", icon: "\uD83D\uDCCA" }
];

function resolveActionIconUrl(action) {
  if (action?.iconName !== "highlight") {
    return null;
  }
  const isDarkMode = document.body?.dataset?.theme === "dark";
  return isDarkMode ? HIGHLIGHT_ICON_DARK_THEME_URL : HIGHLIGHT_ICON_LIGHT_THEME_URL;
}

function normalizeSelectionText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isNodeInside(root, node) {
  if (!root || !node) {
    return false;
  }
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return Boolean(element && root.contains(element));
}

function findClosestPageShell(node) {
  if (!node) {
    return null;
  }
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  return element?.closest?.(".pdfPageShell") ?? null;
}

function getSelectionRect(range) {
  if (!range) {
    return null;
  }

  let rect = range.getBoundingClientRect();
  if ((rect.width > 0 || rect.height > 0) && Number.isFinite(rect.top)) {
    return rect;
  }

  const clientRects = range.getClientRects();
  if (!clientRects.length) {
    return null;
  }

  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const clientRect of clientRects) {
    left = Math.min(left, clientRect.left);
    right = Math.max(right, clientRect.right);
    top = Math.min(top, clientRect.top);
    bottom = Math.max(bottom, clientRect.bottom);
  }
  return new DOMRect(left, top, Math.max(right - left, 0), Math.max(bottom - top, 0));
}

function findPageShellForRange(range, pdfRoot, rect) {
  const startPage = findClosestPageShell(range.startContainer);
  if (startPage) {
    return startPage;
  }

  const endPage = findClosestPageShell(range.endContainer);
  if (endPage) {
    return endPage;
  }

  const commonPage = findClosestPageShell(range.commonAncestorContainer);
  if (commonPage) {
    return commonPage;
  }

  if (!rect) {
    return null;
  }

  const probeX = Math.min(
    Math.max(rect.left + Math.min(rect.width, 4), 0),
    Math.max(window.innerWidth - 1, 0)
  );
  const probeY = Math.min(
    Math.max(rect.top + Math.min(rect.height, 4), 0),
    Math.max(window.innerHeight - 1, 0)
  );
  const elementAtPoint = document.elementFromPoint(probeX, probeY);
  if (!elementAtPoint || !pdfRoot.contains(elementAtPoint)) {
    return null;
  }
  return elementAtPoint.closest(".pdfPageShell");
}

function findTextLayerForRange(range, pageShell) {
  const startElement =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : range.startContainer;
  const endElement =
    range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.parentElement
      : range.endContainer;
  const commonElement =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;

  const fromStart = startElement?.closest?.(".textLayer");
  if (fromStart) {
    return fromStart;
  }

  const fromEnd = endElement?.closest?.(".textLayer");
  if (fromEnd) {
    return fromEnd;
  }

  const fromCommon = commonElement?.closest?.(".textLayer");
  if (fromCommon) {
    return fromCommon;
  }

  return pageShell?.querySelector?.(".textLayer") ?? null;
}

function getNormalizedSelectionRects(range, textLayer) {
  if (!range || !(textLayer instanceof HTMLElement)) {
    return [];
  }
  const layerRect = textLayer.getBoundingClientRect();
  if (!Number.isFinite(layerRect.width) || !Number.isFinite(layerRect.height) || layerRect.width <= 0 || layerRect.height <= 0) {
    return [];
  }

  const rects = [];
  const dedupe = new Set();
  for (const clientRect of Array.from(range.getClientRects())) {
    const left = Math.max(clientRect.left, layerRect.left);
    const top = Math.max(clientRect.top, layerRect.top);
    const right = Math.min(clientRect.right, layerRect.right);
    const bottom = Math.min(clientRect.bottom, layerRect.bottom);
    const width = right - left;
    const height = bottom - top;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      continue;
    }

    const normalized = {
      x: Math.min(1, Math.max(0, (left - layerRect.left) / layerRect.width)),
      y: Math.min(1, Math.max(0, (top - layerRect.top) / layerRect.height)),
      width: Math.min(1, Math.max(0, width / layerRect.width)),
      height: Math.min(1, Math.max(0, height / layerRect.height))
    };
    const key = [
      Math.round(normalized.x * 10000),
      Math.round(normalized.y * 10000),
      Math.round(normalized.width * 10000),
      Math.round(normalized.height * 10000)
    ].join(":");
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    rects.push(normalized);
  }
  return rects;
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

function extractContextWindow(textLayer, selectedText) {
  const layerText = textLayer?.innerText ?? "";
  if (!layerText || !selectedText) {
    return "";
  }

  let startIndex = layerText.indexOf(selectedText);
  let endIndex = startIndex >= 0 ? startIndex + selectedText.length : -1;

  if (startIndex < 0) {
    const lowerLayerText = layerText.toLowerCase();
    const lowerSelectedText = selectedText.toLowerCase();
    startIndex = lowerLayerText.indexOf(lowerSelectedText);
    endIndex = startIndex >= 0 ? startIndex + lowerSelectedText.length : -1;
  }

  if (startIndex < 0) {
    const { collapsed, map } = collapseTextWithMap(layerText);
    const collapsedSelectedText = normalizeSelectionText(selectedText).toLowerCase();
    const collapsedIndex = collapsed.toLowerCase().indexOf(collapsedSelectedText);
    if (collapsedIndex >= 0 && map.length > 0) {
      const mappedStart = map[Math.min(collapsedIndex, map.length - 1)] ?? 0;
      const mappedEndIndex = Math.min(
        collapsedIndex + Math.max(collapsedSelectedText.length - 1, 0),
        map.length - 1
      );
      const mappedEnd = (map[mappedEndIndex] ?? mappedStart) + 1;
      startIndex = mappedStart;
      endIndex = mappedEnd;
    }
  }

  if (startIndex < 0 || endIndex < 0) {
    const fallbackLength = Math.min(layerText.length, CONTEXT_RADIUS * 2);
    return layerText.slice(0, fallbackLength).trim();
  }

  const contextStart = Math.max(startIndex - CONTEXT_RADIUS, 0);
  const contextEnd = Math.min(endIndex + CONTEXT_RADIUS, layerText.length);
  return layerText.slice(contextStart, contextEnd).trim();
}

function resolveShortcutAction(event) {
  if (event.defaultPrevented || event.repeat || event.altKey) {
    return null;
  }
  if (!event.shiftKey || (!event.ctrlKey && !event.metaKey)) {
    return null;
  }

  const key = (event.key || "").toLowerCase();
  if (key === "d") {
    return "define";
  }
  if (key === "h") {
    return "highlight";
  }
  if (key === "e") {
    return "explain";
  }
  if (key === "t") {
    return "translate";
  }
  return null;
}

export function initSelectionSystem({ pdfRoot, onAction, isEnabled }) {
  if (!(pdfRoot instanceof HTMLElement)) {
    throw new Error("initSelectionSystem requires a valid pdfRoot element.");
  }
  const onActionHandler = typeof onAction === "function" ? onAction : () => {};
  const isEnabledHandler = typeof isEnabled === "function" ? isEnabled : () => true;

  let popoverEl = null;
  let activeSelection = null;
  let captureTimer = null;

  function removePopover() {
    if (!popoverEl) {
      return;
    }
    popoverEl.remove();
    popoverEl = null;
  }

  function clearSelectionState() {
    activeSelection = null;
    removePopover();
  }

  function positionPopover(rect) {
    if (!popoverEl || !rect) {
      return;
    }

    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const viewportRight = scrollX + window.innerWidth;
    const viewportBottom = scrollY + window.innerHeight;

    let left = rect.right + scrollX + POPOVER_OFFSET;
    let top = rect.top + scrollY - POPOVER_OFFSET;

    const width = popoverEl.offsetWidth;
    const height = popoverEl.offsetHeight;

    if (left + width > viewportRight - POPOVER_MARGIN) {
      left = rect.left + scrollX - width - POPOVER_OFFSET;
    }
    if (left < scrollX + POPOVER_MARGIN) {
      left = scrollX + POPOVER_MARGIN;
    }

    if (top < scrollY + POPOVER_MARGIN) {
      top = rect.bottom + scrollY + POPOVER_OFFSET;
    }
    if (top + height > viewportBottom - POPOVER_MARGIN) {
      top = viewportBottom - height - POPOVER_MARGIN;
    }
    if (top < scrollY + POPOVER_MARGIN) {
      top = scrollY + POPOVER_MARGIN;
    }

    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.top = `${Math.round(top)}px`;
  }

  function triggerAction(type) {
    if (!activeSelection) {
      return;
    }

    logger.info(`Action triggered: ${type}`);
    onActionHandler({
      type,
      selectedText: activeSelection.selectedText,
      pageIndex: activeSelection.pageIndex,
      contextWindow: activeSelection.contextWindow,
      highlightRects: activeSelection.highlightRects
    });
    clearSelectionState();
  }

  function showPopover(selectionData) {
    removePopover();
    activeSelection = selectionData;

    const popover = document.createElement("div");
    popover.className = "selectionPopover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Selection actions");

    for (const action of ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "selectionPopoverButton";
      button.dataset.action = action.type;
      const iconWrap = document.createElement("span");
      iconWrap.className = "selectionPopoverButtonIcon";
      const iconUrl = resolveActionIconUrl(action);
      if (iconUrl) {
        const icon = document.createElement("img");
        icon.className = "selectionPopoverIconImage";
        icon.src = iconUrl;
        icon.alt = "";
        iconWrap.append(icon);
      } else {
        iconWrap.textContent = action.icon;
      }
      const label = document.createElement("span");
      label.className = "selectionPopoverButtonLabel";
      label.textContent = action.label;
      button.append(iconWrap, label);
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        triggerAction(action.type);
      });
      popover.append(button);
    }

    popoverEl = popover;
    document.body.append(popoverEl);
    positionPopover(selectionData.boundingRect);
  }

  function captureSelectionData() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!isNodeInside(pdfRoot, range.startContainer) || !isNodeInside(pdfRoot, range.endContainer)) {
      return null;
    }

    const normalizedText = normalizeSelectionText(selection.toString());
    if (!normalizedText) {
      return null;
    }

    const selectedText = normalizedText.slice(0, MAX_SELECTION_LENGTH);
    const rect = getSelectionRect(range);
    if (!rect) {
      return null;
    }

    const pageShell = findPageShellForRange(range, pdfRoot, rect);
    const pageNumber = Number(pageShell?.dataset?.pageNumber);
    const pageIndex =
      Number.isFinite(pageNumber) && pageNumber > 0 ? Math.max(pageNumber - 1, 0) : null;
    const textLayer = findTextLayerForRange(range, pageShell);
    const contextWindow = extractContextWindow(textLayer, selectedText);

    return {
      selectedText,
      pageIndex,
      boundingRect: rect,
      contextWindow,
      highlightRects: getNormalizedSelectionRects(range, textLayer)
    };
  }

  function captureSelection() {
    if (!isEnabledHandler()) {
      clearSelectionState();
      return;
    }

    const selectionData = captureSelectionData();
    if (!selectionData) {
      clearSelectionState();
      return;
    }

    logger.info(`Selection captured (length ${selectionData.selectedText.length})`);
    showPopover(selectionData);
  }

  function scheduleCapture() {
    if (captureTimer) {
      clearTimeout(captureTimer);
    }
    captureTimer = setTimeout(() => {
      captureTimer = null;
      captureSelection();
    }, CAPTURE_DEBOUNCE_MS);
  }

  function handleMouseUp() {
    scheduleCapture();
  }

  function handleKeyUp() {
    scheduleCapture();
  }

  function handleKeyDown(event) {
    if (!isEnabledHandler()) {
      return;
    }

    if (event.key === "Escape") {
      clearSelectionState();
      return;
    }

    const action = resolveShortcutAction(event);
    if (!action) {
      return;
    }

    if (!activeSelection) {
      activeSelection = captureSelectionData();
    }
    if (!activeSelection) {
      return;
    }

    event.preventDefault();
    triggerAction(action);
  }

  function handleDocumentPointerDown(event) {
    if (!popoverEl) {
      return;
    }
    if (event.target instanceof Node && popoverEl.contains(event.target)) {
      return;
    }
    clearSelectionState();
  }

  function handleScrollOrResize() {
    if (!popoverEl || !activeSelection?.boundingRect) {
      return;
    }
    clearSelectionState();
  }

  document.addEventListener("mouseup", handleMouseUp);
  document.addEventListener("keyup", handleKeyUp);
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  pdfRoot.addEventListener("scroll", handleScrollOrResize, { passive: true });
  window.addEventListener("resize", handleScrollOrResize);

  return {
    destroy() {
      if (captureTimer) {
        clearTimeout(captureTimer);
        captureTimer = null;
      }
      clearSelectionState();
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
      pdfRoot.removeEventListener("scroll", handleScrollOrResize);
      window.removeEventListener("resize", handleScrollOrResize);
    }
  };
}

