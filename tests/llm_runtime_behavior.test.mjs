import assert from "node:assert/strict"
import test from "node:test"

import { generateLLM } from "../src/shared/llm/index.js"
import { installChromeStorageMock } from "./helpers/chrome_storage_mock.mjs"
import { buildMatrixRowFillInput } from "./helpers/matrix_input.mjs"

function makeJsonResponse(payload, status = 200) {
  const serialized = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get() {
        return null
      }
    },
    async json() {
      return payload
    },
    async text() {
      return serialized
    }
  }
}

test("runtime uses settings OpenAI key instead of process env key", async () => {
  const storage = installChromeStorageMock({
    settings: {
      llmMode: "openai",
      openaiApiKey: "settings-key"
    }
  })
  const originalFetch = globalThis.fetch
  const originalApiKeyEnv = process.env.API_KEY
  let authHeader = ""

  process.env.API_KEY = "env-key-should-not-be-used"
  globalThis.fetch = async (_url, options) => {
    authHeader = options?.headers?.Authorization || ""
    return makeJsonResponse({
      output_text: JSON.stringify({
        cells: [
          {
            columnId: "method",
            value: "Settings key path",
            confidence: 0.78,
            evidenceSnippet: "Verified in test.",
            evidencePage: 0,
            insufficientReason: ""
          }
        ],
        hiddenFeatures: [],
        warnings: []
      })
    })
  }

  try {
    const result = await generateLLM("project_matrix_row_fill", buildMatrixRowFillInput())
    assert.equal(result.providerUsed, "openai")
    assert.equal(authHeader, "Bearer settings-key")
    assert.notEqual(authHeader, "Bearer env-key-should-not-be-used")
  } finally {
    if (originalApiKeyEnv === undefined) {
      delete process.env.API_KEY
    } else {
      process.env.API_KEY = originalApiKeyEnv
    }
    globalThis.fetch = originalFetch
    storage.restore()
  }
})

test("runtime sends model from settings by default", async () => {
  const storage = installChromeStorageMock({
    settings: {
      llmMode: "openai",
      openaiApiKey: "settings-key",
      openaiModel: "gpt-4.1"
    }
  })
  const originalFetch = globalThis.fetch
  let model = ""

  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body || "{}"))
    model = String(payload?.model || "")
    return makeJsonResponse({
      output_text: JSON.stringify({
        cells: [],
        hiddenFeatures: [],
        warnings: []
      })
    })
  }

  try {
    await generateLLM("project_matrix_row_fill", buildMatrixRowFillInput())
    assert.equal(model, "gpt-4.1")
  } finally {
    globalThis.fetch = originalFetch
    storage.restore()
  }
})

test("runtime does not fall back to mock on OpenAI timeout when key exists", async () => {
  const storage = installChromeStorageMock({
    settings: {
      llmMode: "openai",
      openaiApiKey: "settings-key"
    }
  })
  const originalFetch = globalThis.fetch

  globalThis.fetch = async () => {
    const abortError = new Error("network wait exceeded")
    abortError.name = "AbortError"
    throw abortError
  }

  try {
    await assert.rejects(
      () => generateLLM("project_matrix_row_fill", buildMatrixRowFillInput()),
      /timed out|timeout/i
    )
  } finally {
    globalThis.fetch = originalFetch
    storage.restore()
  }
})

test("runtime uses mock provider in auto mode when no key is saved", async () => {
  const storage = installChromeStorageMock({
    settings: {
      llmMode: "auto",
      openaiApiKey: null
    }
  })
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    return makeJsonResponse({})
  }

  try {
    const result = await generateLLM("project_matrix_row_fill", buildMatrixRowFillInput())
    assert.equal(result.providerUsed, "mock")
    assert.equal(fetchCalled, false)
    assert.ok(Array.isArray(result.response?.cells))
  } finally {
    globalThis.fetch = originalFetch
    storage.restore()
  }
})
