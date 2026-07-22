// HTTP API client for the Ranksta's Paradise server — PLACEHOLDER.
//
// The real client (built on Effect's HttpApiClient against the server's
// HttpApi, see PLO-27x) lands in a later ticket. This stub exists so the
// package resolves, references @rp/domain, and type-checks in the build graph.
// It intentionally implements nothing.
import { Effect } from "effect"

import type { DashboardSnapshot } from "@rp/domain/reports/schema"
import type { SiteId } from "@rp/domain/sites/schema"

export interface ApiClientConfig {
  readonly baseUrl: string
  readonly token: string
}

export interface Interface {
  // Fetch a site's full dashboard snapshot (GET /api/dashboard?site=<id>).
  readonly dashboard: (site: SiteId) => Effect.Effect<DashboardSnapshot>
}

export const make = (_config: ApiClientConfig): Interface => ({
  dashboard: () => Effect.die("unimplemented: ApiClient.dashboard"),
})

export * as ApiClient from "./client"
