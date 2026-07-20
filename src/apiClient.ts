// Thin bearer'd HTTP client for the Ranksta's Paradise API — the seam the TUI
// (HTTP-client mode) and the CLI (remote mode) call instead of touching
// SQLite/CSV directly. Plain async, no Effect, so both the Effect TUI and the
// non-Effect CLI can consume it.
import { loadClientConfig, type ClientConfig } from "./clientConfig.ts"
import { type RegistryPatch } from "./registry.ts"
import type { LogAddInput, QueriesOptions, RegistryAddInput } from "./service.ts"

// Derive the report shapes straight from the service functions so the client
// can never drift from them. `typeof import(...)` is a type-only query and is
// erased at build time — importing service.ts adds no runtime dependency. The
// HTTP layer wraps each payload in { generatedAt, mode, ...payload }; we type
// against the payload since those envelope fields are additive.
type Service = typeof import("./service.ts")
type Report<K extends keyof Service> = Service[K] extends (...args: never[]) => infer R ? Awaited<R> : never

// POST /api/jobs/sync returns the queued job; the Job shape lives in server.ts
// and isn't exported, so mirror the fields the client cares about here.
export type SyncJob = {
  readonly id: number
  readonly name: string
  readonly siteId: string
  readonly status: "running" | "done" | "failed"
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly message: string | null
}

type QueryParams = Record<string, string | number | boolean | undefined>

export const createApiClient = (config?: ClientConfig) => {
  const resolved = config ? Promise.resolve(config) : loadClientConfig()

  const request = async <T>(method: string, path: string, query: QueryParams = {}, body?: unknown): Promise<T> => {
    const { apiUrl, token } = await resolved
    const url = new URL(path, apiUrl)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`)
    return await response.json() as T
  }

  return {
    // Reads — every method takes an optional site passed as ?site=.
    status: (site?: string) =>
      request<Report<"statusReport">>("GET", "/api/status", { site }),
    // The whole dashboard model in one read — what the remote TUI consumes.
    dashboard: (site?: string) =>
      request<Report<"dashboardSnapshot">>("GET", "/api/dashboard", { site }),
    pages: (window?: number, site?: string) =>
      request<Report<"pagesReport">>("GET", "/api/pages", { window, site }),
    page: (path: string, site?: string) =>
      request<Report<"pageReport">>("GET", "/api/page", { path, site }),
    queries: (opts: QueriesOptions = {}, site?: string) =>
      request<Report<"queriesReport">>("GET", "/api/queries", {
        page: opts.page,
        window: opts.windowDays,
        "min-impressions": opts.minImpressions,
        "include-brand": opts.includeBrand,
        limit: opts.limit,
        site,
      }),
    opportunities: (kind?: string, site?: string) =>
      request<Report<"opportunitiesReport">>("GET", "/api/opportunities", { kind, site }),
    registry: (site?: string) =>
      request<Report<"registryList">>("GET", "/api/registry", { site }),
    log: (path?: string, site?: string) =>
      request<Report<"logList">>("GET", "/api/log", { path, site }),
    history: (limit?: number, site?: string) =>
      request<Report<"historyReport">>("GET", "/api/history", { limit, site }),

    // Writes — the server derives the target site from ?site= here too.
    registryAdd: (body: RegistryAddInput, site?: string) =>
      request<Report<"registryAdd">>("POST", "/api/registry", { site }, body),
    registrySet: (target: string, keyword: string | undefined, patch: RegistryPatch, site?: string) =>
      request<Report<"registrySet">>("PATCH", "/api/registry", { site }, { target, keyword, patch }),
    logAdd: (body: LogAddInput, site?: string) =>
      request<Report<"logAdd">>("POST", "/api/log", { site }, body),

    // Jobs.
    syncJob: (site?: string) =>
      request<{ readonly job: SyncJob }>("POST", "/api/jobs/sync", { site }),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
