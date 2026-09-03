// Row-sized sparklines. The full charts are Recharts (see
// ../charts/TrendAreaChart.tsx); these are not, because a registry list mounts
// one per row and a Recharts tree each would cost far more than the line is
// worth.
export interface SparklineProps {
  readonly values: readonly number[]
  // A rising position number is a worse ranking, so its line is coloured against
  // the trend rather than with it.
  readonly lowerIsBetter?: boolean
  readonly width?: number
  readonly height?: number
  // Overrides the colour derived from the first and last readings. A caller that
  // already shows a period-over-period change must pass its own verdict, or the
  // line contradicts the number printed next to it: a series can end on a dip
  // and still be far above the period before it.
  readonly tone?: "positive" | "negative"
}

export const Sparkline = ({
  values,
  lowerIsBetter = false,
  width = 96,
  height = 26,
  tone,
}: SparklineProps) => {
  const observed = values.filter((value) => value > 0)
  if (observed.length < 2)
    return (
      <svg className="sparkline sparkline-empty" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <line x1={2} x2={width - 2} y1={height / 2} y2={height / 2} />
      </svg>
    )

  const pad = { left: 1, right: 1, top: 3, bottom: 3 }
  const maximum = Math.max(...values, 1)
  const minimum = Math.min(...values, maximum)
  // A flat series would divide by zero; a 1-unit span keeps it on the baseline.
  const span = maximum - minimum || 1
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const x = (index: number) =>
    pad.left + (values.length < 2 ? plotWidth / 2 : (index / (values.length - 1)) * plotWidth)
  const y = (value: number) => pad.top + plotHeight - ((value - minimum) / span) * plotHeight

  const first = values.find((value) => value > 0) ?? 0
  const last = [...values].reverse().find((value) => value > 0) ?? 0
  const rising = last >= first
  const better = tone ? tone === "positive" : lowerIsBetter ? !rising : rising

  return (
    <svg
      className={`sparkline ${better ? "tone-positive" : "tone-negative"}`}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline
        className="sparkline-line"
        points={values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
      />
      <circle
        className="sparkline-point"
        cx={x(values.length - 1)}
        cy={y(values.at(-1) ?? 0)}
        r={2}
      />
    </svg>
  )
}
