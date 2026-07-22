// SearchConsole service: the Google Search Console + URL Inspection boundary,
// with OAuth token refresh. Backed by Effect HttpClient with typed errors and a
// token-refresh Schedule. Reads client credentials from Config and the active
// property from CurrentSite. FROZEN CONTRACT — Interface/Service/use signatures
// are frozen; the `layer` below is the real implementation.
import { createHash, randomBytes } from "node:crypto"
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageDailyTotal,
  type PageIndexInspection,
  type PageIndexStatus,
  SearchConsoleAuthError,
  SearchConsoleDecodeError,
  type SearchConsoleError,
  SearchConsoleHttpError,
  type SiteDailyTotal,
} from "./schema.ts"

export interface Interface {
  // Whether a usable (valid or refreshable) Google connection is stored. Never
  // fails — an unreadable token reads as "not connected".
  readonly hasGoogleConnection: () => Effect.Effect<boolean>
  // Run the interactive OAuth authorization flow and persist the token.
  readonly connectGoogle: () => Effect.Effect<string, SearchConsoleError>
  // Query-grouped snapshots (query/page/device/country) for the given dates.
  readonly fetchSearchConsoleSnapshots: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<DailySnapshot>, SearchConsoleError>
  // Query-less site and per-page daily totals (the true numbers) for the dates.
  readonly fetchDailyTotals: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<DailyTotals, SearchConsoleError>
  // URL-inspection index statuses for the given fully-qualified target URLs.
  readonly fetchPageIndexStatuses: (
    targetUrls: ReadonlyArray<string>,
  ) => Effect.Effect<PageIndexInspection, SearchConsoleError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/SearchConsole",
) {}

export const use = serviceUse(Service)

// --- OAuth constants (ported from legacy src/google.ts) ---

const scope = "https://www.googleapis.com/auth/webmasters.readonly"
const callbackPort = 8765
const redirectUri = `http://127.0.0.1:${callbackPort}/oauth/callback`
const tokenEndpoint = "https://oauth2.googleapis.com/token"
const authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
const queryEndpoint = (property: string) =>
  `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    property,
  )}/searchAnalytics/query`
const inspectEndpoint =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"

const rowLimit = 25_000
// URL inspection is slow (~seconds/call); bounded concurrency keeps peak rate
// well under Google's per-property limit even for a full registry.
const inspectionConcurrency = 8

// --- internal wire schemas (schema.ts is frozen; these decode raw responses) ---

const StoredToken = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  created_at: Schema.Number,
})
interface StoredToken extends Schema.Schema.Type<typeof StoredToken> {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
})

const SearchRow = Schema.Struct({
  keys: Schema.optional(Schema.Array(Schema.String)),
  clicks: Schema.Number,
  impressions: Schema.Number,
  ctr: Schema.Number,
  position: Schema.Number,
})
const SearchAnalyticsResponse = Schema.Struct({
  rows: Schema.optional(Schema.Array(SearchRow)),
})

