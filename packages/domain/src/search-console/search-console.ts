// SearchConsole service: the Google Search Console + URL Inspection boundary.
// Backed by Effect HttpClient with typed errors and a retry Schedule.
//
// Auth is a **service-account key** only: a JWT signed with the key's private
// half is exchanged for a short-lived access token, cached in memory. There is
// no interactive OAuth flow and no refresh token — the key is valid until it is
// deleted in Google Cloud, which is what a headless deploy wants. The key path
// comes from Config; the active property from CurrentSite.
import { createSign } from "node:crypto"
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
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
  // Whether a usable Google service-account key is present. Never fails — a
  // missing or malformed key reads as "not connected".
  readonly hasGoogleConnection: () => Effect.Effect<boolean>
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

// --- endpoints ---

const scope = "https://www.googleapis.com/auth/webmasters.readonly"
const tokenEndpoint = "https://oauth2.googleapis.com/token"
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

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
})

// The subset of a Google service-account JSON key this service needs. `token_uri`
// is present in every key Google mints but is defaulted rather than required, so
// a hand-trimmed key still works.
const ServiceAccountKey = Schema.Struct({
  client_email: Schema.String,
  private_key: Schema.String,
  token_uri: Schema.optional(Schema.String),
})
interface ServiceAccountKey extends Schema.Schema.Type<typeof ServiceAccountKey> {}

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
// request retries and token-mint retries.
const transientRetrySchedule = Schedule.exponential(
  Duration.millis(500),
  2,
).pipe(Schedule.jittered, Schedule.upTo({ times: 5 }))

// --- service-account helpers (headless JWT-bearer flow) ---

const base64Url = (value: Buffer) => value.toString("base64url")

// Google's JWT-bearer grant: an assertion signed with the service account's
// private key is exchanged for an access token. There is no refresh token to
// expire or be revoked — the key stays valid until it is deleted in Google Cloud.
const jwtBearerGrant = "urn:ietf:params:oauth:grant-type:jwt-bearer"
// Google caps the assertion lifetime at one hour and rejects anything longer.
const assertionLifetimeSeconds = 3600

