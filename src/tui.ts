import { BoxRenderable, createCliRenderer, fg, StyledText, t, TextRenderable } from "@opentui/core"

import { debugMode } from "./config.ts"
import { loadRegistry, type RegistryEntry } from "./registry.ts"
import { opportunityLabels, phaseFor, readableIntent, shortAction, signalExplanation, signalMeaning, signalReason, sparkline } from "./service.ts"
import { loadCachedSitemapPages, unmappedSitemapPages } from "./sitemap.ts"
import { history, opportunityDigest, registryTargetProgress, snapshotSummary, targetPerformance, type OpportunityKind, type OpportunitySignal, type RegistryTargetProgress } from "./storage.ts"
import { loadSites, withSite, type Site } from "./site.ts"

type View = "home" | "opportunities" | "history" | "registry"
type HomeCategory = OpportunityKind | "sitemap-coverage"

const views: readonly { readonly view: View; readonly key: string; readonly label: string }[] = [
  { view: "home", key: "0", label: "Home" },
  { view: "opportunities", key: "1", label: "Opportunities" },
  { view: "history", key: "2", label: "History" },
  { view: "registry", key: "3", label: "Registry" },
]

const registryFor = (query: string, registry: readonly RegistryEntry[]) =>
  registry.find((entry) => entry.keyword.toLowerCase() === query.toLowerCase())

const registryForSignal = (signal: OpportunitySignal, registry: readonly RegistryEntry[]) => {
  const queryMapping = signal.query ? registryFor(signal.query, registry) : undefined
  return queryMapping ?? registry.find((entry) => entry.targetUrl === new URL(signal.page).pathname)
}

const opportunityKinds: readonly OpportunityKind[] = ["striking-distance", "ctr", "new-demand", "cannibalization", "launch-readout"]
const homeCategories: readonly HomeCategory[] = [...opportunityKinds, "sitemap-coverage"]

const opportunityRow = (signal: OpportunitySignal, selected: boolean, wide: boolean) => {
  const typeWidth = wide ? 19 : 17
  const labelWidth = wide ? 32 : 8
  return `${selected ? "▶" : " "} ${opportunityLabels[signal.kind].slice(0, typeWidth).padEnd(typeWidth)} ${signal.label.slice(0, labelWidth).padEnd(labelWidth)} ${formatMetric(signal.current.impressions).padStart(5)}`
}

const registryRow = (progress: RegistryTargetProgress, selected: boolean, wide: boolean, targetWidth: number) => {
  const keywordCount = progress.entries.filter((entry) => entry.keyword.trim()).length
  const phase = phaseFor(progress)
  const priority = progress.entries[0]?.priority ?? "—"
  if (wide) return `${selected ? "▶" : " "} ${priority.padEnd(8)} ${progress.targetUrl.padEnd(targetWidth)} ${keywordCount.toString().padStart(8)} ${formatMetric(progress.target.impressions).padStart(11)} ${formatMetric(progress.target.clicks).padStart(7)} ${phase}`
  return `${selected ? "▶" : " "} ${priority} ${progress.targetUrl.padEnd(targetWidth)} ${keywordCount.toString().padStart(2)} ${formatMetric(progress.target.impressions).padStart(4)} ${formatMetric(progress.target.clicks).padStart(3)} ${phase}`
}

const registryTable = (targets: readonly RegistryTargetProgress[], selected: number, start: number, wide: boolean, targetWidth: number) => {
  const header = wide
    ? `  PRIORITY ${"TARGET URL".padEnd(targetWidth)} KEYWORDS IMPRESSIONS  CLICKS PHASE`
    : `  PR ${"TARGET".padEnd(targetWidth)} KW  IMP CLK PHASE`
  const chunks = [...t`${header}\n`.chunks]
  for (const [index, progress] of targets.entries()) {
    const row = registryRow(progress, start + index === selected, wide, targetWidth)
    chunks.push(...t`${progress.indexStatus === "not-indexed" ? fg("#718096")(row) : row}\n`.chunks)
  }
  return new StyledText(chunks)
}

