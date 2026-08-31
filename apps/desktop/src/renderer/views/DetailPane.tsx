// The detail half of the four split screens: everything known about the row the
// list has selected. `setActiveOrigin` is called first because the shared
// presentation copy strips the active site's origin from the URLs it formats.
import {
  opportunityLabels,
  phaseFor,
  readableIntent,
  setActiveOrigin,
  shortAction,
  signalExplanation,
  signalMeaning,
  signalReason,
} from "../../../../tui/src/presentation.ts"

import { TrendAreaChart } from "../charts/TrendAreaChart.tsx"
import { Sparkline } from "../components/Sparkline.tsx"
import {
  Badge,
  Card,
  Chips,
  EmptyState,
  KeyValues,
  OpenPageButton,
  Prose,
  Tile,
  Tiles,
  Timeline,
  type Tone,
} from "../components/ui.tsx"
import {
  compact,
  count,
  metricLine,
  pathOf,
  percent,
  position,
  readableDate,
  shortDate,
  signed,
} from "../format.ts"
import type {
  Dashboard,
  HistoryDay,
  LogFeedEntry,
  OpportunitySignal,
  RegistryTargetProgress,
  Site,
  View,
} from "../types.ts"
import {
  kindTone,
  logKindLabel,
  phaseTone,
  provisionalAnchor,
  readoutLine,
  registryForSignal,
} from "./shared.ts"

export interface DetailPaneProps {
  readonly data: Dashboard
  readonly site: Site
  readonly view: View
  readonly selected: number
  readonly onSelect: (index: number) => void
}

// A signed count with thousands separators, for a delta shown beside a headline.
const movement = (delta: number) => `${delta >= 0 ? "+" : "−"}${count(Math.abs(delta))}`

const OpportunityDetail = ({
  data,
  site,
  signal,
}: {
  data: Dashboard
  site: Site
  signal: OpportunitySignal
}) => {
  const mapping = registryForSignal(signal, data.registry, site)
  const delta = signal.previous ? signal.current.impressions - signal.previous.impressions : null
  const previousLabel = signal.launch ? "vs pre-launch baseline" : "vs previous 28 days"
  return (
    <>
      <div className="detail-head">
        <div>
          <Badge tone={kindTone[signal.kind]}>{opportunityLabels[signal.kind]}</Badge>
          <h2>{signal.label}</h2>
          <p className="muted mono">{pathOf(signal.page, site)}</p>
        </div>
        <OpenPageButton url={signal.page} />
      </div>
      <Tiles>
        <Tile
          label="Impressions"
          value={count(signal.current.impressions)}
          detail={delta === null ? previousLabel : `${movement(delta)} ${previousLabel}`}
          tone={delta === null ? "muted" : delta >= 0 ? "positive" : "negative"}
        />
        <Tile label="Clicks" value={count(signal.current.clicks)} />
        <Tile label="CTR" value={percent(signal.current.ctr)} />
        <Tile
          label="Position"
          value={signal.current.position.toFixed(1)}
          detail="lower is better"
        />
      </Tiles>
      <Card title="Why this matches the rule">
        <p className="prose-body">{signalReason(signal)}</p>
        <KeyValues
          rows={[
            ["Query", signal.query ?? "Launch target"],
            ["Registry", mapping ? `${mapping.targetUrl} · ${mapping.priority}` : "Unmapped"],
            ["Recommendation", signal.recommendation],
            signal.pages.length > 1
              ? ["Competing URLs", signal.pages.map((page) => pathOf(page, site)).join(", ")]
              : null,
          ]}
        />
      </Card>
      {signal.launch && (
        <Card title="Launch windows" subtitle={`${signal.launch.daysSinceLaunch} days since launch`}>
          <p className="prose-body">
            {[
              metricLine("28 days", signal.launch.day28, signal.launch.daysSinceLaunch >= 27),
              metricLine("56 days", signal.launch.day56, signal.launch.daysSinceLaunch >= 55),
              metricLine("84 days", signal.launch.day84, signal.launch.daysSinceLaunch >= 83),
            ].join("\n")}
          </p>
        </Card>
      )}
      <Card title={opportunityLabels[signal.kind]}>
        <Prose title="What it means">{signalExplanation[signal.kind]}</Prose>
        <Prose title="Detection rule">{signalMeaning[signal.kind]}</Prose>
        <Prose title="Recommended action">{shortAction[signal.kind]}</Prose>
      </Card>
    </>
  )
}

