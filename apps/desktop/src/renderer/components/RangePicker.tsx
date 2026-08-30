// The span the daily-totals views cover. It governs the overview's headline and
// chart and the History list; the opportunity, registry and log collections are
// classified server-side over a fixed 28-day window, so it leaves those alone —
// which is why it only appears on the two views it can actually change.
import { type Range, ranges } from "../format.ts"

export const RangePicker = ({
  value,
  onChange,
}: {
  value: number
  onChange: (days: number) => void
}) => (
  <div className="range-picker" role="group" aria-label="Reporting range">
    {ranges.map((range: Range) => (
      <button
        key={range.id}
        className={`range-option${range.days === value ? " is-active" : ""}`}
        type="button"
        aria-pressed={range.days === value}
        onClick={() => onChange(range.days)}
      >
        {range.label}
      </button>
    ))}
  </div>
)
