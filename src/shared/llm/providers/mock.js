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

function makeProjectRelevanceResponse(seed, input) {
  const projectBrief = normalizeText(input.projectBrief)
  const paperTitle = normalizeText(input.title) || "this paper"
  const keyTerms = Array.isArray(input.projectKeyTerms) ? input.projectKeyTerms.map((term) => normalizeText(term)) : []
  const score = 45 + (seed % 45)
  const recommendation = score >= 75 ? "include" : score <= 56 ? "exclude" : "review"
  const matchedTerm = keyTerms.find(Boolean) || "project goals"
  return {
    fitScore: score,
    recommendation,
    relevanceSummary: projectBrief
      ? `${paperTitle} appears ${recommendation === "include" ? "well aligned" : recommendation === "exclude" ? "weakly aligned" : "partially aligned"} with the project brief, especially around ${matchedTerm}.`
      : `${paperTitle} has ${recommendation === "include" ? "strong" : recommendation === "exclude" ? "limited" : "mixed"} alignment with the current project goals.`,
    methodMatch: `Method alignment is strongest around ${matchedTerm}, with remaining uncertainty in dataset comparability.`,
    gapsOrRisks: [
      "Evaluation details may be insufficient for direct transfer.",
      "Need confirmation that datasets and constraints match project scope."
    ],
    recommendedSections: ["Introduction", "Method", "Results", "Limitations"],
    groundingPages: [0, 1].slice(0, recommendation === "exclude" ? 1 : 2),
    groundingQuotes: [
      `Quoted evidence for ${paperTitle} and ${matchedTerm}.`,
      "Additional evidence should be verified in the results section."
    ].slice(0, recommendation === "exclude" ? 1 : 2)
  }
}

function makeProjectCompareResponse(seed, papers, rubric) {
  const safePapers = Array.isArray(papers) ? papers.filter((paper) => normalizeText(paper?.paperId)) : []
  const criteria = Array.isArray(rubric) && rubric.length > 0 ? rubric : ["Method fit", "Dataset fit", "Evidence quality"]
  const columns = ["Criterion", ...safePapers.map((paper) => normalizeText(paper.title) || normalizeText(paper.paperId))]
  const rows = criteria.slice(0, 12).map((criterion, index) => ({
    criterion: normalizeText(criterion) || `Criterion ${index + 1}`,
    cells: safePapers.map((paper, paperIndex) => ({
      paperId: normalizeText(paper.paperId) || `paper_${paperIndex + 1}`,
      value:
        (seed + index + paperIndex) % 3 === 0
          ? "Strong support with explicit evidence."
          : (seed + index + paperIndex) % 3 === 1
            ? "Moderate support; needs deeper validation."
            : "Limited evidence for this criterion.",
      groundingPage: Math.max(0, (index + paperIndex) % 4),
      groundingQuote: `Mock evidence snippet for ${normalizeText(paper.title) || normalizeText(paper.paperId)}.`
    }))
  }))

  return {
    columns,
    rows,
    crossPaperInsights: [
      "Most papers agree on baseline direction but differ in effect size.",
      "Method families cluster into stronger and weaker evidence groups."
    ],
    contradictions: ["One paper reports opposite behavior under a narrower setting."],
    evidenceGaps: ["Ablation or robustness evidence is missing in at least one compared paper."]
  }
}

function makeProjectMatrixRowFillResponse(seed, input) {
  const columns = Array.isArray(input.matrixColumns) ? input.matrixColumns : []
  const cells = []
  const hiddenFeatures = []
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]
    const columnId = normalizeText(column?.columnId || column?.id)
    if (!columnId || columnId === "paper_key") {
      continue
    }
    const label = normalizeText(column?.label || columnId)
    const type = normalizeText(column?.type || "categorical").toLowerCase()
    let value = ""
    if (type === "numeric") {
      value = String(1 + ((seed + index) % 5))
    } else if (type === "boolean") {
      value = (seed + index) % 2 === 0 ? "Yes" : "No"
    } else if (type === "text") {
      value = `Mock summary for ${label.toLowerCase()}.`
      hiddenFeatures.push({
        columnId,
        tags: ["baseline", (seed + index) % 2 === 0 ? "high-fit" : "medium-fit"]
      })
    } else {
      value = pick(seed + index, ["High", "Medium", "Low", "Mixed"])
    }
    cells.push({
      columnId,
      value,
      confidence: 0.62 + ((seed + index) % 30) / 100,
      evidenceSnippet: `Mock evidence for ${label}.`,
      evidencePage: Math.max(0, (seed + index) % 4),
      insufficientReason: ""
    })
  }
  return {
    cells,
    hiddenFeatures,
    warnings: ["Mock provider used for matrix row fill."]
  }
}

