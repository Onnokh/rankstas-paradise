// Number, date and path formatting for the desktop views. The wording helpers
// (opportunity labels, detection rules, recommended actions, intents, log kinds)
// are NOT redefined here — they come from `apps/tui/src/presentation.ts`, which
// exists so the copy never drifts between the interactive front-ends.
import type { HistoryDay, Metrics, Site, TrendDay } from "./types.ts"

// Day-over-day moves smaller than this share of the previous day's impressions
// read as noise, so they stay neutral instead of flapping. Same threshold as the
// terminal dashboard's history table.
export const HISTORY_CHANGE_THRESHOLD = 0.05

const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

// Table cells: 12.4k rather than 12,438, because the column is scanned, not read.
export const compact = (value: number): string =>
  value < 1000 ? value.toString() : compactFormat.format(value)

// Headline numbers, where every digit is worth showing.
export const count = (value: number): string => value.toLocaleString("en-US")

export const percent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`

export const position = (value: number): string => (value > 0 ? value.toFixed(1) : "—")

export const signed = (value: number, digits = 0): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`

// "2026-08-25" → "25 Aug 2026". Dates are parsed as UTC noon so a negative local
// offset cannot shift the calendar day backwards.
export const readableDate = (iso: string): string => {
  const date = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

export const shortDate = (iso: string): string => {
  const date = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

// Reduce a full URL to its site-relative path when it belongs to the active
// site; leave anything else untouched.
export const pathOf = (page: string, site: Site): string => {
  if (!page.startsWith(site.origin)) return page
  try {
    return new URL(page).pathname
  } catch {
    return page
  }
}

export const metricLine = (label: string, metrics: Metrics, complete = true): string =>
  `${label}${complete ? "" : " (partial)"}: ${count(metrics.impressions)} impressions · ${count(metrics.clicks)} clicks · ${percent(metrics.ctr)} CTR · position ${metrics.position.toFixed(1)}`

export interface DayChange {
  readonly change: number | null
  readonly significant: boolean
}

export const dayChange = (day: HistoryDay, previous: HistoryDay | undefined): DayChange => {
  if (!previous) return { change: null, significant: false }
  const change = day.impressions - previous.impressions
  const significant =
    previous.impressions > 0 && Math.abs(change / previous.impressions) >= HISTORY_CHANGE_THRESHOLD
  return { change, significant }
}

// The stored daily series summed into one window. These are Google's query-less
// daily totals — the true headline numbers, including the long tail withheld
// from per-query rows — so position is weighted by impressions, not averaged.
export const windowTotals = (days: readonly HistoryDay[]): Metrics => {
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

// The selectable spans for the daily-totals views. Each is read as a period and
// the period before it, so a 6-month range asks the server for 12 months — well
// inside Search Console's ~16-month retention.
export interface Range {
  readonly id: string
  readonly label: string
  readonly days: number
}

export const ranges: readonly Range[] = [
  { id: "3d", label: "3D", days: 3 },
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "3m", label: "3M", days: 90 },
  { id: "6m", label: "6M", days: 180 },
]

// The default span. 30 days is what a reader expects from "last 30 days"; the
// dashboard snapshot's own window is 28, so this series is read separately (see
// `RpBridge.history`).
export const TREND_WINDOW = 30

// "30 days" / "3 months", for prose that names the span.
export const rangeName = (days: number): string =>
  days % 30 === 0 && days >= 60 ? `${days / 30} months` : `${days} days`

export interface Trend {
  readonly delta: number
  // Null when the previous period had nothing to grow from, so no percentage is
  // meaningful — the tile shows the absolute move instead of "+∞%".
  readonly ratio: number | null
}

export const trend = (current: number, previous: number): Trend => ({
  delta: current - previous,
  ratio: previous > 0 ? (current - previous) / previous : null,
})

// A period and the one immediately before it, cut from one ascending series.
// A short series still yields a current period; `previous` is then whatever
// remains, so an under-filled comparison reads as a smaller previous total
// rather than a crash.
export interface Periods {
  readonly current: readonly TrendDay[]
  readonly previous: readonly TrendDay[]
}

export const periods = (days: readonly TrendDay[], window = TREND_WINDOW): Periods => ({
  current: days.slice(-window),
  previous: days.slice(Math.max(0, days.length - window * 2), Math.max(0, days.length - window)),
})

// Count change plus its percentage: "+1,204 (+18.3%)", or just the count when
// there is no base to compare against.
export const trendLabel = (value: Trend, unit = ""): string => {
  const moved = `${value.delta >= 0 ? "+" : "−"}${count(Math.abs(value.delta))}${unit ? ` ${unit}` : ""}`
  return value.ratio === null ? moved : `${moved} (${signed(value.ratio * 100, 1)}%)`
}

// When the data was last fetched, for the title bar. An absolute local time
// rather than "5 minutes ago", so it stays correct without a ticking clock; the
// day is included only when it is not today, which is the common case.
export const fetchedLabel = (iso: string): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  const isToday = at.toDateString() === new Date().toDateString()
  return isToday ? time : `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`
}


// The Domain Rating move across a window: the newest reading against the newest
// one at least `days` old.
//
// Not `periods()`. That cuts two equal spans from a dense daily series; this
// series is sparse and short — it only started when the feature shipped and only
// grows on days a sync ran. So the comparison walks back to the last reading on
// or before the cutoff, and reports nothing when the series does not reach that
// far rather than inventing a baseline from its oldest point.
export interface RatingMove {
  readonly current: number
  readonly delta: number | null
  readonly since: string | null
}

export const ratingMove = (
  history: readonly { readonly date: string; readonly rating: number }[],
  days: number,
): RatingMove | null => {
  const latest = history.at(-1)
  if (!latest) return null
  const cutoff = new Date(`${latest.date}T12:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - days)
  const iso = cutoff.toISOString().slice(0, 10)
  const baseline = [...history].reverse().find((point) => point.date <= iso)
  if (!baseline) return { current: latest.rating, delta: null, since: null }
  return {
    current: latest.rating,
    delta: latest.rating - baseline.rating,
    since: baseline.date,
  }
}
