const DEFAULT_MAX_ITEMS = 220
const VALID_RESPONSE_TYPES = new Set([
  "mcq",
  "short_answer",
  "long_answer",
  "multi_select",
  "fill_blank",
  "true_false",
  "table_definition",
  "unknown"
])

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function normalizeWorksheetText(value) {
  if (typeof value !== "string") {
    return ""
  }
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function structureWorksheetText(value) {
  const source = normalizeWorksheetText(value)
  if (!source) {
    return ""
  }
  return source
    .replace(/\b(Question\s+\d+\.?)/gi, "\n$1")
    .replace(/\b(Part\s*\([a-z]\))/gi, "\n$1")
    .replace(/(^|[^A-Za-z0-9])(\d+\.)\s+(?=[A-Z])/g, (match, prefix, marker, offset, fullText) => {
      const markerStart = Number(offset) + String(prefix).length
      const start = Math.max(0, markerStart - 24)
      const windowText = fullText.slice(start, markerStart)
      if (/Question\s*$/i.test(windowText) || /Part\s*\([a-z]\)\s*$/i.test(windowText)) {
        return match
      }
      return `${prefix}\n${marker} `
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function parsePageIndex(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0
  }
  return Math.floor(numeric)
}

function clampText(value, maxLength) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(maxLength - 3, 1)).trim()}...`
}

function hashString(input) {
  const source = typeof input === "string" ? input : ""
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function escapeXml(value) {
  const text = typeof value === "string" ? value : ""
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function normalizeKeyToken(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function makeNodeSourceKey({ pageIndex, kind, label, text, parentSourceKey, lineIndex }) {
  const payload = [
    parsePageIndex(pageIndex),
    normalizeText(kind).toLowerCase(),
    normalizeKeyToken(label),
    normalizeKeyToken(text),
    normalizeText(parentSourceKey),
    Number.isFinite(Number(lineIndex)) ? String(Math.floor(Number(lineIndex))) : "0"
  ].join("|")
  return `wsn_${hashString(payload).toString(36)}`
}

function makeNodeId(sourceKey) {
  const key = normalizeText(sourceKey)
  if (!key) {
    return `wsn_${hashString(String(Date.now())).toString(36)}`
  }
  return `wsn_${hashString(key).toString(36)}`
}

function normalizeResponseType(value) {
  const type = normalizeText(value).toLowerCase()
  if (VALID_RESPONSE_TYPES.has(type)) {
    return type
  }
  return "unknown"
}

function uniqueTypes(types) {
  const normalized = Array.isArray(types) ? types : []
  const seen = new Set()
  const deduped = []
  for (const type of normalized) {
    const normalizedType = normalizeResponseType(type)
    if (normalizedType === "unknown") {
      continue
    }
    if (seen.has(normalizedType)) {
      continue
    }
    seen.add(normalizedType)
    deduped.push(normalizedType)
  }
  if (deduped.length === 0) {
    return ["unknown"]
  }
  return deduped
}

function parseMarks(text) {
  const source = normalizeText(text)
  if (!source) {
    return {
      raw: "",
      value: null,
      unit: "",
      each: false
    }
  }

  const patterns = [
    /\((\d+(?:\.\d+)?)\s*(marks?|points?|pts?)\)/i,
    /\[(\d+(?:\.\d+)?)\s*(marks?|points?|pts?)\]/i,
    /(?:^|[\s-])(\d+(?:\.\d+)?)\s*(marks?|points?|pts?)(?:\b|$)/i
  ]

  let match = null
  for (const pattern of patterns) {
    const candidate = source.match(pattern)
    if (candidate?.[0]) {
      match = candidate
      break
    }
  }

  if (!match?.[0]) {
    return {
      raw: "",
      value: null,
      unit: "",
      each: false
    }
  }

  const value = Number(match[1])
  const unit = normalizeText(match[2]).toLowerCase()
  const each = /\beach\b/i.test(source)
  return {
    raw: normalizeText(match[0]),
    value: Number.isFinite(value) ? value : null,
    unit: unit || "marks",
    each
  }
}

function isOptionLine(line) {
  const text = normalizeText(line)
  if (!text) {
    return false
  }
  return /^([a-z]|[ivxlcdm]|\d+)[\)\.]\s+/i.test(text)
}

function parseOptionLine(line) {
  const text = normalizeText(line)
  if (!text) {
    return null
  }
  const match = text.match(/^([a-z]|[ivxlcdm]|\d+)[\)\.]\s+(.+)$/i)
  if (!match?.[1] || !match?.[2]) {
    return null
  }
  return {
    key: normalizeText(match[1]).toLowerCase(),
    text: clampText(match[2], 220)
  }
}

function isFooterLine(line) {
  const text = normalizeText(line)
  if (!text) {
    return false
  }
  if (/^page\s+\d+\s*(?:\/|of)\s*\d+/i.test(text)) {
    return true
  }
  return /cont'?d\.?$/i.test(text)
}

function stripFooterFragments(line) {
  const text = normalizeText(line)
  if (!text) {
    return ""
  }
  return normalizeText(
    text
      .replace(/\bpage\s+\d+\s*(?:\/|of)\s*\d+\b.*$/i, "")
      .replace(/\bcont'?d\.?\b.*$/i, "")
  )
}

function isLikelyTermLine(line) {
  const text = stripFooterFragments(line)
  if (!text || text.length < 3 || text.length > 84) {
    return false
  }
  if (isFooterLine(text) || isOptionLine(text)) {
    return false
  }
  if (/^Question\s+\d+|^Part\s*\([a-z]\)|^\d+\.\s+/i.test(text)) {
    return false
  }
  if (/^(term|definition|virtual address|physical address|notes)$/i.test(text)) {
    return false
  }
  if (/[?.:;!]/.test(text)) {
    return false
  }
  if (
    /\b(explain|describe|justify|indicate|select|calculate|determine|identify|complete|consider|translate|briefly|answer)\b/i.test(
      text
    )
  ) {
    return false
  }
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 5) {
    return false
  }
  return /[A-Za-z]/.test(text)
}

function splitPackedTerms(line) {
  const text = stripFooterFragments(line)
  const cleaned = normalizeText(
    text
      .replace(/^term\s+definition\s+/i, "")
      .replace(/^virtual\s+address\s+physical\s+address\s+notes\s+/i, "")
  )
  if (!cleaned || cleaned.length < 24 || cleaned.length > 720) {
    return []
  }
  if (/[?.:;!]/.test(cleaned.replace(/\./g, ""))) {
    return []
  }
  const parts = cleaned
    .split(/\s+(?=[A-Z][a-z])/)
    .map((item) => normalizeText(item))
    .filter(Boolean)
  if (parts.length < 3) {
    return []
  }
  return parts.filter((item) => isLikelyTermLine(item))
}

function inferResponseTypes({ text, kind, optionCount = 0, hasTermChildren = false }) {
  const source = normalizeText(text).toLowerCase()
  const normalizedKind = normalizeText(kind).toLowerCase()
  const types = []

  if (hasTermChildren || normalizedKind === "term") {
    types.push("table_definition")
    if (normalizedKind === "term") {
      types.push("short_answer")
    }
  }
  if (
    /\btrue\s*\/?\s*false\b/.test(source) ||
    /\btrue or false\b/.test(source) ||
    /\btrue\/false\b/.test(source)
  ) {
    types.push("true_false")
  }
  if (
    /\bselect\s+all\b/.test(source) ||
    /\bchoose\s+all\b/.test(source) ||
    /\bmultiple\s+answers?\b/.test(source) ||
    /\bmore than one\b/.test(source)
  ) {
    types.push("multi_select")
  } else if (
    /\bselect\s+one\b/.test(source) ||
    /\bone option\b/.test(source) ||
    /\bchoose one\b/.test(source) ||
    /\bmcq\b/.test(source)
  ) {
    types.push("mcq")
  }
  if (optionCount >= 2 && !types.includes("multi_select") && !types.includes("mcq")) {
    types.push("mcq")
  }
  if (/\bfill in the blank\b/.test(source) || /_{3,}/.test(source) || /\bblank\b/.test(source)) {
    types.push("fill_blank")
  }
  if (/\bjustify\b|\breason\b|\bexplain\b|\bdescribe\b|\bwhy\b|\bhow\b/.test(source)) {
    types.push("long_answer")
  }
  if (!types.includes("long_answer") && !types.includes("mcq") && !types.includes("multi_select")) {
    types.push("short_answer")
  }

  return uniqueTypes(types)
}

function derivePrimaryType(types) {
  const normalized = uniqueTypes(types)
  if (normalized.includes("table_definition")) {
    return "table_definition"
  }
  if (normalized.includes("multi_select")) {
    return "multi_select"
  }
  if (normalized.includes("mcq")) {
    return "mcq"
  }
  if (normalized.includes("true_false")) {
    return "true_false"
  }
  if (normalized.includes("fill_blank")) {
    return "fill_blank"
  }
  if (normalized.includes("long_answer")) {
    return "long_answer"
  }
  if (normalized.includes("short_answer")) {
    return "short_answer"
  }
  return "unknown"
}

function buildContextWindow(lines, lineIndex) {
  const index = Number.isFinite(Number(lineIndex)) ? Math.max(0, Math.floor(Number(lineIndex))) : 0
  const start = Math.max(0, index - 2)
  const end = Math.min(lines.length, index + 3)
  return clampText(lines.slice(start, end).join(" "), 900)
}

function isMarkerLine(line) {
  const text = normalizeText(line)
  if (!text) {
    return false
  }
  if (/^Question\s+\d+\.?/i.test(text)) {
    return true
  }
  if (/^Part\s*\([a-z]\)/i.test(text)) {
    return true
  }
  return /^\d+\.\s+/.test(text)
}

function shouldAppendContinuation(node, line) {
  if (!node || !line) {
    return false
  }
  const text = normalizeText(line)
  if (!text) {
    return false
  }
  if (isMarkerLine(text) || isOptionLine(text) || isFooterLine(text)) {
    return false
  }
  if (node.kind === "term") {
    return false
  }
  const current = normalizeText(node.text)
  if (!current) {
    return true
  }
  if (!/[.?!:]$/.test(current)) {
    return true
  }
  return /^[a-z]/.test(text)
}

function makeNode({
  pageIndex,
  kind,
  label,
  text,
  anchorText,
  parentSourceKey,
  lineIndex,
  contextWindow,
  options = []
}) {
  const normalizedKind = normalizeText(kind).toLowerCase() || "prompt"
  const normalizedLabel = clampText(label, 120)
  const normalizedText = clampText(text, 520)
  const normalizedAnchorText = clampText(anchorText || normalizedText, 260)
  const sourceKey = makeNodeSourceKey({
    pageIndex,
    kind: normalizedKind,
    label: normalizedLabel,
    text: normalizedText,
    parentSourceKey: normalizeText(parentSourceKey),
    lineIndex
  })
  const marks = parseMarks(normalizedText)
  const normalizedOptions = (Array.isArray(options) ? options : [])
    .map((option) => ({
      key: clampText(option?.key, 12),
      text: clampText(option?.text, 220)
    }))
    .filter((option) => option.key && option.text)
    .slice(0, 12)
  const responseTypes = inferResponseTypes({
    text: normalizedText,
    kind: normalizedKind,
    optionCount: normalizedOptions.length,
    hasTermChildren: false
  })
  return {
    id: makeNodeId(sourceKey),
    sourceKey,
    parentSourceKey: normalizeText(parentSourceKey),
    kind: normalizedKind,
    label: normalizedLabel,
    text: normalizedText,
    anchorText: normalizedAnchorText,
    pageIndex: parsePageIndex(pageIndex),
    lineIndex: Number.isFinite(Number(lineIndex)) ? Math.max(0, Math.floor(Number(lineIndex))) : 0,
    contextWindow: clampText(contextWindow, 900),
    options: normalizedOptions,
    marks,
    responseModel: {
      primaryType: derivePrimaryType(responseTypes),
      responseTypes,
      mixed: responseTypes.length > 1
    },
    children: []
  }
}

function finalizeNodeMetadata(node) {
  if (!node || typeof node !== "object") {
    return
  }
  const hasTermChildren = Array.isArray(node.children) && node.children.some((child) => child?.kind === "term")
  const responseTypes = inferResponseTypes({
    text: node.text,
    kind: node.kind,
    optionCount: Array.isArray(node.options) ? node.options.length : 0,
    hasTermChildren
  })
  node.responseModel = {
    primaryType: derivePrimaryType(responseTypes),
    responseTypes,
    mixed: responseTypes.length > 1
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    finalizeNodeMetadata(child)
  }
}

function parseWorksheetPage(page, options = {}) {
  const pageIndex = parsePageIndex(page?.pageIndex)
  const structured = structureWorksheetText(page?.text)
  if (!structured) {
    return {
      pageIndex,
      nodes: []
    }
  }

  const lines = structured
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
  if (lines.length === 0) {
    return {
      pageIndex,
      nodes: []
    }
  }

  const nodes = []
  let currentQuestion = null
  let currentPart = null
  let currentItem = null
  let continuationNode = null
  let tableMode = false
  let tableParent = null
  let seenTableTerms = 0
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(40, Math.floor(Number(options.maxItems)))
    : DEFAULT_MAX_ITEMS

  const addNode = ({ kind, label, text, anchorText, parentNode = null, lineIndex }) => {
    const node = makeNode({
      pageIndex,
      kind,
      label,
      text,
      anchorText,
      parentSourceKey: parentNode?.sourceKey || "",
      lineIndex,
      contextWindow: buildContextWindow(lines, lineIndex)
    })
    if (parentNode && Array.isArray(parentNode.children)) {
      parentNode.children.push(node)
    } else {
      nodes.push(node)
    }
    if (nodes.length > maxItems) {
      return node
    }
    return node
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (!line || isFooterLine(line)) {
      continue
    }

    if (continuationNode && shouldAppendContinuation(continuationNode, line)) {
      continuationNode.text = clampText(`${continuationNode.text} ${line}`, 520)
      continuationNode.contextWindow = clampText(
        `${continuationNode.contextWindow} ${buildContextWindow(lines, lineIndex)}`,
        900
      )
      continuationNode.marks = parseMarks(continuationNode.text)
      continue
    }

    const questionMatch = line.match(/^Question\s+(\d+)\.?\s*(.*)$/i)
    if (questionMatch?.[1]) {
      const label = `Question ${questionMatch[1]}`
      const trailing = normalizeText(questionMatch[2])
      const text = trailing ? `${label}. ${trailing}` : `${label}.`
      currentQuestion = addNode({
        kind: "question",
        label,
        text,
        anchorText: `${label}.`,
        parentNode: null,
        lineIndex
      })
      currentPart = null
      currentItem = null
      continuationNode = currentQuestion
      tableMode = false
      tableParent = null
      seenTableTerms = 0
      continue
    }

    const partMatch = line.match(/^Part\s*\(([a-z])\)\s*(.*)$/i)
    if (partMatch?.[1]) {
      const partLabel = `Part (${partMatch[1].toLowerCase()})`
      const trailing = normalizeText(partMatch[2])
      const text = trailing
        ? `${currentQuestion ? `${currentQuestion.label} ` : ""}${partLabel} ${trailing}`
        : `${currentQuestion ? `${currentQuestion.label} ` : ""}${partLabel}`
      currentPart = addNode({
        kind: "part",
        label: partLabel,
        text,
        anchorText: trailing ? `${partLabel} ${trailing}` : partLabel,
        parentNode: currentQuestion,
        lineIndex
      })
      currentItem = null
      continuationNode = currentPart
      tableMode = /\btable\b|\bdefinitions?\b/i.test(text)
      tableParent = tableMode ? currentPart : null
      seenTableTerms = 0
      continue
    }

    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/)
    if (numberedMatch?.[1] && numberedMatch?.[2]) {
      const label = `${numberedMatch[1]}.`
      const body = normalizeText(numberedMatch[2].replace(/\s+[a-d]\)\s+.+$/i, ""))
      currentItem = addNode({
        kind: "item",
        label,
        text: `${currentQuestion ? `${currentQuestion.label} ` : ""}${label} ${body}`,
        anchorText: `${label} ${body}`,
        parentNode: currentPart || currentQuestion,
        lineIndex
      })
      continuationNode = currentItem
      tableMode = false
      tableParent = null
      seenTableTerms = 0
      continue
    }

    if (/^term\b/i.test(line) && /\bdefinition\b/i.test(line)) {
      tableMode = true
      tableParent = currentPart || currentQuestion
      seenTableTerms = 0
      continuationNode = null
      continue
    }

    if (isOptionLine(line)) {
      const option = parseOptionLine(line)
      if (option) {
        const optionTarget = currentItem || currentPart || currentQuestion
        if (optionTarget) {
          optionTarget.options = [...(Array.isArray(optionTarget.options) ? optionTarget.options : []), option]
        }
      }
      continuationNode = null
      continue
    }

    if (tableMode) {
      const termParentNode = tableParent || currentPart || currentQuestion
      if (termParentNode && isLikelyTermLine(line)) {
        addNode({
          kind: "term",
          label: line,
          text: line,
          anchorText: line,
          parentNode: termParentNode,
          lineIndex
        })
        seenTableTerms += 1
        continuationNode = null
        continue
      }
      const packedTerms = splitPackedTerms(line)
      if (termParentNode && packedTerms.length > 0) {
        for (const term of packedTerms) {
          addNode({
            kind: "term",
            label: term,
            text: term,
            anchorText: term,
            parentNode: termParentNode,
            lineIndex
          })
          seenTableTerms += 1
        }
        continuationNode = null
        continue
      }
      if (seenTableTerms > 0) {
        tableMode = false
        tableParent = null
      }
    }

    if (currentPart || currentQuestion) {
      const parent = currentPart || currentQuestion
      const promptNode = addNode({
        kind: "prompt",
        label: "",
        text: `${currentQuestion ? `${currentQuestion.label} ` : ""}${line}`,
        anchorText: line,
        parentNode: parent,
        lineIndex
      })
      continuationNode = promptNode
      continue
    }
  }

  for (const node of nodes) {
    finalizeNodeMetadata(node)
  }

  return {
    pageIndex,
    nodes: nodes.slice(0, maxItems)
  }
}

function cloneNodeForFlat(node) {
  if (!node || typeof node !== "object") {
    return null
  }
  return {
    id: normalizeText(node.id),
    sourceKey: normalizeText(node.sourceKey),
    parentSourceKey: normalizeText(node.parentSourceKey),
    questionText: clampText(node.text, 360),
    pageIndex: parsePageIndex(node.pageIndex),
    kind: normalizeText(node.kind).toLowerCase() || "prompt",
    label: clampText(node.label, 120),
    anchorText: clampText(node.anchorText || node.text, 240),
    questionType: normalizeResponseType(node.responseModel?.primaryType),
    responseTypes: uniqueTypes(node.responseModel?.responseTypes),
    marksRaw: clampText(node.marks?.raw, 80),
    marksValue: Number.isFinite(Number(node.marks?.value)) && Number(node.marks.value) > 0 ? Number(node.marks.value) : null,
    marksEach: Boolean(node.marks?.each),
    options: (Array.isArray(node.options) ? node.options : [])
      .map((option) => clampText(`${option?.key}) ${option?.text}`, 120))
      .filter(Boolean)
      .slice(0, 12),
    contextWindow: clampText(node.contextWindow, 900)
  }
}

function flattenNodes(nodes, output, maxItems) {
  if (!Array.isArray(nodes) || !Array.isArray(output)) {
    return
  }
  for (const node of nodes) {
    if (output.length >= maxItems) {
      return
    }
    const flat = cloneNodeForFlat(node)
    if (flat?.questionText) {
      output.push(flat)
    }
    flattenNodes(node?.children, output, maxItems)
    if (output.length >= maxItems) {
      return
    }
  }
}

function serializeNodeXml(node, indentLevel) {
  const indent = "  ".repeat(Math.max(0, indentLevel))
  const attrs = [
    `id="${escapeXml(node.id)}"`,
    `sourceKey="${escapeXml(node.sourceKey)}"`,
    `kind="${escapeXml(node.kind)}"`,
    `pageIndex="${String(parsePageIndex(node.pageIndex))}"`,
    node.label ? `label="${escapeXml(node.label)}"` : "",
    node.parentSourceKey ? `parentSourceKey="${escapeXml(node.parentSourceKey)}"` : ""
  ]
    .filter(Boolean)
    .join(" ")

  const lines = [`${indent}<node ${attrs}>`]
  lines.push(`${indent}  <prompt>${escapeXml(node.text)}</prompt>`)

  if (node.anchorText && node.anchorText !== node.text) {
    lines.push(`${indent}  <anchor>${escapeXml(node.anchorText)}</anchor>`)
  }

  const numericMarksValue = Number(node.marks?.value)
  const hasNumericMarksValue = Number.isFinite(numericMarksValue) && numericMarksValue > 0
  if (node.marks?.raw || hasNumericMarksValue) {
    const marksAttrs = [
      node.marks?.raw ? `raw="${escapeXml(node.marks.raw)}"` : "",
      hasNumericMarksValue ? `value="${String(numericMarksValue)}"` : "",
      node.marks?.unit ? `unit="${escapeXml(node.marks.unit)}"` : "",
      node.marks?.each ? `each="true"` : ""
    ]
      .filter(Boolean)
      .join(" ")
    lines.push(`${indent}  <marks ${marksAttrs} />`)
  }

  const responseTypes = uniqueTypes(node.responseModel?.responseTypes)
  lines.push(
    `${indent}  <response primaryType="${escapeXml(derivePrimaryType(responseTypes))}" mixed="${responseTypes.length > 1 ? "true" : "false"}" types="${escapeXml(responseTypes.join(","))}" />`
  )

  if (Array.isArray(node.options) && node.options.length > 0) {
    lines.push(`${indent}  <options>`)
    for (const option of node.options) {
      lines.push(
        `${indent}    <option key="${escapeXml(option.key)}">${escapeXml(option.text)}</option>`
      )
    }
    lines.push(`${indent}  </options>`)
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    lines.push(`${indent}  <children>`)
    for (const child of node.children) {
      lines.push(serializeNodeXml(child, indentLevel + 2))
    }
    lines.push(`${indent}  </children>`)
  }

  lines.push(`${indent}</node>`)
  return lines.join("\n")
}

export function parseWorksheetPagesToModel(worksheetPages, options = {}) {
  const pages = Array.isArray(worksheetPages) ? worksheetPages : []
  const title = clampText(options?.title || "", 220)
  const modelPages = pages
    .map((page) => parseWorksheetPage(page, options))
    .filter((page) => Array.isArray(page?.nodes) && page.nodes.length > 0)
  const nodeCount = modelPages.reduce((sum, page) => {
    const flat = []
    flattenNodes(page.nodes, flat, Number.MAX_SAFE_INTEGER)
    return sum + flat.length
  }, 0)
  return {
    schemaVersion: "1.0",
    title,
    pageCount: modelPages.length,
    nodeCount,
    pages: modelPages
  }
}

export function flattenWorksheetModelToQuestions(model, options = {}) {
  const maxItems = Number.isFinite(Number(options?.maxItems))
    ? Math.max(1, Math.floor(Number(options.maxItems)))
    : DEFAULT_MAX_ITEMS
  const output = []
  const pages = Array.isArray(model?.pages) ? model.pages : []
  for (const page of pages) {
    flattenNodes(page?.nodes, output, maxItems)
    if (output.length >= maxItems) {
      break
    }
  }
  return output
}

export function serializeWorksheetModelAsXml(model) {
  const title = clampText(model?.title || "", 220)
  const pages = Array.isArray(model?.pages) ? model.pages : []
  const lines = [
    `<worksheet schemaVersion="${escapeXml(normalizeText(model?.schemaVersion) || "1.0")}" title="${escapeXml(title)}" pageCount="${String(pages.length)}">`
  ]
  for (const page of pages) {
    const pageIndex = parsePageIndex(page?.pageIndex)
    lines.push(`  <page index="${String(pageIndex)}">`)
    const nodes = Array.isArray(page?.nodes) ? page.nodes : []
    for (const node of nodes) {
      lines.push(serializeNodeXml(node, 2))
    }
    lines.push("  </page>")
  }
  lines.push("</worksheet>")
  return lines.join("\n")
}
