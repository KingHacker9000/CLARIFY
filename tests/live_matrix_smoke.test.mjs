import assert from "node:assert/strict"
import test from "node:test"

import { generateLLM } from "../src/shared/llm/index.js"
import { installChromeStorageMock } from "./helpers/chrome_storage_mock.mjs"
import { readOpenAIApiKeyFromEnv } from "./helpers/env.mjs"
import { buildMatrixRowFillInput } from "./helpers/matrix_input.mjs"

test(
  "live smoke: matrix row fill runs with .env key and arXiv PDF link context",
  { timeout: 180000 },
  async (t) => {
    const apiKey = readOpenAIApiKeyFromEnv()
    if (!apiKey) {
      t.skip("No API key found in process env or .env (API_KEY / OPENAI_API_KEY).")
      return
    }

    const storage = installChromeStorageMock({
      settings: {
        llmMode: "openai",
        openaiApiKey: apiKey
      }
    })

    try {
      const result = await generateLLM(
        "project_matrix_row_fill",
        buildMatrixRowFillInput({
          contextWindow:
            "Paper URL for extraction context: https://arxiv.org/pdf/2412.12093. Fill matrix cells conservatively and mark missing evidence.",
          snippet:
            "Use https://arxiv.org/pdf/2412.12093 as the source reference for this matrix-fill smoke test."
        })
      )

      assert.equal(result.providerUsed, "openai")
      assert.ok(Array.isArray(result.response?.cells))
      assert.ok(
        (Array.isArray(result.warnings) ? result.warnings : []).every(
          (warning) => !String(warning).toLowerCase().includes("mock fallback")
        )
      )
    } finally {
      storage.restore()
    }
  }
)
