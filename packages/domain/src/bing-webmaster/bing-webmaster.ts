// BingWebmaster service: the Bing Webmaster Tools API boundary for site-level
// daily totals (GetRankAndTrafficStats). Auth is a single API key per user;
// the active property comes from CurrentSite.origin.
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
  type BingSiteDailyTotal,
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
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/BingWebmaster",
) {}

export const use = serviceUse(Service)

const baseUrl =
  "https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats"

const authErrorCodes = new Set([3, 7, 14])

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
export const parseDotNetDate = (value: string): string => {
  const match = /^\/Date\((\d+)([+-]\d{4})?\)\/$/.exec(value)
  if (!match)
    throw new Error(`Not a .NET JSON date: ${value}`)
  return new Date(Number(match[1])).toISOString().slice(0, 10)
}

const BingTrafficRowRaw = Schema.Struct({
  Date: Schema.String,
  Clicks: Schema.Number,
  Impressions: Schema.Number,
})

const BingEnvelopeRaw = Schema.Struct({
  d: Schema.Array(BingTrafficRowRaw),
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

    const decodeResponse = (
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<ReadonlyArray<BingSiteDailyTotal>, BingError> =>
      Effect.gen(function* () {
        const status = response.status
        const json = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new BingDecodeError({
                message: "The Bing Webmaster response body could not be read.",
                cause,
              }),
          ),
        )
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
        const envelope = yield* Schema.decodeUnknownEffect(BingEnvelopeRaw)(
          json,
        ).pipe(
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

    const impl: Interface = {
      hasBingConnection: () =>
        config.bingApiKey().pipe(
          Effect.map(Option.isSome),
          Effect.catchCause(() => Effect.succeed(false)),
        ),

      fetchSiteDailyTotals: Effect.fn("BingWebmaster.fetchSiteDailyTotals")(
        function* () {
          const key = yield* config.bingApiKey()
          if (Option.isNone(key))
            return yield* Effect.fail(
              new BingAuthError({
                message: "No Bing API key is configured.",
              }),
            )
          const site = yield* currentSite.current()
          const request = HttpClientRequest.get(baseUrl).pipe(
            HttpClientRequest.setUrlParams({
              apikey: Redacted.value(key.value),
              siteUrl: site.origin,
            }),
          )
          const response = yield* executeWithRetry(request)
          return yield* decodeResponse(response)
        },
      ),
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
