(function forwardPdfUrl() {
  const hashValue = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  const queryValue = new URLSearchParams(location.search).get("u") || "";
  const originalUrl = hashValue || queryValue;
  const viewerBaseUrl = chrome.runtime.getURL("src/viewer/viewer.html");

  if (!originalUrl) {
    location.replace(viewerBaseUrl);
    return;
  }

  try {
    const parsed = new URL(originalUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      location.replace(viewerBaseUrl);
      return;
    }

    const target = `${viewerBaseUrl}?src=${encodeURIComponent(parsed.toString())}`;
    location.replace(target);
  } catch (_error) {
    location.replace(viewerBaseUrl);
  }
})();
