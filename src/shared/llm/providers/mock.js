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
    .replace(/(^|[^A-Za-z0-9])(\d+\.)\s+(?=[A-Z])/g, (_match, prefix, marker) => `${prefix}\n${marker} `)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function hashString(input) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function pick(seed, items, offset = 0) {
  if (!Array.isArray(items) || items.length === 0) {
    return ""
  }
  return items[(seed + offset) % items.length]
}

function makeDefinitionResponse(seed, selectedText) {
  const intros = ["In this section,", "In context,", "For this paper,", "Here,", "At this point,"]
  const endings = [
    "names the core concept used to interpret the evidence.",
    "is the term anchoring how the result is read.",
    "acts as the shared label for the method idea.",
    "frames the key concept tied to the claim.",
    "is the definition future arguments point back to."
  ]

  return {
    shortAnswer: `${pick(seed, intros)} ${selectedText} ${pick(seed, endings, 2)}`,
    eli5: `${selectedText} is the paper's simple name for the main idea in this part.`,
    steps: [
      `Find where ${selectedText} is first introduced.`,
      "Note the assumptions attached to that definition.",
      "Track where later claims reuse the term."
    ],
    paperUsage: [
      "Sets common terminology for the section.",
      "Connects methods to interpretation.",
      "Supports later argument steps."
    ]
  }
}

function makeExplanationResponse(seed, selectedText) {
  const verbs = ["explains", "supports", "connects", "motivates", "clarifies"]
  const outcomes = [
    "the section's main claim.",
    "why the reported method works.",
    "how the evidence should be interpreted.",
    "the transition from result to conclusion.",
    "the comparison against baseline."
  ]

  return {
    shortAnswer: `${selectedText} ${pick(seed, verbs)} ${pick(seed, outcomes, 1)}`,
    eli5: `${selectedText} is the bridge between what was measured and what the authors conclude.`,
    steps: [
      "Read the claim before this sentence.",
      "Check the evidence immediately after it.",
      "Confirm assumptions are explicit."
    ],
    paperUsage: [
      "Clarifies the reasoning chain.",
      "Links evidence to conclusions.",
      "Improves section-level interpretability."
    ]
  }
}

function makeQuantResponse(seed, selectedText) {
  const signals = [
    "relative differences",
    "trend direction",
    "uncertainty overlap",
    "baseline gap",
    "outlier behavior"
  ]
  const claims = [
    "the method improves outcomes under the reported setup.",
    "the effect is consistent rather than random.",
    "the visual trend matches the written conclusion.",
    "the proposed approach outperforms baseline conditions.",
    "the measured change is large enough to matter."
  ]

  return {
    shortAnswer: `The figure summarizes ${selectedText} and emphasizes ${pick(seed, signals)} to support interpretation.`,
    whatItShows: `A quantitative view of ${selectedText} across the compared conditions.`,
    takeaway: `The dominant signal is ${pick(seed, signals, 2)}, which drives the conclusion.`,
    supportsClaim: [
      `Supports the claim that ${pick(seed, claims, 3)}`,
      "Shows the reported effect in the plotted data."
    ],
    whatToLookAt: [
      "Axis labels, units, and scale.",
      "Largest gap between compared groups.",
      "Whether uncertainty ranges overlap."
    ]
  }
}

