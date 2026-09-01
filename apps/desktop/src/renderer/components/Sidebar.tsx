// The source list: the brand, the cross-site overview, then every site with its
// views nested under it.
//
// A site's own name IS its Home — clicking it opens that site's overview — so
// Home is not repeated as a child. Every site stays open: there are a handful of
// them, and collapsing hides exactly the counts the list exists to show.
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

// Home is the site row itself, so it is not listed again beneath it.
const childViews = views.filter((item) => item.view !== "home")

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
  // site row is highlighted while it is.
  readonly isOverview: boolean
  readonly onOpen: (siteId: string, view: View) => void
  readonly onOpenOverview: () => void
  readonly onSync: () => void
  readonly isSyncing: boolean
  readonly status: string
}

// The site's own favicon. It arrives as a `data:` URL over the bridge (see
// main/favicon.ts), so a site with no readable icon — or whose lookup has not
// landed yet — keeps a plain dot rather than leaving a gap that would shift the
// row.
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
      {/* The traffic lights sit over this strip; it is the window's drag handle. */}
      <div className="sidebar-drag" />
      <header className="brand">
        <img className="brand-mark" src="logo.png" alt="" aria-hidden="true" />
        <span className="brand-name">Ranksta’s Paradise</span>
      </header>
      <nav className="nav" aria-label="Sites and views">
        <button
          className={`nav-item${isOverview ? " is-active" : ""}`}
          type="button"
          onClick={onOpenOverview}
        >
          <Icon name="layers" />
          <span className="nav-label">All sites</span>
          <span className="nav-count">{count(sites.length)}</span>
        </button>

        {sites.map((site, index) => {
          const isActiveSite = !isOverview && site.id === activeSiteId
          // A site whose query has not resolved yet has no counts to show; its
          // views still open, they just carry no number until the read lands.
          const snapshot = snapshots[index]?.data
          return (
            <div key={site.id} className="site-group">
              <button
                className={`nav-item site-head${isActiveSite && view === "home" ? " is-active" : ""}${
                  isActiveSite ? " is-current" : ""
                }`}
                type="button"
                title={site.origin}
                onClick={() => onOpen(site.id, "home")}
              >
                <SiteMark origin={site.origin} />
                <span className="nav-label">{site.name}</span>
              </button>
              <div className="site-views">
                {childViews.map((item) => {
                  const badgeText = navCount(snapshot, item.view)
                  return (
                    <button
                      key={item.view}
                      className={`nav-sub${isActiveSite && item.view === view ? " is-active" : ""}`}
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
          <Icon name="refresh" />
          <span>
            {isSyncing ? "Syncing…" : isOverview ? "Sync all sites" : "Sync this site"}
          </span>
        </button>
        {status && <p className="status">{status}</p>}
      </div>
    </aside>
  )
}
