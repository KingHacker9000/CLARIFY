import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

function stripQuotes(value) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) {
    return ""
  }
  if (
    (text.startsWith("\"") && text.endsWith("\"")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim()
  }
  return text
}

export function readDotEnv(dotEnvPath = resolve(process.cwd(), ".env")) {
  if (!existsSync(dotEnvPath)) {
    return {}
  }
  const text = readFileSync(dotEnvPath, "utf8")
  const lines = text.split(/\r?\n/g)
  const values = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    const equalIndex = trimmed.indexOf("=")
    if (equalIndex <= 0) {
      continue
    }
    const key = trimmed.slice(0, equalIndex).trim()
    const value = stripQuotes(trimmed.slice(equalIndex + 1))
    if (!key) {
      continue
    }
    values[key] = value
  }
  return values
}

export function readOpenAIApiKeyFromEnv(dotEnvPath) {
  const fromProcess = (process.env.API_KEY || process.env.OPENAI_API_KEY || "").trim()
  if (fromProcess) {
    return fromProcess
  }
  const parsed = readDotEnv(dotEnvPath)
  return (parsed.API_KEY || parsed.OPENAI_API_KEY || "").trim()
}
