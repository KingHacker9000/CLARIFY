export function buildMatrixRowFillInput(overrides = {}) {
  return {
    title: "Adaptive Decision Trees for Research Screening",
    selectedText: "Adaptive Decision Trees for Research Screening",
    contextWindow:
      "Paper source URL: https://arxiv.org/pdf/2412.12093. Extract concise method and outcome signals for matrix criteria.",
    snippet:
      "Paper source URL: https://arxiv.org/pdf/2412.12093. Use available context and mark missing evidence when needed.",
    projectBrief: "Compare methods for literature screening and extraction reliability.",
    projectKeyTerms: ["screening", "literature review", "matrix extraction"],
    projectRubric: ["Method", "Evidence quality", "Limitations"],
    matrixColumns: [
      {
        columnId: "paper_key",
        label: "Paper",
        type: "text",
        description: "Canonical paper key",
        clusterEnabled: false
      },
      {
        columnId: "method",
        label: "Method",
        type: "text",
        description: "Core approach described by the paper",
        clusterEnabled: true
      },
      {
        columnId: "outcome",
        label: "Outcome",
        type: "text",
        description: "Main result in one sentence",
        clusterEnabled: true
      },
      {
        columnId: "confidence_band",
        label: "Confidence band",
        type: "categorical",
        description: "High/Medium/Low confidence interpretation",
        clusterEnabled: false
      }
    ],
    ...overrides
  }
}