const UrlInspectionResponse = Schema.Struct({
  inspectionResult: Schema.optional(
    Schema.Struct({
      indexStatusResult: Schema.optional(
        Schema.Struct({
          verdict: Schema.optional(Schema.String),
          coverageState: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})

// --- status classification ---

const isTransientStatus = (status: number) => status === 429 || status >= 500
const isOkStatus = (status: number) => status >= 200 && status < 300

// A transient HTTP failure (transport error → no status, or 429/5xx) should be
// retried; everything else surfaces immediately.
const isRetryable = (error: SearchConsoleError) =>
  error._tag === "SearchConsoleHttpError" &&
  (error.status === undefined || isTransientStatus(error.status))

// Exponential backoff + jitter, capped at five retries. Drives both transient
// request retries and token-refresh retries.
const transientRetrySchedule = Schedule.exponential(
  Duration.millis(500),
  2,
).pipe(Schedule.jittered, Schedule.upTo({ times: 5 }))

// --- OAuth helpers (interactive connect flow) ---

const base64Url = (value: Buffer) => value.toString("base64url")
const codeVerifier = () => base64Url(randomBytes(32))
const challengeFor = (verifier: string) =>
  base64Url(createHash("sha256").update(verifier).digest())

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const currentSite = yield* CurrentSite.Service
    const httpClient = yield* HttpClient.HttpClient

    // Execute a request, converting transport errors and transient (429/5xx)
    // statuses into retryable failures, then retrying them with the Schedule.
    // Non-transient non-2xx responses come back untouched so the caller can
    // classify them (e.g. a 401 that should trigger a refresh).
    const executeWithRetry = (request: HttpClientRequest.HttpClientRequest) =>
      httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new SearchConsoleHttpError({
              message: "The Search Console request could not be sent.",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          isTransientStatus(response.status)
            ? Effect.fail(
                new SearchConsoleHttpError({
                  message: `Search Console returned a transient error (HTTP ${response.status}).`,
                  status: response.status,
                }),
              )
            : Effect.succeed(response),
        ),
        Effect.retry({
          schedule: transientRetrySchedule,
          while: isRetryable,
        }),
      )

    // Classify a settled (non-transient) response and decode its body.
    const decodeOk = <A>(
      schema: Schema.Codec<A, unknown>,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<A, SearchConsoleError> =>
      Effect.gen(function* () {
        const status = response.status
        if (!isOkStatus(status)) {
          if (status === 401 || status === 403)
            return yield* Effect.fail(
              new SearchConsoleAuthError({
                message: `Google rejected the request (HTTP ${status}). The connection may need to be re-authorized.`,
              }),
            )
          return yield* Effect.fail(
            new SearchConsoleHttpError({
              message: `Search Console returned an unexpected status (HTTP ${status}).`,
              status,
            }),
          )
        }
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleDecodeError({
                message: "The Search Console response body could not be read.",
                cause,
              }),
          ),
        )
        return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleDecodeError({
                message: "The Search Console response did not match its expected shape.",
                cause,
              }),
          ),
        )
      })

    const readStoredToken: Effect.Effect<StoredToken, SearchConsoleAuthError> =
      Effect.gen(function* () {
        const path = yield* config.tokenPath()
        const raw = yield* Effect.tryPromise({
          try: () => Bun.file(path).text(),
          catch: (cause) =>
            new SearchConsoleAuthError({
              message: "No stored Google connection was found.",
              cause,
            }),
        })
        const parsed = yield* Effect.sync(() => raw).pipe(
          Effect.flatMap((text) =>
            Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: (cause) =>
                new SearchConsoleAuthError({
                  message: "The stored Google token is not valid JSON.",
                  cause,
                }),
            }),
          ),
        )
        return yield* Schema.decodeUnknownEffect(StoredToken)(parsed).pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The stored Google token is malformed.",
                cause,
              }),
          ),
        )
      })

    // Refresh the access token via the OAuth refresh_token grant and rewrite the
    // token file. Retries transient failures via executeWithRetry.
    const refreshAccessToken = (
      token: StoredToken,
    ): Effect.Effect<string, SearchConsoleError> =>
      Effect.gen(function* () {
        const refreshToken = token.refresh_token
        if (refreshToken === undefined)
          return yield* Effect.fail(
            new SearchConsoleAuthError({
              message:
                "The Google connection has expired and must be authorized again.",
            }),
          )
        const seoConfig = yield* config.load().pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The Google client credentials could not be loaded.",
                cause,
              }),
          ),
        )
        const request = HttpClientRequest.post(tokenEndpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: seoConfig.googleClientId,
            client_secret: Redacted.value(seoConfig.googleClientSecret),
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        )
        const response = yield* executeWithRetry(request)
        if (!isOkStatus(response.status))
          return yield* Effect.fail(
            new SearchConsoleAuthError({
              message: `Google refused to refresh the connection (HTTP ${response.status}).`,
            }),
          )
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The token-refresh response could not be read.",
                cause,
              }),
          ),
        )
        const refreshed = yield* Schema.decodeUnknownEffect(TokenResponse)(
          json,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The token-refresh response was malformed.",
                cause,
              }),
          ),
        )
        const next: StoredToken = {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token ?? refreshToken,
          expires_in: refreshed.expires_in,
          created_at: Date.now(),
        }
        const path = yield* config.tokenPath()
        yield* Effect.tryPromise({
          try: () => Bun.write(path, JSON.stringify(next, null, 2)),
          catch: (cause) =>
            new SearchConsoleHttpError({
              message: "The refreshed Google token could not be saved.",
              cause,
            }),
        })
        return next.access_token
      })

    // Return a usable access token, refreshing when near-expiry (or when forced,
    // e.g. after a 401). Mirrors the legacy 60-second freshness margin.
    const getAccessToken = (
      force: boolean,
    ): Effect.Effect<string, SearchConsoleError> =>
      Effect.gen(function* () {
        const token = yield* readStoredToken
        if (
          !force &&
          token.created_at + (token.expires_in - 60) * 1_000 > Date.now()
        )
          return token.access_token
        return yield* refreshAccessToken(token)
      })

    // Run an authenticated request; on a 401, refresh once and retry.
    const authedJson = <A>(
      schema: Schema.Codec<A, unknown>,
      buildRequest: (accessToken: string) => HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<A, SearchConsoleError> =>
      Effect.gen(function* () {
        const token = yield* getAccessToken(false)
        const response = yield* executeWithRetry(buildRequest(token))
        if (response.status === 401) {
          const refreshed = yield* getAccessToken(true)
          const retried = yield* executeWithRetry(buildRequest(refreshed))
          return yield* decodeOk(schema, retried)
        }
        return yield* decodeOk(schema, response)
      })

    const queryRequest = (
      property: string,
      accessToken: string,
      date: string,
      dimensions: ReadonlyArray<string>,
      startRow: number,
    ) =>
      HttpClientRequest.post(queryEndpoint(property)).pipe(
        HttpClientRequest.bearerToken(accessToken),
        HttpClientRequest.bodyJsonUnsafe({
          startDate: date,
          endDate: date,
          dimensions,
          type: "web",
          rowLimit,
          startRow,
          dataState: "final",
        }),
      )

    // Page through searchAnalytics/query until a short page signals the end.
    const queryAllRows = (
      property: string,
      date: string,
      dimensions: ReadonlyArray<string>,
    ): Effect.Effect<
      ReadonlyArray<Schema.Schema.Type<typeof SearchRow>>,
      SearchConsoleError
    > =>
      Effect.gen(function* () {
        const rows: Array<Schema.Schema.Type<typeof SearchRow>> = []
        for (let startRow = 0; ; startRow += rowLimit) {
          const result = yield* authedJson(SearchAnalyticsResponse, (token) =>
            queryRequest(property, token, date, dimensions, startRow),
          )
          const pageRows = result.rows ?? []
          rows.push(...pageRows)
          if (pageRows.length < rowLimit) return rows
        }
      })

    const impl: Interface = {
      hasGoogleConnection: () =>
        readStoredToken.pipe(
          Effect.map((token) => {
            const accessTokenIsValid =
              token.access_token.length > 0 &&
              token.created_at + token.expires_in * 1_000 > Date.now()
            return (
              (token.refresh_token !== undefined &&
                token.refresh_token.length > 0) ||
              accessTokenIsValid
            )
          }),
          Effect.catchCause(() => Effect.succeed(false)),
        ),

      connectGoogle: Effect.fn("SearchConsole.connectGoogle")(function* () {
        const seoConfig = yield* config.load().pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The Google client credentials could not be loaded.",
                cause,
              }),
          ),
        )
        yield* config.ensureDataDirectory().pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleHttpError({
                message: "The data directory could not be created.",
                cause,
              }),
          ),
        )
        const verifier = codeVerifier()
        const state = base64Url(randomBytes(24))
        const authorizationUrl = new URL(authorizeEndpoint)
        authorizationUrl.search = new URLSearchParams({
          client_id: seoConfig.googleClientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope,
          access_type: "offline",
          prompt: "consent",
          code_challenge: challengeFor(verifier),
          code_challenge_method: "S256",
          state,
        }).toString()

        const callback = yield* Effect.callback<
          { readonly code: string },
          SearchConsoleAuthError
        >((resume) => {
          const server = Bun.serve({
            port: callbackPort,
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname !== "/oauth/callback")
                return new Response("Not found", { status: 404 })
              const code = url.searchParams.get("code")
              const responseState = url.searchParams.get("state")
              if (!code || responseState !== state) {
                resume(
                  Effect.fail(
                    new SearchConsoleAuthError({
                      message:
                        "The Google OAuth callback was missing a valid authorization code.",
                    }),
                  ),
                )
                return new Response(
                  "Authorization failed. You can close this tab.",
                  { status: 400 },
                )
              }
              resume(Effect.succeed({ code }))
              return new Response(
                "Ranksta's Paradise is connected. You can close this tab and return to the terminal.",
              )
            },
          })
          Bun.spawn(["open", authorizationUrl.toString()])
          return Effect.sync(() => server.stop())
        })

        const request = HttpClientRequest.post(tokenEndpoint).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: seoConfig.googleClientId,
            client_secret: Redacted.value(seoConfig.googleClientSecret),
            code: callback.code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        )
        const response = yield* executeWithRetry(request)
        if (!isOkStatus(response.status))
          return yield* Effect.fail(
            new SearchConsoleAuthError({
              message: `Could not exchange the Google OAuth code (HTTP ${response.status}).`,
            }),
          )
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The OAuth token response could not be read.",
                cause,
              }),
          ),
        )
        const token = yield* Schema.decodeUnknownEffect(TokenResponse)(
          json,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The OAuth token response was malformed.",
                cause,
              }),
          ),
        )
        const path = yield* config.tokenPath()
        yield* Effect.tryPromise({
          try: () =>
            Bun.write(
              path,
              JSON.stringify(
                { ...token, created_at: Date.now() } satisfies StoredToken,
                null,
                2,
              ),
            ),
          catch: (cause) =>
            new SearchConsoleHttpError({
              message: "The Google token could not be saved.",
              cause,
            }),
        })
        return "Connected to Google Search Console."
      }),

      fetchSearchConsoleSnapshots: Effect.fn(
        "SearchConsole.fetchSearchConsoleSnapshots",
      )(function* (dates: ReadonlyArray<string>) {
        const site = yield* currentSite.current()
        const snapshots: Array<DailySnapshot> = []
        for (const date of dates) {
          const rows = yield* queryAllRows(site.property, date, [
            "query",
            "page",
            "device",
            "country",
          ])
          for (const row of rows) {
            snapshots.push({
              date,
              query: row.keys?.[0] ?? "",
              page: row.keys?.[1] ?? "",
              device: row.keys?.[2] ?? "",
              country: row.keys?.[3] ?? "",
              clicks: row.clicks,
              impressions: row.impressions,
              ctr: row.ctr,
              position: row.position,
            })
          }
        }
        return snapshots
      }),

      fetchDailyTotals: Effect.fn("SearchConsole.fetchDailyTotals")(
        function* (dates: ReadonlyArray<string>) {
          const site = yield* currentSite.current()
          const siteTotals: Array<SiteDailyTotal> = []
          const pages: Array<PageDailyTotal> = []
          for (const date of dates) {
            const siteRows = yield* queryAllRows(site.property, date, [])
            const siteRow = siteRows[0]
            if (siteRow)
              siteTotals.push({
                date,
                clicks: siteRow.clicks,
                impressions: siteRow.impressions,
                ctr: siteRow.ctr,
                position: siteRow.position,
              })
            const pageRows = yield* queryAllRows(site.property, date, ["page"])
            for (const row of pageRows) {
              pages.push({
                date,
                page: row.keys?.[0] ?? "",
                clicks: row.clicks,
                impressions: row.impressions,
                ctr: row.ctr,
                position: row.position,
              })
            }
          }
          return { site: siteTotals, pages } satisfies DailyTotals
        },
      ),

      fetchPageIndexStatuses: Effect.fn(
        "SearchConsole.fetchPageIndexStatuses",
      )(function* (targetUrls: ReadonlyArray<string>) {
        const site = yield* currentSite.current()
        const unique = [...new Set(targetUrls)]
        const results = yield* Effect.forEach(
          unique,
          (targetUrl) =>
            authedJson(UrlInspectionResponse, (token) =>
              HttpClientRequest.post(inspectEndpoint).pipe(
                HttpClientRequest.bearerToken(token),
                HttpClientRequest.bodyJsonUnsafe({
                  inspectionUrl: targetUrl,
                  siteUrl: site.property,
                  languageCode: "en-US",
                }),
              ),
            ).pipe(
              Effect.map((response): PageIndexStatus => {
                const indexStatus =
                  response.inspectionResult?.indexStatusResult
                const verdict = indexStatus?.verdict ?? "VERDICT_UNSPECIFIED"
                return {
                  targetUrl,
                  status:
                    verdict === "PASS"
                      ? "indexed"
                      : verdict === "FAIL" || verdict === "NEUTRAL"
                        ? "not-indexed"
                        : "unknown",
                  verdict,
                  coverageState: indexStatus?.coverageState ?? "",
                }
              }),
              // A single failed inspection must not fail the whole batch; it is
              // counted as `failed` instead. Interrupts still propagate.
              Effect.option,
            ),
          { concurrency: inspectionConcurrency },
        )
        const inspections = results.filter(Option.isSome).map((o) => o.value)
        return {
          inspections,
          failed: results.length - inspections.length,
        } satisfies PageIndexInspection
      }),
    }

    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as SearchConsole from "./search-console"
