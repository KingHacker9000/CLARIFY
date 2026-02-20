const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "OPEN_VIEWER") {
      await chrome.tabs.create({ url: viewerUrl });
    }

    if (msg?.type === "OPEN_VIEWER_FROM_TAB") {
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