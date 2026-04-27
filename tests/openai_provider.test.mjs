import assert from "node:assert/strict"
import test from "node:test"

import { generate as generateOpenAI } from "../src/shared/llm/providers/openai.js"
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

function hasInputFileAttachment(payload) {
  const input = Array.isArray(payload?.input) ? payload.input : []
  for (const block of input) {
    const content = Array.isArray(block?.content) ? block.content : []
    for (const item of content) {
      if (item?.type === "input_file") {
        return true
      }
    }
  }
  return false
}

test("openai provider retries transient timeout for project_matrix_row_fill", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = async () => {
    callCount += 1
    if (callCount === 1) {
      const abortError = new Error("aborted by signal")
      abortError.name = "AbortError"
      throw abortError
    }

    return makeJsonResponse({
      output_text: JSON.stringify({
        cells: [
          {
            columnId: "method",
            value: "Transformer encoder with retrieval augmentation",
            confidence: 0.82,
            evidenceSnippet: "The method combines retrieval and transformer encoding.",
            evidencePage: 2,
            insufficientReason: ""
          }
        ],
        hiddenFeatures: [{ columnId: "method", tags: ["transformer", "retrieval"] }],
        warnings: []
      })
    })
  }

  try {
    const result = await generateOpenAI("project_matrix_row_fill", buildMatrixRowFillInput(), {
      apiKey: "test-key",
      timeoutMs: 1500,
      maxAttempts: 3
    })

    assert.equal(callCount, 2)
    assert.ok(Array.isArray(result.cells))
    assert.equal(result.cells[0]?.columnId, "method")
    assert.ok(Array.isArray(result.hiddenFeatures))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("openai provider retries after invalid JSON + repair failure", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = async () => {
    callCount += 1
    if (callCount === 1) {
      return makeJsonResponse({ output_text: "{\"cells\": [}" })
    }
    if (callCount === 2) {
      return makeJsonResponse({ output_text: "this is still not json" })
    }
    return makeJsonResponse({
      output_text: JSON.stringify({
        cells: [
          {
            columnId: "outcome",
            value: "Recovered after retry",
            confidence: 0.74,
            evidenceSnippet: "Recovered on second generation attempt.",
            evidencePage: 1,
            insufficientReason: ""
          }
        ],
        hiddenFeatures: [],
        warnings: []
      })
    })
  }

  try {
    const result = await generateOpenAI("project_matrix_row_fill", buildMatrixRowFillInput(), {
      apiKey: "test-key",
      maxAttempts: 4
    })
    assert.equal(callCount, 3)
    assert.equal(result.cells?.[0]?.columnId, "outcome")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("openai provider retries once without file attachments when file_id is invalid", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  const requestPayloads = []

  globalThis.fetch = async (_url, options) => {
    callCount += 1
    requestPayloads.push(JSON.parse(String(options?.body || "{}")))
    if (callCount === 1) {
      return makeJsonResponse(
        {
          error: {
            message: "No file found with id file-deadbeef."
          }
        },
        400
      )
    }
    return makeJsonResponse({
      output_text: JSON.stringify({
        cells: [],
        hiddenFeatures: [],
        warnings: []
      })
    })
  }

  try {
    await generateOpenAI(
      "project_matrix_row_fill",
      buildMatrixRowFillInput({
        openaiFileId: "file-deadbeef"
      }),
      {
        apiKey: "test-key",
        maxAttempts: 3
      }
    )
    assert.equal(callCount, 2)
    assert.equal(hasInputFileAttachment(requestPayloads[0]), true)
    assert.equal(hasInputFileAttachment(requestPayloads[1]), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("openai provider retries incomplete output with larger max_output_tokens", async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0
  const tokenBudgets = []

  globalThis.fetch = async (_url, options) => {
    callCount += 1
    const payload = JSON.parse(String(options?.body || "{}"))
    tokenBudgets.push(Number(payload?.max_output_tokens) || 0)
    if (callCount === 1) {
      return makeJsonResponse({
        status: "incomplete",
        incomplete_details: {
          reason: "max_output_tokens"
        },
        output_text: "{\"cells\":[]}"
      })
    }
    return makeJsonResponse({
      output_text: JSON.stringify({
        cells: [],
        hiddenFeatures: [],
        warnings: []
      })
    })
  }

  try {
    await generateOpenAI("project_matrix_row_fill", buildMatrixRowFillInput(), {
      apiKey: "test-key",
      maxAttempts: 3
    })
    assert.equal(callCount, 2)
    assert.ok(tokenBudgets[1] > tokenBudgets[0])
  } finally {
    globalThis.fetch = originalFetch
  }
})