function makeOrientationResponse(seed, title, headings, readingMode) {
  const normalizedTitle = normalizeText(title) || "this paper"
  const headingList = Array.isArray(headings) ? headings.filter(Boolean) : []
  const mode = readingMode === "structure" ? "structure" : "flow"
  const defaultSectionIntents = headingList.slice(0, 8).map((heading, index) => ({
    title: heading,
    intent:
      index === 0
        ? "Sets context and frames the paper's main problem."
        : index % 3 === 1
          ? "Defines the method and key assumptions to track while reading."
          : index % 3 === 2
            ? "Presents results and how they support the core claim."
            : "Summarizes implications and limits."
  }))

  return {
    purpose: `${normalizedTitle} explains the problem setting and the approach used to address it with evidence from the paper.`,
    contribution:
      mode === "structure"
        ? "Its main contribution is a clearly organized method-to-results chain that is easiest to follow section by section."
        : "Its main contribution is a practical method and evidence pattern you can understand quickly before drilling into details.",
    focusBullets: [
      "Read the stated problem and assumptions first.",
      "Track the exact method components and where they are introduced.",
      "Compare claims against reported evidence and uncertainty.",
      mode === "structure"
        ? "Use section transitions to verify how conclusions are supported."
        : "Capture one takeaway per section before moving on."
    ],
    keyTerms: [
      "problem setup",
      "assumptions",
      "method",
      "baseline",
      "evaluation",
      "results",
      "limitations",
      "conclusion"
    ],
    sectionIntents:
      defaultSectionIntents.length > 0
        ? defaultSectionIntents
        : [
            { title: "Introduction", intent: "Frames the problem and why it matters." },
            { title: "Method", intent: "Describes the proposed approach and design choices." },
            { title: "Results", intent: "Shows empirical outcomes and comparisons." },
            { title: "Conclusion", intent: "Summarizes contributions and practical implications." }
          ]
  }
}

function makeSectionIntentsResponse(seed, sections) {
  const safeSections = Array.isArray(sections) ? sections : []
  const intents = []
  for (let index = 0; index < safeSections.length; index += 1) {
    const section = safeSections[index]
    const sectionKey = normalizeText(section?.sectionKey)
    const title = normalizeText(section?.title) || `Section ${index + 1}`
    if (!sectionKey) {
      continue
    }
    const lowerTitle = title.toLowerCase()
    if (
      /\breferences?\b/.test(lowerTitle) ||
      /\bbibliograph/.test(lowerTitle) ||
      /\bappendix\b/.test(lowerTitle) ||
      /\backnowledg(e)?ments?\b/.test(lowerTitle) ||
      /\bsupplement(ar(y|al))?\b/.test(lowerTitle)
    ) {
      intents.push({
        sectionKey,
        intent: `Usually skippable on a time budget; scan ${title} only if you need citations or extra implementation details.`
      })
      continue
    }
    const variant = (seed + index) % 4
    let intent = ""
    if (variant === 0) {
      intent = `Read this section to understand ${title} and how it fits the paper's argument.`
    } else if (variant === 1) {
      intent = `This section explains ${title}, focusing on assumptions, setup, and why it matters.`
    } else if (variant === 2) {
      intent = `Use this section to capture the main point of ${title} before moving forward.`
    } else {
      intent = `This section provides key evidence or context related to ${title}.`
    }
    intents.push({
      sectionKey,
      intent
    })
  }
  return { intents }
}

function makeSingleSectionIntentResponse(seed, title, snippet, pageIndex) {
  const normalizedTitle = normalizeText(title) || `Section ${Math.max(1, pageIndex + 1)}`
  const normalizedSnippet = normalizeText(snippet)
  const lowerTitle = normalizedTitle.toLowerCase()
  if (
    /\breferences?\b/.test(lowerTitle) ||
    /\bbibliograph/.test(lowerTitle) ||
    /\bappendix\b/.test(lowerTitle) ||
    /\backnowledg(e)?ments?\b/.test(lowerTitle) ||
    /\bsupplement(ar(y|al))?\b/.test(lowerTitle)
  ) {
    return { intent: `Usually skippable unless you need citations or implementation details from ${normalizedTitle}.` }
  }

  const variant = seed % 4
  if (variant === 0) {
    return { intent: `Read ${normalizedTitle} for the core claim and how evidence is presented.` }
  }
  if (variant === 1) {
    return { intent: `Use ${normalizedTitle} to track assumptions, setup, and why this step matters.` }
  }
  if (variant === 2) {
    return {
      intent: normalizedSnippet
        ? `This section clarifies ${normalizedTitle} and highlights key context before later results.`
        : `This section introduces ${normalizedTitle} and its role in the paper's argument.`
    }
  }
  return { intent: `Capture one takeaway from ${normalizedTitle} before moving to the next section.` }
}

