// A source list: every configured site, each with its own five views, so one
// click reaches any view of any site.
//
// The counts come from `useQueries` over every site's dashboard — one query per
// site, all cached under their own keys. That is also what makes switching feel
// instant: by the time a site is clicked its snapshot is usually already
// resolved, so the pane paints from cache instead of blanking.
import { useQueries, useQuery } from "@tanstack/react-query"

import type { DashboardSnapshot } from "@rp/api-client/schema"

import { count } from "../format.ts"
import { dashboardQuery, faviconQuery } from "../queries.ts"
import { type Site, type View, views } from "../types.ts"
import { Icon, type IconName } from "./Icon.tsx"

const navIcons: Record<View, IconName> = {
  home: "home",
  opportunities: "target",
  history: "chart",
  registry: "table",
  log: "clock",
}

const navCount = (snapshot: DashboardSnapshot | undefined, view: View): string | null => {
  if (!snapshot || view === "home") return null
  if (view === "opportunities") return count(snapshot.digest.signals.length)
  if (view === "history") return count(snapshot.history.length)
  if (view === "registry") return count(snapshot.registryTargets.length)
  return count(snapshot.logEntries.length)
}

export interface SidebarProps {
  readonly sites: readonly Site[]
  readonly activeSiteId: string | undefined
  readonly view: View
  // True when the cross-site overview is open. It belongs to no site, so no
  // site group is highlighted while it is.
  readonly isOverview: boolean
  readonly onOpen: (siteId: string, view: View) => void
  readonly onOpenOverview: () => void
  readonly onSync: () => void
  readonly isSyncing: boolean
  readonly status: string
}

// The site's own favicon, standing in for the generic dot. It arrives as a
// `data:` URL over the bridge (see main/favicon.ts), so a site that has no
// readable icon — or whose lookup has not landed yet — keeps the dot rather
// than leaving a gap that would shift the row.
const SiteMark = ({ origin }: { origin: string }) => {
  const icon = useQuery(faviconQuery(origin))
  if (!icon.data) return <span className="site-dot" />
  return <img className="site-favicon" src={icon.data} alt="" aria-hidden="true" />
}

export const Sidebar = ({
  sites,
  activeSiteId,
  view,
  isOverview,
  onOpen,
  onOpenOverview,
  onSync,
  isSyncing,
  status,
}: SidebarProps) => {
  const snapshots = useQueries({
    queries: sites.map((site) => dashboardQuery(site.id)),
  })

  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <nav className="nav" aria-label="Sites and views">
        {/* Above the site groups, because it is not one of them: this page sets
            the sites beside each other rather than opening one. */}
        <button
          className={`nav-item nav-root${isOverview ? " is-active" : ""}`}
          type="button"
          onClick={onOpenOverview}
        >
          <Icon name="layers" />
          <span className="nav-label">Overview</span>
          <span className="nav-count">{count(sites.length)}</span>
        </button>
        {sites.map((site, index) => {
          const isActiveSite = !isOverview && site.id === activeSiteId
          // A site whose query has not resolved yet has no counts to show; its
          // views still open, they just carry no number until the read lands.
          const snapshot = snapshots[index]?.data
          return (
            <div key={site.id} className={`site-group${isActiveSite ? " is-active" : ""}`}>
              <button
                className="site-name"
                type="button"
                title={site.origin}
                onClick={() => onOpen(site.id, view)}
              >
                <SiteMark origin={site.origin} />
                <span>{site.name}</span>
              </button>
              <div className="site-views">
                {views.map((item) => {
                  const badgeText = navCount(snapshot, item.view)
                  return (
                    <button
                      key={item.view}
                      className={`nav-item${isActiveSite && item.view === view ? " is-active" : ""}`}
                      type="button"
                      onClick={() => onOpen(site.id, item.view)}
                    >
                      <Icon name={navIcons[item.view]} />
                      <span className="nav-label">{item.label}</span>
                      {badgeText && <span className="nav-count">{badgeText}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>
      <div className="sidebar-foot">
        <button
          id="reload"
          className={`sync-button${isSyncing ? " is-busy" : ""}`}
          type="button"
          disabled={isSyncing}
          onClick={onSync}
        >
          Sync
        </button>
        <p className="status">{status}</p>
      </div>
    </aside>
  )
}
