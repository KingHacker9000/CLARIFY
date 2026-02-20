import { createLogger } from "../shared/diagnostics.js";

const openViewerBtn = document.getElementById("openViewer");
const openFromTabBtn = document.getElementById("openFromTab");
const logger = createLogger("POPUP");

logger.info("Popup loaded");
logger.debug("Popup actions ready");

openViewerBtn.addEventListener("click", async () => {
  logger.info("Open viewer button clicked");
  await chrome.runtime.sendMessage({ type: "OPEN_VIEWER" });
  window.close();
});

openFromTabBtn.addEventListener("click", async () => {
  logger.info("Open from current tab button clicked");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "OPEN_VIEWER_FROM_TAB", url: tab?.url });
  window.close();
});
