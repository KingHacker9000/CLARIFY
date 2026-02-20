import { DEFAULT_SETTINGS, normalizeSettings } from "./settings_schema.js";

const DIAGNOSTICS_VERBOSE_KEY = "diagnostics.verbose";
const SETTINGS_KEY = "settings";

function getStorageArea() {
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      return chrome.storage.local;
    }
  } catch (_error) {
    // Ignore and fall back.
  }
  return null;
}

function buildFallbackResult(keys) {
  if (typeof keys === "string") {
    return { [keys]: undefined };
  }

  if (Array.isArray(keys)) {
    return keys.reduce((acc, key) => {
      acc[key] = undefined;
      return acc;
    }, {});
  }

  if (keys && typeof keys === "object") {
    return { ...keys };
  }

  return {};
}

export async function get(keys) {
  const storage = getStorageArea();
  if (!storage) {
    return buildFallbackResult(keys);
  }

  try {
    return await storage.get(keys);
  } catch (_error) {
    return buildFallbackResult(keys);
  }
}

export async function set(obj) {
  const storage = getStorageArea();
  if (!storage) {
    return false;
  }

  try {
    await storage.set(obj ?? {});
    return true;
  } catch (_error) {
    return false;
  }
}

export async function getVerbose() {
  const values = await get({ [DIAGNOSTICS_VERBOSE_KEY]: false });
  return Boolean(values?.[DIAGNOSTICS_VERBOSE_KEY]);
}

export async function setVerbose(value) {
  return set({ [DIAGNOSTICS_VERBOSE_KEY]: Boolean(value) });
}

export async function getSettings() {
  const values = await get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  return normalizeSettings(values?.[SETTINGS_KEY]);
}

export async function setSettings(partial) {
  const current = await getSettings();
  const update = partial && typeof partial === "object" ? partial : {};
  const next = normalizeSettings({ ...current, ...update });
  const didPersist = await set({ [SETTINGS_KEY]: next });
  return didPersist ? next : current;
}

export async function clearOpenAIKey() {
  return setSettings({ openaiApiKey: null });
}
