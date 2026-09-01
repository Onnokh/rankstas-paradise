// The window shell. It holds the only UI state — which site, which view, which
// row — and reads every byte of data through TanStack Query, so nothing here
// caches, refetches or tracks loading by hand.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { Icon } from "./components/Icon.tsx"
import { RangePicker } from "./components/RangePicker.tsx"
import { Sidebar } from "./components/Sidebar.tsx"
import { EmptyState } from "./components/ui.tsx"
import { TREND_WINDOW, count, fetchedLabel, periods, rangeName, readableDate } from "./format.ts"
import { dashboardQuery, historyQuery, keys, sitesQuery, statusQuery } from "./queries.ts"
import { type View, toDashboard, views } from "./types.ts"
import { DetailPane } from "./views/DetailPane.tsx"
import { SitesOverview } from "./views/SitesOverview.tsx"
import { ListPane } from "./views/ListPane.tsx"
import { Overview } from "./views/Overview.tsx"
import { heading, initialSelection, isSplit, rowCount } from "./views/shared.ts"

const Fatal = ({ message }: { message: string }) => {
  const [path, setPath] = useState("")
  useEffect(() => {
    void window.rp.configPath().then(setPath)
  }, [])
  return (
    <main className="fatal">
      <div className="fatal-card">
        <Icon name="alert" size={24} />
        <h1>Cannot reach the Ranksta’s Paradise server</h1>
        <p>{message}</p>
        <p className="muted">
          This app reads the same client config as `bun run seo`: RP_API_URL and RP_TOKEN, or the
          file below.
        </p>
        <code>{path}</code>
      </div>
    </main>
  )
}

