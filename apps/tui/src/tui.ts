import { BoxRenderable, createCliRenderer, dim, fg, StyledText, t, TextRenderable } from "@opentui/core"

import { bingInventoryKeywordNote, detailSummaryHeight, engineMetricsLine, formatBingIndexLine, homeCardStripHeight, homeEngineCards, keywordEngineBlock, logKindLabel, masterVisibleRowLimit, opportunityLabels, phaseFor, readableIntent, setActiveOrigin, shortAction, signalExplanation, signalMeaning, signalReason, sparkline } from "./presentation.ts"
import { loadSiteCatalog, loadTuiData, type TuiData } from "./tuiData.ts"
import type { HistoryDay, LogFeedEntry, LogReadout, OpportunityKind, OpportunitySignal, QueriesRow, RegistryEntry, RegistryTargetProgress, Site } from "./types.ts"

type View = "home" | "opportunities" | "history" | "registry" | "log" | "queries"
type HomeCategory = OpportunityKind | "sitemap-coverage" | "recent-activity"

const views: readonly { readonly view: View; readonly key: string; readonly label: string }[] = [
  { view: "home", key: "0", label: "Home" },
  { view: "opportunities", key: "1", label: "Opportunities" },
  { view: "history", key: "2", label: "History" },
  { view: "registry", key: "3", label: "Registry" },
  { view: "log", key: "4", label: "Log" },
  { view: "queries", key: "5", label: "Queries" },
]

const registryFor = (query: string, registry: readonly RegistryEntry[]) =>
  registry.find((entry) => entry.keyword.toLowerCase() === query.toLowerCase())

const registryForSignal = (signal: OpportunitySignal, registry: readonly RegistryEntry[]) => {
  const queryMapping = signal.query ? registryFor(signal.query, registry) : undefined
  return queryMapping ?? registry.find((entry) => entry.targetUrl === new URL(signal.page).pathname)
}

const opportunityKinds: readonly OpportunityKind[] = ["striking-distance", "ctr", "new-demand", "cannibalization"]
const homeCategories: readonly HomeCategory[] = [...opportunityKinds, "sitemap-coverage", "recent-activity"]

const readoutLine = (readout: LogReadout) => {
  if (readout.state === "window") {
    const delta = readout.after.impressions - readout.before.impressions
    return `Before/after (${readout.scope === "non-brand" ? "non-brand" : "all queries"}): ${readout.before.impressions} → ${readout.after.impressions} impressions (${delta >= 0 ? "+" : ""}${delta})${readout.afterComplete ? "" : " · after window partial"}`
  }
  if (readout.state === "unavailable") return "No measured window around this date yet."
  return ""
}

// Fit a URL path to a fixed column, keeping its end (the meaningful slug) and
// marking the elided head with a leading ellipsis.
const fitPathTail = (path: string, width: number) => path.length > width ? `…${path.slice(-(width - 1))}` : path.padEnd(width)

const logRow = (entry: LogFeedEntry, selected: boolean, wide: boolean, targetWidth: number) => {
  const note = entry.note || "—"
  const kind = logKindLabel(entry.kind)
  if (wide) return `${selected ? "▶" : " "} ${entry.date} ${kind.padEnd(14)} ${fitPathTail(entry.path, targetWidth)} ${note.slice(0, 32)}`
  return `${selected ? "▶" : " "} ${entry.date.slice(5)} ${kind.slice(0, 10).padEnd(10)} ${fitPathTail(entry.path, targetWidth)}`
}

const logTable = (entries: readonly LogFeedEntry[], visible: readonly LogFeedEntry[], selected: number, start: number, wide: boolean, targetWidth: number) => {
  const header = wide
    ? `  DATE       ${"KIND".padEnd(14)} ${"TARGET".padEnd(targetWidth)} NOTE`
    : `  DATE  ${"KIND".padEnd(10)} ${"TARGET".padEnd(targetWidth)}`
  const chunks = [...t`${header}\n`.chunks]
  visible.forEach((entry, index) => {
    const row = logRow(entry, start + index === selected, wide, targetWidth)
    chunks.push(...t`${entry.isAction ? row : fg("#718096")(row)}\n`.chunks)
  })
  return new StyledText(chunks)
}

