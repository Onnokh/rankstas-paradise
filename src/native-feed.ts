// Text feed for the Native SDK app. Its app-core subset has no JSON parser
// and only byte-level string tooling, so the server pre-renders each view
// as a tab-separated document the app can split and display.
//
// Feed grammar (v2 — typed detail nodes instead of prose lines):
//
//   header  <TAB> <one header line>
//   meta    <TAB> label <TAB> value <TAB> delta <TAB> tone     summary cards
//   head    <TAB> c0..c5 column titles
//   row     <TAB> id <TAB> c0..c5 <TAB> url <TAB> icon <TAB> tone
//   dtitle  <TAB> id <TAB> detail panel title
//   dsect   <TAB> id <TAB> section heading (pre-uppercased)
//   dtext   <TAB> id <TAB> prose paragraph line
//   dkv     <TAB> id <TAB> label <TAB> value <TAB> tone
//   dmetric <TAB> id <TAB> label <TAB> value <TAB> delta <TAB> tone
//   dlist   <TAB> id <TAB> list item text
//   dspark  <TAB> id <TAB> label <TAB> v0,v1,...  (integer CSV series)
//
// tone ∈ up|down|flat|"" — the app maps up→success, down→destructive.
// Dynamic text is scrubbed of tabs/newlines so the line format holds.
import { debugMode } from "./config.ts"
import { loadRegistry, type RegistryEntry } from "./registry.ts"
import { opportunityLabels, phaseFor, readableIntent, shortAction, signalExplanation, signalMeaning, signalReason } from "./service.ts"
import { currentSiteOrigin } from "./site.ts"
import { loadCachedSitemapPages, unmappedSitemapPages } from "./sitemap.ts"
import {
  history,
  opportunityDigest,
  registryTargetProgress,
  snapshotSummary,
  targetPerformance,
  type Metrics,
  type OpportunityKind,
  type OpportunitySignal,
} from "./storage.ts"

export type FeedView = "home" | "opportunities" | "history" | "registry"

type Tone = "up" | "down" | "flat" | "warn" | ""

const opportunityKinds: readonly OpportunityKind[] = ["striking-distance", "ctr", "new-demand", "cannibalization", "launch-readout"]

const kindIcons: Record<OpportunityKind, string> = {
  "striking-distance": "arrow-up",
  ctr: "eye",
  "new-demand": "search",
  cannibalization: "git-branch",
  "launch-readout": "clock",
}

const scrub = (text: string) => text.replaceAll("\t", " ").replaceAll("\n", " ").replaceAll("\r", " ")

const line = (parts: readonly (string | number)[]) => parts.map((part) => scrub(String(part))).join("\t")

const toneFor = (delta: number): Tone => delta > 0 ? "up" : delta < 0 ? "down" : "flat"

const signed = (value: number, digits = 0) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// "2026-05-17" → "May 17": within a 28-day window the year is noise.
const shortDate = (date: string) => {
  const month = Number(date.slice(5, 7))
  return `${monthNames[month - 1] ?? date.slice(5, 7)} ${Number(date.slice(8, 10))}`
}

