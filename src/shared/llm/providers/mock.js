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

export async function generate(task, input = {}) {
  const normalizedTask = normalizeText(task).toLowerCase()
  const selectedText = normalizeText(input.selectedText) || "this selection"
  const title = normalizeText(input.title)
  const sectionTitle = normalizeText(input.grounding?.sectionTitle)
  const seed = hashString(`${normalizedTask}|${selectedText}|${title}|${sectionTitle}`)

  if (normalizedTask === "quant") {
    return makeQuantResponse(seed, selectedText)
  }
  if (normalizedTask === "definition") {
    return makeDefinitionResponse(seed, selectedText)
  }
  return makeExplanationResponse(seed, selectedText)
}