function makeProjectScreeningSuggestResponse(seed, input) {
  const reasons = Array.isArray(input.screenReasonLibrary)
    ? input.screenReasonLibrary
        .map((reason) => ({
          code: normalizeText(reason?.code),
          label: normalizeText(reason?.label)
        }))
        .filter((reason) => reason.code || reason.label)
    : []
  const projectTerms = Array.isArray(input.projectKeyTerms)
    ? input.projectKeyTerms.map((term) => normalizeText(term)).filter(Boolean)
    : []
  const term = projectTerms[seed % Math.max(projectTerms.length, 1)] || "project scope"
  const decisionCycle = ["include", "needs_info", "exclude", "review"]
  const decisionSuggestion = decisionCycle[seed % decisionCycle.length]
  const selectedReasons =
    reasons.length > 0
      ? reasons.slice(0, Math.min(2, reasons.length)).map((reason) => reason.code || reason.label)
      : decisionSuggestion === "exclude"
        ? ["out_of_scope"]
        : decisionSuggestion === "needs_info"
          ? ["no_full_text"]
          : ["review"]

  return {
    decisionSuggestion,
    confidence: 0.55 + ((seed % 35) / 100),
    reasonCandidates: selectedReasons,
    evidenceSnippet:
      decisionSuggestion === "exclude"
        ? `Title/abstract indicates weak alignment with ${term}.`
        : decisionSuggestion === "needs_info"
          ? `Title appears relevant to ${term}, but evidence details are incomplete.`
          : `Title/abstract suggests alignment with ${term} and likely inclusion value.`,
    evidencePage: 0,
    insufficientReason: decisionSuggestion === "review" ? "Abstract context is too limited for a firm decision." : ""
  }
}

function makeProjectContributionMapResponse(seed, input) {
  const matrixRows = Array.isArray(input.matrixRows) ? input.matrixRows : []
  const matrixColumns = Array.isArray(input.matrixColumns) ? input.matrixColumns : []
  const clusterIds = Array.from(
    new Set(
      matrixRows
        .map((row) => Number(row?.clusterId))
        .filter((clusterId) => Number.isFinite(clusterId) && clusterId >= 0)
        .map((clusterId) => Math.floor(clusterId))
    )
  ).slice(0, 8)

  const clustersSummary =
    clusterIds.length > 0
      ? clusterIds.map((clusterId, index) => ({
          label: `Cluster ${clusterId}`,
          summary:
            index % 2 === 0
              ? "Concentrates on established methods with broad evaluation coverage."
              : "Shows specialized setups with narrower evidence coverage.",
          confidence: 0.58 + ((seed + index) % 25) / 100
        }))
      : [
          {
            label: "Unclustered set",
            summary: "Current matrix rows are sparse; run clustering after filling more columns.",
            confidence: 0.62
          }
        ]

  const featureLabel =
    normalizeText(matrixColumns.find((column) => column?.clusterEnabled)?.label) ||
    normalizeText(matrixColumns[0]?.label) ||
    "method-task-data features"

  const underexploredZones = [
    {
      label: `Low-density combinations in ${featureLabel}`,
      summary: "Few rows cover this combination; candidate area for a focused contribution experiment.",
      confidence: 0.66
    },
    {
      label: "Cross-domain transfer claims",
      summary: "Claims appear in summaries but supporting comparative evidence is limited.",
      confidence: 0.61
    }
  ]

  const differentiationIdeas = [
    {
      label: "Target underrepresented regime",
      summary: "Design experiments on low-density combinations and benchmark against nearest cluster baselines.",
      confidence: 0.7
    },
    {
      label: "Resolve contradiction zone",
      summary: "Prioritize settings where reported gains conflict and run controlled ablations.",
      confidence: 0.65
    }
  ]

  const evidenceLinks = matrixRows.slice(0, 12).map((row, index) => {
    const firstCell = Array.isArray(row?.cells) ? row.cells.find((cell) => normalizeText(cell?.value)) : null
    return {
      label: normalizeText(row?.paperKey) || `Row ${index + 1}`,
      rowId: normalizeText(row?.rowId || row?.id),
      clusterId: Number.isFinite(Number(row?.clusterId)) ? Math.floor(Number(row.clusterId)) : null,
      columnId: normalizeText(firstCell?.columnId),
      value: normalizeText(firstCell?.value)
    }
  })

  return {
    clustersSummary,
    underexploredZones,
    differentiationIdeas,
    evidenceLinks
  }
}

