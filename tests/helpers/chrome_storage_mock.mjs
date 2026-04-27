function readFromStore(store, key) {
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : undefined
}

function buildGetResult(store, keys) {
  if (typeof keys === "string") {
    return { [keys]: readFromStore(store, keys) }
  }

  if (Array.isArray(keys)) {
    return keys.reduce((acc, key) => {
      acc[key] = readFromStore(store, key)
      return acc
    }, {})
  }

  if (keys && typeof keys === "object") {
    const result = { ...keys }
    for (const key of Object.keys(keys)) {
      const existing = readFromStore(store, key)
      if (existing !== undefined) {
        result[key] = existing
      }
    }
    return result
  }

  return { ...store }
}

export function installChromeStorageMock(initialStore = {}) {
  const originalChrome = globalThis.chrome
  const store = { ...(initialStore && typeof initialStore === "object" ? initialStore : {}) }
  const local = {
    async get(keys) {
      return buildGetResult(store, keys)
    },
    async set(obj) {
      Object.assign(store, obj && typeof obj === "object" ? obj : {})
    }
  }

  globalThis.chrome = {
    ...(originalChrome && typeof originalChrome === "object" ? originalChrome : {}),
    storage: {
      ...(originalChrome?.storage && typeof originalChrome.storage === "object" ? originalChrome.storage : {}),
      local
    }
  }

  return {
    store,
    restore() {
      if (originalChrome === undefined) {
        delete globalThis.chrome
        return
      }
      globalThis.chrome = originalChrome
    }
  }
}
