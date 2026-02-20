const openViewerBtn = document.getElementById("openViewer");
const openFromTabBtn = document.getElementById("openFromTab");

openViewerBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "OPEN_VIEWER" });
  window.close();
});

openFromTabBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "OPEN_VIEWER_FROM_TAB", url: tab?.url });
  window.close();
});