function makeLiteratureImportResponse(seed, input) {
  const projectNameBase = normalizeText(input.documentName) || "Imported literature review"
  const papers = []
  const sourcePapers = Array.isArray(input.seedPapers) ? input.seedPapers : []
  for (let index = 0; index < sourcePapers.length; index += 1) {
    const entry = sourcePapers[index]
    const title = normalizeText(entry?.title)
    if (!title) {
      continue
    }
    papers.push({
      title,
      url: normalizeText(entry?.url),
      authors: Array.isArray(entry?.authors) ? entry.authors.map((author) => normalizeText(author)).filter(Boolean) : [],
      year: Number.isFinite(Number(entry?.year)) ? Math.floor(Number(entry.year)) : null,
      venue: normalizeText(entry?.venue),
      tags: Array.isArray(entry?.tags) ? entry.tags.map((tag) => normalizeText(tag)).filter(Boolean) : [],
      status: "queued",
      priority: 2,
      notes: normalizeText(entry?.notes),
      arxivId: normalizeText(entry?.arxivId),
      doi: normalizeText(entry?.doi),
      confidence: "medium",
      searchQuery: normalizeText(entry?.searchQuery)
    })
  }

  if (papers.length === 0) {
    papers.push(
      {
        title: "Attention Is All You Need",
        url: "https://arxiv.org/pdf/1706.03762.pdf",
        authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
        year: 2017,
        venue: "NeurIPS",
        tags: ["transformers", "nlp"],
        status: "queued",
        priority: 2,
        notes: "Found from imported literature notes.",
        arxivId: "1706.03762",
        doi: "",
        confidence: "high",
        searchQuery: ""
      },
      {
        title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
        url: "",
        authors: ["Jacob Devlin", "Ming-Wei Chang", "Kenton Lee", "Kristina Toutanova"],
        year: 2018,
        venue: "NAACL",
        tags: ["nlp", "pretraining"],
        status: "queued",
        priority: 2,
        notes: "No direct PDF in source notes.",
        arxivId: "1810.04805",
        doi: "",
        confidence: "medium",
        searchQuery: "BERT pre-training language understanding pdf"
      }
    )
  }

  const maxPapers = Number.isFinite(Number(input.maxImportedPapers))
    ? Math.max(1, Math.floor(Number(input.maxImportedPapers)))
    : 120

  return {
    project: {
      name: input.importMode === "new_project" ? projectNameBase : "",
      researchQuestion: "What evidence trends appear across imported prior work?",
      objective: "Bootstrap the literature review workspace from existing notes.",
      scopeNotes: "This project metadata was inferred from imported document content.",
      keyTerms: ["literature review", "evidence synthesis", "screening"],
      rubric: ["Method fit", "Evidence quality", "Relevance to objective"]
    },
    papers: papers.slice(0, maxPapers),
    warnings: seed % 2 === 0 ? ["Mock provider used for literature import extraction."] : []
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
  const projectBrief = normalizeText(input.projectBrief)
  const projectKeyTerms = Array.isArray(input.projectKeyTerms)
    ? input.projectKeyTerms.map((term) => normalizeText(term)).filter(Boolean)
    : []
  const projectRubric = Array.isArray(input.projectRubric)
    ? input.projectRubric.map((item) => normalizeText(item)).filter(Boolean)
    : []
  const papers = Array.isArray(input.papers)
    ? input.papers.map((paper, index) => ({
        paperId: normalizeText(paper?.paperId) || `paper_${index + 1}`,
        title: normalizeText(paper?.title),
        summary: normalizeText(paper?.summary),
        status: normalizeText(paper?.status),
        tags: Array.isArray(paper?.tags) ? paper.tags.map((tag) => normalizeText(tag)).filter(Boolean) : []
      }))
    : []
  const matrixColumns = Array.isArray(input.matrixColumns)
    ? input.matrixColumns.map((column, index) => ({
        columnId: normalizeText(column?.columnId || column?.id) || `col_${index + 1}`,
        label: normalizeText(column?.label || ""),
        type: normalizeText(column?.type || "categorical").toLowerCase(),
        clusterEnabled: column?.clusterEnabled !== false
      }))
    : []
  const screenReasonLibrary = Array.isArray(input.screenReasonLibrary)
    ? input.screenReasonLibrary.map((reason) => ({
        code: normalizeText(reason?.code),
        label: normalizeText(reason?.label),
        description: normalizeText(reason?.description)
      }))
    : []
  const matrixRows = Array.isArray(input.matrixRows)
    ? input.matrixRows.map((row, index) => ({
        rowId: normalizeText(row?.rowId || row?.id) || `row_${index + 1}`,
        paperKey: normalizeText(row?.paperKey || ""),
        clusterId: Number.isFinite(Number(row?.clusterId)) ? Math.floor(Number(row.clusterId)) : null,
        cells: Array.isArray(row?.cells)
          ? row.cells.map((cell) => ({
              columnId: normalizeText(cell?.columnId || ""),
              label: normalizeText(cell?.label || ""),
              value: normalizeText(cell?.value || "")
            }))
          : []
      }))
    : []
  const importMode = input.importMode === "new_project" ? "new_project" : "active_project"
  const importDocumentName = normalizeText(input.importDocumentName || title)
  const importDocumentType = normalizeText(input.importDocumentType)
  const maxImportedPapers = Number.isFinite(Number(input.maxImportedPapers))
    ? Math.max(10, Math.min(220, Math.floor(Number(input.maxImportedPapers))))
    : 120
  const pageIndex = Number.isFinite(Number(input.pageIndex)) ? Math.max(0, Math.floor(Number(input.pageIndex))) : 0
  const seed = hashString(
    `${normalizedTask}|${selectedText}|${title}|${sectionTitle}|${headings.join("|")}|${readingMode}|${snippet}|${pageIndex}|${questionText}|${gradeLevel}|${projectBrief}|${projectKeyTerms.join("|")}|${projectRubric.join("|")}|${papers.map((paper) => paper.paperId).join("|")}|${importMode}|${importDocumentName}|${importDocumentType}|${maxImportedPapers}`
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
  if (normalizedTask === "project_relevance") {
    return makeProjectRelevanceResponse(seed, {
      title,
      projectBrief,
      projectKeyTerms
    })
  }
  if (normalizedTask === "project_compare_table") {
    return makeProjectCompareResponse(seed, papers, projectRubric)
  }
  if (normalizedTask === "project_matrix_row_fill") {
    return makeProjectMatrixRowFillResponse(seed, {
      matrixColumns
    })
  }
  if (normalizedTask === "project_screening_suggest") {
    return makeProjectScreeningSuggestResponse(seed, {
      projectKeyTerms,
      screenReasonLibrary
    })
  }
  if (normalizedTask === "project_contribution_map") {
    return makeProjectContributionMapResponse(seed, {
      matrixColumns,
      matrixRows
    })
  }
  if (normalizedTask === "literature_import") {
    return makeLiteratureImportResponse(seed, {
      importMode,
      documentName: importDocumentName,
      documentType: importDocumentType,
      maxImportedPapers,
      seedPapers: []
    })
  }
  if (normalizedTask === "definition") {
    return makeDefinitionResponse(seed, selectedText)
  }
  return makeExplanationResponse(seed, selectedText)
}