const historyRow = (day: ReturnType<typeof history>[number], previous: ReturnType<typeof history>[number] | undefined, selected: boolean, wide: boolean) => {
  const change = previous ? day.impressions - previous.impressions : null
  const changeLabel = change === null ? "—" : `${change >= 0 ? "+" : ""}${change}`
  return wide
    ? `${selected ? "▶" : " "} ${day.date} ${day.impressions.toString().padStart(11)} ${changeLabel.padStart(9)} ${day.clicks.toString().padStart(7)} ${`${(day.ctr * 100).toFixed(1)}%`.padStart(7)} ${day.position.toFixed(1).padStart(12)}`
    : `${selected ? "▶" : " "} ${day.date.slice(5)} ${day.impressions.toString().padStart(5)} ${changeLabel.padStart(5)} ${day.clicks.toString().padStart(4)} ${`${(day.ctr * 100).toFixed(1)}%`.padStart(5)} ${day.position.toFixed(1).padStart(5)}`
}

const formatMetric = (value: number) => value >= 10_000
  ? `${Math.round(value / 1_000)}k`
  : value >= 1_000
    ? `${(value / 1_000).toFixed(1)}k`
    : value.toString()

const navigationHint = (view: View) => view === "home"
  ? "Mouse drag copies section   ↑↓ select category   ←→ navigate sections   s switch site   Enter inspect signals   r reload   q quit"
  : view === "history"
    ? "Mouse drag copies section   ↑↓ select day   ←→ navigate sections   s switch site   r reload   q quit"
    : `Mouse drag copies section   ↑↓ select ${view === "registry" ? "target" : "opportunity"}   ←→ navigate sections   s switch site   Enter open page   r reload   q quit`

const historyChart = (days: readonly ReturnType<typeof history>[number][], selected: number, width = 23) => {
  const height = 8
  const values = days.map((day) => day.impressions)
  const maximum = Math.max(...values, 1)
  const minimum = Math.min(...values, maximum)
  const range = maximum - minimum
  const axisWidth = Math.max(minimum.toString().length, maximum.toString().length)
  const canvas = Array.from({ length: height }, () => Array.from({ length: width }, () => " "))
  const point = (index: number) => ({
    x: values.length < 2 ? 0 : Math.round((index / (values.length - 1)) * (width - 1)),
    y: range === 0 ? Math.floor(height / 2) : height - 1 - Math.round((((values[index] ?? minimum) - minimum) / range) * (height - 1)),
  })
  for (let index = 0; index < values.length; index += 1) {
    const current = point(index)
    if (index > 0) {
      const previous = point(index - 1)
      for (let x = previous.x + 1; x < current.x; x += 1) {
        const ratio = (x - previous.x) / (current.x - previous.x)
        const y = Math.round(previous.y + (current.y - previous.y) * ratio)
        canvas[y]![x] = current.y < previous.y ? "╱" : current.y > previous.y ? "╲" : "─"
      }
    }
    canvas[current.y]![current.x] = index === selected ? "◆" : "●"
  }
  return [
    ...canvas.map((line, index) => `${index === 0 ? maximum.toString().padStart(axisWidth) : index === height - 1 ? minimum.toString().padStart(axisWidth) : " ".repeat(axisWidth)} ┤${line.join("")}`),
    `${" ".repeat(axisWidth + 1)}└${"─".repeat(width)}`,
    `${" ".repeat(axisWidth + 2)}${days[0]?.date.slice(5) ?? ""}${" ".repeat(Math.max(1, width - 10))}${days.at(-1)?.date.slice(5) ?? ""}`,
  ].join("\n")
}

