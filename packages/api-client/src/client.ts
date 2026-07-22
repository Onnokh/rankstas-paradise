// Typed HTTP client for the Ranksta's Paradise server — the seam the remote TUI
// (HTTP-client mode) and the CLI (remote mode) call instead of touching
// SQLite/CSV directly. Ported from the legacy `src/apiClient.ts`, now built on
// Effect's `HttpClient`: every response is decoded through the frozen report
// `Schema`, and the three failure modes (transport, non-2xx status, decode) map
// to distinct tagged errors (see ./schema.ts).
//
// SEAM — switching to a derived client (PLO-275): once the server's `HttpApi`
// exists, this hand-written client can be replaced by one derived from it via
// `HttpApiClient.make(Api, ...)` from `effect/unstable/httpapi`, which generates
// typed, schema-decoding methods straight from the endpoint definitions. Keep
// the `Interface` below as the stable public shape so consumers don't change:
// re-implement `layer` on top of the derived client and delete the `send`
// helper. The wire schemas in ./schema.ts become the endpoint success schemas.
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { FetchHttpClient } from "effect/unstable/http"

import { serviceUse } from "@rp/domain/service-use"
import type {
  LogAddInput,
  QueriesOptions,
  RegistryAddInput,
} from "@rp/domain/reports/schema"
import type { RegistryPatch } from "@rp/domain/registry/schema"
import type { SiteId } from "@rp/domain/sites/schema"

import { ClientConfig } from "./client-config.ts"
import {
  ApiClientError,
  ApiDecodeError,
  type ApiError,
  ApiHttpError,
  DashboardSnapshot,
  HistoryReport,
  JobResponse,
  JobsResponse,
  LogAddResult,
  LogListResult,
  OpportunitiesReport,
  PageReport,
  PagesReport,
  QueriesReport,
  RegistryAddResult,
  RegistryListReport,
  RegistrySetResult,
  SitesResponse,
  StatusReport,
} from "./schema.ts"

export interface Interface {
  // The configured site catalog (server-side config) — the remote site switcher
  // reads this instead of a local config.
  readonly sites: () => Effect.Effect<SitesResponse, ApiError>

  // Reads — every method takes an optional site passed as ?site=<id>.
  readonly status: (site?: SiteId) => Effect.Effect<StatusReport, ApiError>
  // The whole dashboard model in one read — what the remote TUI consumes.
  readonly dashboard: (
    site?: SiteId,
  ) => Effect.Effect<DashboardSnapshot, ApiError>
  readonly pages: (
    window?: number,
    site?: SiteId,
  ) => Effect.Effect<PagesReport, ApiError>
  readonly page: (
    path: string,
    site?: SiteId,
  ) => Effect.Effect<PageReport, ApiError>
  readonly queries: (
    opts?: QueriesOptions,
    site?: SiteId,
  ) => Effect.Effect<QueriesReport, ApiError>
  readonly opportunities: (
    kind?: string,
    site?: SiteId,
  ) => Effect.Effect<OpportunitiesReport, ApiError>
  readonly registry: (
    site?: SiteId,
  ) => Effect.Effect<RegistryListReport, ApiError>
  readonly log: (
    path?: string,
    site?: SiteId,
  ) => Effect.Effect<LogListResult, ApiError>
  readonly history: (
    limit?: number,
    site?: SiteId,
  ) => Effect.Effect<HistoryReport, ApiError>

  // Writes — the server derives the target site from ?site= here too.
  readonly registryAdd: (
    body: RegistryAddInput,
    site?: SiteId,
  ) => Effect.Effect<RegistryAddResult, ApiError>
  readonly registrySet: (
    target: string,
    keyword: string | undefined,
    patch: RegistryPatch,
    site?: SiteId,
  ) => Effect.Effect<RegistrySetResult, ApiError>
  readonly logAdd: (
    body: LogAddInput,
    site?: SiteId,
  ) => Effect.Effect<LogAddResult, ApiError>

  // Jobs. The process-wide job history isn't site-scoped; the POSTs are.
  readonly jobs: () => Effect.Effect<JobsResponse, ApiError>
  readonly syncJob: (site?: SiteId) => Effect.Effect<JobResponse, ApiError>
  readonly backfillJob: (
    months?: number,
    site?: SiteId,
  ) => Effect.Effect<JobResponse, ApiError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/ApiClient",
) {}

export const use = serviceUse(Service)

