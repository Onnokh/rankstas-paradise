// Data-acquisition seam for the TUI (decision A1 in ADR 0001). The renderer in
// tui.ts reads everything it draws from an in-memory TuiData snapshot; this
// module is the only place that knows WHERE that snapshot comes from. Both
// implementations behind loadTuiData now share ONE builder, service.ts's
// dashboardSnapshot: the local path calls it directly against SQLite/CSV, the
// remote path fetches the identical structure from /api/dashboard over the
// bearer'd apiClient. Because the server serves the raw internal shapes,
// nothing is reconstructed client-side and a remote TUI renders byte-for-byte
// like a local one — the whole reason the endpoint exists.
//
// The snapshot is loaded up front (per site, on reload/switch) rather than
// per-view because the render loop is synchronous and reads across views on
// every keypress; a bundle keeps the remote round-trips out of the hot path.
import { createApiClient } from "./apiClient.ts"
import { dashboardSnapshot, type DashboardSnapshot } from "./service.ts"
import { loadSites, withSite, type Site } from "./site.ts"
import { type Metrics, type RegistryPerformance } from "./storage.ts"

// The exact shape the renderer consumes: the dashboard snapshot, except the
// registry detail wants a target's day series as a lookup, so `performances`
// (a serializable array over the wire) becomes a `performance` function here.
// tui.ts is unchanged — it still calls `performance(targetUrl, inventoryOnly)`;
// the series is already keyed by target, so the flag is accepted but unused.
export type TuiData = Omit<DashboardSnapshot, "performances"> & {
  readonly performance: (targetUrl: string, inventoryOnly: boolean) => RegistryPerformance
}

const zero: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }
const emptyPerformance: RegistryPerformance = { days: [], total: zero, last7: zero, previous7: zero }

// Turn the wire/DTO snapshot into the render shape: the only transform is
// `performances` (array) → `performance` (map lookup). Identical for both paths.
const toTuiData = (snapshot: DashboardSnapshot): TuiData => {
  const { performances, ...rest } = snapshot
  const byUrl = new Map(performances.map((entry) => [entry.targetUrl, entry.performance]))
  return { ...rest, performance: (targetUrl) => byUrl.get(targetUrl) ?? emptyPerformance }
}

// LOCAL — build the snapshot inside the site's context so every SQLite/CSV read
// hits the right site's data.
const localTuiData = (site: Site): Promise<TuiData> =>
  withSite(site, async () => toTuiData(await dashboardSnapshot()))

// REMOTE — the identical snapshot, fetched over HTTP.
const remoteTuiData = async (site: Site): Promise<TuiData> =>
  toTuiData(await createApiClient().dashboard(site.id))

export const loadTuiData = (site: Site, remote: boolean): Promise<TuiData> =>
  remote ? remoteTuiData(site) : localTuiData(site)

// The site catalog behind the same seam: the server's configured sites when
// remote, the local config otherwise. Lets a config-less client still populate
// its site switcher.
export const loadSiteCatalog = (remote: boolean): Promise<readonly Site[]> =>
  remote ? createApiClient().sites().then((result) => result.sites) : loadSites()
