// The top-level overview: every configured site side by side. It is the only
// screen not scoped to one site.
//
// Deliberately NOT a portfolio total. These sites differ by three orders of
// magnitude, so one summed headline would be the largest site wearing a
// different label — the small ones would round away and a real collapse on one
// of them could hide inside the others' growth. Every number here therefore
// belongs to exactly one site, and the columns are aligned so the comparison is
// read down the page rather than computed.
//
// It adds no reads. The sidebar already holds a `dashboardQuery` per site, so
// those snapshots are warm before this page opens; the longer daily series is
// one `historyQuery` per site, which the site's own Overview would fetch anyway.
// `useQueries` subscribes to the same cache entries, so nothing here refetches.
import { useQueries } from "@tanstack/react-query"

import { opportunityLabels } from "../../../../tui/src/presentation.ts"

import { TrendAreaChart } from "../charts/TrendAreaChart.tsx"
import { Sparkline } from "../components/Sparkline.tsx"
import { Card, EmptyState, LinkButton, SectionHeading } from "../components/ui.tsx"
import {
  compact,
  count,
  pathOf,
  percent,
  periods,
  position,
  shortDate,
  signed,
  trend,
  trendLabel,
  windowTotals,
} from "../format.ts"
import { dashboardQuery, historyQuery } from "../queries.ts"
import type { OpportunitySignal, Site, TrendDay, View } from "../types.ts"
import { provisionalAnchor } from "./shared.ts"

export interface SitesOverviewProps {
  readonly sites: readonly Site[]
  readonly rangeDays: number
  readonly onOpen: (siteId: string, view: View, index?: number) => void
}

// One site's contribution to the page: its two comparison periods and the parts
// of its snapshot the page ranks and labels with.
interface SiteRow {
  readonly site: Site
  readonly current: readonly TrendDay[]
  readonly previous: readonly TrendDay[]
  readonly signals: readonly OpportunitySignal[]
  readonly latestDate: string | null
  readonly isLoading: boolean
}

// A value over its move against the previous period. Two lines rather than one
// column each, so a row stays readable at six metrics wide.
const Metric = ({
  value,
  delta,
  tone,
}: {
  value: string
  delta: string
  tone: "positive" | "negative" | "muted"
}) => (
  <div className="site-metric">
    <span className="site-metric-value">{value}</span>
    <span className={`site-metric-delta tone-${tone}`}>{delta}</span>
  </div>
)

const SiteRowView = ({
  row,
  onOpen,
}: {
  row: SiteRow
  onOpen: SitesOverviewProps["onOpen"]
}) => {
  const now = windowTotals(row.current)
  const before = windowTotals(row.previous)
  const clicks = trend(now.clicks, before.clicks)
  const impressions = trend(now.impressions, before.impressions)
  const ctrPoints = (now.ctr - before.ctr) * 100
  const positionMove = now.position - before.position
  // No earlier period stored means there is nothing to compare against, and a
  // "+100%" against zero would be an invention.
  const hasComparison = before.impressions > 0

  return (
    <button className="site-row" type="button" onClick={() => onOpen(row.site.id, "home")}>
      <div className="site-row-name">
        <span className="site-row-title">{row.site.name}</span>
        <span className="site-row-origin">{row.site.origin}</span>
      </div>
      {row.isLoading ? (
        <span className="site-row-loading">Loading…</span>
      ) : (
        <>
          <Metric
            value={count(now.clicks)}
            delta={hasComparison ? trendLabel(clicks) : "—"}
            tone={!hasComparison ? "muted" : clicks.delta >= 0 ? "positive" : "negative"}
          />
          <Metric
            value={count(now.impressions)}
            delta={hasComparison ? trendLabel(impressions) : "—"}
            tone={!hasComparison ? "muted" : impressions.delta >= 0 ? "positive" : "negative"}
          />
          <Metric
            value={percent(now.ctr)}
            delta={hasComparison ? `${signed(ctrPoints, 1)} pp` : "—"}
            tone={!hasComparison ? "muted" : ctrPoints >= 0 ? "positive" : "negative"}
          />
          <Metric
            value={position(now.position)}
            delta={hasComparison ? signed(positionMove, 1) : "—"}
            // A falling position number is a better ranking, so the tone inverts.
            tone={!hasComparison ? "muted" : positionMove <= 0 ? "positive" : "negative"}
          />
          <div className="site-row-spark">
            {/* Coloured by the impressions column beside it, not by its own last
                reading — a provisional final day dips, and a red line next to
                "+178%" would just be wrong. */}
            <Sparkline
              values={row.current.map((day) => day.impressions)}
              width={120}
              height={32}
              tone={
                hasComparison ? (impressions.delta >= 0 ? "positive" : "negative") : undefined
              }
            />
          </div>
          <div className="site-row-meta">
            <span>{count(row.signals.length)} signals</span>
            {/* The finalized date, not the newest stored day: a site can hold
                days Google is still revising and have nothing settled yet. */}
            <span className="site-row-date">
              {row.latestDate ? `through ${shortDate(row.latestDate)}` : "nothing finalized"}
            </span>
          </div>
        </>
      )}
    </button>
  )
}

