// Shared presentation copy and small formatting helpers for the interactive
// dashboard. Ported verbatim from the legacy `src/service.ts` — these are pure
// functions over the render shapes, the part of the old service that was always
// about display rather than data access, so they move with the renderer.
//
// The one adaptation: the legacy `pathOf` read the active site's origin from a
// thread-local site context (`currentSiteOrigin()`). A remote-only client
// has no such context, so the active origin is set explicitly via
// `setActiveOrigin` whenever the active site changes (see tui.ts `inSite`).
import { bold, dim, fg, StyledText, t } from "@opentui/core"

import type {
  ActionKind,
  EngineTotals,
  EngineWindowTotals,
  KeywordEngineWindow,
  LogKind,
  OpportunityKind,
  OpportunitySignal,
  RegistryTargetProgress,
  TidyMetrics,
} from "./types.ts"

export const detailSummaryHeight = (
  isRegistry: boolean,
  rendererWidth: number,
): number => isRegistry
  ? rendererWidth >= 120 ? 10 : 14
  : rendererWidth >= 120 ? 8 : 11

export const formatBingIndexLine = (
  progress: Pick<
    RegistryTargetProgress,
    | "bingInIndex"
    | "bingDiscoveredAt"
    | "bingLastCrawledAt"
    | "bingInspectedAt"
  >,
): string | null => {
  if (progress.bingInspectedAt == null) return null
  if (progress.bingInIndex === false) return "Bing: not indexed"
  const parts = [
    progress.bingLastCrawledAt
      ? `crawled ${progress.bingLastCrawledAt}`
      : null,
    progress.bingDiscoveredAt
      ? `discovered ${progress.bingDiscoveredAt}`
      : null,
  ].filter(Boolean)
  return parts.length > 0 ? `Bing: ${parts.join(" · ")}` : "Bing: indexed"
}

export const MASTER_TABLE_BASE_CHROME = 12

export const masterVisibleRowLimit = (
  rendererHeight: number,
  options: { readonly hasTableHeader: boolean; readonly extraChrome?: number },
): number =>
  Math.max(
    1,
    rendererHeight
      - MASTER_TABLE_BASE_CHROME
      - (options.hasTableHeader ? 1 : 0)
      - (options.extraChrome ?? 0),
  )

/**
 * Outer height of the Home engine strip when using real bordered BoxRenderables
 * (same chrome as master/detail: single border + padding 1).
 * Full: 2 border + 2 padding + title + 2 metric rows = 7.
 * Collapsed: 2 border + 2 padding + 1 summary row = 5.
 */
export const homeCardStripHeight = (
  view: string,
  rendererHeight: number,
): number =>
  view !== "home" ? 0 : rendererHeight >= 30 ? 7 : 5

const formatCardCount = (value: number) =>
  value >= 10_000
    ? `${Math.round(value / 1_000)}k`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : value.toString()

const formatCardPct = (ctr: number) => `${(ctr * 100).toFixed(1)}%`

/** Compact window label so partial Bing windows still fit a narrow card. */
const windowLabel = (window: EngineWindowTotals) =>
  window.daysCollected < window.windowDays
    ? `${window.windowDays}d·${window.daysCollected}d`
    : `${window.windowDays}d`

/** Flatten StyledText for tests / plain-string asserts. */
export const styledTextPlain = (text: StyledText): string =>
  text.chunks.map((chunk) => chunk.text).join("")

/** One engine pair: bold bright numbers, dim engine names. */
const enginePairChunks = (google: string, bing: string, numberColor: string) => [
  bold(fg(numberColor)(google)),
  dim(" Google · "),
  bold(fg(numberColor)(bing)),
  dim(" Bing"),
]

export type HomeEngineCard = {
  readonly title: string
  readonly body: StyledText
}

/**
 * Per-card copy for the three bordered Home KPI boxes.
 * Numbers lead; window labels trail dim so the metrics read as the hierarchy.
 */