const HistoryDetail = ({
  data,
  day,
  selected,
  onSelect,
}: {
  data: Dashboard
  day: HistoryDay
  selected: number
  onSelect: (index: number) => void
}) => {
  const days = data.history
  const previous = days[selected - 1]
  const provisionalFrom = provisionalAnchor(days)
  return (
    <>
      <div className="detail-head">
        <div>
          {day.provisional ? (
            <Badge tone="muted">Provisional</Badge>
          ) : (
            <Badge tone="positive">Finalized</Badge>
          )}
          <h2>{readableDate(day.date)}</h2>
        </div>
      </div>
      <Tiles>
        <Tile
          label="Impressions"
          value={count(day.impressions)}
          detail={
            previous
              ? `${movement(day.impressions - previous.impressions)} vs previous day`
              : "first stored day"
          }
          tone={previous ? (day.impressions >= previous.impressions ? "positive" : "negative") : "muted"}
        />
        <Tile
          label="Clicks"
          value={count(day.clicks)}
          detail={previous ? `${signed(day.clicks - previous.clicks)} vs previous day` : undefined}
          tone={previous ? (day.clicks >= previous.clicks ? "positive" : "negative") : "muted"}
        />
        <Tile
          label="CTR"
          value={percent(day.ctr)}
          detail={previous ? `${signed((day.ctr - previous.ctr) * 100, 1)} pp` : undefined}
        />
        <Tile label="Position" value={day.position.toFixed(1)} detail="weighted average" />
      </Tiles>
      <Card title="Daily impressions" subtitle={`${days.length} finalized days`}>
        <TrendAreaChart
          data={days.map((entry) => ({
            label: shortDate(entry.date),
            impressions: entry.impressions,
          }))}
          series={[{ key: "impressions", name: "Impressions", color: "var(--chart-1)" }]}
          xKey="label"
          format={compact}
          provisionalFrom={provisionalFrom ? shortDate(provisionalFrom) : undefined}
          activeIndex={selected}
          onSelectIndex={onSelect}
        />
      </Card>
      <Card>
        <p className="prose-body muted">
          {day.provisional
            ? "Provisional: site-level totals only. Google has not finalized the per-query breakdown for this day, so it is not yet counted in query, page, or opportunity views."
            : "Search Console data is finalized with a short reporting delay; the daily sync refreshes recent dates to absorb revisions."}
        </p>
      </Card>
    </>
  )
}

const LogDetail = ({ site, entry }: { site: Site; entry: LogFeedEntry }) => {
  const readout = readoutLine(entry.readout)
  return (
    <>
      <div className="detail-head">
        <div>
          <Badge tone={entry.isAction ? "accent" : "muted"}>{logKindLabel(entry.kind)}</Badge>
          <h2>{readableDate(entry.date)}</h2>
          <p className="muted mono">{entry.path}</p>
        </div>
        <OpenPageButton url={`${site.origin}${entry.path}`} />
      </div>
      <Card title="Note">
        <p className="prose-body">{entry.note || "No note recorded."}</p>
      </Card>
      {readout && (
        <Card title="Before / after">
          <p className="prose-body">{readout}</p>
        </Card>
      )}
      <Card>
        <KeyValues
          rows={[
            [
              "Kind",
              `${logKindLabel(entry.kind)}${entry.isAction ? "" : " — an annotation, not a change"}`,
            ],
            ["Logged", readableDate(entry.createdAt.slice(0, 10))],
          ]}
        />
      </Card>
    </>
  )
}