// One site's own chart. Each keeps its own Y scale rather than sharing one
// across the row: the sites differ by three orders of magnitude, and a shared
// scale would flatten the small ones onto the axis. The shapes are comparable
// even though the heights are not, which is what a row of charts is read for.
//
// Within a chart the two series still share one axis — clicks are a subset of
// impressions, so a second scale would draw clicks above the impressions they
// came from.
const SiteChart = ({ row, onOpen }: { row: SiteRow; onOpen: SitesOverviewProps["onOpen"] }) => {
  const provisionalFrom = provisionalAnchor(row.current)
  return (
    <Card
      title={row.site.name}
      subtitle={`${row.current.length} days`}
      action={<LinkButton label="Open" onClick={() => onOpen(row.site.id, "home")} />}
    >
      {row.current.length > 0 ? (
        <TrendAreaChart
          data={row.current.map((day) => ({
            label: shortDate(day.date),
            impressions: day.impressions,
            clicks: day.clicks,
          }))}
          series={[
            { key: "impressions", name: "Impressions", color: "var(--chart-1)" },
            { key: "clicks", name: "Clicks", color: "var(--chart-2)" },
          ]}
          xKey="label"
          format={compact}
          maxHeight="190px"
          provisionalFrom={provisionalFrom ? shortDate(provisionalFrom) : undefined}
        />
      ) : (
        <EmptyState message="No daily totals stored yet." icon="chart" />
      )}
    </Card>
  )
}

export const SitesOverview = ({ sites, rangeDays, onOpen }: SitesOverviewProps) => {
  const snapshots = useQueries({ queries: sites.map((site) => dashboardQuery(site.id)) })
  const histories = useQueries({ queries: sites.map((site) => historyQuery(site.id, rangeDays)) })

  const rows: readonly SiteRow[] = sites.map((site, index) => {
    const snapshot = snapshots[index]?.data
    const days = histories[index]?.data
    // Until the longer series lands, the snapshot's own fixed window stands in,
    // so a row shows real numbers immediately and only its comparison is late.
    const split = days && days.length > 0 ? periods(days, rangeDays) : undefined
    return {
      site,
      current: split?.current ?? ((snapshot?.history ?? []) as readonly TrendDay[]),
      previous: split?.previous ?? [],
      signals: snapshot?.digest.signals ?? [],
      latestDate: snapshot?.digest.latestDate ?? null,
      isLoading: !snapshot && !days,
    }
  })

  // The widest span any site actually covers, only to label the page. Sites can
  // differ here, and nothing is combined across them.
  const covered = rows.flatMap((row) => row.current.map((day) => day.date)).sort()
  const span =
    covered.length > 0
      ? `${shortDate(covered[0]!)} – ${shortDate(covered.at(-1)!)}`
      : "no days stored"
  const provisional = rows.some((row) => row.current.some((day) => day.provisional))

  // Every site's signals in one ranking — a list, not a total. Impressions is
  // the ordering a site's own opportunity list already uses, so the top of this
  // list and the top of that one agree.
  const ranked = rows
    .flatMap((row) => row.signals.map((signal, index) => ({ site: row.site, signal, index })))
    .sort((a, b) => b.signal.current.impressions - a.signal.current.impressions)
    .slice(0, 8)

  return (
    <div className="overview">
      <SectionHeading>{`${sites.length} sites · last ${rangeDays} days · ${span}`}</SectionHeading>
      <p className="section-note">
        Each site against its own previous {rangeDays} days
        {provisional && " · the last days are still provisional"}
      </p>
      <div className="site-table">
        <div className="site-row site-row-head">
          <span>Site</span>
          <span>Clicks</span>
          <span>Impressions</span>
          <span>CTR</span>
          <span>Position</span>
          <span>Impressions trend</span>
          <span />
        </div>
        {rows.map((row) => (
          <SiteRowView key={row.site.id} row={row} onOpen={onOpen} />
        ))}
      </div>
      <SectionHeading>Daily impressions and clicks</SectionHeading>
      <p className="section-note">
        One chart per site, each on its own scale — the shapes compare, the heights do not
      </p>
      <div className="site-chart-grid">
        {rows.map((row) => (
          <SiteChart key={row.site.id} row={row} onOpen={onOpen} />
        ))}
      </div>
      <Card
        title="Top opportunities"
        subtitle="The largest signals on any site, by impressions"
      >
        {ranked.length > 0 ? (
          <ul className="plain-list">
            {ranked.map(({ site, signal, index }) => (
              <li key={`${site.id}-${signal.kind}-${signal.label}-${signal.page}`}>
                <div className="plain-list-main">
                  <span>{signal.label}</span>
                  <span className="muted">
                    {site.name} · {opportunityLabels[signal.kind]} · {pathOf(signal.page, site)}
                  </span>
                </div>
                <button
                  className="link-button"
                  type="button"
                  onClick={() => onOpen(site.id, "opportunities", index)}
                >
                  {compact(signal.current.impressions)} impr.
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState message="No signals qualify on any site in this window." icon="target" />
        )}
      </Card>
    </div>
  )
}
