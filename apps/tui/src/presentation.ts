// Shared presentation copy and small formatting helpers for the interactive
// dashboard. Ported verbatim from the legacy `src/service.ts` — these are pure
// functions over the render shapes, the part of the old service that was always
// about display rather than data access, so they move with the renderer.
//
// The one adaptation: the legacy `pathOf` read the active site's origin from a
// thread-local site context (`currentSiteOrigin()`). A remote-only client
// has no such context, so the active origin is set explicitly via
// `setActiveOrigin` whenever the active site changes (see tui.ts `inSite`).
import type {
  ActionKind,
  EngineTotals,
  EngineWindowTotals,
  LogKind,
  OpportunityKind,
  OpportunitySignal,
  RegistryTargetProgress,
} from "./types.ts"

export const detailSummaryHeight = (
  isRegistry: boolean,
  rendererWidth: number,
): number => isRegistry
  ? rendererWidth >= 120 ? 9 : 13
  : rendererWidth >= 120 ? 8 : 11

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

export const homeCardStripHeight = (
  view: string,
  rendererHeight: number,
): number =>
  view !== "home" ? 0 : rendererHeight >= 30 ? 5 : 1

const formatCardCount = (value: number) =>
  value >= 10_000
    ? `${Math.round(value / 1_000)}k`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : value.toString()

const formatCardPct = (ctr: number) => `${(ctr * 100).toFixed(1)}%`

const windowLabel = (window: EngineWindowTotals) =>
  window.daysCollected < window.windowDays
    ? `${window.windowDays}d · ${window.daysCollected}d`
    : `${window.windowDays}d`

const cardColumn = (
  title: string,
  columnWidth: number,
  formatValue: (window: EngineWindowTotals) => string,
  google28: EngineWindowTotals,
  bing28: EngineWindowTotals,
  google7: EngineWindowTotals,
  bing7: EngineWindowTotals,
  collapsed: boolean,
) => {
  const label28 = windowLabel(bing28)
  const inner = collapsed
    ? `${label28} ${formatValue(google28)} G · ${formatValue(bing28)} B`
    : [
        `${label28.padEnd(6)} ${formatValue(google28).padStart(5)} G · ${formatValue(bing28).padStart(4)} B`,
        `${"7d".padEnd(6)} ${formatValue(google7).padStart(5)} G · ${formatValue(bing7).padStart(4)} B`,
      ].join("\n")
  const titleLine = title.toUpperCase().slice(0, Math.max(4, columnWidth - 2))
  if (collapsed) return `${titleLine}: ${inner}`
  const top = `┌ ${titleLine}${"─".repeat(Math.max(0, columnWidth - titleLine.length - 1))}┐`
  const body = inner.split("\n").map((line) => `│ ${line.padEnd(columnWidth - 2)} │`).join("\n")
  const bottom = `└${"─".repeat(columnWidth - 2)}┘`
  return [top, body, bottom].join("\n")
}

export const formatHomeCardStrip = (
  totals: EngineTotals,
  width: number,
  rendererHeight: number,
): string => {
  const collapsed = rendererHeight < 30
  const columnWidth = Math.max(18, Math.floor((width - 4) / 3))
  const impressions = cardColumn(
    "Impressions",
    columnWidth,
    (window) => formatCardCount(window.impressions),
    totals.google.d28,
    totals.bing.d28,
    totals.google.d7,
    totals.bing.d7,
    collapsed,
  )
  const clicks = cardColumn(
    "Clicks",
    columnWidth,
    (window) => formatCardCount(window.clicks),
    totals.google.d28,
    totals.bing.d28,
    totals.google.d7,
    totals.bing.d7,
    collapsed,
  )
  const ctr = cardColumn(
    "CTR",
    columnWidth,
    (window) => formatCardPct(window.ctr),
    totals.google.d28,
    totals.bing.d28,
    totals.google.d7,
    totals.bing.d7,
    collapsed,
  )
  if (collapsed) return `${impressions}   ${clicks}   ${ctr}`
  const lines = [0, 1, 2].map((index) =>
    [impressions, clicks, ctr]
      .map((card) => card.split("\n")[index] ?? "")
      .join("  "),
  )
  return lines.join("\n")
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
