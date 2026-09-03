// Pieces every screen needs: the title-bar copy, the lookups that join a signal
// back to the registry, and the tone map that turns a domain kind into a badge
// colour. Kept out of the components so the wording stays in one place.
import { logKindLabel, opportunityLabels } from "../../../../tui/src/presentation.ts"

import type { Tone } from "../components/ui.tsx"
import { count, pathOf, rangeName, readableDate, signed } from "../format.ts"
import type {
  Dashboard,
  HomeCategory,
  LogReadout,
  OpportunityKind,
  OpportunitySignal,
  RegistryEntry,
  Site,
  View,
} from "../types.ts"
import { homeCategories } from "../types.ts"

export const isSplit = (view: View): boolean => view !== "home"

export const rowCount = (data: Dashboard, view: View): number =>
  view === "home"
    ? homeCategories.length
    : view === "opportunities"
      ? data.digest.signals.length
      : view === "history"
        ? data.history.length
        : view === "log"
          ? data.logEntries.length
          : data.registryTargets.length

// History opens on the newest day — the row a reader wants first.
export const initialSelection = (data: Dashboard, view: View): number =>
  view === "history" ? Math.max(0, data.history.length - 1) : 0

// The title bar above the content, per view.
export const heading = (
  data: Dashboard,
  view: View,
  rangeDays: number,
  site: Site | undefined,
): { title: string; subtitle: string } => {
  const window = `${data.digest.currentStart ? readableDate(data.digest.currentStart) : "—"} – ${data.digest.latestDate ? readableDate(data.digest.latestDate) : "—"}`
  // The site's own name, not "Overview": the sidebar no longer lists a Home row
  // under each site — the site's name IS that page — so the heading has to match
  // what was clicked, and "Overview" already names the cross-site screen.
  if (view === "home")
    return {
      title: site?.name ?? "Overview",
      subtitle: `Last ${rangeName(rangeDays)} versus the ${rangeName(rangeDays)} before`,
    }
  if (view === "opportunities")
    return {
      title: "Opportunities",
      subtitle: `${data.digest.signals.length} classified signals · ${window}`,
    }
  if (view === "history")
    return { title: "History", subtitle: `${data.history.length} days of site totals` }
  if (view === "registry")
    return {
      title: "Registry",
      subtitle: `${data.registryTargets.length} target pages · ${data.registry.filter((entry) => entry.keyword.trim()).length} keywords`,
    }
  return { title: "Activity log", subtitle: `${data.logEntries.length} actions and notes` }
}

const registryFor = (query: string, registry: readonly RegistryEntry[]) =>
  registry.find((entry) => entry.keyword.toLowerCase() === query.toLowerCase())

export const registryForSignal = (
  signal: OpportunitySignal,
  registry: readonly RegistryEntry[],
  site: Site,
) => {
  const queryMapping = signal.query ? registryFor(signal.query, registry) : undefined
  return queryMapping ?? registry.find((entry) => entry.targetUrl === pathOf(signal.page, site))
}

export const readoutLine = (readout: LogReadout): string => {
  if (readout.state === "window") {
    const delta = readout.after.impressions - readout.before.impressions
    return `${readout.scope === "non-brand" ? "Non-brand" : "All queries"}: ${count(readout.before.impressions)} → ${count(readout.after.impressions)} impressions (${signed(delta)})${readout.afterComplete ? "" : " · after window still partial"}`
  }
  if (readout.state === "unavailable") return "No measured window around this date yet."
  return ""
}

export const kindTone: Record<OpportunityKind, Tone> = {
  "striking-distance": "accent",
  ctr: "neutral",
  "new-demand": "positive",
  cannibalization: "negative",
}

export const phaseTone = (phase: string): Tone =>
  phase === "LIVE" ? "positive" : phase === "PAGE" ? "muted" : "accent"

export const homeCategoryLabel = (kind: HomeCategory): string =>
  kind === "sitemap-coverage"
    ? "Unmapped sitemap pages"
    : kind === "recent-activity"
      ? "Recent activity"
      : opportunityLabels[kind]

// Where the provisional wash starts. It anchors on the last FINALIZED day, not
// the first provisional one: the x-axis is categorical, so a band drawn between
// the first and last provisional ticks covers only the interval between them —
// with two provisional days that shades one of them and leaves the other looking
// settled. Anchoring a tick earlier covers every segment that touches an
// unsettled reading.
export const provisionalAnchor = (
  days: readonly { readonly date: string; readonly provisional?: boolean }[],
): string | undefined => {
  const first = days.findIndex((day) => day.provisional)
  if (first < 0) return undefined
  return days[Math.max(0, first - 1)]?.date
}

export { logKindLabel }
