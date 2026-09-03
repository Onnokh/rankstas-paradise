// The overview: what the site did over the last 30 days, how that compares with
// the 30 before it, and the classified signals in the current window.
//
// The comparison rides on a separate `/api/history` read, because the dashboard
// snapshot only carries the current window. While that query is loading the
// headline shows plain totals for the snapshot's own window — the tiles keep
// their size either way, so nothing below them moves when the series lands.
import {
  opportunityLabels,
  shortAction,
  signalExplanation,
  signalMeaning,
} from "../../../../tui/src/presentation.ts"

import { TrendAreaChart } from "../charts/TrendAreaChart.tsx"
import {
  Card,
  Chips,
  Disclosure,
  EmptyState,
  KeyValues,
  LinkButton,
  OpenPageButton,
  Prose,
  SectionHeading,
  Tile,
  Tiles,
  Timeline,
} from "../components/ui.tsx"
import {
  compact,
  count,
  pathOf,
  percent,
  periods,
  position,
  readableDate,
  shortDate,
  signed,
  trend,
  trendLabel,
  windowTotals,
} from "../format.ts"
import {
  type Dashboard,
  type HomeCategory,
  type OpportunityKind,
  type Site,
  type TrendDay,
  type View,
  homeCategories,
  opportunityKinds,
} from "../types.ts"
import { homeCategoryLabel, logKindLabel, provisionalAnchor } from "./shared.ts"

export interface OverviewProps {
  readonly data: Dashboard
  readonly site: Site
  readonly trendDays: readonly TrendDay[] | undefined
  readonly rangeDays: number
  readonly selected: number
  readonly onSelect: (index: number) => void
  readonly onGoTo: (view: View, index: number) => void
}

const SignalCard = ({
  kind,
  total,
  previews,
  isSelected,
  onSelect,
}: {
  kind: HomeCategory
  total: number
  previews: readonly string[]
  isSelected: boolean
  onSelect: () => void
}) => (
  <button
    className={`signal-card${isSelected ? " is-selected" : ""}`}
    type="button"
    onClick={onSelect}
  >
    <div className="signal-card-head">
      <span className="signal-card-label">{homeCategoryLabel(kind)}</span>
      <span className={`signal-card-count${total === 0 ? " is-zero" : ""}`}>{count(total)}</span>
    </div>
    <div className="signal-card-previews">
      {(previews.length > 0 ? previews : ["Nothing qualifies in this window"]).map((preview) => (
        <span key={preview} title={preview}>
          {preview}
        </span>
      ))}
    </div>
  </button>
)