export const App = () => {
  const queryClient = useQueryClient()
  const sites = useQuery(sitesQuery())
  const [siteId, setSiteId] = useState<string>()
  const [view, setView] = useState<View>("home")
  const [selected, setSelected] = useState(0)
  const [status, setStatus] = useState("")
  const [rangeDays, setRangeDays] = useState(TREND_WINDOW)
  // Which of the two shapes the window is in: the cross-site overview, which
  // belongs to no site, or one site's five views. The app opens on the
  // overview, because "which site needs me" is the question asked first.
  const [scope, setScope] = useState<"overview" | "site">("overview")

  const activeSiteId = siteId ?? sites.data?.[0]?.id
  const site = sites.data?.find((candidate) => candidate.id === activeSiteId)

  const snapshot = useQuery(dashboardQuery(activeSiteId))
  const history = useQuery(historyQuery(activeSiteId, rangeDays))
  const freshness = useQuery(statusQuery(activeSiteId))

  // The cache holds the raw snapshot so structural sharing can diff it; the
  // render shape (with its `performance` lookup) is derived here instead.
  //
  // The snapshot's own `history` is a fixed 28 days. When the longer series has
  // loaded, the selected span replaces it, so the History list, its detail pane
  // and its row count all follow the range picker from one substitution.
  const data = useMemo(() => {
    if (!snapshot.data) return undefined
    const dashboard = toDashboard(snapshot.data)
    if (!history.data || history.data.length === 0) return dashboard
    return { ...dashboard, history: periods(history.data, rangeDays).current }
  }, [snapshot.data, history.data, rangeDays])

  // A sync's outcome is a receipt, not state. It clears itself, because the
  // sidebar was otherwise left carrying "Refreshing Shadertown…" from a sweep
  // that ended at launch — a line that looks live and is not. A failure sticks:
  // it is the only place the reason is shown, and it stays until the next try.
  const clearStatus = useRef<ReturnType<typeof setTimeout>>(undefined)
  const report = useCallback((message: string, sticky = false) => {
    setStatus(message)
    clearTimeout(clearStatus.current)
    if (!sticky) clearStatus.current = setTimeout(() => setStatus(""), 5000)
  }, [])
  useEffect(() => () => clearTimeout(clearStatus.current), [])

  // A sync is a server-side job. When it finishes, the two queries it can change
  // are invalidated by key rather than refetched by hand.
  const sync = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      window.rp.sync(id, name).then((result) => {
        if (!result.ok) throw new Error(result.message)
        return result.value
      }),
    onSuccess: async (message, { id }) => {
      report(message)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.dashboard(id) }),
        queryClient.invalidateQueries({ queryKey: keys.historiesFor(id) }),
        queryClient.invalidateQueries({ queryKey: keys.status(id) }),
      ])
    },
    onError: (cause) => report(`Refresh failed; showing cached data. ${String(cause)}`, true),
  })

  // Selecting a row is per site and per view, so it resets when either changes.
  // A jump from the overview names the row it wants, and that row has to survive
  // this reset — the site and the view both change on the same render, so the
  // effect below would otherwise fire straight after and discard it.
  const pendingSelection = useRef<number | undefined>(undefined)
  useEffect(() => {
    const requested = pendingSelection.current
    pendingSelection.current = undefined
    if (data) setSelected(requested ?? initialSelection(data, view))
    // The range changes how many history rows exist, so the selection resets
    // with it rather than pointing at a day the new span does not contain.
  }, [activeSiteId, view, rangeDays])

  const clampedSelected = data ? Math.max(0, Math.min(selected, rowCount(data, view) - 1)) : 0

  // The one way into a site. `index` lets the overview land on a specific row —
  // the signal it was ranking — instead of the top of the list.
  const openSiteView = useCallback((nextSiteId: string, nextView: View, index?: number) => {
    setScope("site")
    setSiteId(nextSiteId)
    setView(nextView)
    if (index !== undefined) pendingSelection.current = index
  }, [])

  const openOverview = useCallback(() => setScope("overview"), [])

  const move = useCallback(
    (delta: number) => {
      if (!data) return
      const total = rowCount(data, view)
      if (total === 0) return
      // History lists newest-first, so its indices run against the reading
      // direction: arrow-down should move to an older day, not a newer one.
      const step = view === "history" ? -delta : delta
      setSelected((current) => Math.max(0, Math.min(current + step, total - 1)))
    },
    [data, view],
  )

  const moveView = useCallback(
    (delta: number) => {
      const index = views.findIndex((item) => item.view === view)
      setView(views[(index + delta + views.length) % views.length]!.view)
    },
    [view],
  )

  // The button says what it does. On the overview no single site is in view, so
  // syncing one arbitrary site would be a lie; it walks all of them instead.
  // Sequentially, because the server holds one sync lock across sites and
  // parallel requests would just 409 against each other.
  const runSync = useCallback(() => {
    if (scope === "overview") {
      void (async () => {
        for (const target of sites.data ?? []) {
          try {
            await sync.mutateAsync({ id: target.id, name: target.name })
          } catch {
            // A site that cannot sync leaves its cached snapshot in place; the
            // mutation's onError has already put the reason in the status line.
          }
        }
      })()
      return
    }
    if (site) sync.mutate({ id: site.id, name: site.name })
  }, [scope, site, sites.data, sync])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key
      // The overview has no rows and no per-site views, so the keys that address
      // them enter the active site first rather than doing nothing.
      const rowKey = key === "ArrowDown" || key === "j" || key === "ArrowUp" || key === "k"
      const viewKey =
        key === "ArrowLeft" ||
        key === "h" ||
        key === "ArrowRight" ||
        key === "l" ||
        (key >= "0" && key <= "4")
      if (scope === "overview" && (rowKey || viewKey)) setScope("site")
      if (scope === "overview" && rowKey) {
        event.preventDefault()
        return
      }

      if (key === "ArrowDown" || key === "j") move(1)
      else if (key === "ArrowUp" || key === "k") move(-1)
      else if (key === "ArrowLeft" || key === "h") moveView(-1)
      else if (key === "ArrowRight" || key === "l") moveView(1)
      else if (key >= "0" && key <= "4") setView(views[Number(key)]!.view)
      else if (key === "r") runSync()
      else if (key === "s") {
        setScope("site")
        const list = sites.data ?? []
        const index = list.findIndex((candidate) => candidate.id === activeSiteId)
        const next = list[(index + 1) % Math.max(1, list.length)]
        if (next) setSiteId(next.id)
      } else if (key === "a") setScope("overview")
      else return
      event.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [move, moveView, runSync, sites.data, activeSiteId, scope])

  // The startup sweep: sync every site once, in view order, so all of them stay
  // current. Each sync invalidates its own keys, so the sidebar counts and the
  // open pane refresh themselves as it goes.
  const swept = useRef(false)
  useEffect(() => {
    const list = sites.data
    if (!list || list.length === 0 || swept.current) return
    swept.current = true
    void (async () => {
      const ordered = [...list].sort((a) => (a.id === activeSiteId ? -1 : 0))
      for (const target of ordered) {
        try {
          await sync.mutateAsync({ id: target.id, name: target.name })
        } catch {
          // A site that cannot sync leaves its cached snapshot in place; the
          // mutation's onError has already put the reason in the status line.
        }
      }
    })()
  }, [sites.data, activeSiteId, sync])

  if (sites.isError) return <Fatal message={String(sites.error)} />
  if (snapshot.isError) return <Fatal message={String(snapshot.error)} />
  if (!sites.data) return <main className="fatal" />
  if (sites.data.length === 0) return <Fatal message="No sites configured on the server." />

  const isOverview = scope === "overview"
  const title = isOverview
    ? {
        title: "Overview",
        subtitle: `${sites.data.length} sites, each against its own previous ${rangeName(rangeDays)}`,
      }
    : data
      ? heading(data, view, rangeDays, site)
      : { title: "Loading…", subtitle: "" }
  const checkedAt = freshness.data?.data.lastCheckedAt
  const syncedAt = freshness.data?.data.lastSyncedAt

  return (
    <div className="app">
      <Sidebar
        sites={sites.data}
        activeSiteId={activeSiteId}
        view={view}
        isOverview={isOverview}
        onOpen={openSiteView}
        onOpenOverview={openOverview}
        onSync={runSync}
        isSyncing={sync.isPending}
        status={status}
      />
      <div className="content">
        <header className="topbar">
          <div className="topbar-headings">
            <h1>{title.title}</h1>
            <p>{title.subtitle}</p>
          </div>
          {(isOverview || view === "home" || view === "history") && (
            <RangePicker value={rangeDays} onChange={setRangeDays} />
          )}
          <div className="topbar-meta">
            {/* The overview spans every site, so it carries no single origin
                and no single finalized date. */}
            <span className="site-origin">{isOverview ? "" : (site?.origin ?? "")}</span>
            {!isOverview && data && (
              // Two different kinds of freshness, and the difference matters.
              // `latestDate` is the newest day Google has FINALIZED — History
              // may list provisional days after it. `lastCheckedAt` is when
              // Ranksta last ASKED Google; a check newer than the last change
              // means the sync ran and Google had nothing new.
              <span
                className="coverage"
                title={[
                  `Finalized through ${data.digest.latestDate ?? "an unknown date"}`,
                  checkedAt && `Last checked Google at ${checkedAt}`,
                  syncedAt && `Data last changed at ${syncedAt}`,
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                {`Finalized through ${data.digest.latestDate ? readableDate(data.digest.latestDate) : "—"}`}
                {checkedAt && ` · fetched ${fetchedLabel(checkedAt)}`}
                {` · ${count(data.summary.rows)} rows`}
              </span>
            )}
          </div>
        </header>
        <div className={`body ${!isOverview && isSplit(view) ? "body-split" : "body-overview"}`}>
          {isOverview ? (
            <SitesOverview sites={sites.data} rangeDays={rangeDays} onOpen={openSiteView} />
          ) : !data || !site ? (
            <EmptyState message="Loading this site’s dashboard…" icon="clock" />
          ) : isSplit(view) ? (
            <>
              <ListPane
                data={data}
                site={site}
                view={view}
                selected={clampedSelected}
                onSelect={setSelected}
              />
              <DetailPane
                data={data}
                site={site}
                view={view}
                selected={clampedSelected}
                onSelect={setSelected}
              />
            </>
          ) : (
            <Overview
              data={data}
              site={site}
              trendDays={history.data}
              rangeDays={rangeDays}
              selected={clampedSelected}
              onSelect={setSelected}
              onGoTo={(nextView, index) => {
                setView(nextView)
                setSelected(index)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