const opportunityRow = (signal: OpportunitySignal, selected: boolean, wide: boolean) => {
  const typeWidth = wide ? 19 : 17
  const labelWidth = wide ? 32 : 8
  return `${selected ? "▶" : " "} ${opportunityLabels[signal.kind].slice(0, typeWidth).padEnd(typeWidth)} ${signal.label.slice(0, labelWidth).padEnd(labelWidth)} ${formatMetric(signal.current.impressions).padStart(5)}`
}

const registryRow = (progress: RegistryTargetProgress, selected: boolean, wide: boolean, targetWidth: number) => {
  const keywordCount = progress.entries.filter((entry) => entry.keyword.trim()).length
  const phase = phaseFor(progress)
  const priority = progress.entries[0]?.priority ?? "—"
  const ctr = progress.target.impressions > 0 ? `${(progress.target.ctr * 100).toFixed(1)}%` : "—"
  if (wide) return `${selected ? "▶" : " "} ${priority.padEnd(8)} ${progress.targetUrl.padEnd(targetWidth)} ${keywordCount.toString().padStart(8)} ${formatMetric(progress.target.impressions).padStart(11)} ${formatMetric(progress.target.clicks).padStart(7)} ${ctr.padStart(7)} ${phase}`
  return `${selected ? "▶" : " "} ${priority} ${progress.targetUrl.padEnd(targetWidth)} ${keywordCount.toString().padStart(2)} ${formatMetric(progress.target.impressions).padStart(4)} ${formatMetric(progress.target.clicks).padStart(3)} ${ctr.padStart(6)} ${phase}`
}

const registryTable = (targets: readonly RegistryTargetProgress[], selected: number, start: number, wide: boolean, targetWidth: number) => {
  const header = wide
    ? `  PRIORITY ${"TARGET URL".padEnd(targetWidth)} KEYWORDS IMPRESSIONS  CLICKS     CTR PHASE`
    : `  PR ${"TARGET".padEnd(targetWidth)} KW  IMP CLK    CTR PHASE`
  const chunks = [...t`${header}\n`.chunks]
  for (const [index, progress] of targets.entries()) {
    const row = registryRow(progress, start + index === selected, wide, targetWidth)
    chunks.push(...t`${progress.indexStatus === "not-indexed" ? fg("#718096")(row) : row}\n`.chunks)
  }
  return new StyledText(chunks)
}

// Day-over-day moves smaller than this share of the previous day's impressions
// read as noise, so they stay neutral (no arrow, no color) instead of flapping.
const HISTORY_CHANGE_THRESHOLD = 0.05

const historyRow = (day: HistoryDay, previous: HistoryDay | undefined, selected: boolean, wide: boolean) => {
  const change = previous ? day.impressions - previous.impressions : null
  const significant = change !== null && previous!.impressions > 0 && Math.abs(change / previous!.impressions) >= HISTORY_CHANGE_THRESHOLD
  const arrow = !significant ? " " : change! > 0 ? "▲" : "▼"
  const changeLabel = change === null ? "—" : `${change >= 0 ? "+" : ""}${change}`
  const row = wide
    ? `${selected ? "▶" : " "}${arrow} ${day.date} ${day.impressions.toString().padStart(11)} ${changeLabel.padStart(9)} ${day.clicks.toString().padStart(7)} ${`${(day.ctr * 100).toFixed(1)}%`.padStart(7)} ${day.position.toFixed(1).padStart(12)}`
    : `${selected ? "▶" : " "}${arrow} ${day.date.slice(5)} ${day.impressions.toString().padStart(5)} ${changeLabel.padStart(5)} ${day.clicks.toString().padStart(4)} ${`${(day.ctr * 100).toFixed(1)}%`.padStart(5)} ${day.position.toFixed(1).padStart(5)}`
  // Provisional days are dimmed wholesale; the green/red day-over-day signal only
  // applies to finalized rows where the comparison is trustworthy.
  if (day.provisional) return t`${fg("#718096")(row)}`
  // Green/red carries the day-over-day signal; the leading ▲/▼ arrow is the
  // non-color cue so the direction reads without relying on hue.
  const rowColor = !significant ? null : change! > 0 ? fg("#68D391") : fg("#FC8181")
  return rowColor ? t`${rowColor(row)}` : t`${row}`
}

