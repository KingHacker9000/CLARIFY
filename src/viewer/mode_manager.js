function normalizeMode(mode) {
  if (mode === "viewer") {
    return "viewer"
  }
  if (mode === "structure") {
    return "structure"
  }
  if (mode === "worksheet") {
    return "worksheet"
  }
  return "flow"
}

function getModeConfig(mode, settings) {
  const normalized = normalizeMode(mode)
  const maxCitations = Number.isFinite(Number(settings?.maxCitations))
    ? Math.max(1, Math.floor(Number(settings.maxCitations)))
    : 3

  if (normalized === "viewer") {
    return {
      mode: normalized,
      orientationCollapsed: true,
      walkthroughVisible: false,
      walkthroughProminent: false,
      defaultTab: "explain",
      cardDetailsOpenByDefault: false,
      maxGroundingQuotes: 1,
      autoGenerateOnLoad: false,
      autoBuildWalkthroughOnLoad: false,
      autoPrewarmOnLoad: false,
      showMicroActions: false,
      sidebarVisible: false,
      aiEnabled: false
    }
  }

  if (normalized === "structure") {
    return {
      mode: normalized,
      orientationCollapsed: false,
      walkthroughVisible: true,
      walkthroughProminent: true,
      defaultTab: "orientation",
      cardDetailsOpenByDefault: true,
      maxGroundingQuotes: Math.min(maxCitations, 3),
      autoGenerateOnLoad: true,
      autoBuildWalkthroughOnLoad: false,
      autoPrewarmOnLoad: true,
      showMicroActions: false,
      sidebarVisible: true,
      aiEnabled: true
    }
  }

  if (normalized === "worksheet") {
    return {
      mode: normalized,
      orientationCollapsed: true,
      walkthroughVisible: false,
      walkthroughProminent: false,
      defaultTab: "explain",
      cardDetailsOpenByDefault: false,
      maxGroundingQuotes: 1,
      autoGenerateOnLoad: false,
      autoBuildWalkthroughOnLoad: false,
      autoPrewarmOnLoad: false,
      showMicroActions: false,
      sidebarVisible: true,
      aiEnabled: true
    }
  }

  return {
    mode: normalized,
    orientationCollapsed: true,
    walkthroughVisible: false,
    walkthroughProminent: false,
    defaultTab: "explain",
    cardDetailsOpenByDefault: false,
    maxGroundingQuotes: 1,
    autoGenerateOnLoad: false,
    autoBuildWalkthroughOnLoad: false,
    autoPrewarmOnLoad: false,
    showMicroActions: true,
    sidebarVisible: true,
    aiEnabled: true
  }
}

export function applyMode(mode, ctx = {}) {
  const settings = ctx.settings || {}
  const config = getModeConfig(mode, settings)

  if (document?.body) {
    document.body.dataset.mode = config.mode
  }

  ctx.state?.setModeConfig?.(config)
  ctx.toolbar?.setModeToggle?.(config.mode)
  ctx.toolbar?.setReadingModeLabel?.(config.mode)
  ctx.toolbar?.setMicroActionsVisible?.(config.showMicroActions)

  ctx.sidebar?.setWalkthroughVisibility?.(config.walkthroughVisible)
  ctx.sidebar?.setWalkthroughProminent?.(config.walkthroughProminent)
  ctx.sidebar?.setOrientationCollapsed?.(config.orientationCollapsed)
  ctx.sidebar?.setSidebarVisible?.(config.sidebarVisible)

  ctx.cards?.setCardDetailsOpenByDefault?.(config.cardDetailsOpenByDefault)
  ctx.cards?.setMaxGroundingQuotes?.(config.maxGroundingQuotes)
  ctx.behavior?.setAiEnabled?.(config.aiEnabled)

  const nextTab = ctx.sidebar?.resolvePreferredTab?.(config)
  if (nextTab) {
    ctx.sidebar?.setActiveTab?.(nextTab, { fromModeApply: true })
  }

  ctx.render?.refreshPanel?.()
  return config
}