export const homeEngineCards = (
  totals: EngineTotals,
  collapsed: boolean,
): readonly [HomeEngineCard, HomeEngineCard, HomeEngineCard] => {
  const card = (
    title: string,
    formatValue: (window: EngineWindowTotals) => string,
  ): HomeEngineCard => {
    const label28 = windowLabel(totals.bing.d28)
    const primary = [
      ...enginePairChunks(
        formatValue(totals.google.d28),
        formatValue(totals.bing.d28),
        "#F7FAFC",
      ),
      dim("  "),
      dim(label28),
    ]
    if (collapsed) {
      return { title: title.toUpperCase(), body: new StyledText(primary) }
    }
    return {
      title: title.toUpperCase(),
      body: new StyledText([
        ...primary,
        ...t`\n`.chunks,
        ...enginePairChunks(
          formatValue(totals.google.d7),
          formatValue(totals.bing.d7),
          "#A0AEC0",
        ),
        dim("  "),
        dim("7d"),
      ]),
    }
  }
  return [
    card("Impressions", (window) => formatCardCount(window.impressions)),
    card("Clicks", (window) => formatCardCount(window.clicks)),
    card("CTR", (window) => formatCardPct(window.ctr)),
  ]
}

// The active site's canonical origin, refreshed on startup and site switch.
let activeOrigin = ""
export const setActiveOrigin = (origin: string): void => {
  activeOrigin = origin
}

// Reduce a full URL to its site-relative path when it belongs to the active
// site; leave anything else untouched.
const pathOf = (page: string, origin = activeOrigin) =>
  page.startsWith(origin) ? new URL(page).pathname : page

export const phaseFor = (progress: RegistryTargetProgress) => {
  const keywordCount = progress.entries.filter((entry) => entry.keyword.trim()).length
  if (keywordCount === 0) return "PAGE"
  if (progress.target.impressions > 0) return "LIVE"
  if (progress.state === "measuring") return "NONE"
  if (progress.state === "awaiting-post-baseline") return "PRE"
  return "NEW"
}

// Shared presentation copy for the interactive frontends (TUI, native app).
export const opportunityLabels: Record<OpportunityKind, string> = {
  "striking-distance": "Striking distance",
  ctr: "CTR opportunity",
  "new-demand": "New demand",
  cannibalization: "Cannibalization",
}

export const shortAction: Record<OpportunityKind, string> = {
  "striking-distance": "Improve the existing ranking page first: strengthen intent match, content depth, and internal links before creating a new page.",
  ctr: "Test the title and description against the query intent; keep the page focused if its ranking is already strong.",
  "new-demand": "Check existing pages first. Map the keyword only when the intent fits; create a page only when no current page fits.",
  cannibalization: "Choose one primary page, then consolidate, redirect, or clarify the competing pages and their internal links.",
}

export const signalMeaning: Record<OpportunityKind, string> = {
  "striking-distance": "Current 28-day query row: 20+ impressions, position 4–20, and CTR under 10%. Brand queries are excluded.",
  ctr: "Current 28-day query row: 50+ impressions, position 1–10, and CTR below 80% of its benchmark. The benchmark is the same-band median when 3+ comparable rows exist; otherwise it is the site median.",
  "new-demand": "After grouping current 28-day rows by query: 20+ impressions and no exact case-insensitive registry keyword match. Brand queries are excluded.",
  cannibalization: "After grouping current 28-day rows by query: the query has rows for 2+ different page URLs. Brand queries are excluded.",
}

export const signalExplanation: Record<OpportunityKind, string> = {
  "striking-distance": "This page is already visible and close to the first page. Improving the page may produce more traffic faster than publishing a new page.",
  ctr: "This page already ranks well, but its search result earns fewer clicks than similar results. The title, description, or intent match may need work.",
  "new-demand": "People are searching for a phrase your plan does not cover. First decide whether an existing page satisfies that intent; only then create a new mapping or page.",
  cannibalization: "Google is dividing one query between multiple pages on this site. That can weaken both pages because neither has a clear primary target.",
}

