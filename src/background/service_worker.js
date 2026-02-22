import { createLogger } from "../shared/diagnostics.js";
import { getSettings } from "../shared/storage.js";

const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");
const redirectTrampolineUrl = chrome.runtime.getURL("src/viewer/redirect.html");
const SETTINGS_KEY = "settings";
const CONTEXT_MENU_ID = "open_pdf_in_clarify";
const PDF_RULES = Object.freeze([
  {
    id: 9001,
    regexFilter: "^https?://.*\\.[Pp][Dd][Ff](?:[?#].*)?$"
  },
  {
    id: 9002,
    regexFilter: "^https?://arxiv\\.org/pdf/[^?#]+(?:\\.[Pp][Dd][Ff])?(?:[?#].*)?$"
  },
  {
    id: 9003,
    regexFilter: "^https?://.*/download\\.[Pp][Dd][Ff](?:[?#].*)?$"
  },
  {
    id: 9004,
    regexFilter: "^https?://.*[?&](?:file|filename|download)=[^&#]*\\.[Pp][Dd][Ff](?:[&#].*)?$"
  }
]);
const logger = createLogger("SW");
let autoOpenPdfEnabled = false;
let fileRedirectWarned = false;

logger.info("Service worker startup");
logger.debug("Service worker initialized");

function buildViewerUrl(srcUrl) {
  return `${viewerUrl}?src=${encodeURIComponent(srcUrl)}`;
}

function normalizeViewerSourceUrl(url) {
  if (typeof url !== "string") {
    return "";
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (
      protocol !== "http:" &&
      protocol !== "https:" &&
      protocol !== "file:" &&
      protocol !== "blob:"
    ) {
      return "";
    }
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function isLikelyPdfSourceUrl(url) {
  const normalized = normalizeViewerSourceUrl(url);
  if (!normalized) {
    return false;
  }
  if (normalized.toLowerCase().startsWith("blob:")) {
    return true;
  }
  return normalized.toLowerCase().includes(".pdf");
}

function isFilePdfUrl(url) {
  if (typeof url !== "string") {
    return false;
  }
  return /^file:\/\//i.test(url) && /\.pdf(?:$|[?#])/i.test(url);
}

function buildPdfRedirectRules() {
  const regexSubstitution = `${redirectTrampolineUrl}#\\0`;
  return PDF_RULES.map((rule) => ({
    id: rule.id,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        regexSubstitution
      }
    },
    condition: {
      regexFilter: rule.regexFilter,
      resourceTypes: ["main_frame"]
    }
  }));
}

async function syncPdfRedirectRules(enabled) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    logger.warn("declarativeNetRequest API unavailable");
    return;
  }

  const removeRuleIds = PDF_RULES.map((rule) => rule.id);
  const addRules = enabled ? buildPdfRedirectRules() : [];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules
    });
    logger.info("PDF redirect rules synced", {
      enabled,
      count: addRules.length
    });
  } catch (error) {
    logger.error("Failed to sync PDF redirect rules", {
      enabled,
      message: error?.message ?? "Unknown error"
    });
  }
}

async function applyAutoOpenPdfSetting(enabled) {
  autoOpenPdfEnabled = Boolean(enabled);
  await syncPdfRedirectRules(autoOpenPdfEnabled);
}

async function refreshAutoOpenPdfSetting() {
  try {
    const settings = await getSettings();
    await applyAutoOpenPdfSetting(settings.autoOpenPdf);
  } catch (error) {
    logger.error("Failed to load auto-open setting", {
      message: error?.message ?? "Unknown error"
    });
    await applyAutoOpenPdfSetting(false);
  }
}

function ensureContextMenu() {
  if (!chrome.contextMenus?.create) {
    return;
  }

  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      logger.warn("Failed to clear context menus", {
        message: chrome.runtime.lastError.message
      });
    }

    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: "Open PDF in CLARIFY",
        contexts: ["link"]
      },
      () => {
        if (chrome.runtime.lastError) {
          logger.warn("Failed to create context menu", {
            message: chrome.runtime.lastError.message
          });
        }
      }
    );
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  logger.debug("Message received", { type: msg?.type });

  (async () => {
    if (msg?.type === "OPEN_VIEWER") {
      logger.info("OPEN_VIEWER received");
      await chrome.tabs.create({ url: viewerUrl });
      return;
    }

    if (msg?.type === "OPEN_VIEWER_FROM_TAB") {
      logger.info("OPEN_VIEWER_FROM_TAB received");
      const normalizedSourceUrl = normalizeViewerSourceUrl(msg?.url || "");
      const target = isLikelyPdfSourceUrl(normalizedSourceUrl)
        ? buildViewerUrl(normalizedSourceUrl)
        : viewerUrl;
      await chrome.tabs.create({ url: target });
    }
  })()
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch((error) => {
      logger.warn("Message handling failed", {
        type: msg?.type ?? "unknown",
        message: error?.message ?? "Unknown error"
      });
      sendResponse({ ok: false, error: "Message handling failed." });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
  void refreshAutoOpenPdfSetting();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenu();
  void refreshAutoOpenPdfSetting();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes?.[SETTINGS_KEY]) {
    return;
  }

  const nextValue = changes[SETTINGS_KEY]?.newValue;
  const nextAutoOpen = Boolean(nextValue?.autoOpenPdf);
  if (nextAutoOpen === autoOpenPdfEnabled) {
    return;
  }

  void applyAutoOpenPdfSetting(nextAutoOpen);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const changedUrl = changeInfo?.url;
  if (!autoOpenPdfEnabled || typeof changedUrl !== "string") {
    return;
  }

  if (!isFilePdfUrl(changedUrl)) {
    return;
  }

  const target = buildViewerUrl(changedUrl);
  chrome.tabs.update(tabId, { url: target }).catch((error) => {
    if (fileRedirectWarned) {
      return;
    }
    fileRedirectWarned = true;
    logger.warn("Unable to redirect file:// PDF tab", {
      message: error?.message ?? "Unknown error"
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !info.linkUrl) {
    return;
  }

  const normalizedSourceUrl = normalizeViewerSourceUrl(info.linkUrl);
  if (!normalizedSourceUrl) {
    logger.warn("Rejected unsupported context-menu link URL");
    return;
  }

  chrome.tabs.create({ url: buildViewerUrl(normalizedSourceUrl) }).catch((error) => {
    logger.warn("Failed to open PDF link from context menu", {
      message: error?.message ?? "Unknown error"
    });
  });
});

void refreshAutoOpenPdfSetting();
