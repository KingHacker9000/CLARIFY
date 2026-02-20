import { getSettings, getVerbose } from "./storage.js";

function writeLog(method, prefix, args) {
  try {
    const fn = typeof console?.[method] === "function" ? console[method] : console.log;
    fn(prefix, ...args);
  } catch (_error) {
    // Never crash logging.
  }
}

function getManifest() {
  try {
    if (typeof chrome !== "undefined" && chrome?.runtime?.getManifest) {
      return chrome.runtime.getManifest();
    }
  } catch (_error) {
    // Ignore and fall back.
  }
  return null;
}

function getViewerUrlFallback() {
  try {
    if (typeof chrome !== "undefined" && chrome?.runtime?.getURL) {
      return chrome.runtime.getURL("src/viewer/viewer.html");
    }
  } catch (_error) {
    // Ignore and fall back.
  }
  return null;
}

function normalizeOpenedPdfSource(value) {
  if (value === "local" || value === "remote") {
    return value;
  }
  return null;
}

export function createLogger(scope) {
  const prefix = `[CLARIFY][${scope}]`;
  const alwaysInfo = scope === "OPENAI";

  function logIfVerbose(method, args) {
    void (async () => {
      try {
        const verbose = await getVerbose();
        if (verbose) {
          writeLog(method, prefix, args);
        }
      } catch (_error) {
        // Skip output if verbose state cannot be read.
      }
    })();
  }

  return {
    debug(...args) {
      logIfVerbose("debug", args);
    },
    info(...args) {
      if (alwaysInfo) {
        writeLog("info", prefix, args);
        return;
      }
      logIfVerbose("info", args);
    },
    warn(...args) {
      writeLog("warn", prefix, args);
    },
    error(...args) {
      writeLog("error", prefix, args);
    }
  };
}

export async function getDebugInfo(context = {}) {
  const manifest = getManifest();
  const diagnosticsVerbose = await getVerbose();
  const settings = await getSettings();

  let userAgent = null;
  try {
    if (typeof navigator !== "undefined") {
      userAgent = navigator.userAgent;
    }
  } catch (_error) {
    // Ignore and keep null.
  }

  const contextViewerUrl = typeof context.viewerUrl === "string" ? context.viewerUrl : null;

  return {
    extensionVersion: manifest?.version ?? null,
    manifestVersion: manifest?.manifest_version ?? null,
    diagnosticsVerbose,
    llmMode: settings.llmMode,
    hasOpenAIKey: Boolean(settings.openaiApiKey),
    contextScope: settings.contextScope,
    wholePdfUpload: settings.wholePdfUpload,
    promptCacheRetention: settings.promptCacheRetention,
    maxQuoteChars: settings.maxQuoteChars,
    maxCitations: settings.maxCitations,
    defaultReadingMode: settings.defaultReadingMode,
    autoOpenPdf: settings.autoOpenPdf,
    userAgent,
    viewerUrl: contextViewerUrl ?? getViewerUrlFallback(),
    openedPdfSource: normalizeOpenedPdfSource(context.openedPdfSource),
    timestamp: new Date().toISOString(),
    build: "dev"
  };
}
