function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
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

function capWords(value, maxWords = 35) {
  const text = normalizeText(value)
  if (!text) {
    return ""
  }
  const words = text.split(" ")
  if (words.length <= maxWords) {
    return text
  }
  return `${words.slice(0, maxWords).join(" ")}...`
}

function makeDefinitionResponse(seed, selectedText) {
  const intros = [
    "In this paper,",
    "Here,",
    "In context,",
    "For this section,",
    "At this point,"
  ]
  const connectors = [
    "is used as the core idea behind the argument.",
    "labels the mechanism the authors rely on.",
    "acts as a compact name for the method.",
    "frames how results should be interpreted.",
    "anchors the claim being tested."
  ]

  return {
    shortAnswer: capWords(
      `${pick(seed, intros)} ${selectedText} ${pick(seed, connectors, 3)}`,
      35
    ),
    eli5: `${selectedText} is the paper's shortcut label for the main concept being discussed.`,
    steps: [
      `Find where ${selectedText} is first defined in the paragraph.`,
      "Note what variables or assumptions are attached to it.",
      "Track where later claims refer back to that definition."
    ],
    paperUsage: [
      "Introduced to set shared terminology.",
      "Referenced when interpreting evidence.",
      "Used to connect methods to conclusions."
    ]
  }
}

function makeExplanationResponse(seed, selectedText) {
  const verbs = ["connects", "explains", "supports", "links", "motivates"]
  const outcomes = [
    "the paper's main claim.",
    "why the method works.",
    "how evidence is interpreted.",
    "the transition between results and conclusion.",
    "the comparison with prior work."
  ]

  return {
    shortAnswer: capWords(
      `${selectedText} ${pick(seed, verbs)} ${pick(seed, outcomes, 2)}`,
      35
    ),
    eli5: `Think of ${selectedText} as the bridge between what the authors measured and what they conclude.`,
    steps: [
      "Identify the claim directly before this sentence.",
      "Check the evidence directly after it.",
      "Confirm whether assumptions are stated or implied."
    ],
    paperUsage: [
      "Clarifies the reasoning path for readers.",
      "Justifies interpretation of experimental results.",
      "Provides context for section-level conclusions."
    ]
  }
}

function makeQuantResponse(seed, selectedText) {
  const signals = [
    "trend direction",
    "relative differences",
    "uncertainty bands",
    "baseline comparison",
    "outlier behavior"
  ]
  const claimLinks = [
    "the method improves performance under the tested setup.",
    "the proposed approach is more stable than baseline.",
    "the effect size is meaningful, not random noise.",
    "the visual evidence matches the written conclusion.",
    "the hypothesis is supported in the reported regime."
  ]

  return {
    shortAnswer: capWords(
      `This figure shows ${selectedText} with emphasis on ${pick(seed, signals)}, highlighting how the reported pattern supports interpretation.`,
      35
    ),
    eli5: `This chart is showing what changes, and ${selectedText} tells you where the important pattern is.`,
    steps: [
      "Read axis labels and units first.",
      "Compare curves/bars against baseline.",
      "Check error bars or confidence intervals."
    ],
    paperUsage: [
      "Used as visual evidence for a key result.",
      "Supports the section's quantitative argument.",
      "Provides a quick comparison against alternatives."
    ],
    whatItShows: `A quantitative view of ${selectedText} and how values change across conditions.`,
    takeaway: `The main signal is ${pick(seed, signals, 1)}, which drives the interpretation.`,
    supportsClaim: `This supports the claim that ${pick(seed, claimLinks, 4)}`,
    whatToLookAt: [
      "Axis scale and unit consistency.",
      "Largest gap between compared conditions.",
      "Whether uncertainty overlaps between groups."
    ]
  }
}

export function mockExplain({ type, selectedText, contextWindow }) {
  const normalizedType = normalizeText(type).toLowerCase()
  const normalizedSelection = normalizeText(selectedText) || "this selection"
  const seed = hashString(`${normalizedType}|${normalizedSelection}`)
  void contextWindow

  if (normalizedType === "quant") {
    return makeQuantResponse(seed, normalizedSelection)
  }
  if (normalizedType === "definition") {
    return makeDefinitionResponse(seed, normalizedSelection)
  }
  return makeExplanationResponse(seed, normalizedSelection)
}
