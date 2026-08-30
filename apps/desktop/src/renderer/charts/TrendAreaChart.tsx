// Recharts' Simple Area Chart, from
// https://recharts.github.io/en-US/examples/AreaChartExample/, bound to this
// app's data instead of the example's mock rows.
//
// Kept from the example verbatim: the `responsive` chart with a 1.618 aspect
// ratio, the `margin`, the per-series `<linearGradient>` with stops at 5%
// (opacity 0.8) and 95% (opacity 0), `<CartesianGrid>`, `<XAxis dataKey>`,
// `<YAxis width="auto">`, `<Tooltip>`, and `type="monotone"` areas with
// `fillOpacity={1}`, a matching `activeDot`, and the 200ms/1300ms entry
// animation.
//
// Adapted: the example's `maxWidth: 700px` becomes a `maxHeight` (a card here is
// wider than a docs page, and the aspect ratio alone would make the chart
// enormous); its `#8884d8`/`#82ca9d` placeholders become theme variables so the
// chart follows the system light/dark appearance; axis, grid and tooltip colours
// are set, which the example can leave at their light-mode defaults but a dark
// window cannot; and gradient ids are per-instance, because the example's
// hardcoded `colorUv`/`colorPv` would collide between two charts.
import { useId } from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

export interface Series {
  readonly key: string
  readonly name: string
  // Any CSS colour; a `var(--…)` keeps the series on the app's palette.
  readonly color: string
}

export type Row = Record<string, string | number | null>

export interface TrendAreaChartProps {
  readonly data: readonly Row[]
  readonly series: readonly Series[]
  readonly xKey: string
  readonly format?: (value: number) => string
  // Marks one reading and reports clicks back, so a chart can drive a selection
  // (the History view) or stay a read-only glance (the Overview).
  readonly activeIndex?: number
  readonly onSelectIndex?: (index: number) => void
  // The example caps at `70vh`, which suits a page with one chart on it. A card
  // in a scrolling column wants a shorter one.
  readonly maxHeight?: string
  // The x value from which the readings are provisional — Google is still
  // revising them. Everything from here on is washed out, so an unsettled tail
  // is never read as a finished trend.
  readonly provisionalFrom?: string
}

const tooltipStyle = {
  background: "var(--surface-raised)",
  border: "1px solid var(--border-strong)",
  borderRadius: "8px",
  boxShadow: "var(--shadow)",
  color: "var(--text)",
  fontSize: "12px",
}

export const TrendAreaChart = ({
  data,
  series,
  xKey,
  format,
  activeIndex,
  onSelectIndex,
  maxHeight = "320px",
  provisionalFrom,
}: TrendAreaChartProps) => {
  // The example hardcodes `colorUv`/`colorPv`; two charts on one screen would
  // then share a gradient, so each instance gets its own id prefix.
  const gradientPrefix = useId().replaceAll(":", "")
  const activeLabel =
    activeIndex === undefined ? undefined : (data[activeIndex]?.[xKey] as string | undefined)

  return (
    <AreaChart
      // Recharts interpolates its entry animation between the old and new
      // datasets. Changing the reporting range changes the point count, and the
      // interpolation between two different lengths leaves the area drawn with
      // the old number of points — a 180-day series rendered as a handful of
      // segments. Keying on the shape remounts the chart so it animates from
      // scratch instead.
      key={`${series.map((entry) => entry.key).join("-")}-${data.length}`}
      style={{ width: "100%", maxHeight, aspectRatio: 1.618 }}
      responsive
      data={data as Row[]}
      margin={{ top: 10, right: 0, left: 0, bottom: 0 }}
      onClick={(state) => {
        if (!onSelectIndex) return
        // Recharts reports the active index as `number | string` (a categorical
        // axis may be keyed by its label), so it is narrowed rather than trusted.
        const index = Number(state?.activeTooltipIndex)
        if (Number.isInteger(index) && index >= 0) onSelectIndex(index)
      }}
    >
      <defs>
        {series.map((entry) => (
          <linearGradient
            key={entry.key}
            id={`${gradientPrefix}-${entry.key}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="5%" stopColor={entry.color} stopOpacity={0.8} />
            <stop offset="95%" stopColor={entry.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
      <XAxis
        dataKey={xKey}
        stroke="var(--border-strong)"
        tick={{ fill: "var(--faint)", fontSize: 11 }}
        // 30 labels do not fit; Recharts drops the ones that would collide.
        interval="preserveStartEnd"
        minTickGap={24}
      />
      {/* One axis for every series: clicks are a subset of impressions, so a
          second scale would draw them above the impressions they came from. */}
      <YAxis
        width="auto"
        stroke="var(--border-strong)"
        tick={{ fill: "var(--faint)", fontSize: 11 }}
        tickFormatter={format}
      />
      <Tooltip
        contentStyle={tooltipStyle}
        labelStyle={{ color: "var(--text-strong)", fontWeight: 600 }}
        itemStyle={{ color: "var(--text)" }}
        cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
        formatter={(value) =>
          typeof value === "number" && format ? format(value) : String(value ?? "")
        }
      />
      {series.map((entry, index) => (
        <Area
          key={entry.key}
          type="monotone"
          dataKey={entry.key}
          name={entry.name}
          stroke={entry.color}
          activeDot={{ stroke: entry.color }}
          fillOpacity={1}
          fill={`url(#${gradientPrefix}-${entry.key})`}
          isAnimationActive
          animationBegin={index === 0 ? 200 : 0}
          animationDuration={1300}
          connectNulls
        />
      ))}
      {provisionalFrom === undefined ? null : (
        // Drawn after the areas so it sits over them: the card's own background
        // at partial opacity, which fades the tail toward the surface rather
        // than tinting it another colour.
        <ReferenceArea
          x1={provisionalFrom}
          x2={data.at(-1)?.[xKey] as string | undefined}
          fill="var(--surface)"
          fillOpacity={0.62}
          stroke="var(--border-strong)"
          strokeOpacity={0.5}
          strokeDasharray="3 3"
        />
      )}
      {activeLabel === undefined ? null : (
        <ReferenceLine x={activeLabel} stroke="var(--accent)" strokeDasharray="3 3" />
      )}
    </AreaChart>
  )
}
