// BingWebmaster service: the Bing Webmaster Tools API boundary for site-level
// daily totals (GetRankAndTrafficStats), query stats (GetQueryStats), and
// per-URL crawl info (GetUrlInfo). Auth is a single API key per user; the
// active property comes from CurrentSite.origin.
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
  type BingQueryWindowRow,
  type BingSiteDailyTotal,
  type BingUrlInfo,
  type BingUrlInfoInspection,
  BingAuthError,
  BingDecodeError,
  type BingError,
  BingHttpError,
} from "./schema.ts"

export interface Interface {
  readonly hasBingConnection: () => Effect.Effect<boolean>
  readonly fetchSiteDailyTotals: () => Effect.Effect<
    ReadonlyArray<BingSiteDailyTotal>,
    BingError
  >
  readonly fetchQueryWindow: () => Effect.Effect<
    ReadonlyArray<BingQueryWindowRow>,
    BingError
  >
  readonly fetchUrlInfo: (
    targetUrls: ReadonlyArray<string>,
  ) => Effect.Effect<BingUrlInfoInspection, BingError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/BingWebmaster",
) {}

export const use = serviceUse(Service)

const jsonApi = (method: string) =>
  `https://ssl.bing.com/webmaster/api.svc/json/${method}`

const authErrorCodes = new Set([3, 7, 14])
const urlInfoAuthErrorCodes = new Set([3, 14])
const urlInfoConcurrency = 8

const isTransientStatus = (status: number) => status === 429 || status >= 500
const isOkStatus = (status: number) => status >= 200 && status < 300

const isRetryable = (error: BingError) =>
  error._tag === "BingHttpError" &&
  (error.status === undefined || isTransientStatus(error.status))

const transientRetrySchedule = Schedule.exponential(
  Duration.millis(500),
  2,
).pipe(Schedule.jittered, Schedule.upTo({ times: 5 }))

// .NET JSON dates: "/Date(1784876400000-0700)/" — ms is UTC epoch; offset
// is informational and already applied.
const dotNetDatePattern = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/

export const parseDotNetDate = (value: string): string => {
  const match = dotNetDatePattern.exec(value)
  if (!match)
    throw new Error(`Not a .NET JSON date: ${value}`)
  return new Date(Number(match[1])).toISOString().slice(0, 10)
}

export const isNotInIndexSentinel = (
  documentSize: number,
  discoveryDate: string,
): boolean => {
  if (documentSize !== 0) return false
  if (discoveryDate.startsWith("0001") || discoveryDate.includes("0001-01-01"))
    return true
  const match = dotNetDatePattern.exec(discoveryDate)
  if (match) return new Date(Number(match[1])).getUTCFullYear() <= 1
  try {
    return parseDotNetDate(discoveryDate).startsWith("0001")
  } catch {
    return false
  }
}

const optionalDotNetDate = (value: string | undefined): string | null => {
  if (!value) return null
  try {
    return parseDotNetDate(value)
  } catch {
    return null
  }
}

const BingTrafficRowRaw = Schema.Struct({
  Date: Schema.String,
  Clicks: Schema.Number,
  Impressions: Schema.Number,
})

const BingTrafficEnvelopeRaw = Schema.Struct({
  d: Schema.Array(BingTrafficRowRaw),
})

const BingQueryRowRaw = Schema.Struct({
  Query: Schema.String,
  Clicks: Schema.Number,
  Impressions: Schema.Number,
  AvgImpressionPosition: Schema.Number,
})

const BingQueryEnvelopeRaw = Schema.Struct({
  d: Schema.Array(BingQueryRowRaw),
})

const BingUrlInfoRowRaw = Schema.Struct({
  DiscoveryDate: Schema.String,
  LastCrawledDate: Schema.optional(Schema.String),
  AnchorCount: Schema.Number,
  DocumentSize: Schema.Number,
})

const BingUrlInfoEnvelopeRaw = Schema.Struct({
  d: BingUrlInfoRowRaw,
})