const RegistryDetail = ({
  data,
  site,
  progress,
}: {
  data: Dashboard
  site: Site
  progress: RegistryTargetProgress
}) => {
  const entry = progress.entries[0]
  if (!entry) return <EmptyState message="This target has no registry rows." />
  const keywordEntries = progress.entries.filter((mapped) => mapped.keyword.trim())
  const inventoryOnly = keywordEntries.length === 0
  const performance = data.performance(progress.targetUrl)
  const indexTone: Tone =
    progress.indexStatus === "indexed"
      ? "positive"
      : progress.indexStatus === "not-indexed"
        ? "negative"
        : "muted"
  const indexLabel =
    progress.indexStatus === "indexed"
      ? "Indexed"
      : progress.indexStatus === "not-indexed"
        ? "Not indexed"
        : "Index unknown"
  const momentum = performance.last7.impressions - performance.previous7.impressions
  const momentumLabel =
    performance.previous7.impressions > 0
      ? `${signed(momentum)} impressions (${signed((momentum / performance.previous7.impressions) * 100, 1)}%)`
      : performance.last7.impressions > 0
        ? `${signed(momentum)} impressions · new visibility`
        : "No impression change yet"
  const measurementStatus = inventoryOnly
    ? `Tracking all Search Console visibility for this sitemap page; latest finalized data is ${progress.latestDate ?? "unavailable"}.`
    : performance.total.impressions > 0
      ? `Measuring non-brand visibility since ${progress.measuredFrom ?? "the first stored day"}; latest finalized data is ${progress.latestDate ?? "unavailable"}.`
      : progress.state === "measuring"
        ? `No non-brand impressions for this target in the measurement window ending ${progress.latestDate ?? "the latest stored day"}.`
        : progress.state === "awaiting-post-baseline"
          ? `Waiting for finalized Search Console data after ${entry.publishedAt || entry.baselineDate}. Latest available date is ${progress.latestDate ?? "unavailable"}.`
          : "Waiting for the first Search Console observation."
  const trend = performance.days.slice(-14)
  const activity = data.logEntries.filter((logged) => logged.path === progress.targetUrl)
  const phase = phaseFor(progress)
  const baselineDelta = progress.baseline
    ? performance.total.impressions - progress.baseline.impressions
    : null

  return (
    <>
      <div className="detail-head">
        <div>
          <div className="badge-row">
            <Badge tone={phaseTone(phase)}>{phase}</Badge>
            <Badge tone={indexTone}>{indexLabel}</Badge>
            <Badge tone="muted">{entry.priority}</Badge>
          </div>
          <h2 className="mono">{progress.targetUrl}</h2>
          <p className="muted">{readableIntent(entry.intent)}</p>
        </div>
        <OpenPageButton url={`${site.origin}${progress.targetUrl}`} />
      </div>
      <Tiles>
        <Tile
          label="Impressions"
          value={count(performance.total.impressions)}
          detail={
            inventoryOnly
              ? "all queries, 28 days"
              : baselineDelta === null
                ? "non-brand, 28 days"
                : `${movement(baselineDelta)} vs baseline`
          }
          tone={
            baselineDelta === null || inventoryOnly
              ? "muted"
              : baselineDelta >= 0
                ? "positive"
                : "negative"
          }
        />
        <Tile label="Clicks" value={count(performance.total.clicks)} />
        <Tile label="CTR" value={percent(performance.total.ctr)} />
        <Tile
          label="Position"
          value={position(performance.total.position)}
          detail="lower is better"
        />
      </Tiles>
      <Card
        title={inventoryOnly ? "Page performance · all queries" : "Non-brand performance"}
        subtitle={momentumLabel}
      >
        <p className="prose-body muted">{measurementStatus}</p>
        <div className="trend-row">
          <div className="trend">
            <span className="trend-label">Daily impressions</span>
            <Sparkline values={trend.map((day) => day.impressions)} width={160} height={34} />
            <span className="num">{count(performance.last7.impressions)}</span>
          </div>
          <div className="trend">
            <span className="trend-label">Daily position</span>
            <Sparkline
              values={trend.map((day) => day.position)}
              width={160}
              height={34}
              lowerIsBetter
            />
            <span className="num">{position(performance.last7.position)}</span>
          </div>
        </div>
        <KeyValues
          rows={[
            ["Last 7 days", metricLine("", performance.last7).replace(/^: /, "")],
            ["Previous 7 days", metricLine("", performance.previous7).replace(/^: /, "")],
            [
              "Google index",
              [
                indexLabel,
                progress.coverageState,
                progress.inspectedAt ? `checked ${progress.inspectedAt.slice(0, 10)}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ],
            ["Country", entry.country],
          ]}
        />
      </Card>
      <Card title="Why this is an opportunity">
        <p className="prose-body">
          {entry.whyOpportunity || "No opportunity rationale has been recorded for this page."}
        </p>
      </Card>
      <Card title="Keywords" subtitle={`${keywordEntries.length} mapped`}>
        {keywordEntries.length > 0 ? (
          <Chips items={keywordEntries.map((mapped) => mapped.keyword)} />
        ) : (
          <EmptyState
            message="No keyword target assigned; this page is tracked as sitemap inventory."
            icon="table"
          />
        )}
      </Card>
      <Card title="Activity" subtitle={`${activity.length} entries`}>
        {activity.length > 0 ? (
          <Timeline
            items={activity.slice(0, 8).map((logged) => ({
              id: String(logged.id),
              title: logKindLabel(logged.kind),
              meta:
                logged.readout.state === "window"
                  ? `${readableDate(logged.date)} · ${count(logged.readout.before.impressions)} → ${count(logged.readout.after.impressions)} impr${logged.readout.afterComplete ? "" : " (partial)"}`
                  : readableDate(logged.date),
              body: logged.note || undefined,
              tone: logged.isAction ? ("accent" as const) : ("muted" as const),
            }))}
          />
        ) : (
          <EmptyState message="No actions or notes logged for this page yet." icon="clock" />
        )}
      </Card>
    </>
  )
}

export const DetailPane = ({ data, site, view, selected, onSelect }: DetailPaneProps) => {
  setActiveOrigin(site.origin)
  const item =
    view === "opportunities"
      ? data.digest.signals[selected]
      : view === "history"
        ? data.history[selected]
        : view === "log"
          ? data.logEntries[selected]
          : data.registryTargets[selected]

  return (
    <section className="detail-pane">
      {!item ? (
        <EmptyState message="Select a row to inspect it." icon="target" />
      ) : view === "opportunities" ? (
        <OpportunityDetail data={data} site={site} signal={item as OpportunitySignal} />
      ) : view === "history" ? (
        <HistoryDetail
          data={data}
          day={item as HistoryDay}
          selected={selected}
          onSelect={onSelect}
        />
      ) : view === "log" ? (
        <LogDetail site={site} entry={item as LogFeedEntry} />
      ) : (
        <RegistryDetail data={data} site={site} progress={item as RegistryTargetProgress} />
      )}
    </section>
  )
}
