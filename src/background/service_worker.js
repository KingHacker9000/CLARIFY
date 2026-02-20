import { createLogger } from "../shared/diagnostics.js";

const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");
const logger = createLogger("SW");

logger.info("Service worker startup");
logger.debug("Service worker initialized");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  logger.debug("Message received", { type: msg?.type });

  (async () => {
    if (msg?.type === "OPEN_VIEWER") {
      logger.info("OPEN_VIEWER received");
      await chrome.tabs.create({ url: viewerUrl });
    }

    if (msg?.type === "OPEN_VIEWER_FROM_TAB") {
      logger.info("OPEN_VIEWER_FROM_TAB received");
      const url = msg?.url || "";
      // If it's a PDF URL, pass it to the viewer as a query param.
      // Otherwise just open viewer empty.
      const isPdf = url.toLowerCase().includes(".pdf") || url.startsWith("blob:");
      const target = isPdf ? `${viewerUrl}?src=${encodeURIComponent(url)}` : viewerUrl;
      await chrome.tabs.create({ url: target });
    }
  })();

  sendResponse({ ok: true });
  return true;
});
