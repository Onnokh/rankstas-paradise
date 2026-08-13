// Data-acquisition seam for the TUI (decision A1 in ADR 0001). The renderer in
// tui.ts reads everything it draws from an in-memory TuiData snapshot; this
// module is the only place that knows WHERE that snapshot comes from. In this
// remote-only client it ALWAYS reads through `@rp/api-client`: the server serves
// the raw internal shapes over `/api/dashboard`, so nothing is reconstructed
// client-side and the remote TUI renders byte-for-byte like the legacy local
// one — the whole reason the endpoint exists.
//
// The snapshot is loaded up front (per site, on reload/switch) rather than
// per-view because the render loop is synchronous and reads across views on
// every keypress; a bundle keeps the remote round-trips out of the hot path.
// Every function here bridges an api-client Effect to a Promise at the boundary
// (see ./runtime.ts) so the imperative renderer never touches Effect directly.
import { Duration, Effect } from "effect"

import { ApiClient } from "@rp/api-client/client"

import { runApi } from "./runtime.ts"
import type {
  DashboardSnapshot,
  Metrics,
  QueriesReport,
  RegistryPerformance,
  Site,
} from "./types.ts"

// The exact shape the renderer consumes: the dashboard snapshot, except the
// registry detail wants a target's day series as a lookup, so `performances`
// (a serializable array over the wire) becomes a `performance` function here.
// tui.ts is unchanged — it still calls `performance(targetUrl, inventoryOnly)`;
// the series is already keyed by target, so the flag is accepted but unused.
export type TuiData = Omit<DashboardSnapshot, "performances"> & {
  readonly performance: (targetUrl: string, inventoryOnly: boolean) => RegistryPerformance
  readonly queries: QueriesReport
}

const zero: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }
const emptyPerformance: RegistryPerformance = { days: [], total: zero, last7: zero, previous7: zero }

// Turn the wire snapshot into the render shape: the only transform is
// `performances` (array) → `performance` (map lookup).
export const toTuiData = (
  snapshot: DashboardSnapshot,
  queries: QueriesReport,
): TuiData => {
  const { performances, ...rest } = snapshot
  const byUrl = new Map(performances.map((entry) => [entry.targetUrl, entry.performance]))
  return { ...rest, queries, performance: (targetUrl) => byUrl.get(targetUrl) ?? emptyPerformance }
}

// The whole dashboard model for one site, fetched over the bearer'd API.
export const loadTuiData = (site: Site): Promise<TuiData> =>
  runApi(
    Effect.gen(function* () {
      const snapshot = yield* ApiClient.use.dashboard(site.id)
      const queries = yield* ApiClient.use.queries({ windowDays: 7 }, site.id)
      return toTuiData(snapshot, queries)
    }),
  )

// The site catalog behind the same seam — the server's configured sites, so the
// site switcher is populated without any local config.
export const loadSiteCatalog = (): Promise<readonly Site[]> =>
  runApi(ApiClient.use.sites()).then((result) => result.sites)

// Watch a queued server job through to completion so the TUI can repaint with
// the synced data instead of the stale snapshot it painted at startup. Polls
// the process-wide job list (~1s) until the job leaves "running"; caps the wait
// so a wedged job can't hang the refresh forever.
const waitForJob = (id: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt++) {
      const { jobs } = yield* ApiClient.use.jobs()
      const job = jobs.find((candidate) => candidate.id === id)
      if (job && job.status !== "running") return job
      yield* Effect.sleep(Duration.seconds(1))
    }
    return undefined
  })

// Force a server sync (ungated — a human opening the TUI or pressing reload
// always means "get fresh now"), then wait for it so the caller repaints synced
// data rather than the cached snapshot. A warm sync the TUI's own dashboard read
// may have already started makes the POST 409; coalesce onto that running job
// instead of failing.
const runServerSync = (site: Site) =>
  Effect.gen(function* () {
    const job = yield* ApiClient.use.syncJob(site.id).pipe(
      Effect.map((result) => result.job),
      Effect.catchTag("ApiHttpError", (error) =>
        error.status === 409
          ? ApiClient.use
              .jobs()
              .pipe(Effect.map(({ jobs }) => jobs.find((candidate) => candidate.status === "running")))
          : Effect.fail(error),
      ),
    )
    if (!job) return `Refreshing ${site.name} on the server…`
    const finished = yield* waitForJob(job.id)
    if (!finished) return `Sync for ${site.name} is still running on the server.`
    return finished.status === "done"
      ? `Synced ${site.name} from the server.`
      : `Server sync failed for ${site.name}: ${finished.message ?? "unknown error"}`
  })

// Background refresh the renderer calls per site: force the server's sync job
// and poll it to completion, returning the status line to show.
export const backgroundRefresh = (site: Site): Promise<string> => runApi(runServerSync(site))