type QueryParams = Record<string, string | number | boolean | undefined>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const clientConfig = yield* ClientConfig.Service
    // Resolve the remote target once at construction; a missing config fails
    // the layer rather than every call.
    const { apiUrl, token } = yield* clientConfig.load()
    const bearer = Redacted.value(token)

    const buildUrl = (path: string, query: QueryParams) => {
      const url = new URL(path, apiUrl)
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) url.searchParams.set(key, String(value))
      return url.toString()
    }

    // The full round trip: build + bearer + execute, then classify status
    // (non-2xx → ApiHttpError) before decoding the body through Schema
    // (unreadable/mismatched → ApiDecodeError). Transport failures →
    // ApiClientError. `httpClient.execute` does NOT fail on non-2xx, so the
    // status is inspected explicitly.
    const send = <A>(
      method: "GET" | "POST" | "PATCH",
      path: string,
      schema: Schema.Codec<A, unknown>,
      options: { readonly query?: QueryParams; readonly body?: unknown } = {},
    ): Effect.Effect<A, ApiError> =>
      Effect.gen(function* () {
        const url = buildUrl(path, options.query ?? {})
        const base =
          method === "GET"
            ? HttpClientRequest.get(url)
            : method === "POST"
              ? HttpClientRequest.post(url)
              : HttpClientRequest.patch(url)
        const request =
          options.body !== undefined
            ? base.pipe(
                HttpClientRequest.bearerToken(bearer),
                HttpClientRequest.bodyJsonUnsafe(options.body),
              )
            : base.pipe(HttpClientRequest.bearerToken(bearer))

        const response = yield* httpClient.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new ApiClientError({
                message: `The request ${method} ${path} could not be sent.`,
                method,
                path,
                cause,
              }),
          ),
        )

        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.catchCause(() => Effect.succeed("")),
          )
          return yield* Effect.fail(
            new ApiHttpError({
              message: `${method} ${path} failed (HTTP ${response.status}).`,
              method,
              path,
              status: response.status,
              body,
            }),
          )
        }

        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new ApiDecodeError({
                message: `The ${method} ${path} response body could not be read.`,
                method,
                path,
                cause,
              }),
          ),
        )
        return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(
            (cause) =>
              new ApiDecodeError({
                message: `The ${method} ${path} response did not match its expected shape.`,
                method,
                path,
                cause,
              }),
          ),
        )
      })

    const impl: Interface = {
      sites: Effect.fn("ApiClient.sites")(function* () {
        return yield* send("GET", "/api/sites", SitesResponse)
      }),

      status: Effect.fn("ApiClient.status")(function* (site?: SiteId) {
        return yield* send("GET", "/api/status", StatusReport, {
          query: { site },
        })
      }),

      dashboard: Effect.fn("ApiClient.dashboard")(function* (site?: SiteId) {
        return yield* send("GET", "/api/dashboard", DashboardSnapshot, {
          query: { site },
        })
      }),

      pages: Effect.fn("ApiClient.pages")(function* (
        window?: number,
        site?: SiteId,
      ) {
        return yield* send("GET", "/api/pages", PagesReport, {
          query: { window, site },
        })
      }),

      page: Effect.fn("ApiClient.page")(function* (
        path: string,
        site?: SiteId,
      ) {
        return yield* send("GET", "/api/page", PageReport, {
          query: { path, site },
        })
      }),

      queries: Effect.fn("ApiClient.queries")(function* (
        opts: QueriesOptions = {},
        site?: SiteId,
      ) {
        return yield* send("GET", "/api/queries", QueriesReport, {
          query: {
            page: opts.page,
            window: opts.windowDays,
            "min-impressions": opts.minImpressions,
            "include-brand": opts.includeBrand,
            limit: opts.limit,
            site,
          },
        })
      }),

      opportunities: Effect.fn("ApiClient.opportunities")(function* (
        kind?: string,
        site?: SiteId,
      ) {
        return yield* send("GET", "/api/opportunities", OpportunitiesReport, {
          query: { kind, site },
        })
      }),

      registry: Effect.fn("ApiClient.registry")(function* (site?: SiteId) {
        return yield* send("GET", "/api/registry", RegistryListReport, {
          query: { site },
        })
      }),

      log: Effect.fn("ApiClient.log")(function* (
        path?: string,
        site?: SiteId,
      ) {
        return yield* send("GET", "/api/log", LogListResult, {
          query: { path, site },
        })
      }),

      history: Effect.fn("ApiClient.history")(function* (
        limit?: number,
        site?: SiteId,
      ) {
        return yield* send("GET", "/api/history", HistoryReport, {
          query: { limit, site },
        })
      }),

      registryAdd: Effect.fn("ApiClient.registryAdd")(function* (
        body: RegistryAddInput,
        site?: SiteId,
      ) {
        return yield* send("POST", "/api/registry", RegistryAddResult, {
          query: { site },
          body,
        })
      }),

      registrySet: Effect.fn("ApiClient.registrySet")(function* (
        target: string,
        keyword: string | undefined,
        patch: RegistryPatch,
        site?: SiteId,
      ) {
        return yield* send("PATCH", "/api/registry", RegistrySetResult, {
          query: { site },
          body: { target, keyword, patch },
        })
      }),

      logAdd: Effect.fn("ApiClient.logAdd")(function* (
        body: LogAddInput,
        site?: SiteId,
      ) {
        return yield* send("POST", "/api/log", LogAddResult, {
          query: { site },
          body,
        })
      }),

      jobs: Effect.fn("ApiClient.jobs")(function* () {
        return yield* send("GET", "/api/jobs", JobsResponse)
      }),

      syncJob: Effect.fn("ApiClient.syncJob")(function* (site?: SiteId) {
        return yield* send("POST", "/api/jobs/sync", JobResponse, {
          query: { site },
        })
      }),

      backfillJob: Effect.fn("ApiClient.backfillJob")(function* (
        months?: number,
        site?: SiteId,
      ) {
        return yield* send("POST", "/api/jobs/backfill", JobResponse, {
          query: { site },
          body: { months },
        })
      }),
    }

    return impl
  }),
)

// Everything wired: real config resolution + the platform fetch transport.
export const defaultLayer = layer.pipe(
  Layer.provide(ClientConfig.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as ApiClient from "./client"
