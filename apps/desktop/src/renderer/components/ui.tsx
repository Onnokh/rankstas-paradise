// The app's visual vocabulary: cards, stat tiles, badges and lists. The views
// compose these instead of formatting fixed-width text, which is the whole
// difference between this window and the terminal dashboard it shares data with.
import type { ReactNode } from "react"

import { Icon, type IconName } from "./Icon.tsx"

export type Tone = "neutral" | "positive" | "negative" | "accent" | "muted"

export const Card = ({
  title,
  subtitle,
  action,
  children,
}: {
  title?: string
  subtitle?: string
  action?: ReactNode
  children?: ReactNode
}) => (
  <section className="card">
    {(title || action) && (
      <header className="card-head">
        <div className="card-headings">
          {title && <h2 className="card-title">{title}</h2>}
          {subtitle && <p className="card-subtitle">{subtitle}</p>}
        </div>
        {action}
      </header>
    )}
    {children}
  </section>
)

export const SectionHeading = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="section-heading">
    <h2>{children}</h2>
    {action}
  </div>
)

// A headline number with its label — the dashboard's unit of "one measurement".
export const Tile = ({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string
  value: string
  detail?: string
  tone?: Tone
}) => (
  <div className="tile">
    <span className="tile-label">{label}</span>
    <span className="tile-value">{value}</span>
    {detail && <span className={`tile-detail tone-${tone}`}>{detail}</span>}
  </div>
)

export const Tiles = ({ children }: { children: ReactNode }) => <div className="tiles">{children}</div>

export const Badge = ({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) => (
  <span className={`badge tone-${tone}`}>{children}</span>
)

export type Fact = readonly [string, ReactNode]

// Label/value pairs. Values stay selectable text, so a path or a date can be
// copied straight out of the pane.
export const KeyValues = ({ rows }: { rows: readonly (Fact | null | false)[] }) => (
  <dl className="kv">
    {rows
      .filter((row): row is Fact => Boolean(row))
      .map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
  </dl>
)

// A titled paragraph of the shared explanatory copy (what it means, detection
// rule, recommended action).
export const Prose = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="prose">
    <h3 className="prose-title">{title}</h3>
    <p className="prose-body">{children}</p>
  </div>
)

// The guide copy is reference material, not something to read on every row, so
// it collapses behind a disclosure instead of filling a third of the pane.
export const Disclosure = ({ summary, children }: { summary: string; children: ReactNode }) => (
  <details className="disclosure">
    <summary>
      {summary}
      <Icon name="chevron" size={14} />
    </summary>
    <div className="disclosure-body">{children}</div>
  </details>
)

export const EmptyState = ({ message, icon = "alert" }: { message: string; icon?: IconName }) => (
  <div className="empty">
    <Icon name={icon} size={20} />
    <p>{message}</p>
  </div>
)

export const Chips = ({ items }: { items: readonly string[] }) => (
  <ul className="chips">
    {items.map((item) => (
      <li key={item} className="chip">
        {item}
      </li>
    ))}
  </ul>
)

export interface TimelineItem {
  readonly id: string
  readonly title: string
  readonly meta?: string
  readonly body?: string
  readonly tone?: Tone
}

export const Timeline = ({ items }: { items: readonly TimelineItem[] }) => (
  <ol className="timeline">
    {items.map((item) => (
      <li key={item.id} className={`timeline-item tone-${item.tone ?? "neutral"}`}>
        <div className="timeline-head">
          <span className="timeline-title">{item.title}</span>
          {item.meta && <span className="timeline-meta">{item.meta}</span>}
        </div>
        {item.body && <p className="timeline-body">{item.body}</p>}
      </li>
    ))}
  </ol>
)

export const LinkButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button className="link-button" type="button" onClick={onClick}>
    {label}
  </button>
)

// Opening a tracked page belongs in the OS browser, matching the TUI's Enter key.
export const OpenPageButton = ({ url, label = "Open page" }: { url: string; label?: string }) => (
  <button
    className="ghost-button"
    type="button"
    title={url}
    onClick={() => void window.rp.openExternal(url)}
  >
    {label}
    <Icon name="external" size={13} />
  </button>
)
