import { getSettings, getVerbose } from "./storage.js";

const MAX_STRUCTURED_LOG_LENGTH = 600;

function clampStructuredLog(text) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= MAX_STRUCTURED_LOG_LENGTH) {
    return text;
  }
  return `${text.slice(0, Math.max(MAX_STRUCTURED_LOG_LENGTH - 3, 1)).trim()}...`;
}

function serializeStructuredLogValue(value) {
  if (value instanceof Error) {
    const name = typeof value.name === "string" && value.name ? value.name : "Error";
    const message = typeof value.message === "string" && value.message ? value.message : "Unknown error";
    return clampStructuredLog(`${name}: ${message}`);
  }

  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }

  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }

  if (typeof value !== "object") {
    return String(value);
  }

  const seen = new WeakSet();
  try {
    const json = JSON.stringify(value, (_key, current) => {
      if (current instanceof Error) {
        return {
          name: current.name || "Error",
          message: current.message || "Unknown error"
        };
      }
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return "[circular]";
        }
        seen.add(current);
      }
      return current;
    });
    if (typeof json === "string" && json) {
      return clampStructuredLog(json);
    }
  } catch (_error) {
    // Fall through to String(value).
  }

  return clampStructuredLog(String(value));
}

function formatLogArgs(method, args) {
  if (!Array.isArray(args)) {
    return [];
  }
  if (method !== "warn" && method !== "error") {
    return args;
  }
  return args.map((arg) => (typeof arg === "string" ? arg : serializeStructuredLogValue(arg)));
}

function writeLog(method, prefix, args) {
  try {
    const fn = typeof console?.[method] === "function" ? console[method] : console.log;
    fn(prefix, ...formatLogArgs(method, args));
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
    debugMode: Boolean(settings.debugMode),
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
    build: "release"
  };
}