export const showTui = async (initialStatus?: string) => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, consoleMode: "disabled", useMouse: true })
  const sites = [...await loadSites()]
  let siteIndex = 0
  let activeSiteId = sites[siteIndex]?.id ?? "sleevy"
  const inSite = <T>(work: () => T): T => withSite(sites[siteIndex] ?? activeSiteId, work)
  let registry = await inSite(() => loadRegistry())
  let sitemapPages = await inSite(() => loadCachedSitemapPages())
  let digest = inSite(() => opportunityDigest(registry))
  let registryTargets = inSite(() => registryTargetProgress(registry))
  let view: View = "home"
  let selected = 0
  let status = initialStatus ?? navigationHint("home")

  const app = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", padding: 1, gap: 1 })
  const header = new TextRenderable(renderer, { height: 1, flexShrink: 0, overflow: "hidden", content: "", fg: "#F7FAFC", attributes: 1 })
  const nav = new TextRenderable(renderer, { height: 1, flexShrink: 0, overflow: "hidden", content: "", fg: "#CBD5E0" })
  const split = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, gap: 1 })
  const master = new BoxRenderable(renderer, { width: "47%", flexShrink: 0, borderStyle: "single", borderColor: "#4A5568", padding: 1, flexDirection: "column" })
  const detail = new BoxRenderable(renderer, { flexGrow: 1, minWidth: 0, overflow: "hidden", borderStyle: "single", borderColor: "#4A5568", padding: 1, flexDirection: "column" })
  const masterTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F6AD55", attributes: 1 })
  const masterBody = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#E2E8F0" })
  const detailSummary = new BoxRenderable(renderer, { height: 7, flexShrink: 0, minWidth: 0, overflow: "hidden", border: ["bottom"], borderStyle: "single", borderColor: "#4A5568", paddingBottom: 1, flexDirection: "column" })
  const detailSummaryTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F7FAFC", attributes: 1 })
  const detailSummaryBody = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#CBD5E0" })
  const detailGuide = new BoxRenderable(renderer, { height: 0, flexShrink: 0, minWidth: 0, overflow: "hidden", border: false, borderStyle: "single", borderColor: "#4A5568", paddingBottom: 1, flexDirection: "column" })
  const detailGuideTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F7FAFC", attributes: 1 })
  const detailGuideBody = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#CBD5E0" })
  const detailContent = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, minWidth: 0, overflow: "hidden", paddingTop: 1, flexDirection: "column" })
  const detailTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F7FAFC", attributes: 1 })
  const detailBody = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#CBD5E0" })
  const detailBottom = new BoxRenderable(renderer, { height: 0, flexShrink: 0, minWidth: 0, overflow: "hidden", border: false, borderStyle: "single", borderColor: "#4A5568", paddingTop: 1, flexDirection: "column" })
  const detailBottomTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F7FAFC", attributes: 1 })
  const detailBottomBody = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#CBD5E0" })
  const footer = new TextRenderable(renderer, { height: 1, flexShrink: 0, overflow: "hidden", content: "", fg: "#718096" })
  master.add(masterTitle)
  master.add(masterBody)
  detailSummary.add(detailSummaryTitle)
  detailSummary.add(detailSummaryBody)
  detailGuide.add(detailGuideTitle)
  detailGuide.add(detailGuideBody)
  detailContent.add(detailTitle)
  detailContent.add(detailBody)
  detailBottom.add(detailBottomTitle)
  detailBottom.add(detailBottomBody)
  detail.add(detailSummary)
  detail.add(detailGuide)
  detail.add(detailContent)
  detail.add(detailBottom)
  split.add(master)
  split.add(detail)
  app.add(header)
  app.add(nav)
  app.add(split)
  app.add(footer)
  renderer.root.add(app)

  const rows = () => view === "home" ? homeCategories : view === "opportunities" ? digest.signals : view === "history" ? inSite(() => history()) : registryTargets
  const selectedRow = () => rows()[selected]
  const visibleRows = <T>(items: readonly T[]) => {
    const hasTableHeader = view === "registry" || view === "history" || (view === "opportunities" && renderer.width >= 120)
    const limit = Math.max(1, renderer.height - 12 - (hasTableHeader ? 1 : 0))
    const start = Math.min(Math.max(0, selected - Math.floor(limit / 2)), Math.max(0, items.length - limit))
    return { start, items: items.slice(start, start + limit) }
  }
  const setView = (next: View) => { view = next; selected = next === "history" ? Math.max(0, inSite(() => history()).length - 1) : 0 }
  const moveView = (direction: -1 | 1) => {
    const index = views.findIndex((item) => item.view === view)
    setView(views[(index + direction + views.length) % views.length]!.view)
  }
  const openSelected = () => withSite(activeSiteId, () => {
    const item = selectedRow()
    if (view === "home") {
      const kind = item as HomeCategory | undefined
      if (kind === "sitemap-coverage") {
        const gaps = unmappedSitemapPages(sitemapPages, registry)
        status = gaps.length > 0 ? `${gaps.length} sitemap pages need registry rows.` : "Every sitemap page is represented in the registry."
        return
      }
      const signalIndex = kind ? digest.signals.findIndex((signal) => signal.kind === kind) : -1
      if (signalIndex >= 0) {
        view = "opportunities"
        selected = signalIndex
        status = `Showing ${opportunityLabels[kind!]} signals.`
      } else {
        status = kind ? `No ${opportunityLabels[kind]} signals qualify in this window.` : "Nothing selected."
      }
      return
    }
    const url = view === "opportunities"
      ? (item as OpportunitySignal | undefined)?.page
      : view === "registry"
        ? `${sites[siteIndex]?.origin ?? "https://sleevy.app"}${(item as RegistryTargetProgress | undefined)?.targetUrl ?? ""}`
        : undefined
    if (!url) {
      status = view === "history" ? "History rows have no page destination. Use ←/→ to change workspace." : "Nothing selected."
      return
    }
    Bun.spawn(["open", url])
    status = `Opened ${url}`
  })
  const render = () => withSite(activeSiteId, () => {
    const summary = snapshotSummary()
    const activeView = views.findIndex((item) => item.view === view)
    detailSummary.height = renderer.width >= 120 ? 8 : 11
    const showGuide = view === "home" || view === "opportunities"
    detailGuide.height = showGuide ? (renderer.width >= 120 ? 8 : 10) : 0
    detailGuide.border = showGuide ? ["bottom"] : false
    detailGuideTitle.content = ""
    detailGuideBody.content = ""
    const showBottomPanel = (view === "registry" && registryTargets.length > 0) || view === "history"
    detailBottom.height = showBottomPanel
      ? view === "history" ? (renderer.height >= 32 ? 14 : 8) : (renderer.height >= 32 ? 8 : 5)
      : 0
    detailBottom.border = showBottomPanel ? ["top"] : false
    const site = sites[siteIndex]!
    header.content = `${site.name} SEO  ·  ${site.origin}  ·  ${summary.rows} Search Console rows across ${summary.dates} finalized days  ·  ${debugMode ? "DEBUG" : "LIVE"}`
    nav.content = views.map((item, index) => `${index === activeView ? "[" : " "}${item.key} ${item.label}${index === activeView ? "]" : " "}`).join("  ")
    if (view === "home") {
      selected = Math.max(0, Math.min(selected, homeCategories.length - 1))
      const grouped = new Map(opportunityKinds.map((kind) => [kind, digest.signals.filter((signal) => signal.kind === kind)]))
      const selectedKind = homeCategories[selected]!
      const sitemapGaps = unmappedSitemapPages(sitemapPages, registry)
      const selectedSignals = selectedKind === "sitemap-coverage" ? [] : grouped.get(selectedKind) ?? []
      const expanded = renderer.height >= 32
      masterTitle.content = `WEEKLY SIGNALS · ${digest.signals.length + sitemapGaps.length}`
      masterBody.content = homeCategories.flatMap((kind, index) => {
        const signals = kind === "sitemap-coverage" ? [] : grouped.get(kind) ?? []
        const count = kind === "sitemap-coverage" ? sitemapGaps.length : signals.length
        const label = kind === "sitemap-coverage" ? "Unmapped sitemap pages" : opportunityLabels[kind]
        const category = `${index === selected ? "▶" : " "} ${label.padEnd(20)} ${count.toString().padStart(3)}`
        if (!expanded) return [category]
        const previews = kind === "sitemap-coverage"
          ? sitemapGaps.slice(0, 2).map((page, pageIndex) => `  ${pageIndex === Math.min(1, sitemapGaps.length - 1) ? "└" : "├"} ${page.path}`)
          : signals.slice(0, 2).map((signal, signalIndex) => `  ${signalIndex === Math.min(1, signals.length - 1) ? "└" : "├"} ${signal.label} · ${formatMetric(signal.current.impressions)} impressions`)
        return [category, ...(previews.length > 0 ? previews : ["    No qualifying signals"]), ""]
      }).join("\n")
      detailSummaryTitle.content = "REPORTING WINDOW"
      detailSummaryBody.content = [
        `Current 28 days: ${digest.currentStart ?? "—"} → ${digest.latestDate ?? "—"}`,
        `Previous 28 days: ${digest.previousStart ?? "—"} → ${digest.previousEnd ?? "—"}`,
        `Sources: ${summary.rows} raw rows · ${sitemapPages.length} sitemap pages · ${registry.filter((entry) => entry.keyword.trim()).length} keywords`,
      ].join("\n")
      if (selectedKind === "sitemap-coverage") {
        detailTitle.content = `Sitemap coverage · ${sitemapGaps.length} unmapped pages`
        detailGuideTitle.content = "SITEMAP COVERAGE"
        detailGuideBody.content = [
          "WHAT IT MEANS",
          "A published URL appears in sitemap.xml but has no target-page row in the selected site's registry.",
          "",
          "DETECTION RULE",
          "Every sitemap URL path is compared with the registry target_url column. A blank keyword is allowed for inventory-only pages.",
        ].join("\n")
        detailBody.content = [
          "",
          "Recommended response",
          "Add a page-only registry row, then assign keywords only when research or observed demand supports them.",
          "",
          "Unmapped pages",
          ...(sitemapGaps.length > 0 ? sitemapGaps.map((page) => page.path) : ["Every sitemap page is represented in the registry."]),
        ].join("\n")
      } else {
        detailTitle.content = `${opportunityLabels[selectedKind]} · ${selectedSignals.length} signals`
        detailGuideTitle.content = opportunityLabels[selectedKind].toUpperCase()
        detailGuideBody.content = [
          "WHAT IT MEANS",
          signalExplanation[selectedKind],
          "",
          "DETECTION RULE",
          signalMeaning[selectedKind],
        ].join("\n")
        detailBody.content = [
          "",
          "Recommended response",
          shortAction[selectedKind],
          "",
          "Top signals",
          ...(selectedSignals.length > 0
            ? selectedSignals.slice(0, expanded ? 6 : 2).flatMap((signal, index) => [
                `${index + 1}. ${signal.label}`,
                `   ${new URL(signal.page).pathname} · ${formatMetric(signal.current.impressions)} impressions · ${signal.current.clicks} clicks · position ${signal.current.position.toFixed(1)}`,
              ])
            : ["No signals meet this rule in the current window."]),
        ].join("\n")
      }
      footer.content = status === navigationHint(view) ? status : `${status}   ·   ${navigationHint(view)}`
      return
    }
    const items = rows()
    const registryTargetWidth = Math.max("TARGET URL".length, ...registryTargets.map((target) => target.targetUrl.length))
    selected = Math.max(0, Math.min(selected, Math.max(0, items.length - 1)))
    const window = visibleRows(items as readonly unknown[])
    masterTitle.content = view === "opportunities"
      ? "OPPORTUNITIES"
      : view === "history"
        ? `DAILY SEARCH VISIBILITY · ${window.start + 1}–${Math.min(items.length, window.start + window.items.length)}/${items.length}`
        : `REGISTRY · 28D  ${window.start + 1}–${Math.min(items.length, window.start + window.items.length)}/${items.length}`
    masterBody.content = items.length === 0
      ? view === "opportunities" ? "No opportunities meet the current thresholds." : view === "history" ? "No finalized search activity is available." : "The keyword registry has no target pages."
      : view === "opportunities"
        ? [
            ...(renderer.width >= 120 ? ["  TYPE                QUERY                            IMPRESSIONS"] : []),
            ...(window.items as OpportunitySignal[]).map((signal, index) => opportunityRow(signal, window.start + index === selected, renderer.width >= 120)),
          ].join("\n")
        : view === "history"
          ? [
              renderer.width >= 120 ? "  DATE        IMPRESSIONS    CHANGE  CLICKS     CTR AVG. POSITION" : "  DATE   IMPR.   Δ  CLK   CTR  POS.",
              ...(window.items as ReturnType<typeof history>).map((day, index) => historyRow(day, (items as ReturnType<typeof history>)[window.start + index - 1], window.start + index === selected, renderer.width >= 120)),
            ].join("\n")
          : registryTable(window.items as readonly RegistryTargetProgress[], selected, window.start, renderer.width >= 120, registryTargetWidth)
    const item = selectedRow()
    if (!item) {
      detailSummaryTitle.content = "NO SELECTION"
      detailSummaryBody.content = "Sync data or add a keyword mapping to get started."
      detailTitle.content = "No selection"
      detailBody.content = "Select a row to inspect it."
    } else if (view === "opportunities") {
      const signal = item as OpportunitySignal
      const mapping = registryForSignal(signal, registry)
      const delta = signal.previous ? signal.current.impressions - signal.previous.impressions : null
      const metricLine = (label: string, metrics: typeof signal.current, complete = true) => `${label}${complete ? "" : " (partial)"}: ${metrics.impressions} impressions · ${metrics.clicks} clicks · ${(metrics.ctr * 100).toFixed(1)}% CTR · position ${metrics.position.toFixed(1)}`
      detailSummaryTitle.content = signal.label
      detailSummaryBody.content = [
        `Page: ${new URL(signal.page).pathname}`,
        metricLine("Current 28 days", signal.current),
        signal.previous
          ? `${signal.launch ? "Pre-launch baseline" : "Previous 28 days"}: ${signal.previous.impressions} impressions · ${delta! >= 0 ? "+" : ""}${delta} impressions`
          : `${signal.launch ? "Pre-launch baseline" : "Previous 28 days"}: unavailable`,
        `Registry: ${mapping ? `${mapping.targetUrl} · ${mapping.priority}` : "Unmapped"}`,
      ].join("\n")
      detailTitle.content = `${opportunityLabels[signal.kind]} analysis`
      detailGuideTitle.content = opportunityLabels[signal.kind].toUpperCase()
      detailGuideBody.content = [
        "WHAT IT MEANS",
        signalExplanation[signal.kind],
        "",
        "DETECTION RULE",
        signalMeaning[signal.kind],
      ].join("\n")
      detailBody.content = [
        `Query: ${signal.query ?? "Launch target"}`,
        signal.pages.length > 1 ? `Competing URLs: ${signal.pages.map((page) => new URL(page).pathname).join(", ")}` : "",
        ...(signal.launch ? [
          `Launch age: ${signal.launch.daysSinceLaunch} days`,
          metricLine("28 days", signal.launch.day28, signal.launch.daysSinceLaunch >= 27),
          metricLine("56 days", signal.launch.day56, signal.launch.daysSinceLaunch >= 55),
          metricLine("84 days", signal.launch.day84, signal.launch.daysSinceLaunch >= 83),
        ] : []),
        "",
        "WHY THIS MATCHES THE RULE",
        signalReason(signal),
        "",
        "RECOMMENDED ACTION",
        shortAction[signal.kind],
      ].join("\n")
    } else if (view === "history") {
      const row = item as ReturnType<typeof history>[number]
      const historyDays = items as ReturnType<typeof history>
      const previousDay = historyDays[selected - 1]
      const signed = (value: number, digits = 0) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`
      detailSummaryTitle.content = row.date
      detailSummaryBody.content = [
        `Impressions: ${row.impressions}`,
        `Clicks: ${row.clicks}`,
        `CTR: ${(row.ctr * 100).toFixed(1)}%`,
        `Weighted average position: ${row.position.toFixed(1)}`,
      ].join("\n")
      detailTitle.content = "DAILY COMPARISON"
      detailBody.content = [
        previousDay
          ? `Compared with ${previousDay.date}: ${signed(row.impressions - previousDay.impressions)} impressions · ${signed(row.clicks - previousDay.clicks)} clicks · ${signed((row.ctr - previousDay.ctr) * 100, 1)} percentage points CTR.`
          : "This is the first stored reporting day, so no previous-day comparison is available.",
        "",
        "Search Console data is finalized with a short reporting delay; the daily sync refreshes recent dates to absorb revisions.",
      ].join("\n")
      detailBottomTitle.content = "28-DAY IMPRESSION CHART"
      detailBottomBody.content = historyChart(historyDays, selected, Math.max(23, Math.min(64, Math.floor(renderer.width * 0.42) - 10)))
    } else {
      const progress = item as RegistryTargetProgress
      const entry = progress.entries[0]!
      const keywordEntries = progress.entries.filter((mapped) => mapped.keyword.trim())
      const inventoryOnly = keywordEntries.length === 0
      const performance = targetPerformance(progress.targetUrl, inventoryOnly)
      const momentum = performance.last7.impressions - performance.previous7.impressions
      const momentumLabel = performance.previous7.impressions > 0
        ? `${momentum >= 0 ? "+" : ""}${momentum} impressions (${momentum >= 0 ? "+" : ""}${((momentum / performance.previous7.impressions) * 100).toFixed(1)}%)`
        : performance.last7.impressions > 0 ? `+${momentum} impressions · new visibility` : "No impression change yet"
      const measurementStatus = inventoryOnly
        ? `Status: Tracking all Search Console visibility for this sitemap page; latest finalized data is ${progress.latestDate ?? "unavailable"}.`
        : performance.total.impressions > 0
        ? `Status: Measuring non-brand visibility since ${progress.measuredFrom ?? "the first stored day"}; latest finalized data is ${progress.latestDate ?? "unavailable"}.`
        : progress.state === "measuring"
          ? `Status: No non-brand impressions for this target in the measurement window ending ${progress.latestDate ?? "the latest stored day"}.`
        : progress.state === "awaiting-post-baseline"
          ? `Status: Waiting for finalized Search Console data after ${entry.publishedAt || entry.baselineDate}. Latest available date is ${progress.latestDate ?? "unavailable"}.`
          : "Status: Waiting for the first Search Console observation."
      const metricSummary = (label: string, metrics: typeof performance.last7) => `${label}: ${metrics.impressions} impressions · ${metrics.clicks} clicks · ${(metrics.ctr * 100).toFixed(1)}% CTR · position ${metrics.position > 0 ? metrics.position.toFixed(1) : "—"}`
      const trendDays = performance.days.slice(-14)
      const impressionValues = trendDays.map((day) => day.impressions)
      const positionValues = trendDays.map((day) => day.position)
      const endpoint = (values: readonly number[], format: (value: number) => string) => ({
        first: (values[0] ?? 0) > 0 ? format(values[0]!) : "—",
        last: (values.at(-1) ?? 0) > 0 ? format(values.at(-1)!) : "—",
      })
      const impressionEndpoints = endpoint(impressionValues, (value) => Math.round(value).toString())
      const positionEndpoints = endpoint(positionValues, (value) => value.toFixed(1))
      detailSummaryTitle.content = progress.targetUrl
      detailSummaryBody.content = [
        `Page: ${progress.targetUrl}`,
        `Current 28 days: ${performance.total.impressions} impressions · ${performance.total.clicks} clicks · ${(performance.total.ctr * 100).toFixed(1)}% CTR · position ${performance.total.position.toFixed(1)}`,
        inventoryOnly
          ? "Baseline: not applicable to an inventory-only page"
          : progress.baseline
          ? `Previous baseline: ${progress.baseline.impressions} impressions · ${performance.total.impressions - progress.baseline.impressions >= 0 ? "+" : ""}${performance.total.impressions - progress.baseline.impressions} impressions`
          : "Previous baseline: not captured",
        `Search intent: ${readableIntent(entry.intent)}`,
        `Registry: ${entry.priority} · ${entry.country} · ${keywordEntries.length} keywords`,
      ].join("\n")
      detailTitle.content = inventoryOnly ? "PAGE PERFORMANCE · ALL QUERIES" : "NON-BRAND PERFORMANCE"
      const performanceDetails = [
        metricSummary("Last 7 days", performance.last7),
        metricSummary("Previous 7 days", performance.previous7),
        `Change: ${momentumLabel}`,
        "",
        `Daily impressions: ${impressionEndpoints.first}  ${sparkline(impressionValues)}  ${impressionEndpoints.last}`,
        `Daily position:    ${positionEndpoints.first}  ${sparkline(positionValues, true)}  ${positionEndpoints.last} · lower is better`,
      ].join("\n")
      detailBody.content = t`${measurementStatus}\n\n${fg("#F7FAFC")("WHY THIS IS AN OPPORTUNITY")}\n${entry.whyOpportunity || "No opportunity rationale has been recorded for this page."}\n\n${performanceDetails}`
      detailBottomTitle.content = `KEYWORDS · ${keywordEntries.length}`
      detailBottomBody.content = keywordEntries.length > 0
        ? keywordEntries.map((mapped, index) => `${index + 1}. ${mapped.keyword}`).join("\n")
        : "No keyword target assigned; this page is tracked as sitemap inventory."
    }
    footer.content = `${status === navigationHint(view) ? status : `${status}   ·   ${navigationHint(view)}`}${view === "registry" ? "   ·   Dim rows: Google reports this page is not indexed." : ""}`
  })
  renderer.on("selection", (selection) => {
    const text = selection.getSelectedText()
    if (!text.trim()) return
    const clipboard = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    clipboard.stdin.write(text)
    clipboard.stdin.end()
    status = `Copied ${text.length} characters from this section.`
    render()
  })
  render()

  await new Promise<void>((resolve) => {
    renderer.once("destroy", resolve)
    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "up") selected -= 1
      else if (key.name === "down") selected += 1
      else if (key.name === "left" || key.name === "h") moveView(-1)
      else if (key.name === "right" || key.name === "l") moveView(1)
      else if (key.name === "return") { openSelected(); render(); return }
      else if (key.name === "0") setView("home")
      else if (key.name === "1") setView("opportunities")
      else if (key.name === "2") setView("history")
      else if (key.name === "3") setView("registry")
      else if (key.name === "s") {
        siteIndex = (siteIndex + 1) % sites.length
        activeSiteId = sites[siteIndex]?.id ?? "sleevy"
        void Promise.all([inSite(() => loadRegistry()), inSite(() => loadCachedSitemapPages())]).then(([nextRegistry, nextSitemapPages]) => { registry = nextRegistry; sitemapPages = nextSitemapPages; digest = inSite(() => opportunityDigest(registry)); registryTargets = inSite(() => registryTargetProgress(registry)); selected = 0; status = `Switched to ${sites[siteIndex]?.name ?? activeSiteId}.`; render() })
        return
      }
      else if (key.name === "r") {
        void Promise.all([inSite(() => loadRegistry()), inSite(() => loadCachedSitemapPages())]).then(([nextRegistry, nextSitemapPages]) => { registry = nextRegistry; sitemapPages = nextSitemapPages; digest = inSite(() => opportunityDigest(registry)); registryTargets = inSite(() => registryTargetProgress(registry)); status = "Reloaded keyword registry, sitemap cache, and local SQLite history."; render() })
        return
      }
      else if (key.name === "q") { renderer.destroy(); resolve(); return }
      else return
      selected = Math.max(0, Math.min(selected, Math.max(0, rows().length - 1)))
      status = navigationHint(view)
      render()
    })
  })
}