const BingErrorBody = Schema.Struct({
  ErrorCode: Schema.Number,
  Message: Schema.optional(Schema.String),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const currentSite = yield* CurrentSite.Service
    const httpClient = yield* HttpClient.HttpClient

    const executeWithRetry = (request: HttpClientRequest.HttpClientRequest) =>
      httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new BingHttpError({
              message: "The Bing Webmaster request could not be sent.",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          isTransientStatus(response.status)
            ? Effect.fail(
                new BingHttpError({
                  message: `Bing Webmaster returned a transient error (HTTP ${response.status}).`,
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

    const readJson = (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.mapError(
          (cause) =>
            new BingDecodeError({
              message: "The Bing Webmaster response body could not be read.",
              cause,
            }),
        ),
      )

    const classifyErrorBody = (
      json: unknown,
      status: number,
    ): Effect.Effect<void, BingError> =>
      Effect.gen(function* () {
        const errorBody = yield* Schema.decodeUnknownEffect(BingErrorBody)(
          json,
        ).pipe(Effect.option)
        if (Option.isSome(errorBody)) {
          const { ErrorCode, Message } = errorBody.value
          if (authErrorCodes.has(ErrorCode))
            return yield* Effect.fail(
              new BingAuthError({
                message:
                  Message ??
                  `Bing Webmaster rejected the request (ErrorCode ${ErrorCode}).`,
                errorCode: ErrorCode,
              }),
            )
          return yield* Effect.fail(
            new BingHttpError({
              message:
                Message ??
                `Bing Webmaster returned ErrorCode ${ErrorCode} (HTTP ${status}).`,
              status,
            }),
          )
        }
        if (!isOkStatus(status))
          return yield* Effect.fail(
            new BingHttpError({
              message: `Bing Webmaster returned an unexpected status (HTTP ${status}).`,
              status,
            }),
          )
      })

    const withApiKey = <A>(
      method: string,
      decode: (
        response: HttpClientResponse.HttpClientResponse,
      ) => Effect.Effect<A, BingError>,
    ) =>
      Effect.gen(function* () {
        const key = yield* config.bingApiKey()
        if (Option.isNone(key))
          return yield* Effect.fail(
            new BingAuthError({
              message: "No Bing API key is configured.",
            }),
          )
        const site = yield* currentSite.current()
        const request = HttpClientRequest.get(jsonApi(method)).pipe(
          HttpClientRequest.setUrlParams({
            apikey: Redacted.value(key.value),
            siteUrl: site.origin,
          }),
        )
        const response = yield* executeWithRetry(request)
        return yield* decode(response)
      })

    const decodeSiteDailyTotals = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<ReadonlyArray<BingSiteDailyTotal>, BingError> =>
      Effect.gen(function* () {
        const json = yield* readJson(response)
        yield* classifyErrorBody(json, response.status)
        const envelope = yield* Schema.decodeUnknownEffect(
          BingTrafficEnvelopeRaw,
        )(json).pipe(
          Effect.mapError(
            (cause) =>
              new BingDecodeError({
                message:
                  "The Bing Webmaster response did not match its expected shape.",
                cause,
              }),
          ),
        )
        return envelope.d.map((row) => ({
          date: parseDotNetDate(row.Date),
          clicks: row.Clicks,
          impressions: row.Impressions,
        }))
      })

    const decodeQueryWindow = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<ReadonlyArray<BingQueryWindowRow>, BingError> =>
      Effect.gen(function* () {
        const json = yield* readJson(response)
        yield* classifyErrorBody(json, response.status)
        const envelope = yield* Schema.decodeUnknownEffect(
          BingQueryEnvelopeRaw,
        )(json).pipe(
          Effect.mapError(
            (cause) =>
              new BingDecodeError({
                message:
                  "The Bing Webmaster response did not match its expected shape.",
                cause,
              }),
          ),
        )
        return envelope.d.map((row) => ({
          query: row.Query,
          clicks: row.Clicks,
          impressions: row.Impressions,
          position: row.AvgImpressionPosition,
        }))
      })

    const decodeUrlInfoResponse = (
      targetUrl: string,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<BingUrlInfo, BingError> =>
      Effect.gen(function* () {
        const json = yield* readJson(response)
        const errorBody = yield* Schema.decodeUnknownEffect(BingErrorBody)(
          json,
        ).pipe(Effect.option)
        if (Option.isSome(errorBody)) {
          const { ErrorCode, Message } = errorBody.value
          if (urlInfoAuthErrorCodes.has(ErrorCode))
            return yield* Effect.fail(
              new BingAuthError({
                message:
                  Message ??
                  `Bing Webmaster rejected the request (ErrorCode ${ErrorCode}).`,
                errorCode: ErrorCode,
              }),
            )
          return yield* Effect.fail(
            new BingHttpError({
              message:
                Message ??
                `Bing Webmaster returned ErrorCode ${ErrorCode} (HTTP ${response.status}).`,
              status: response.status,
            }),
          )
        }
        yield* classifyErrorBody(json, response.status)
        const envelope = yield* Schema.decodeUnknownEffect(
          BingUrlInfoEnvelopeRaw,
        )(json).pipe(
          Effect.mapError(
            (cause) =>
              new BingDecodeError({
                message:
                  "The Bing Webmaster GetUrlInfo response did not match its expected shape.",
                cause,
              }),
          ),
        )
        const row = envelope.d
        if (isNotInIndexSentinel(row.DocumentSize, row.DiscoveryDate)) {
          return {
            targetUrl,
            discoveredAt: null,
            lastCrawledAt: null,
            anchorCount: row.AnchorCount,
            documentSize: row.DocumentSize,
            inIndex: false,
          }
        }
        return {
          targetUrl,
          discoveredAt: optionalDotNetDate(row.DiscoveryDate),
          lastCrawledAt: optionalDotNetDate(row.LastCrawledDate),
          anchorCount: row.AnchorCount,
          documentSize: row.DocumentSize,
          inIndex: true,
        }
      })

    const impl: Interface = {
      hasBingConnection: () =>
        config.bingApiKey().pipe(
          Effect.map(Option.isSome),
          Effect.catchCause(() => Effect.succeed(false)),
        ),

      fetchSiteDailyTotals: Effect.fn("BingWebmaster.fetchSiteDailyTotals")(
        () => withApiKey("GetRankAndTrafficStats", decodeSiteDailyTotals),
      ),

      fetchQueryWindow: Effect.fn("BingWebmaster.fetchQueryWindow")(() =>
        withApiKey("GetQueryStats", decodeQueryWindow),
      ),

      fetchUrlInfo: Effect.fn("BingWebmaster.fetchUrlInfo")(function* (
        targetUrls: ReadonlyArray<string>,
      ) {
        const key = yield* config.bingApiKey()
        if (Option.isNone(key))
          return yield* Effect.fail(
            new BingAuthError({
              message: "No Bing API key is configured.",
            }),
          )
        const site = yield* currentSite.current()
        const unique = [...new Set(targetUrls)]
        const results = yield* Effect.forEach(
          unique,
          (targetUrl) =>
            Effect.gen(function* () {
              const request = HttpClientRequest.get(jsonApi("GetUrlInfo")).pipe(
                HttpClientRequest.setUrlParams({
                  apikey: Redacted.value(key.value),
                  siteUrl: site.origin,
                  url: targetUrl,
                }),
              )
              const response = yield* executeWithRetry(request)
              return yield* decodeUrlInfoResponse(targetUrl, response)
            }).pipe(Effect.option),
          { concurrency: urlInfoConcurrency },
        )
        const infos = results.filter(Option.isSome).map((result) => result.value)
        return {
          infos,
          failed: results.length - infos.length,
        } satisfies BingUrlInfoInspection
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

export * as BingWebmaster from "./bing-webmaster"