const historyTable = (allDays: readonly HistoryDay[], visible: readonly HistoryDay[], selected: number, start: number, wide: boolean) => {
  const header = wide
    ? "   DATE        IMPRESSIONS    CHANGE  CLICKS     CTR AVG. POSITION"
    : "   DATE   IMPR.   Δ  CLK   CTR  POS."
  const chunks = [...t`${header}\n`.chunks]
  visible.forEach((day, index) => {
    const row = historyRow(day, allDays[start + index - 1], start + index === selected, wide)
    chunks.push(...row.chunks, ...t`\n`.chunks)
  })
  return new StyledText(chunks)
}

const queriesRow = (row: QueriesRow, selected: boolean, wide: boolean, queryWidth: number) => {
  const query = row.query.length > queryWidth ? `…${row.query.slice(-(queryWidth - 1))}` : row.query.padEnd(queryWidth)
  const page = row.page ? fitPathTail(row.page, wide ? 18 : 10) : "—".padEnd(wide ? 18 : 10)
  const gImpr = row.google ? formatMetric(row.google.impressions).padStart(5) : "—".padStart(5)
  const bImpr = row.bing ? formatMetric(row.bing.impressions).padStart(4) : "—".padStart(4)
  if (wide) return `${selected ? "▶" : " "} ${query} ${page} ${gImpr} ${bImpr} ${(row.google?.clicks ?? "—").toString().padStart(4)} ${(row.bing?.clicks ?? "—").toString().padStart(3)}`
  return `${selected ? "▶" : " "} ${query.slice(0, queryWidth)} ${gImpr} ${bImpr}`
}