function splitWorksheetCandidates(pageText) {
  const lines = structureWorksheetText(pageText)
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
  const candidates = []
  for (const line of lines) {
    if (line.length < 6) {
      continue
    }
    if (/[?]$/.test(line)) {
      candidates.push(line)
      continue
    }
    if (/^\(?\d+[.)]\s+/.test(line) || /^[A-Za-z][.)]\s+/.test(line)) {
      candidates.push(line)
      continue
    }
    if (/\b(explain|describe|define|calculate|solve|identify|compare|list)\b/i.test(line)) {
      candidates.push(line)
    }
  }
  return candidates
}

function parseWorksheetMarks(text) {
  const source = normalizeText(text)
  if (!source) {
    return { marksRaw: "", marksValue: null, marksEach: false }
  }
  const match =
    source.match(/\((\d+(?:\.\d+)?)\s*(marks?|points?|pts?)\)/i) ||
    source.match(/\[(\d+(?:\.\d+)?)\s*(marks?|points?|pts?)\]/i) ||
    source.match(/(?:^|[\s-])(\d+(?:\.\d+)?)\s*(marks?|points?|pts?)(?:\b|$)/i)
  if (!match?.[0]) {
    return { marksRaw: "", marksValue: null, marksEach: false }
  }
  const numeric = Number(match[1])
  return {
    marksRaw: normalizeText(match[0]),
    marksValue: Number.isFinite(numeric) ? numeric : null,
    marksEach: /\beach\b/i.test(source)
  }
}

function inferWorksheetQuestionTypes(text) {
  const source = normalizeText(text).toLowerCase()
  const types = []
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
    /\bmultiple\s+answers?\b/.test(source)
  ) {
    types.push("multi_select")
  } else if (/\bselect\s+one\b/.test(source) || /\bone option\b/.test(source) || /\bchoose one\b/.test(source)) {
    types.push("mcq")
  }
  if (/\bfill in the blank\b/.test(source) || /_{3,}/.test(source)) {
    types.push("fill_blank")
  }
  if (/\btable\b/.test(source) && /\bdefinition\b/.test(source)) {
    types.push("table_definition")
  }
  if (/\bjustify\b|\bexplain\b|\bdescribe\b|\bwhy\b|\bhow\b/.test(source)) {
    types.push("long_answer")
  }
  if (!types.includes("mcq") && !types.includes("multi_select") && !types.includes("fill_blank")) {
    types.push("short_answer")
  }
  const dedupe = []
  for (const type of types) {
    if (!dedupe.includes(type)) {
      dedupe.push(type)
    }
  }
  return dedupe.length > 0 ? dedupe : ["unknown"]
}

function makeWorksheetQuestionsResponse(seed, worksheetPages) {
  const pages = Array.isArray(worksheetPages) ? worksheetPages : []
  const questions = []
  for (let pageOffset = 0; pageOffset < pages.length; pageOffset += 1) {
    const page = pages[pageOffset]
    const pageIndex = Number.isFinite(Number(page?.pageIndex)) ? Math.max(0, Math.floor(Number(page.pageIndex))) : 0
    const candidates = splitWorksheetCandidates(page?.text).slice(0, 12)
    for (let index = 0; index < candidates.length; index += 1) {
      const text = candidates[index]
      const gradeLevel =
        /\b(grade|class)\s*\d+\b/i.test(text)
          ? (text.match(/\b(grade|class)\s*\d+\b/i)?.[0] || "").replace(/\s+/g, " ")
          : ""
      const responseTypes = inferWorksheetQuestionTypes(text)
      const marks = parseWorksheetMarks(text)
      questions.push({
        questionText: text,
        pageIndex,
        gradeLevel,
        questionType: responseTypes[0] || "unknown",
        responseTypes,
        marksRaw: marks.marksRaw,
        marksValue: marks.marksValue,
        marksEach: marks.marksEach,
        options: []
      })
      if (questions.length >= 120) {
        return { questions }
      }
    }
  }
  return { questions }
}