const signedAssertion = (key: ServiceAccountKey) => {
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = base64Url(
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  )
  const claims = base64Url(
    Buffer.from(
      JSON.stringify({
        iss: key.client_email,
        scope,
        aud: key.token_uri ?? tokenEndpoint,
        iat: issuedAt,
        exp: issuedAt + assertionLifetimeSeconds,
      }),
    ),
  )
  const body = `${header}.${claims}`
  return `${body}.${base64Url(
    createSign("RSA-SHA256").update(body).sign(key.private_key),
  )}`
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const currentSite = yield* CurrentSite.Service
    const httpClient = yield* HttpClient.HttpClient

    // Execute a request, converting transport errors and transient (429/5xx)
    // statuses into retryable failures, then retrying them with the Schedule.
    // Non-transient non-2xx responses come back untouched so the caller can
    // classify them (e.g. a 401 that should trigger a token remint).
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
          // 401 and 403 mean different things and have different fixes: the
          // credential is stale vs. the credential is fine but has no access to
          // this property (the usual first-run state for a service account,
          // until it is added under Search Console → Users and permissions).
          if (status === 401)
            return yield* Effect.fail(
              new SearchConsoleAuthError({
                message:
                  "Google rejected the credential (HTTP 401). The service-account key may have been deleted or disabled in Google Cloud.",
              }),
            )
          if (status === 403)
            return yield* Effect.fail(
              new SearchConsoleAuthError({
                message:
                  "Google denied access to this property (HTTP 403). The credential is valid but lacks permission — grant it access in Search Console → Settings → Users and permissions.",
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

    // Read the service-account key off the volume. This is the only credential
    // the service accepts, so a missing or broken key is a hard failure with a
    // message that names the path — the operator's fix is always "put a valid
    // key there".
    const readServiceAccountKey: Effect.Effect<
      ServiceAccountKey,
      SearchConsoleAuthError
    > = Effect.gen(function* () {
      const path = yield* config.serviceAccountPath()
      const raw = yield* Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: (cause) =>
          new SearchConsoleAuthError({
            message: `No Google service-account key was found at ${path}.`,
            cause,
          }),
      })
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) =>
          new SearchConsoleAuthError({
            message: `The service-account key at ${path} is not valid JSON.`,
            cause,
          }),
      })
      return yield* Schema.decodeUnknownEffect(ServiceAccountKey)(parsed).pipe(
        Effect.mapError(
          (cause) =>
            new SearchConsoleAuthError({
              message: `The service-account key at ${path} is missing client_email or private_key.`,
              cause,
            }),
        ),
      )
    })

    // Access tokens minted from the key, cached in memory until shortly before
    // expiry. Nothing is written to disk — there is no rotating credential to
    // persist — so the volume can be mounted read-only.
    const cachedToken = yield* Ref.make(
      Option.none<{ readonly token: string; readonly expiresAt: number }>(),
    )

    // Return a usable access token, minting a new one when the cached one is
    // near expiry or when forced (e.g. after a 401).
    const getAccessToken = (
      force: boolean,
    ): Effect.Effect<string, SearchConsoleError> =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(cachedToken)
        if (
          !force &&
          Option.isSome(cached) &&
          cached.value.expiresAt > Date.now()
        )
          return cached.value.token

        const key = yield* readServiceAccountKey
        const request = HttpClientRequest.post(
          key.token_uri ?? tokenEndpoint,
        ).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: jwtBearerGrant,
            assertion: signedAssertion(key),
          }),
        )
        const response = yield* executeWithRetry(request)
        if (!isOkStatus(response.status))
          return yield* Effect.fail(
            new SearchConsoleAuthError({
              message: `Google refused the service-account assertion (HTTP ${response.status}). Check that the key is still enabled and that ${key.client_email} has access to the property.`,
            }),
          )
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The service-account token response could not be read.",
                cause,
              }),
          ),
        )
        const minted = yield* Schema.decodeUnknownEffect(TokenResponse)(json).pipe(
          Effect.mapError(
            (cause) =>
              new SearchConsoleAuthError({
                message: "The service-account token response was malformed.",
                cause,
              }),
          ),
        )
        // A 60-second margin, so a token can't expire mid-flight on a slow call.
        yield* Ref.set(
          cachedToken,
          Option.some({
            token: minted.access_token,
            expiresAt: Date.now() + (minted.expires_in - 60) * 1_000,
          }),
        )
        return minted.access_token
      })

    // Run an authenticated request; on a 401, mint a fresh token once and retry.
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

    // `dataState` picks which side of Google's finalization boundary we see.
    // "final" returns finalized days only — a day newer than the cutoff comes
    // back with zero rows, whatever its real traffic. "all" adds the still-being
    // -revised trailing days. Query breakdowns stay "final" (they feed the
    // registry and opportunity maths, which must not chase numbers Google is
    // still moving); the site-wide daily totals ask for "all" so the provisional
    // tail actually arrives and the UI can dim it.
    const queryRequest = (
      property: string,
      accessToken: string,
      date: string,
      dimensions: ReadonlyArray<string>,
      startRow: number,
      dataState: "final" | "all",
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
          dataState,
        }),
      )

    // Page through searchAnalytics/query until a short page signals the end.
    const queryAllRows = (
      property: string,
      date: string,
      dimensions: ReadonlyArray<string>,
      dataState: "final" | "all" = "final",
    ): Effect.Effect<
      ReadonlyArray<Schema.Schema.Type<typeof SearchRow>>,
      SearchConsoleError
    > =>
      Effect.gen(function* () {
        const rows: Array<Schema.Schema.Type<typeof SearchRow>> = []
        for (let startRow = 0; ; startRow += rowLimit) {
          const result = yield* authedJson(SearchAnalyticsResponse, (token) =>
            queryRequest(property, token, date, dimensions, startRow, dataState),
          )
          const pageRows = result.rows ?? []
          rows.push(...pageRows)
          if (pageRows.length < rowLimit) return rows
        }
      })

    const impl: Interface = {
      // The key needs no authorization round-trip and cannot expire, so a
      // readable, well-formed key on the volume *is* the connection.
      hasGoogleConnection: () =>
        readServiceAccountKey.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        ),

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
            const siteRows = yield* queryAllRows(site.property, date, [], "all")
            const siteRow = siteRows[0]
            if (siteRow)
              siteTotals.push({
                date,
                clicks: siteRow.clicks,
                impressions: siteRow.impressions,
                ctr: siteRow.ctr,
                position: siteRow.position,
              })
            const pageRows = yield* queryAllRows(
              site.property,
              date,
              ["page"],
              "all",
            )
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
