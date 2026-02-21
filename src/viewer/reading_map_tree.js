function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

function parsePageIndex(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null
  }
  return Math.floor(numeric)
}

function parseLevel(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 1
  }
  return Math.max(1, Math.floor(numeric))
}

function normalizeSectionKeyTitle(title) {
  return normalizeText(title).toLowerCase()
}

function getSectionKey(section) {
  const title = normalizeText(section?.title || section?.displayTitle)
  const pageIndex = parsePageIndex(section?.pageIndex)
  const level = parseLevel(section?.level)
  if (!title || pageIndex == null) {
    return ""
  }
  return `${pageIndex}:${level}:${normalizeSectionKeyTitle(title)}`
}

function normalizeSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map((section) => {
      const title = normalizeText(section?.title || section?.displayTitle)
      const pageIndex = parsePageIndex(section?.pageIndex)
      const level = parseLevel(section?.level)
      if (!title || pageIndex == null) {
        return null
      }
      return {
        key: getSectionKey({ title, pageIndex, level }),
        title,
        pageIndex,
        level,
        children: [],
        hasChildren: false
      }
    })
    .filter(Boolean)
}

export function buildSectionTree(sections) {
  const normalized = normalizeSections(sections)
  const roots = []
  const stack = []

  for (const node of normalized) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop()
    }

    if (stack.length === 0) {
      roots.push(node)
    } else {
      const parent = stack[stack.length - 1]
      parent.children.push(node)
      parent.hasChildren = true
    }
    stack.push(node)
  }

  return roots
}
