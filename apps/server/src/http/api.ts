// The Ranksta's Paradise HTTP API, described as an Effect `HttpApi`. This is the
// single source of truth for the server's routes and their request/response
// schemas — the same routes the legacy `src/server.ts` served, now typed.
//
// Success schemas reuse the frozen domain report DTOs (`@rp/domain/reports/
// schema`) so there is one shape shared by the server, the wire, and the future
// derived client. The actual responses are wrapped in the `{ generatedAt, mode,
// ...payload }` envelope by the handlers (see handlers.ts / response.ts); the
// declared success schema describes the payload portion.
//
// EXPORTED for PLO-276 / the api-client seam: `Api` is what
// `HttpApiClient.make(Api, ...)` will consume to derive a typed client.
import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi"

import {
  DashboardSnapshot,
  HistoryReport,
  LogAddInput,
  LogAddResult,
  LogListResult,
  OpportunitiesReport,
  PageReport,
  PagesReport,
  QueriesReport,
  RegistryAddInput,
  RegistryAddResult,
  RegistryListReport,
  RegistrySetResult,
  StatusReport,
} from "@rp/domain/reports/schema"
import { RegistryPatch } from "@rp/domain/registry/schema"
import { Site } from "@rp/domain/sites/schema"
import { Job } from "../jobs/schema.ts"

// Query fields are loose optional strings at the boundary; the handlers parse
// and validate them (numbers, required ?site=, etc.) to reproduce the exact
// legacy 400 semantics rather than delegating to schema-level rejection.
const S = Schema.optional(Schema.String)

// Success envelopes as declared to clients: the payload plus generatedAt/mode.
const enveloped = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({
    generatedAt: Schema.String,
    mode: Schema.Literals(["debug", "live"]),
    ...fields,
  })

const SitesResponse = enveloped({ sites: Schema.Array(Site) })
const JobsResponse = enveloped({ jobs: Schema.Array(Job) })
const JobResponse = enveloped({ job: Job })

// --- endpoint group -----------------------------------------------------------

export const apiGroup = HttpApiGroup.make("api")
  .add(
    HttpApiEndpoint.get("sites", "/api/sites", {
      success: SitesResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("status", "/api/status", {
      query: { site: S },
      success: enveloped(StatusReport.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("dashboard", "/api/dashboard", {
      query: { site: S },
      success: enveloped(DashboardSnapshot.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("pages", "/api/pages", {
      query: { site: S, window: S },
      success: enveloped(PagesReport.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("page", "/api/page", {
      query: { site: S, path: S },
      success: enveloped(PageReport.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("queries", "/api/queries", {
      query: {
        site: S,
        page: S,
        window: S,
        "min-impressions": S,
        "include-brand": S,
        limit: S,
      },
      success: enveloped(QueriesReport.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("opportunities", "/api/opportunities", {
      query: { site: S, kind: S },
      success: enveloped(OpportunitiesReport.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("registry", "/api/registry", {
      query: { site: S },
      success: enveloped(RegistryListReport.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("log", "/api/log", {
      query: { site: S, path: S },
      success: enveloped(LogListResult.fields),
    }),
  )
  .add(
    HttpApiEndpoint.get("history", "/api/history", {
      query: { site: S, limit: S },
      success: enveloped(HistoryReport.fields),
    }),
  )
  .add(
    // `site` is optional here, unlike the other site-scoped reads: the desktop
    // app polls /api/jobs bare, so an omitted site keeps falling back to the
    // first configured site.
    HttpApiEndpoint.get("jobs", "/api/jobs", {
      query: { site: S },
      success: JobsResponse,
    }),
  )
  // --- writes ---
  .add(
    HttpApiEndpoint.post("registryAdd", "/api/registry", {
      query: { site: S },
      payload: RegistryAddInput,
      success: enveloped(RegistryAddResult.fields),
    }),
  )
  .add(
    HttpApiEndpoint.patch("registrySet", "/api/registry", {
      query: { site: S },
      payload: Schema.Struct({
        target: Schema.String,
        keyword: Schema.optional(Schema.String),
        patch: Schema.optional(RegistryPatch),
      }),
      success: enveloped(RegistrySetResult.fields),
    }),
  )
  .add(
    HttpApiEndpoint.post("logAdd", "/api/log", {
      query: { site: S },
      payload: LogAddInput,
      success: enveloped(LogAddResult.fields),
    }),
  )
  .add(
    HttpApiEndpoint.post("syncJob", "/api/jobs/sync", {
      query: { site: S },
      success: JobResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("backfillJob", "/api/jobs/backfill", {
      query: { site: S },
      payload: Schema.Struct({ months: Schema.optional(Schema.Number) }),
      success: JobResponse,
    }),
  )
  // --- plain-text feeds (Native SDK / TUI) ---
  .add(HttpApiEndpoint.get("sitesTxt", "/sites.txt"))
  .add(HttpApiEndpoint.get("pagesTxt", "/pages.txt", { query: { site: S, window: S } }))
  .add(HttpApiEndpoint.get("tuiHome", "/tui/home.txt", { query: { site: S } }))
  .add(HttpApiEndpoint.get("tuiOpportunities", "/tui/opportunities.txt", { query: { site: S } }))
  .add(HttpApiEndpoint.get("tuiHistory", "/tui/history.txt", { query: { site: S } }))
  .add(HttpApiEndpoint.get("tuiRegistry", "/tui/registry.txt", { query: { site: S } }))
  .add(HttpApiEndpoint.get("tuiLog", "/tui/log.txt", { query: { site: S } }))
  .add(HttpApiEndpoint.get("tuiQueries", "/tui/queries.txt", { query: { site: S } }))

export const Api = HttpApi.make("rankstas-paradise").add(apiGroup)

export type Api = typeof Api
