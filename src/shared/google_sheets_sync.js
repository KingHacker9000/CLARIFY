const TOKEN_STORAGE_KEY = "clarify_google_token_v1";
const TOKEN_EXPIRY_STORAGE_KEY = "clarify_google_token_expiry_v1";
const GOOGLE_AUTH_SCOPE = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets"
].join(" ");

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function getTokenFromStorage() {
  try {
    const token = normalizeText(globalThis?.localStorage?.getItem(TOKEN_STORAGE_KEY) || "");
    const expiry = Number(globalThis?.localStorage?.getItem(TOKEN_EXPIRY_STORAGE_KEY) || "0");
    if (!token || !Number.isFinite(expiry) || expiry <= Date.now() + 10_000) {
      return null;
    }
    return { token, expiry };
  } catch (_error) {
    return null;
  }
}

function setTokenInStorage(token, expiresInSec = 3500) {
  try {
    const safeToken = normalizeText(token);
    if (!safeToken) {
      return;
    }
    const expiry = Date.now() + Math.max(60, Number(expiresInSec) || 3500) * 1000;
    globalThis?.localStorage?.setItem(TOKEN_STORAGE_KEY, safeToken);
    globalThis?.localStorage?.setItem(TOKEN_EXPIRY_STORAGE_KEY, String(expiry));
  } catch (_error) {
    // ignore
  }
}

function clearTokenFromStorage() {
  try {
    globalThis?.localStorage?.removeItem(TOKEN_STORAGE_KEY);
    globalThis?.localStorage?.removeItem(TOKEN_EXPIRY_STORAGE_KEY);
  } catch (_error) {
    // ignore
  }
}

function parseAuthFragment(url) {
  try {
    const hash = url.split("#")[1] || "";
    const params = new URLSearchParams(hash);
    const accessToken = normalizeText(params.get("access_token") || "");
    const expiresIn = Number(params.get("expires_in") || "0");
    return {
      accessToken,
      expiresIn: Number.isFinite(expiresIn) ? expiresIn : 3600
    };
  } catch (_error) {
    return { accessToken: "", expiresIn: 3600 };
  }
}