const queriesTable = (rows: readonly QueriesRow[], visible: readonly QueriesRow[], selected: number, start: number, wide: boolean, queryWidth: number) => {
  const header = wide
    ? `  ${"QUERY".padEnd(queryWidth)} ${"PAGE".padEnd(18)} G IMPR B IMPR G CLK BCLK`
    : `  ${"QUERY".padEnd(queryWidth)} GIMPR BIMPR`
  const lines = [header, ...visible.map((row, index) => queriesRow(row, start + index === selected, wide, queryWidth))]
  return lines.join("\n")
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
    : view === "queries"
      ? "Mouse drag copies section   ↑↓ select query   ←→ navigate sections   s switch site   Enter open Google page   r reload   q quit"
      : `Mouse drag copies section   ↑↓ select ${view === "registry" ? "target" : view === "log" ? "entry" : "opportunity"}   ←→ navigate sections   s switch site   Enter open page   r reload   q quit`

const historyChart = (days: readonly HistoryDay[], selected: number, width = 23) => {
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

export const showTui = async (initialStatus?: string, backgroundRefresh?: (site: Site) => Promise<string>) => {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, consoleMode: "disabled", useMouse: true })
  // Where the rendered data comes from: always the HTTP API in this remote-only
  // client (ADR 0001, A1). The server serves the raw internal shapes, so nothing
  // is reconstructed here. The site catalog is fetched over the same seam.
  const sites = [...await loadSiteCatalog()]
  if (sites.length === 0) throw new Error("No sites configured on the server.")
  let siteIndex = 0
  // siteIndex is always a valid catalog index (0-based, cycled by modulo), so
  // the active site is never synthetic — the catalog decides what we open.
  const activeSite = (): Site => sites[siteIndex]!
  // The presentation helpers strip the active site's origin from full URLs; keep
  // that origin current instead of the legacy thread-local site context.
  const inSite = <T>(work: () => T): T => { setActiveOrigin(activeSite().origin); return work() }
  const loadData = () => loadTuiData(activeSite())
  let data = await loadData()
  let view: View = "home"
  let selected = 0
  let status = initialStatus ?? navigationHint("home")

  const app = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", padding: 1, gap: 1 })
  const header = new TextRenderable(renderer, { height: 1, flexShrink: 0, overflow: "hidden", content: "", fg: "#F7FAFC", attributes: 1 })
  const nav = new TextRenderable(renderer, { height: 1, flexShrink: 0, overflow: "hidden", content: "", fg: "#CBD5E0" })
  // Home KPI strip — real bordered boxes like master/detail (not unicode frames in text).
  const cardStrip = new BoxRenderable(renderer, { height: 0, flexShrink: 0, flexDirection: "row", gap: 1, overflow: "hidden" })
  const makeEngineCard = () => {
    const box = new BoxRenderable(renderer, {
      flexGrow: 1,
      minWidth: 0,
      overflow: "hidden",
      borderStyle: "single",
      borderColor: "#4A5568",
      padding: 1,
      flexDirection: "column",
    })
    const title = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F6AD55", attributes: 1 })
    const body = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#E2E8F0" })
    box.add(title)
    box.add(body)
    return { box, title, body }
  }
  const engineCards = [makeEngineCard(), makeEngineCard(), makeEngineCard()] as const
  for (const card of engineCards) cardStrip.add(card.box)
  const split = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, gap: 1 })
  const master = new BoxRenderable(renderer, { width: "47%", flexShrink: 0, borderStyle: "single", borderColor: "#4A5568", padding: 1, flexDirection: "column" })
  const detail = new BoxRenderable(renderer, { flexGrow: 1, minWidth: 0, overflow: "hidden", borderStyle: "single", borderColor: "#4A5568", padding: 1, flexDirection: "column" })
  const masterTitle = new TextRenderable(renderer, { height: 1, flexShrink: 0, content: "", fg: "#F6AD55", attributes: 1 })
  const masterBody = new TextRenderable(renderer, { flexGrow: 1, minHeight: 0, overflow: "hidden", content: "", fg: "#E2E8F0" })
  const detailSummary = new BoxRenderable(renderer, { height: detailSummaryHeight(false, renderer.width), flexShrink: 0, minWidth: 0, overflow: "hidden", border: ["bottom"], borderStyle: "single", borderColor: "#4A5568", paddingBottom: 1, flexDirection: "column" })
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
  app.add(cardStrip)
  app.add(split)
  app.add(footer)
  renderer.root.add(app)

  const rows = () => view === "home" ? homeCategories : view === "opportunities" ? data.digest.signals : view === "history" ? data.history : view === "log" ? data.logEntries : view === "queries" ? data.queries.queries : data.registryTargets
  const selectedRow = () => rows()[selected]
  const visibleRows = <T>(items: readonly T[]) => {
    const hasTableHeader = view === "registry" || view === "history" || view === "log" || view === "queries" || (view === "opportunities" && renderer.width >= 120)
    const stripHeight = homeCardStripHeight(view, renderer.height)
    const extraChrome = stripHeight > 0 ? stripHeight + 1 : 0
    const limit = masterVisibleRowLimit(renderer.height, { hasTableHeader, extraChrome })
    const start = Math.min(Math.max(0, selected - Math.floor(limit / 2)), Math.max(0, items.length - limit))
    return { start, items: items.slice(start, start + limit) }
  }
  const setView = (next: View) => { view = next; selected = next === "history" ? Math.max(0, data.history.length - 1) : 0 }
  const moveView = (direction: -1 | 1) => {
    const index = views.findIndex((item) => item.view === view)
    setView(views[(index + direction + views.length) % views.length]!.view)
  }
  const openSelected = () => inSite(() => {
    const item = selectedRow()
    if (view === "home") {
      const kind = item as HomeCategory | undefined
      if (kind === "recent-activity") {
        view = "log"
        selected = 0
        status = "Showing the full activity log."
        return
      }
      if (kind === "sitemap-coverage") {
        const gaps = data.sitemapGaps
        status = gaps.length > 0 ? `${gaps.length} sitemap pages need registry rows.` : "Every sitemap page is represented in the registry."
        return
      }
      const signalIndex = kind ? data.digest.signals.findIndex((signal) => signal.kind === kind) : -1
      if (signalIndex >= 0) {
        view = "opportunities"
        selected = signalIndex
        status = `Showing ${opportunityLabels[kind!]} signals.`
      } else {
        status = kind ? `No ${opportunityLabels[kind]} signals qualify in this window.` : "Nothing selected."
      }
      return
    }
    const origin = activeSite().origin
    const url = view === "opportunities"
      ? (item as OpportunitySignal | undefined)?.page
      : view === "registry"
        ? `${origin}${(item as RegistryTargetProgress | undefined)?.targetUrl ?? ""}`
        : view === "log"
          ? (item as LogFeedEntry | undefined) ? `${origin}${(item as LogFeedEntry).path}` : undefined
          : view === "queries"
            ? (item as QueriesRow | undefined)?.page ? `${origin}${(item as QueriesRow).page}` : undefined
            : undefined
    if (!url) {
      status = view === "history"
        ? "History rows have no page destination. Use ←/→ to change workspace."
        : view === "queries"
          ? "This query has no Google ranking page in the current window."
          : "Nothing selected."
      return
    }
    Bun.spawn(["open", url])
    status = `Opened ${url}`
  })
  const render = () => inSite(() => {
    const summary = data.summary
    const activeView = views.findIndex((item) => item.view === view)
    detailSummary.height = detailSummaryHeight(view === "registry", renderer.width)
    const showGuide = view === "home" || view === "opportunities"
    detailGuide.height = showGuide ? (renderer.width >= 120 ? 16 : 18) : 0
    detailGuide.border = showGuide ? ["bottom"] : false
    detailGuideTitle.content = ""
    detailGuideBody.content = ""
    const showBottomPanel = (view === "registry" && data.registryTargets.length > 0) || view === "history"
    detailBottom.height = showBottomPanel
      ? view === "history" ? (renderer.height >= 32 ? 14 : 8) : (renderer.height >= 32 ? 14 : 10)
      : 0
    detailBottom.border = showBottomPanel ? ["top"] : false
    const site = sites[siteIndex]!
    header.content = `Ranksta’s Paradise  ·  ${site.origin}  ·  ${summary.rows} Search Console rows across ${summary.dates} finalized days  ·  LIVE`
    nav.content = views.map((item, index) => `${index === activeView ? "[" : " "}${item.key} ${item.label}${index === activeView ? "]" : " "}`).join("  ")
    const stripHeight = homeCardStripHeight(view, renderer.height)
    cardStrip.height = stripHeight
    if (stripHeight > 0) {
      const cards = homeEngineCards(data.engineTotals, renderer.height < 30)
      for (const [index, card] of engineCards.entries()) {
        card.box.border = true
        card.title.content = cards[index]!.title
        card.body.content = cards[index]!.body
      }
    } else {
      for (const card of engineCards) {
        card.box.border = false
        card.title.content = ""
        card.body.content = ""
      }
    }
    if (view === "home") {
      selected = Math.max(0, Math.min(selected, homeCategories.length - 1))
      const grouped = new Map(opportunityKinds.map((kind) => [kind, data.digest.signals.filter((signal) => signal.kind === kind)]))
      const selectedKind = homeCategories[selected]!
      const sitemapGaps = data.sitemapGaps
      const selectedSignals = selectedKind === "sitemap-coverage" || selectedKind === "recent-activity" ? [] : grouped.get(selectedKind) ?? []
      const recent = data.recentActions
      const actionCount = data.logEntries.filter((entry) => entry.isAction).length
      const expanded = renderer.height >= 32
      const labelFor = (kind: HomeCategory) => kind === "sitemap-coverage" ? "Unmapped sitemap pages" : kind === "recent-activity" ? "Recent activity" : opportunityLabels[kind]
      masterTitle.content = `WEEKLY SIGNALS · ${data.digest.signals.length + sitemapGaps.length}`
      masterBody.content = homeCategories.flatMap((kind, index) => {
        const signals = kind === "sitemap-coverage" || kind === "recent-activity" ? [] : grouped.get(kind) ?? []
        const count = kind === "sitemap-coverage" ? sitemapGaps.length : kind === "recent-activity" ? actionCount : signals.length
        const category = `${index === selected ? "▶" : " "} ${labelFor(kind).padEnd(20)} ${count.toString().padStart(3)}`
        if (!expanded) return [category]
        const previews = kind === "sitemap-coverage"
          ? sitemapGaps.slice(0, 2).map((page, pageIndex) => `  ${pageIndex === Math.min(1, sitemapGaps.length - 1) ? "└" : "├"} ${page.path}`)
          : kind === "recent-activity"
            ? recent.slice(0, 2).map((entry, entryIndex) => `  ${entryIndex === Math.min(1, recent.length - 1) ? "└" : "├"} ${entry.date.slice(5)} ${logKindLabel(entry.kind)} · ${entry.path}`)
            : signals.slice(0, 2).map((signal, signalIndex) => `  ${signalIndex === Math.min(1, signals.length - 1) ? "└" : "├"} ${signal.label} · ${formatMetric(signal.current.impressions)} impressions`)
        return [category, ...(previews.length > 0 ? previews : ["    No qualifying signals"]), ""]
      }).join("\n")
      detailSummaryTitle.content = "REPORTING WINDOW"
      detailSummaryBody.content = [
        `Current 28 days: ${data.digest.currentStart ?? "—"} → ${data.digest.latestDate ?? "—"}`,
        `Previous 28 days: ${data.digest.previousStart ?? "—"} → ${data.digest.previousEnd ?? "—"}`,
        `Sources: ${summary.rows} raw rows · ${data.sitemapPageCount} sitemap pages · ${data.registry.filter((entry) => entry.keyword.trim()).length} keywords`,
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
          "",
          "RECOMMENDED ACTION",
          "Add a page-only registry row, then assign keywords only when research or observed demand supports them.",
        ].join("\n")
        detailBody.content = [
          "Unmapped pages",
          ...(sitemapGaps.length > 0 ? sitemapGaps.map((page) => page.path) : ["Every sitemap page is represented in the registry."]),
        ].join("\n")
      } else if (selectedKind === "recent-activity") {
        detailTitle.content = `Recent activity · ${actionCount} actions logged`
        detailGuideTitle.content = "RECENT ACTIVITY"
        detailGuideBody.content = [
          "WHAT IT MEANS",
          "The most recent interventions logged across this site. Notes are excluded from this glance.",
          "",
          "RECOMMENDED ACTION",
          "Press Enter to open the Log view for the full record, including notes and before/after readouts.",
        ].join("\n")
        detailBody.content = [
          "Latest actions",
          ...(recent.length > 0
            ? recent.flatMap((entry) => [
                `${entry.date} · ${logKindLabel(entry.kind)} · ${entry.path}`,
                ...(entry.note ? [`   ${entry.note}`] : []),
              ])
            : ["No actions logged yet. Record one with the log CLI."]),
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
          "",
          "RECOMMENDED ACTION",
          shortAction[selectedKind],
        ].join("\n")
        detailBody.content = [
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
    const registryTargetWidth = Math.max("TARGET URL".length, ...data.registryTargets.map((target) => target.targetUrl.length))
    const logTargetWidth = Math.min(renderer.width >= 120 ? 28 : 16, Math.max("TARGET".length, ...data.logEntries.map((entry) => entry.path.length)))
    const queryWidth = Math.min(renderer.width >= 120 ? 28 : 18, Math.max("QUERY".length, ...data.queries.queries.map((row) => row.query.length)))
    selected = Math.max(0, Math.min(selected, Math.max(0, items.length - 1)))
    const window = visibleRows(items as readonly unknown[])
    masterTitle.content = view === "opportunities"
      ? "OPPORTUNITIES"
      : view === "history"
        ? `DAILY SEARCH VISIBILITY · ${window.start + 1}–${Math.min(items.length, window.start + window.items.length)}/${items.length}`
        : view === "log"
          ? `ACTIVITY LOG · ${window.start + 1}–${Math.min(items.length, window.start + window.items.length)}/${items.length}`
          : view === "queries"
            ? `QUERIES · 7D  ${window.start + 1}–${Math.min(items.length, window.start + window.items.length)}/${items.length}`
            : `REGISTRY · 28D  ${window.start + 1}–${Math.min(items.length, window.start + window.items.length)}/${items.length}`
    masterBody.content = items.length === 0
      ? view === "opportunities"
        ? "No opportunities meet the current thresholds."
        : view === "history"
          ? "No finalized search activity is available."
          : view === "log"
            ? "No actions or notes logged yet. Record one with the log CLI."
            : view === "queries"
              ? "No observed queries meet the current filters."
              : "The keyword registry has no target pages."
      : view === "opportunities"
        ? [
            ...(renderer.width >= 120 ? ["  TYPE                QUERY                            IMPRESSIONS"] : []),
            ...(window.items as OpportunitySignal[]).map((signal, index) => opportunityRow(signal, window.start + index === selected, renderer.width >= 120)),
          ].join("\n")
        : view === "history"
          ? historyTable(items as readonly HistoryDay[], window.items as readonly HistoryDay[], selected, window.start, renderer.width >= 120)
          : view === "log"
            ? logTable(items as readonly LogFeedEntry[], window.items as readonly LogFeedEntry[], selected, window.start, renderer.width >= 120, logTargetWidth)
            : view === "queries"
              ? queriesTable(items as readonly QueriesRow[], window.items as readonly QueriesRow[], selected, window.start, renderer.width >= 120, queryWidth)
              : registryTable(window.items as readonly RegistryTargetProgress[], selected, window.start, renderer.width >= 120, registryTargetWidth)
    const item = selectedRow()
    if (!item) {
      detailSummaryTitle.content = "NO SELECTION"
      detailSummaryBody.content = "Sync data or add a keyword mapping to get started."
      detailTitle.content = "No selection"
      detailBody.content = "Select a row to inspect it."
    } else if (view === "opportunities") {
      const signal = item as OpportunitySignal
      const mapping = registryForSignal(signal, data.registry)
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
        "",
        "RECOMMENDED ACTION",
        shortAction[signal.kind],
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
      ].join("\n")
    } else if (view === "history") {
      const row = item as HistoryDay
      const historyDays = items as readonly HistoryDay[]
      const previousDay = historyDays[selected - 1]
      const signed = (value: number, digits = 0) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`
      detailSummaryTitle.content = `${row.date}${row.provisional ? "  ·  provisional" : ""}`
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
        row.provisional
          ? "Provisional: site-level totals only. Google has not finalized the per-query breakdown for this day, so it is not yet counted in query, page, or opportunity views."
          : "Search Console data is finalized with a short reporting delay; the daily sync refreshes recent dates to absorb revisions.",
      ].join("\n")
      detailBottomTitle.content = "28-DAY IMPRESSION CHART"
      detailBottomBody.content = historyChart(historyDays, selected, Math.max(23, Math.min(64, Math.floor(renderer.width * 0.42) - 10)))
    } else if (view === "log") {
      const entry = item as LogFeedEntry
      detailSummaryTitle.content = `${logKindLabel(entry.kind)} · ${entry.date}`
      detailSummaryBody.content = [
        `Target: ${entry.path}`,
        `Kind: ${logKindLabel(entry.kind)}${entry.isAction ? "" : " (annotation, not a change)"}`,
        `Logged: ${entry.createdAt.slice(0, 10)}`,
      ].join("\n")
      detailTitle.content = "LOG ENTRY"
      const readout = readoutLine(entry.readout)
      detailBody.content = [
        "NOTE",
        entry.note || "No note recorded.",
        "",
        ...(readout ? ["BEFORE / AFTER", readout] : []),
      ].join("\n")
    } else if (view === "queries") {
      const row = item as QueriesRow
      const report = data.queries
      detailSummaryTitle.content = row.query
      detailSummaryBody.content = t`${dim(engineMetricsLine(row.google, row.bing))}
Mapped target: ${row.mappedTarget ?? "Unmapped"}
Google page: ${row.page ?? "—"}
Window: Google ${report.window.google.start ?? "—"} → ${report.window.google.end ?? "—"} · Bing capture ${report.window.bing.capturedDate ?? "—"}`
      detailTitle.content = ""
      detailBody.content = [
        report.note ?? "Google figures are aggregated to a matched 7-day window. Bing figures come from the newest rolling capture only.",
        row.page ? "Press Enter to open the Google ranking page." : "No Google ranking page is available for this query in the current window.",
      ].join("\n")
    } else {
      const progress = item as RegistryTargetProgress
      const entry = progress.entries[0]!
      const keywordEntries = progress.entries.filter((mapped) => mapped.keyword.trim())
      const inventoryOnly = keywordEntries.length === 0
      const performance = data.performance(progress.targetUrl, inventoryOnly)
      const indexLabel = progress.indexStatus === "indexed"
        ? "Indexed"
        : progress.indexStatus === "not-indexed"
          ? "Not indexed"
          : "Unknown"
      const indexDetail = [
        indexLabel,
        progress.coverageState,
        progress.inspectedAt ? `checked ${progress.inspectedAt.slice(0, 10)}` : null,
      ].filter(Boolean).join(" · ")
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
      const bingIndexLine = formatBingIndexLine(progress)
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
        `Google index: ${indexDetail}`,
        ...(bingIndexLine ? [bingIndexLine] : []),
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
      const activity = data.logEntries.filter((logged) => logged.path === progress.targetUrl)
      const activityDetails = [
        `ACTIVITY · ${activity.length}`,
        ...(activity.length > 0
          ? activity.slice(0, 6).flatMap((logged) => {
              const compact = logged.readout.state === "window"
                ? ` · ${logged.readout.before.impressions} → ${logged.readout.after.impressions} impr${logged.readout.afterComplete ? "" : " (partial)"}`
                : ""
              return [`${logged.date} · ${logKindLabel(logged.kind)}${logged.note ? ` — ${logged.note}` : ""}${compact}`]
            })
          : ["No actions or notes logged for this page yet."]),
      ].join("\n")
      detailBody.content = t`${measurementStatus}\n\n${fg("#F7FAFC")("WHY THIS IS AN OPPORTUNITY")}\n${entry.whyOpportunity || "No opportunity rationale has been recorded for this page."}\n\n${performanceDetails}\n\n${fg("#F7FAFC")(activityDetails)}`
      detailBottomTitle.content = `KEYWORDS · ${keywordEntries.length}`
      const windowsForTarget = data.keywordWindows.filter((window) => window.targetUrl === progress.targetUrl)
      if (inventoryOnly) {
        detailBottomBody.content = `No keyword target assigned; this page is tracked as sitemap inventory.\n\n${bingInventoryKeywordNote}`
      } else if (keywordEntries.length === 0) {
        detailBottomBody.content = "No keyword target assigned; this page is tracked as sitemap inventory."
      } else {
        const chunks = []
        for (const [index, mapped] of keywordEntries.entries()) {
          if (index > 0) chunks.push(...t`\n`.chunks)
          const window = windowsForTarget.find(
            (candidate) => candidate.keyword.toLowerCase() === mapped.keyword.toLowerCase(),
          )
          if (window) {
            const block = keywordEngineBlock(window)
            chunks.push(...t`${fg("#F7FAFC")(block.title)}\n${dim(block.metrics)}`.chunks)
          } else {
            chunks.push(...t`${fg("#F7FAFC")(mapped.keyword)}`.chunks)
          }
        }
        detailBottomBody.content = new StyledText(chunks)
      }
    }
    const legend = view === "registry"
      ? "   ·   Dim rows: Google reports this page is not indexed."
      : view === "history"
        ? "   ·   Dim rows: site totals only; per-query data not finalized yet."
        : view === "log"
          ? "   ·   Dim rows: notes (annotations), not changes."
          : ""
    footer.content = `${status === navigationHint(view) ? status : `${status}   ·   ${navigationHint(view)}`}${legend}`
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

  // Re-fetch the whole snapshot for the active site after its data changes
  // (manual reload, or a completed background sync), preserving the user's
  // current selection. The provider hides local-vs-remote.
  const reload = (nextStatus: string) => loadData().then((next) => {
    data = next
    selected = Math.max(0, Math.min(selected, Math.max(0, rows().length - 1)))
    status = nextStatus
    render()
  })

  // Sync one site and, if it's the one in view, repaint with the fresh data.
  // Locally the sync runs Google directly; remotely it forces the server's job
  // and polls it to completion (see main.ts runServerSync), so either way the
  // repaint lands on synced data. A single `refreshing` guard serializes the
  // startup sweep against a manual reload — two overlapping local syncs would
  // race the delete-then-insert transactions, and a manual reload mid-sweep
  // would be redundant anyway.
  let refreshing = false
  const forceRefresh = async (site: Site) => {
    if (refreshing || !backgroundRefresh) return
    refreshing = true
    const viewing = () => site.id === sites[siteIndex]?.id
    if (viewing()) { status = `Syncing ${site.name}…`; render() }
    try {
      const message = await backgroundRefresh(site)
      if (viewing()) await reload(message)
    } catch (cause) {
      if (viewing()) { status = `Refresh failed; showing cached data. ${String(cause).split("\n")[0]}`; render() }
    } finally {
      refreshing = false
    }
  }

  // Startup sync runs without blocking the UI: the active site first for a fast
  // repaint, then every other configured site so all sites stay current without
  // a separate scheduled job. Only the site in view repaints; switching to
  // another ('s') reloads its freshly-synced data.
  if (backgroundRefresh) {
    const order = [...new Set([siteIndex, ...sites.map((_, index) => index)])]
    void (async () => {
      for (const index of order) {
        const site = sites[index]
        if (site) await forceRefresh(site)
      }
    })()
  }

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
      else if (key.name === "4") setView("log")
      else if (key.name === "5") setView("queries")
      else if (key.name === "s") {
        siteIndex = (siteIndex + 1) % sites.length
        void loadData().then((next) => { data = next; selected = 0; status = `Switched to ${activeSite().name}.`; render() })
        return
      }
      else if (key.name === "r") {
        // Reload always means "get fresh now": force a sync of the active site
        // and repaint when it lands. With no refresh path (debug mode) just
        // re-read the cached data as before.
        if (backgroundRefresh) void forceRefresh(activeSite())
        else void reload("Reloaded registry, sitemap coverage, opportunities, history, and the activity log.")
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