export const signalReason = (signal: OpportunitySignal) => {
  const ctr = `${(signal.current.ctr * 100).toFixed(1)}%`
  if (signal.kind === "striking-distance") return `“${signal.label}” is ranking at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions and a ${ctr} CTR. It is visible, but there is room to earn more clicks.`
  if (signal.kind === "ctr") return `“${signal.label}” is ranking at position ${signal.current.position.toFixed(1)} with ${signal.current.impressions} impressions, but its ${ctr} CTR is below the expected rate for this ranking range.`
  if (signal.kind === "new-demand") return `“${signal.label}” generated ${signal.current.impressions} impressions, but it is not mapped to a keyword in the selected site's registry.`
  if (signal.kind === "cannibalization") return `“${signal.label}” is receiving impressions for ${signal.pages.length} pages: ${signal.pages.map((page) => pathOf(page)).join(", ")}.`
  return `“${signal.label}” matched the selected opportunity rule based on its current Search Console performance.`
}

export const readableIntent = (intent: string) => ({
  comparison: "Comparison / high consideration",
  "product-how-to": "Product / how-to",
  "product-solution": "Product / solution",
  "navigational-product": "Navigational / product",
  "developer-solution": "Developer / solution",
  "product-comparison": "Product comparison",
  exploratory: "Exploratory",
  "site-inventory": "Site inventory",
  "supporting-content": "Supporting content",
})[intent] ?? intent.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase())

// Human-readable label per log kind. Notes read as "Note"; actions read as a
// past-tense-ish phrase. Shared by both front-ends so the wording never drifts.
export const actionKindLabels: Record<ActionKind, string> = {
  publish: "Published",
  "content-update": "Content update",
  "title-change": "Title change",
  "internal-links": "Internal links",
  consolidation: "Consolidation",
}

export const logKindLabel = (kind: LogKind): string => kind === "note" ? "Note" : actionKindLabels[kind]

export const bingInventoryKeywordNote =
  "Bing has no page-level keyword data; figures cannot be attributed to inventory-only pages."

/** Compact 7d figures: impressions/clicks/ctr% (pos). */
const formatEngineCompact = (
  label: string,
  metrics: TidyMetrics,
  positionDigits: number,
) =>
  `${label}: ${metrics.impressions}/${metrics.clicks}/${(metrics.ctr * 100).toFixed(1)}% (pos ${metrics.position.toFixed(positionDigits)})`

/** Shared Google/Bing metrics line used by registry keywords and query detail. */
export const engineMetricsLine = (
  google: TidyMetrics | null,
  bing: TidyMetrics | null,
): string =>
  [
    google ? formatEngineCompact("Google", google, 1) : "Google: —",
    bing ? formatEngineCompact("Bing", bing, 0) : "Bing: —",
  ].join(" - ")

export type KeywordEngineBlock = {
  readonly title: string
  readonly metrics: string
}

/** Registry keyword block: title on its own line, engines on the next. */
export const keywordEngineBlock = (window: KeywordEngineWindow): KeywordEngineBlock => ({
  title: window.keyword,
  metrics: engineMetricsLine(window.google7d, window.bing7d),
})

export const keywordEngineLine = (window: KeywordEngineWindow): string => {
  const block = keywordEngineBlock(window)
  return `${block.title}\n${block.metrics}`
}

export const sparkline = (values: readonly number[], lowerIsBetter = false) => {
  const observed = values.filter((value) => value > 0)
  if (observed.length === 0) return "·".repeat(values.length)
  const minimum = Math.min(...observed)
  const maximum = Math.max(...observed)
  const glyphs = "▁▂▃▄▅▆▇█"
  if (minimum === maximum) return values.map((value) => value > 0 ? "─" : "·").join("")
  return values.map((value) => {
    if (value <= 0) return "·"
    const normalized = (value - minimum) / (maximum - minimum)
    const score = lowerIsBetter ? 1 - normalized : normalized
    return glyphs[Math.round(score * (glyphs.length - 1))]!
  }).join("")
}