async function apiGet(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    throw new Error(`Google API response parse failed (${response.status}).`);
  }
  if (!response.ok) {
    const message = normalizeText(payload?.error?.message || payload?.error_description || "");
    throw new Error(`Google API request failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return payload;
}

async function apiRequest(url, token, options = {}) {
  const response = await fetch(url, {
    method: options.method || "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }
  if (!response.ok) {
    const message = normalizeText(payload?.error?.message || payload?.error_description || "");
    throw new Error(`Google API request failed (${response.status})${message ? `: ${message}` : ""}`);
  }
  return payload;
}

function requireChromeIdentity() {
  if (!chrome?.identity?.launchWebAuthFlow || !chrome?.identity?.getRedirectURL) {
    throw new Error("chrome.identity permission is not available.");
  }
}

export async function connectGoogleOAuth({ clientId }) {
  requireChromeIdentity();
  const normalizedClientId = normalizeText(clientId);
  if (!normalizedClientId) {
    throw new Error("Google client ID is missing.");
  }
  const redirectUri = chrome.identity.getRedirectURL("google_oauth");
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", normalizedClientId);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GOOGLE_AUTH_SCOPE);
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true
  });
  const { accessToken, expiresIn } = parseAuthFragment(callbackUrl || "");
  if (!accessToken) {
    throw new Error("Google OAuth did not return access token.");
  }
  setTokenInStorage(accessToken, expiresIn);
  return {
    accessToken,
    expiresIn
  };
}

export async function getGoogleAccessToken({ clientId, forceRefresh = false }) {
  if (!forceRefresh) {
    const cached = getTokenFromStorage();
    if (cached?.token) {
      return cached.token;
    }
  }
  const { accessToken } = await connectGoogleOAuth({ clientId });
  return accessToken;
}

export function disconnectGoogleOAuth() {
  clearTokenFromStorage();
}

export async function listGoogleSpreadsheets({ token, query = "", pageSize = 30 }) {
  const safeToken = normalizeText(token);
  if (!safeToken) {
    throw new Error("Google access token missing.");
  }
  const normalizedQuery = normalizeText(query).replace(/'/g, "\\'");
  const clauses = ["mimeType='application/vnd.google-apps.spreadsheet'", "trashed=false"];
  if (normalizedQuery) {
    clauses.push(`name contains '${normalizedQuery}'`);
  }
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", clauses.join(" and "));
  url.searchParams.set("fields", "files(id,name,modifiedTime),nextPageToken");
  url.searchParams.set("pageSize", String(Math.max(1, Math.min(100, Number(pageSize) || 30))));
  url.searchParams.set("orderBy", "modifiedTime desc");
  const payload = await apiGet(url.toString(), safeToken);
  const files = Array.isArray(payload?.files) ? payload.files : [];
  return files.map((file) => ({
    id: normalizeText(file?.id),
    name: normalizeText(file?.name) || "Untitled sheet",
    modifiedTime: normalizeText(file?.modifiedTime)
  }));
}

export async function listSheetTabs({ token, spreadsheetId }) {
  const safeToken = normalizeText(token);
  const safeSpreadsheetId = normalizeText(spreadsheetId);
  if (!safeToken || !safeSpreadsheetId) {
    throw new Error("Spreadsheet selection is incomplete.");
  }
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(safeSpreadsheetId)}`);
  url.searchParams.set("fields", "spreadsheetId,properties(title),sheets(properties(sheetId,title,index))");
  const payload = await apiGet(url.toString(), safeToken);
  return {
    spreadsheetId: normalizeText(payload?.spreadsheetId || safeSpreadsheetId),
    spreadsheetName: normalizeText(payload?.properties?.title),
    sheets: (Array.isArray(payload?.sheets) ? payload.sheets : [])
      .map((sheet) => ({
        sheetId: Number.isFinite(Number(sheet?.properties?.sheetId)) ? Math.floor(Number(sheet.properties.sheetId)) : null,
        title: normalizeText(sheet?.properties?.title) || "Sheet1",
        index: Number.isFinite(Number(sheet?.properties?.index)) ? Math.floor(Number(sheet.properties.index)) : 0
      }))
      .filter((sheet) => sheet.sheetId != null)
      .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
  };
}

