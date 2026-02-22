import { createLogger } from "../shared/diagnostics.js";
import { getSettings, setSettings } from "../shared/storage.js";

const openViewerBtn = document.getElementById("openViewer");
const openFromTabBtn = document.getElementById("openFromTab");
const themeToggleBtn = document.getElementById("themeToggle");
const logger = createLogger("POPUP");

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  const normalizedTheme = normalizeTheme(theme);
  document.body.dataset.theme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;

  if (themeToggleBtn instanceof HTMLButtonElement) {
    const nextLabel = normalizedTheme === "dark" ? "Enable light mode" : "Enable dark mode";
    themeToggleBtn.textContent = nextLabel;
    themeToggleBtn.setAttribute("aria-label", nextLabel);
    themeToggleBtn.title = nextLabel;
  }
}

async function loadThemeState() {
  const settings = await getSettings();
  applyTheme(settings.theme);
  logger.debug("Popup theme loaded", { theme: settings.theme });
}

async function handleThemeToggle() {
  const settings = await getSettings();
  const nextTheme = normalizeTheme(settings.theme) === "dark" ? "light" : "dark";
  const nextSettings = await setSettings({ theme: nextTheme });
  applyTheme(nextSettings.theme);
  logger.info("Popup theme changed", { theme: nextSettings.theme });
}

logger.info("Popup loaded");
logger.debug("Popup actions ready");
void loadThemeState();

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

themeToggleBtn?.addEventListener("click", () => {
  void handleThemeToggle();
});
