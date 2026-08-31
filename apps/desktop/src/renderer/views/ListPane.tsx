// The list half of the four split screens. Every row is a grid whose tracks are
// set per view in the stylesheet, so a column can be sized to its longest value
// rather than to a shared default.
import { opportunityLabels, phaseFor } from "../../../../tui/src/presentation.ts"

import { type ReactNode, useEffect, useRef } from "react"

import { Badge } from "../components/ui.tsx"
import { Sparkline } from "../components/Sparkline.tsx"
import { compact, count, dayChange, pathOf, percent, shortDate, signed } from "../format.ts"
import type { Dashboard, Site, View } from "../types.ts"
import { kindTone, logKindLabel, phaseTone } from "./shared.ts"

interface Column {
  readonly label: string
  readonly align?: "right"
  // Takes a line of its own across the whole row, for a value too long to share
  // the width with the columns beside it.
  readonly span?: boolean
}

// A two-line cell. A query or a target path is the row's subject and needs the
// full width of the pane; a column each would leave both truncated, so the
// secondary line sits under the primary one instead of beside it.
const Stacked = ({ primary, secondary }: { primary: string; secondary: string }) => (
  <span className="stack">
    <span className="stack-main" title={primary}>
      {primary}
    </span>
    <span className="stack-sub" title={secondary}>
      {secondary}
    </span>
  </span>
)

const Cell = ({ value, className = "" }: { value: string; className?: string }) => (
  <span className={className} title={value}>
    {value}
  </span>
)

export interface ListPaneProps {
  readonly data: Dashboard
  readonly site: Site
  readonly view: View
  readonly selected: number
  readonly onSelect: (index: number) => void
}

const columnsFor = (view: View): readonly Column[] =>
  view === "opportunities"
    ? [
        { label: "Type" },
        { label: "Query and page" },
        { label: "Impr.", align: "right" },
        { label: "Pos.", align: "right" },
      ]
    : view === "history"
      ? [
          { label: "Date" },
          { label: "Impressions", align: "right" },
          { label: "Change", align: "right" },
          { label: "Clicks", align: "right" },
          { label: "CTR", align: "right" },
          { label: "Position", align: "right" },
        ]
      : view === "log"
        ? [{ label: "Date" }, { label: "Kind" }, { label: "Target and note" }]
        : [
            { label: "Target URL", span: true },
            { label: "Phase" },
            { label: "KW" },
            { label: "Trend" },
            { label: "Impr.", align: "right" },
            { label: "CTR", align: "right" },
          ]

const emptyFor = (view: View): string =>
  view === "opportunities"
    ? "No opportunities meet the current thresholds."
    : view === "history"
      ? "No finalized search activity is available."
      : view === "log"
        ? "No actions or notes logged yet. Record one with the log CLI."
        : "The keyword registry has no target pages."

const legendFor = (view: View): string | undefined =>
  view === "history"
    ? "Dimmed days carry site totals only; their per-query data is not finalized yet."
    : view === "log"
      ? "Dimmed rows are notes — annotations, not changes to the page."
      : view === "registry"
        ? "Dimmed rows are pages Google reports as not indexed."
        : undefined

const Row = ({
  index,
  view,
  selected,
  dim,
  onSelect,
  children,
}: {
  index: number
  view: View
  selected: number
  dim?: boolean
  onSelect: (index: number) => void
  children: ReactNode
}) => {
  const node = useRef<HTMLDivElement>(null)
  const isSelected = index === selected
  // The keyboard can move the selection past either edge of the viewport, so the
  // selected row pulls itself back into view.
  useEffect(() => {
    if (isSelected) node.current?.scrollIntoView({ block: "nearest" })
  }, [isSelected])
  return (
    <div
      ref={node}
      className={`row row-${view}${isSelected ? " is-selected" : ""}${dim ? " is-dim" : ""}`}
      role="row"
      tabIndex={-1}
      onClick={() => onSelect(index)}
    >
      {children}
    </div>
  )
}

export const ListPane = ({ data, site, view, selected, onSelect }: ListPaneProps) => {
  const columns = columnsFor(view)
  const legend = legendFor(view)

  const rows =
    view === "opportunities"
      ? data.digest.signals.map((signal, index) => (
          <Row
            key={`${signal.kind}-${signal.label}-${signal.page}-${index}`}
            index={index}
            view={view}
            selected={selected}
            onSelect={onSelect}
          >
            <Badge tone={kindTone[signal.kind]}>{opportunityLabels[signal.kind]}</Badge>
            <Stacked primary={signal.label} secondary={pathOf(signal.page, site)} />
            <Cell value={compact(signal.current.impressions)} className="num" />
            <Cell value={signal.current.position.toFixed(1)} className="num" />
          </Row>
        ))
      : view === "history"
        ? data.history
            .map((day, index) => ({ day, index }))
            .reverse()
            .map(({ day, index }) => {
            const { change, significant } = dayChange(day, data.history[index - 1])
            const tone = !significant ? "flat" : change! > 0 ? "up" : "down"
            return (
              <Row
                key={day.date}
                index={index}
                view={view}
                selected={selected}
                dim={day.provisional}
                onSelect={onSelect}
              >
                <Cell value={shortDate(day.date)} className="strong" />
                <Cell value={count(day.impressions)} className="num" />
                <span className={`num delta delta-${tone}`}>
                  {change === null ? "—" : signed(change)}
                </span>
                <Cell value={count(day.clicks)} className="num" />
                <Cell value={percent(day.ctr)} className="num" />
                <Cell value={day.position.toFixed(1)} className="num" />
              </Row>
            )
          })
        : view === "log"
          ? data.logEntries.map((entry, index) => (
              <Row
                key={entry.id}
                index={index}
                view={view}
                selected={selected}
                dim={!entry.isAction}
                onSelect={onSelect}
              >
                <Cell value={shortDate(entry.date)} className="strong" />
                <Badge tone={entry.isAction ? "accent" : "muted"}>{logKindLabel(entry.kind)}</Badge>
                <Stacked primary={entry.path} secondary={entry.note || "—"} />
              </Row>
            ))
          : data.registryTargets.map((progress, index) => {
              const keywords = progress.entries.filter((entry) => entry.keyword.trim()).length
              const phase = phaseFor(progress)
              const days = data.performance(progress.targetUrl).days.slice(-14)
              return (
                <Row
                  key={progress.targetUrl}
                  index={index}
                  view={view}
                  selected={selected}
                  dim={progress.indexStatus === "not-indexed"}
                  onSelect={onSelect}
                >
                  <Cell value={progress.targetUrl} className="strong mono row-span" />
                  <Badge tone={phaseTone(phase)}>{phase}</Badge>
                  <Cell value={keywords > 0 ? `${keywords} kw` : "page"} className="muted" />
                  <Sparkline values={days.map((day) => day.impressions)} />
                  <Cell value={compact(progress.target.impressions)} className="num" />
                  <Cell
                    value={progress.target.impressions > 0 ? percent(progress.target.ctr) : "—"}
                    className="num"
                  />
                </Row>
              )
            })

  return (
    <section className="list-pane">
      <div className={`list-head row-${view}`}>
        {columns.map((column) => (
          <span
            key={column.label}
            className={`${column.span ? "row-span " : ""}${column.align === "right" ? "align-right" : ""}`.trim()}
          >
            {column.label}
          </span>
        ))}
      </div>
      <div className="list-rows" role="rowgroup">
        {rows.length > 0 ? rows : <p className="list-empty">{emptyFor(view)}</p>}
      </div>
      {legend && <p className="list-legend">{legend}</p>}
    </section>
  )
}