function toA1Column(columnIndex) {
  let index = columnIndex + 1;
  let out = "";
  while (index > 0) {
    const mod = (index - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    index = Math.floor((index - 1) / 26);
  }
  return out;
}

function rowToRange(sheetTitle, rowIndex, width) {
  const safeTitle = sheetTitle.includes("'") ? sheetTitle.replace(/'/g, "''") : sheetTitle;
  const endColumn = toA1Column(Math.max(0, width - 1));
  return `'${safeTitle}'!A${rowIndex}:${endColumn}${rowIndex}`;
}

function equalRow(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (String(a[index] ?? "") !== String(b[index] ?? "")) {
      return false;
    }
  }
  return true;
}

export async function syncMatrixToGoogleSheet({
  token,
  spreadsheetId,
  sheetTitle,
  headers,
  rows,
  keyColumn = "Paper Key"
}) {
  const safeToken = normalizeText(token);
  const safeSpreadsheetId = normalizeText(spreadsheetId);
  const safeSheetTitle = normalizeText(sheetTitle) || "Sheet1";
  const safeHeaders = Array.isArray(headers) ? headers.map((item) => String(item ?? "")) : [];
  const safeRows = Array.isArray(rows) ? rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [])) : [];
  if (!safeToken || !safeSpreadsheetId || !safeHeaders.length) {
    throw new Error("Missing Google Sheet sync input.");
  }

  const keyIndex = Math.max(0, safeHeaders.findIndex((header) => normalizeText(header) === normalizeText(keyColumn)));
  const allData = [safeHeaders, ...safeRows];
  const fetchUrl = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(safeSpreadsheetId)}/values/${encodeURIComponent(`${safeSheetTitle}!A1:ZZZ`)}`
  );
  let existingValues = [];
  try {
    const payload = await apiGet(fetchUrl.toString(), safeToken);
    existingValues = Array.isArray(payload?.values) ? payload.values : [];
  } catch (error) {
    if (!String(error?.message || "").includes("(404)")) {
      throw error;
    }
  }

  const report = {
    successCount: 0,
    failureCount: 0,
    errors: []
  };

  const upsertMap = new Map();
  for (const row of safeRows) {
    const key = normalizeText(row[keyIndex] || "");
    if (!key) {
      report.failureCount += 1;
      report.errors.push("Skipped row with empty paper key.");
      continue;
    }
    upsertMap.set(key, row);
  }

  if (!existingValues.length) {
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(safeSpreadsheetId)}/values/${encodeURIComponent(`${safeSheetTitle}!A1`)}?valueInputOption=RAW`;
    try {
      await apiRequest(updateUrl, safeToken, {
        method: "PUT",
        body: {
          range: `${safeSheetTitle}!A1`,
          majorDimension: "ROWS",
          values: allData
        }
      });
      report.successCount += safeRows.length;
    } catch (error) {
      report.failureCount += safeRows.length;
      report.errors.push(`Initial write failed: ${normalizeText(error?.message || "Unknown error")}`);
    }
    return report;
  }

  const existingHeader = Array.isArray(existingValues[0]) ? existingValues[0].map((item) => String(item ?? "")) : [];
  const existingKeyIndex = Math.max(0, existingHeader.findIndex((header) => normalizeText(header) === normalizeText(keyColumn)));
  const existingByKey = new Map();
  for (let rowIndex = 1; rowIndex < existingValues.length; rowIndex += 1) {
    const row = Array.isArray(existingValues[rowIndex]) ? existingValues[rowIndex].map((item) => String(item ?? "")) : [];
    const key = normalizeText(row[existingKeyIndex] || "");
    if (!key) {
      continue;
    }
    existingByKey.set(key, {
      row,
      rowIndex: rowIndex + 1
    });
  }

  if (!equalRow(existingHeader, safeHeaders)) {
    const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(safeSpreadsheetId)}/values/${encodeURIComponent(`${safeSheetTitle}!A1`)}?valueInputOption=RAW`;
    try {
      await apiRequest(headerUrl, safeToken, {
        method: "PUT",
        body: {
          range: `${safeSheetTitle}!A1`,
          majorDimension: "ROWS",
          values: [safeHeaders]
        }
      });
    } catch (error) {
      report.errors.push(`Header update failed: ${normalizeText(error?.message || "Unknown error")}`);
    }
  }

  const width = safeHeaders.length;
  const pendingAppend = [];
  for (const [key, row] of upsertMap.entries()) {
    const existing = existingByKey.get(key);
    if (!existing) {
      pendingAppend.push(row);
      continue;
    }
    if (equalRow(existing.row, row)) {
      report.successCount += 1;
      continue;
    }
    const rowRange = rowToRange(safeSheetTitle, existing.rowIndex, width);
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(safeSpreadsheetId)}/values/${encodeURIComponent(rowRange)}?valueInputOption=RAW`;
    try {
      await apiRequest(updateUrl, safeToken, {
        method: "PUT",
        body: {
          range: rowRange,
          majorDimension: "ROWS",
          values: [row]
        }
      });
      report.successCount += 1;
    } catch (error) {
      report.failureCount += 1;
      report.errors.push(`Row update failed (${key}): ${normalizeText(error?.message || "Unknown error")}`);
    }
  }

  if (pendingAppend.length) {
    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(safeSpreadsheetId)}/values/${encodeURIComponent(`${safeSheetTitle}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    try {
      await apiRequest(appendUrl, safeToken, {
        method: "POST",
        body: {
          range: `${safeSheetTitle}!A1`,
          majorDimension: "ROWS",
          values: pendingAppend
        }
      });
      report.successCount += pendingAppend.length;
    } catch (error) {
      report.failureCount += pendingAppend.length;
      report.errors.push(`Append failed: ${normalizeText(error?.message || "Unknown error")}`);
    }
  }

  return report;
}