function makeWorksheetAnswerResponse(seed, questionText, gradeLevel, snippet) {
  const question = normalizeText(questionText) || "Question"
  const grade = normalizeText(gradeLevel)
  const context = normalizeText(snippet)
  const hasMathPrompt = /\b(calculate|solve|find|sum|difference|product|equation|fraction|percent|ratio)\b/i.test(
    question
  )
  const hasDefinitionPrompt = /\b(define|what is|meaning|explain)\b/i.test(question)
  const answerLength = question.length <= 90 && !/\b(explain|describe|why|how)\b/i.test(question) ? "short" : "long"

  if (hasMathPrompt) {
    return {
      answer: (seed % 2 === 0 ? "Final answer: " : "") + "Use the given values and compute the required result.",
      answerLength
    }
  }
  if (hasDefinitionPrompt) {
    return {
      answer:
        grade && grade.toLowerCase().includes("grade 3")
          ? "A simple meaning in easy words."
          : "A precise definition based on the worksheet context.",
      answerLength
    }
  }
  if (context) {
    return {
      answer:
        answerLength === "short"
          ? "Direct answer from the worksheet context."
          : "Direct response written in assignment style using the worksheet context only.",
      answerLength
    }
  }
  return {
    answer: "Direct response based on available worksheet text.",
    answerLength
  }
}

export async function generate(task, input = {}) {
  const normalizedTask = normalizeText(task).toLowerCase()
  const selectedText = normalizeText(input.selectedText) || "this selection"
  const title = normalizeText(input.title)
  const sectionTitle = normalizeText(input.grounding?.sectionTitle)
  const headings = Array.isArray(input.headings)
    ? input.headings.map((item) => normalizeText(item)).filter(Boolean)
    : []
  const sections = Array.isArray(input.sections)
    ? input.sections.map((section) => ({
        sectionKey: normalizeText(section?.sectionKey),
        title: normalizeText(section?.title),
        snippet: normalizeText(section?.snippet),
        pageIndex: Number.isFinite(Number(section?.pageIndex))
          ? Math.max(0, Math.floor(Number(section.pageIndex)))
          : 0
      }))
    : []
  const worksheetPages = Array.isArray(input.worksheetPages)
    ? input.worksheetPages.map((entry) => ({
        pageIndex: Number.isFinite(Number(entry?.pageIndex))
          ? Math.max(0, Math.floor(Number(entry.pageIndex)))
          : 0,
        text: structureWorksheetText(entry?.text)
      }))
    : []
  const readingMode =
    input.readingMode === "structure" || input.readingMode === "worksheet" ? input.readingMode : "flow"
  const questionText = normalizeText(input.questionText)
  const gradeLevel = normalizeText(input.gradeLevel)
  const snippet = normalizeText(input.snippet)
  const pageIndex = Number.isFinite(Number(input.pageIndex)) ? Math.max(0, Math.floor(Number(input.pageIndex))) : 0
  const seed = hashString(
    `${normalizedTask}|${selectedText}|${title}|${sectionTitle}|${headings.join("|")}|${readingMode}|${snippet}|${pageIndex}|${questionText}|${gradeLevel}`
  )

  if (normalizedTask === "quant") {
    return makeQuantResponse(seed, selectedText)
  }
  if (normalizedTask === "orientation") {
    return makeOrientationResponse(seed, title, headings, readingMode)
  }
  if (normalizedTask === "section_intents") {
    return makeSectionIntentsResponse(seed, sections)
  }
  if (normalizedTask === "section_intent") {
    return makeSingleSectionIntentResponse(seed, title, snippet, pageIndex)
  }
  if (normalizedTask === "worksheet_questions") {
    return makeWorksheetQuestionsResponse(seed, worksheetPages)
  }
  if (normalizedTask === "worksheet_answer") {
    return makeWorksheetAnswerResponse(seed, questionText, gradeLevel, snippet || input.contextWindow)
  }
  if (normalizedTask === "definition") {
    return makeDefinitionResponse(seed, selectedText)
  }
  return makeExplanationResponse(seed, selectedText)
}
