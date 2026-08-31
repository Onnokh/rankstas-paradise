// The desktop app's data seam: the same remote-only contract the TUI uses
// (ADR 0001, A1). Every read goes to the hosted server's `/api/*` surface with a
// bearer token, and `/api/dashboard` returns the whole dashboard model in one
// document — so nothing is reconstructed client-side and the desktop app renders
// the same numbers as `bun run seo`.
//
// This is a plain `fetch` client rather than `@rp/api-client`, because that
// package resolves its config through `Bun.file` and decodes through Effect
// Schema; the Electron main process runs on Node. The wire shapes are still the
// frozen report DTOs, so the renderer types itself against
// `@rp/api-client/schema` and a drift would surface there.
import type {
  DashboardSnapshot,
  HistoryReport,
  StatusReport,
  JobResponse,
  JobsResponse,
  SitesResponse,
  SyncJob,
} from "@rp/api-client/schema"

import { resolveTarget } from "./config.ts"

export class ApiError extends Error {
  readonly kind = "ApiError"
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

type QueryParams = Record<string, string | number | boolean | undefined>

const request = async <A>(
  method: "GET" | "POST",
  path: string,
  options: { readonly query?: QueryParams; readonly body?: unknown } = {},
): Promise<A> => {
  const { apiUrl, token } = await resolveTarget()
  const url = new URL(path, apiUrl)
  for (const [key, value] of Object.entries(options.query ?? {}))
    if (value !== undefined) url.searchParams.set(key, String(value))

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (cause) {
    throw new ApiError(`The request ${method} ${path} could not be sent to ${apiUrl}.`, undefined, {
      cause,
    })
  }

  if (!response.ok) {
    throw new ApiError(`${method} ${path} failed (HTTP ${response.status}).`, response.status)
  }
  return (await response.json()) as A
}

export const sites = (): Promise<SitesResponse> => request("GET", "/api/sites")

export const dashboard = (site: string): Promise<DashboardSnapshot> =>
  request("GET", "/api/dashboard", { query: { site } })

// A longer daily series than the dashboard snapshot's 28 days, so the overview
// can compare a period against the one before it. The dashboard read cannot
// serve this: it is fixed to the current window.
export const history = (site: string, limit: number): Promise<HistoryReport> =>
  request("GET", "/api/history", { query: { site, limit } })

// Freshness, for the title bar. `lastSyncedAt` is when the site's data last
// CHANGED; `lastCheckedAt` is when Ranksta last ASKED Google — a newer
// lastCheckedAt means the sync ran and Google had nothing new.
//
// Both are part of `StatusReport` now, so the shape is taken straight from the
// frozen DTO. They are nullable rather than absent: a site that has never synced
// has no instant to report, and the title bar omits the fragment.
export const status = (site: string): Promise<StatusReport> =>
  request("GET", "/api/status", { query: { site } })

const jobs = (): Promise<JobsResponse> => request("GET", "/api/jobs")

// Poll the process-wide job list until the job leaves "running", capped so a
// wedged job cannot hang the refresh forever. Mirrors the TUI's `waitForJob`.
const waitForJob = async (id: number): Promise<SyncJob | undefined> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { jobs: running } = await jobs()
    const job = running.find((candidate) => candidate.id === id)
    if (job && job.status !== "running") return job
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return undefined
}

// Force a server sync and wait for it, so the caller repaints synced data rather
// than the cached snapshot. A sync the dashboard read may already have started
// makes the POST 409; coalesce onto that running job instead of failing — the
// same reconciliation the TUI does.
export const syncSite = async (siteId: string, siteName: string): Promise<string> => {
  let job: SyncJob | undefined
  try {
    job = (await request<JobResponse>("POST", "/api/jobs/sync", { query: { site: siteId } })).job
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.status !== 409) throw cause
    job = (await jobs()).jobs.find((candidate) => candidate.status === "running")
  }
  if (!job) return `Refreshing ${siteName} on the server…`
  const finished = await waitForJob(job.id)
  if (!finished) return `Sync for ${siteName} is still running on the server.`
  return finished.status === "done"
    ? `Synced ${siteName} from the server.`
    : `Server sync failed for ${siteName}: ${finished.message ?? "unknown error"}`
}