const Focus = ({
  data,
  site,
  kind,
  onGoTo,
}: Pick<OverviewProps, "data" | "site" | "onGoTo"> & { kind: HomeCategory }) => {
  if (kind === "sitemap-coverage") {
    const gaps = data.sitemapGaps
    return (
      <Card title="Unmapped sitemap pages" subtitle={`${gaps.length} pages without a registry row`}>
        <Disclosure summary="How this is detected">
          <Prose title="What it means">
            A published URL appears in sitemap.xml but has no target-page row in the selected site's
            registry.
          </Prose>
          <Prose title="Detection rule">
            Every sitemap URL path is compared with the registry target_url column. A blank keyword is
            allowed for inventory-only pages.
          </Prose>
          <Prose title="Recommended action">
            Add a page-only registry row, then assign keywords only when research or observed demand
            supports them.
          </Prose>
        </Disclosure>
        {gaps.length > 0 ? (
          <ul className="plain-list">
            {gaps.map((page) => (
              <li key={page.path}>
                <span className="mono">{page.path}</span>
                <OpenPageButton url={`${site.origin}${page.path}`} label="Open" />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState message="Every sitemap page is represented in the registry." />
        )}
      </Card>
    )
  }

  if (kind === "recent-activity") {
    const recent = data.recentActions
    const actions = data.logEntries.filter((entry) => entry.isAction).length
    return (
      <Card
        title="Recent activity"
        subtitle={`${actions} actions logged for this site`}
        action={<LinkButton label="Open the log" onClick={() => onGoTo("log", 0)} />}
      >
        {recent.length > 0 ? (
          <Timeline
            items={recent.map((entry) => ({
              id: String(entry.id),
              title: `${logKindLabel(entry.kind)} · ${entry.path}`,
              meta: readableDate(entry.date),
              body: entry.note || undefined,
            }))}
          />
        ) : (
          <EmptyState message="No actions logged yet. Record one with the log CLI." icon="clock" />
        )}
      </Card>
    )
  }

  const signals = data.digest.signals.filter((signal) => signal.kind === kind)
  const firstIndex = data.digest.signals.findIndex((signal) => signal.kind === kind)
  return (
    <Card
      title={opportunityLabels[kind]}
      subtitle={`${signals.length} signals in the current window`}
      action={
        signals.length > 0 ? (
          <LinkButton label="Inspect signals" onClick={() => onGoTo("opportunities", firstIndex)} />
        ) : undefined
      }
    >
      <Disclosure summary="How this is detected">
        <Prose title="What it means">{signalExplanation[kind]}</Prose>
        <Prose title="Detection rule">{signalMeaning[kind]}</Prose>
        <Prose title="Recommended action">{shortAction[kind]}</Prose>
      </Disclosure>
      {signals.length > 0 ? (
        <ul className="plain-list">
          {signals.slice(0, 6).map((signal) => (
            <li key={`${signal.kind}-${signal.label}-${signal.page}`}>
              <div className="plain-list-main">
                <span>{signal.label}</span>
                <span className="muted">
                  {pathOf(signal.page, site)} · position {signal.current.position.toFixed(1)}
                </span>
              </div>
              <span className="num">{compact(signal.current.impressions)} impr.</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState message="No signals meet this rule in the current window." icon="target" />
      )}
    </Card>
  )
}

const Headline = ({ data, trendDays, rangeDays }: Pick<OverviewProps, "data" | "trendDays" | "rangeDays">) => {
  if (!trendDays || trendDays.length === 0) {
    const totals = windowTotals(data.history)
    return (
      <>
        <SectionHeading>{`Last ${data.history.length} days`}</SectionHeading>
        <Tiles>
          <Tile label="Clicks" value={count(totals.clicks)} detail="site totals" />
          <Tile label="Impressions" value={count(totals.impressions)} detail="site totals, all queries" />
          <Tile label="CTR" value={percent(totals.ctr)} />
          <Tile
            label="Average position"
            value={position(totals.position)}
            detail="weighted by impressions"
          />
        </Tiles>
      </>
    )
  }

  const { current, previous } = periods(trendDays, rangeDays)
  const now = windowTotals(current)
  const before = windowTotals(previous)
  const clicks = trend(now.clicks, before.clicks)
  const impressions = trend(now.impressions, before.impressions)
  const ctrPoints = (now.ctr - before.ctr) * 100
  const positionMove = now.position - before.position
  const provisional = current.filter((day) => day.provisional).length
  const range = `${shortDate(current[0]?.date ?? "")} – ${shortDate(current.at(-1)?.date ?? "")}`
  const comparedWith =
    previous.length > 0
      ? `compared with ${shortDate(previous[0]?.date ?? "")} – ${shortDate(previous.at(-1)?.date ?? "")}`
      : "no earlier period stored to compare with"
  const provisionalFrom = provisionalAnchor(current)

  return (
    <>
      <SectionHeading>{`Last ${current.length} days · ${range}`}</SectionHeading>
      <p className="section-note">
        {comparedWith}
        {provisional > 0 && ` · ${provisional} day${provisional === 1 ? "" : "s"} still provisional`}
      </p>
      <Tiles>
        <Tile
          label="Clicks"
          value={count(now.clicks)}
          detail={trendLabel(clicks)}
          tone={clicks.delta >= 0 ? "positive" : "negative"}
        />
        <Tile
          label="Impressions"
          value={count(now.impressions)}
          detail={trendLabel(impressions)}
          tone={impressions.delta >= 0 ? "positive" : "negative"}
        />
        <Tile
          label="CTR"
          value={percent(now.ctr)}
          detail={`${signed(ctrPoints, 1)} pp`}
          tone={ctrPoints >= 0 ? "positive" : "negative"}
        />
        <Tile
          label="Average position"
          value={position(now.position)}
          detail={`${signed(positionMove, 1)} · lower is better`}
          // A falling position number is a better ranking, so the tone inverts.
          tone={positionMove <= 0 ? "positive" : "negative"}
        />
      </Tiles>
      <Card title="Impressions and clicks" subtitle={`Daily, over the last ${current.length} days`}>
        <TrendAreaChart
          data={current.map((day) => ({
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
          provisionalFrom={provisionalFrom ? shortDate(provisionalFrom) : undefined}
        />
      </Card>
    </>
  )
}

export const Overview = ({ data, site, trendDays, rangeDays, selected, onSelect, onGoTo }: OverviewProps) => {
  const grouped = new Map(
    opportunityKinds.map((kind) => [kind, data.digest.signals.filter((signal) => signal.kind === kind)]),
  )
  const actions = data.logEntries.filter((entry) => entry.isAction).length
  const selectedKind = homeCategories[selected] ?? "striking-distance"

  return (
    <div className="overview">
      <Headline data={data} trendDays={trendDays} rangeDays={rangeDays} />
      <SectionHeading>Signals this window</SectionHeading>
      <div className="signal-grid">
        {homeCategories.map((kind, index) => {
          const signals = grouped.get(kind as OpportunityKind) ?? []
          const total =
            kind === "sitemap-coverage"
              ? data.sitemapGaps.length
              : kind === "recent-activity"
                ? actions
                : signals.length
          const previews =
            kind === "sitemap-coverage"
              ? data.sitemapGaps.slice(0, 2).map((page) => page.path)
              : kind === "recent-activity"
                ? data.recentActions
                    .slice(0, 2)
                    .map(
                      (entry) =>
                        `${shortDate(entry.date)} · ${logKindLabel(entry.kind)} · ${entry.path}`,
                    )
                : signals
                    .slice(0, 2)
                    .map((signal) => `${signal.label} · ${compact(signal.current.impressions)} impr.`)
          return (
            <SignalCard
              key={kind}
              kind={kind}
              total={total}
              previews={previews}
              isSelected={index === selected}
              onSelect={() => onSelect(index)}
            />
          )
        })}
      </div>
      <Focus data={data} site={site} kind={selectedKind} onGoTo={onGoTo} />
      <Card
        title="Reporting window"
        subtitle="The 28-day window the signals above are classified in"
      >
        <KeyValues
          rows={[
            ["Current 28 days", `${data.digest.currentStart ?? "—"} → ${data.digest.latestDate ?? "—"}`],
            [
              "Previous 28 days",
              `${data.digest.previousStart ?? "—"} → ${data.digest.previousEnd ?? "—"}`,
            ],
            [
              "Sources",
              `${count(data.summary.rows)} stored query rows · ${count(data.sitemapPageCount)} sitemap pages · ${data.registry.filter((entry) => entry.keyword.trim()).length} keywords`,
            ],
          ]}
        />
      </Card>
    </div>
  )
}