const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`

type Meta = { readonly label: string; readonly value: string; readonly delta?: string; readonly tone?: Tone }

// slot routes a node to the detail panel's main column or its fixed-width
// right rail; omitted means main.
type Slot = "main" | "rail"

type DetailNode =
  | { readonly kind: "dtitle" | "dsect" | "dtext" | "dlist" | "dinfo" | "dchip"; readonly text: string; readonly slot?: Slot }
  | { readonly kind: "dkv"; readonly label: string; readonly value: string; readonly tone?: Tone; readonly slot?: Slot }
  | { readonly kind: "dmetric"; readonly label: string; readonly value: string; readonly delta?: string; readonly tone?: Tone; readonly slot?: Slot }
  | { readonly kind: "dspark"; readonly label: string; readonly values: readonly number[]; readonly slot?: Slot }

type FeedRow = {
  readonly id: number
  readonly columns: readonly (string | number)[]
  readonly url: string
  readonly icon: string
  readonly tone: Tone
  readonly nodes: readonly DetailNode[]
}

const document = (meta: readonly Meta[], head: readonly string[], rows: readonly FeedRow[]) => {
  const summary = snapshotSummary()
  const lines = [
    line(["header", `${summary.rows} rows · ${summary.dates} days · ${debugMode ? "DEBUG" : "LIVE"}`]),
    // Every card gets a delta line ("—" when there is none) so sibling
    // cards keep identical internal structure.
    ...meta.map((card) => line(["meta", card.label, card.value, card.delta || "—", card.tone ?? ""])),
    line(["head", ...head]),
  ]
  for (const row of rows) lines.push(line(["row", row.id, ...row.columns, row.url, row.icon, row.tone]))
  for (const row of rows) {
    for (const node of row.nodes) {
      const slot = node.slot ?? "main"
      if (node.kind === "dkv") lines.push(line(["dkv", row.id, slot, node.label, node.value, node.tone ?? ""]))
      else if (node.kind === "dmetric") lines.push(line(["dmetric", row.id, slot, node.label, node.value, node.delta ?? "", node.tone ?? ""]))
      else if (node.kind === "dspark") lines.push(line(["dspark", row.id, slot, node.label, node.values.map((value) => Math.round(value)).join(",")]))
      else lines.push(line([node.kind, row.id, slot, node.text === "" ? " " : node.text]))
    }
  }
  return lines.join("\n")
}

const sect = (text: string): DetailNode => ({ kind: "dsect", text: text.toUpperCase() })
const prose = (text: string): DetailNode => ({ kind: "dtext", text })
const item = (text: string): DetailNode => ({ kind: "dlist", text })
const title = (text: string): DetailNode => ({ kind: "dtitle", text })
const info = (text: string): DetailNode => ({ kind: "dinfo", text })

const sumWindow = (days: readonly Metrics[]): Metrics => {
  const impressions = days.reduce((total, day) => total + day.impressions, 0)
  const clicks = days.reduce((total, day) => total + day.clicks, 0)
  const weighted = days.reduce((total, day) => total + day.position * day.impressions, 0)
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  }
}

// Site-level KPI cards from stored query rows: current 28 days versus the
// previous 28.
const siteKpis = (): Meta[] => {
  const days = history(56)
  const current = sumWindow(days.slice(-28))
  const previous = sumWindow(days.slice(0, Math.max(0, days.length - 28)))
  const impressionsDelta = current.impressions - previous.impressions
  const clicksDelta = current.clicks - previous.clicks
  return [
    { label: "Impressions · 28d", value: String(current.impressions), delta: `${signed(impressionsDelta)} vs prev`, tone: toneFor(impressionsDelta) },
    { label: "Clicks · 28d", value: String(current.clicks), delta: `${signed(clicksDelta)} vs prev`, tone: toneFor(clicksDelta) },
    { label: "CTR · 28d", value: pct(current.ctr), delta: previous.impressions > 0 ? `${pct(previous.ctr)} prev` : "", tone: "" },
    { label: "Avg position", value: current.position > 0 ? current.position.toFixed(1) : "—", delta: previous.position > 0 ? `${previous.position.toFixed(1)} prev` : "", tone: "" },
  ]
}

// "Impr." keeps the label inside a four-across detail card at the app's
// minimum detail-pane width; the summary strip up top uses the full word.
const metricCards = (metrics: Metrics, deltas?: { readonly impressions: number; readonly clicks: number }): DetailNode[] => [
  { kind: "dmetric", label: "Impr.", value: String(metrics.impressions), delta: deltas ? signed(deltas.impressions) : "", tone: deltas ? toneFor(deltas.impressions) : "" },
  { kind: "dmetric", label: "Clicks", value: String(metrics.clicks), delta: deltas ? signed(deltas.clicks) : "", tone: deltas ? toneFor(deltas.clicks) : "" },
  { kind: "dmetric", label: "CTR", value: pct(metrics.ctr) },
  { kind: "dmetric", label: "Position", value: metrics.position > 0 ? metrics.position.toFixed(1) : "—" },
]

const registryForSignal = (signal: OpportunitySignal, registry: readonly RegistryEntry[]) => {
  const byKeyword = signal.query ? registry.find((entry) => entry.keyword.toLowerCase() === signal.query!.toLowerCase()) : undefined
  return byKeyword ?? registry.find((entry) => entry.targetUrl === new URL(signal.page).pathname)
}

export const homeFeed = async (): Promise<string> => {
  const registry = await loadRegistry()
  const sitemapPages = await loadCachedSitemapPages()
  const digest = opportunityDigest(registry)
  const sitemapGaps = unmappedSitemapPages(sitemapPages, registry)
  const range = (start: string | null, end: string | null) => start && end ? `${shortDate(start)} – ${shortDate(end)}` : "—"
  const windowNodes: DetailNode[] = [
    { kind: "dkv", label: "Current 28 days", value: range(digest.currentStart, digest.latestDate) },
    { kind: "dkv", label: "Previous 28 days", value: range(digest.previousStart, digest.previousEnd) },
    { kind: "dkv", label: "Keywords tracked", value: String(registry.filter((entry) => entry.keyword.trim()).length) },
  ]
  const rows: FeedRow[] = opportunityKinds.map((kind, index) => {
    const signals = digest.signals.filter((signal) => signal.kind === kind)
    return {
      id: index,
      columns: [opportunityLabels[kind], signals.length, "", "", "", ""],
      url: "",
      icon: kindIcons[kind],
      tone: "",
      nodes: [
        title(opportunityLabels[kind]),
        ...windowNodes,
        sect("What it means"),
        prose(signalExplanation[kind]),
        sect("Detection rule"),
        prose(signalMeaning[kind]),
        sect("Recommended response"),
        prose(shortAction[kind]),
        sect(`Top signals · ${signals.length}`),
        ...(signals.length > 0
          ? signals.slice(0, 6).map((signal) => item(`${signal.label} — ${new URL(signal.page).pathname} · ${signal.current.impressions} impressions · position ${signal.current.position.toFixed(1)}`))
          : [prose("No signals meet this rule in the current window.")]),
      ],
    }
  })
  rows.push({
    id: opportunityKinds.length,
    columns: ["Unmapped sitemap pages", sitemapGaps.length, "", "", "", ""],
    url: "",
    icon: "file-text",
    tone: "",
    nodes: [
      title("Unmapped sitemap pages"),
      ...windowNodes,
      sect("What it means"),
      prose("A published URL appears in sitemap.xml but has no target-page row in keyword-registry.csv."),
      sect("Detection rule"),
      prose("Compare every sitemap URL path with the registry target_url column. Keywords may be blank for inventory-only pages."),
      sect("Recommended response"),
      prose("Add a page-only registry row, then assign keywords only when research or observed demand supports them."),
      sect("Unmapped pages"),
      ...(sitemapGaps.length > 0 ? sitemapGaps.map((page) => item(page.path)) : [prose("Every sitemap page is represented in the registry.")]),
    ],
  })
  return document(siteKpis(), ["SIGNAL CATEGORY", "COUNT", "", "", "", ""], rows)
}

export const opportunitiesFeed = async (): Promise<string> => {
  const registry = await loadRegistry()
  const digest = opportunityDigest(registry)
  const rows: FeedRow[] = digest.signals.map((signal, index) => {
    const mapping = registryForSignal(signal, registry)
    const deltas = signal.previous ? { impressions: signal.current.impressions - signal.previous.impressions, clicks: signal.current.clicks - signal.previous.clicks } : undefined
    return {
      id: index,
      columns: [
        opportunityLabels[signal.kind],
        signal.label,
        signal.current.impressions,
        signal.current.clicks,
        signal.current.position.toFixed(1),
        Math.round(signal.score),
      ],
      url: signal.page,
      icon: kindIcons[signal.kind],
      tone: "",
      nodes: [
        title(signal.label),
        ...metricCards(signal.current, deltas),
        { kind: "dmetric", label: "Score", value: String(Math.round(signal.score)) },
        { kind: "dkv", label: "Type", value: opportunityLabels[signal.kind] },
        { kind: "dkv", label: "Page", value: new URL(signal.page).pathname },
        { kind: "dkv", label: "Query", value: signal.query ?? "Launch target" },
        { kind: "dkv", label: "Registry", value: mapping ? `${mapping.targetUrl} · ${mapping.priority}` : "Unmapped" },
        ...(signal.pages.length > 1 ? [{ kind: "dkv", label: "Competing URLs", value: signal.pages.map((page) => new URL(page).pathname).join(", ") } as DetailNode] : []),
        ...(signal.launch
          ? [
              { kind: "dkv", label: "Launch age", value: `${signal.launch.daysSinceLaunch} days` } as DetailNode,
              { kind: "dkv", label: "28 days", value: `${signal.launch.day28.impressions} impressions · ${signal.launch.day28.clicks} clicks${signal.launch.daysSinceLaunch >= 27 ? "" : " (partial)"}` } as DetailNode,
              { kind: "dkv", label: "56 days", value: `${signal.launch.day56.impressions} impressions · ${signal.launch.day56.clicks} clicks${signal.launch.daysSinceLaunch >= 55 ? "" : " (partial)"}` } as DetailNode,
              { kind: "dkv", label: "84 days", value: `${signal.launch.day84.impressions} impressions · ${signal.launch.day84.clicks} clicks${signal.launch.daysSinceLaunch >= 83 ? "" : " (partial)"}` } as DetailNode,
            ]
          : []),
        sect("Why this matches the rule"),
        prose(signalReason(signal)),
        sect("Recommended action"),
        prose(shortAction[signal.kind]),
      ],
    }
  })
  return document(siteKpis(), ["TYPE", "QUERY", "IMPR", "CLICKS", "POS", "SCORE"], rows)
}

export const historyFeed = (): string => {
  const days = history()
  const latest = days.at(-1)
  const previous = days.at(-2)
  const meta: Meta[] = latest
    ? [
        { label: `Impressions · ${shortDate(latest.date)}`, value: String(latest.impressions), delta: previous ? `${signed(latest.impressions - previous.impressions)} vs prev day` : "", tone: previous ? toneFor(latest.impressions - previous.impressions) : "" },
        { label: "Clicks", value: String(latest.clicks), delta: previous ? `${signed(latest.clicks - previous.clicks)} vs prev day` : "", tone: previous ? toneFor(latest.clicks - previous.clicks) : "" },
        { label: "CTR", value: pct(latest.ctr) },
        { label: "Position", value: latest.position > 0 ? latest.position.toFixed(1) : "—" },
      ]
    : []
  const rows: FeedRow[] = days.map((day, index) => {
    const before = days[index - 1]
    const change = before ? day.impressions - before.impressions : null
    return {
      id: index,
      columns: [
        shortDate(day.date),
        day.impressions,
        change === null ? "—" : signed(change),
        day.clicks,
        pct(day.ctr),
        day.position.toFixed(1),
      ],
      url: "",
      icon: "",
      tone: change === null ? "" : toneFor(change),
      nodes: [
        title(`${shortDate(day.date)}, ${day.date.slice(0, 4)}`),
        ...metricCards(day, before ? { impressions: day.impressions - before.impressions, clicks: day.clicks - before.clicks } : undefined),
        sect("Daily comparison"),
        prose(before
          ? `Compared with ${shortDate(before.date)}: ${signed(day.impressions - before.impressions)} impressions · ${signed(day.clicks - before.clicks)} clicks · ${signed((day.ctr - before.ctr) * 100, 1)} percentage points CTR.`
          : "This is the first stored reporting day, so no previous-day comparison is available."),
        info("Search Console data is finalized with a short reporting delay; the daily sync refreshes recent dates to absorb revisions."),
      ],
    }
  })
  return document(meta, ["DATE", "IMPR", "CHANGE", "CLICKS", "CTR", "POS"], rows)
}

export const registryFeed = async (): Promise<string> => {
  const registry = await loadRegistry()
  const targets = registryTargetProgress(registry)
  const liveCount = targets.filter((progress) => phaseFor(progress) === "LIVE").length
  const indexedCount = targets.filter((progress) => progress.indexStatus === "indexed").length
  const p0Count = targets.filter((progress) => (progress.entries[0]?.priority ?? "") === "P0").length
  const meta: Meta[] = [
    { label: "Target pages", value: String(targets.length), delta: `${p0Count} at P0` },
    { label: "Live", value: String(liveCount), delta: `of ${targets.length} targets` },
    { label: "Indexed", value: `${indexedCount}/${targets.length}`, delta: `${targets.length - indexedCount} not indexed` },
    { label: "Impressions · 28d", value: String(targets.reduce((total, progress) => total + progress.target.impressions, 0)), delta: "all targets combined" },
  ]
  const rows: FeedRow[] = targets.map((progress, index) => {
    const entry = progress.entries[0]!
    const keywordEntries = progress.entries.filter((mapped) => mapped.keyword.trim())
    const inventoryOnly = keywordEntries.length === 0
    const performance = targetPerformance(progress.targetUrl, inventoryOnly)
    const momentum = performance.last7.impressions - performance.previous7.impressions
    const momentumLabel = performance.previous7.impressions > 0
      ? `${signed(momentum)} impressions (${signed((momentum / performance.previous7.impressions) * 100, 1)}%)`
      : performance.last7.impressions > 0 ? `${signed(momentum)} impressions · new visibility` : "No impression change yet"
    const prettyDate = (date: string | null | undefined, fallback: string) => date ? shortDate(date) : fallback
    const measurementStatus = inventoryOnly
      ? `Tracking all Search Console visibility for this sitemap page; latest finalized data is ${prettyDate(progress.latestDate, "unavailable")}.`
      : performance.total.impressions > 0
      ? `Measuring non-brand visibility since ${prettyDate(progress.measuredFrom, "the first stored day")}; latest finalized data is ${prettyDate(progress.latestDate, "unavailable")}.`
      : progress.state === "measuring"
        ? `No non-brand impressions for this target in the measurement window ending ${prettyDate(progress.latestDate, "the latest stored day")}.`
      : progress.state === "awaiting-post-baseline"
        ? `Waiting for finalized Search Console data after ${prettyDate(entry.publishedAt || entry.baselineDate, "launch")}. Latest available date is ${prettyDate(progress.latestDate, "unavailable")}.`
        : "Waiting for the first Search Console observation."
    const trendDays = performance.days.slice(-14)
    return {
      id: index,
      columns: [
        entry.priority || "—",
        progress.targetUrl,
        keywordEntries.length,
        progress.target.impressions,
        progress.target.clicks,
        phaseFor(progress),
      ],
      url: `${currentSiteOrigin()}${progress.targetUrl}`,
      icon: "",
      tone: "",
      nodes: [
        title(progress.targetUrl),
        ...metricCards(performance.total),
        // Un-indexed is the expected state for PRE-phase pages — warn, not
        // destructive.
        { kind: "dkv", label: "Indexed", value: progress.indexStatus === "indexed" ? "Indexed" : progress.indexStatus === "not-indexed" ? `Not indexed${progress.inspectedAt ? ` · checked ${shortDate(progress.inspectedAt.slice(0, 10))}` : ""}` : "Unknown", tone: progress.indexStatus === "indexed" ? "up" : progress.indexStatus === "not-indexed" ? "warn" : "" },
        { kind: "dkv", label: "Search intent", value: readableIntent(entry.intent) },
        { kind: "dkv", label: "Registry", value: `${entry.priority || "—"} · ${entry.country} · ${keywordEntries.length} keywords` },
        {
          kind: "dkv",
          label: "Baseline",
          value: inventoryOnly
            ? "Not applicable to an inventory-only page"
            : progress.baseline
            ? `${progress.baseline.impressions} impressions · ${signed(performance.total.impressions - progress.baseline.impressions)} since`
            : "Not captured",
        },
        info(measurementStatus),
        sect("Why this is an opportunity"),
        prose(entry.whyOpportunity || "No opportunity rationale has been recorded for this page."),
        sect(inventoryOnly ? "Page performance · all queries" : "Non-brand performance"),
        { kind: "dkv", label: "Last 7 days", value: `${performance.last7.impressions} impressions · ${performance.last7.clicks} clicks` },
        { kind: "dkv", label: "Previous 7 days", value: `${performance.previous7.impressions} impressions · ${performance.previous7.clicks} clicks` },
        { kind: "dkv", label: "Change", value: momentumLabel, tone: toneFor(momentum) },
        // An all-zero series renders as an empty strip under a label — skip
        // the chart node entirely until the page has impressions.
        ...(trendDays.some((day) => day.impressions > 0)
          ? [{ kind: "dspark", slot: "rail", label: "Impressions · 14d", values: trendDays.map((day) => day.impressions) } as DetailNode]
          : []),
        { kind: "dsect", slot: "rail", text: `KEYWORDS · ${keywordEntries.length}` },
        ...(keywordEntries.length > 0
          ? keywordEntries.map((mapped) => ({ kind: "dchip", slot: "rail", text: mapped.keyword } as DetailNode))
          : [{ kind: "dtext", slot: "rail", text: "No keyword target assigned; this page is tracked as sitemap inventory." } as DetailNode]),
      ],
    }
  })
  return document(meta, ["PRIORITY", "TARGET URL", "KW", "IMPR", "CLICKS", "PHASE"], rows)
}

export const feedFor = (view: FeedView): Promise<string> | string => {
  switch (view) {
    case "home": return homeFeed()
    case "opportunities": return opportunitiesFeed()
    case "history": return historyFeed()
    case "registry": return registryFeed()
  }
}
