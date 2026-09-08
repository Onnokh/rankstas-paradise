// Polar adapter: the first revenue provider behind the port in revenue.ts.
//
// Polar's metrics endpoint answers a whole span in one call:
//
//   GET /v1/metrics?start_date=&end_date=&interval=day&timezone=&metrics=…
//
// bucketed by day in the zone asked, with `orders` (a count), `revenue` (what
// customers paid, in cents) and `net_revenue` (that less refunds) per bucket.
// One call covers up to 366 days, so a first run and a daily reconcile cost
// the same: one request.
//
// Everything Polar-specific ends at this file: its envelope (`{ periods,
// totals, metrics }`), its metric slugs, its aware timestamps, and its key
// variable. The rows leaving here are the canonical shape in schema.ts, and
// nothing else in the domain knows Polar exists except the one line in
// providers.ts.
//
// Auth is an organisation access token sent as a bearer token; it needs the
// `metrics:read` scope and nothing more. It comes from the environment variable
// the site's `revenue.keyVariable` names (default POLAR_API_KEY), redacted,
// never from config.json. Polar issues one token per organisation, so two
// sites sold through two organisations name two variables.
import {
  Config,
  Duration,
  Effect,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http"

import { type Provider, type ProviderFactory } from "./providers.ts"
import { type RevenueDay, RevenueError } from "./schema.ts"

// The name a site's config uses to pick this adapter.
export const providerName = "polar"

// Polar's production API, used when a site names no baseUrl; the sandbox is
// https://sandbox-api.polar.sh.
const cloudOrigin = "https://api.polar.sh"

// Polar settles and reports in US dollars; its metrics carry no currency field.
const currency = "USD"

// Polar caps a day-bucketed metrics request at this many days.
const maxSpanDays = 366

export interface Options {
  // Transient failures (no answer, 429, 5xx) are retried this many times with
  // exponential backoff. Tests pass 0.
  readonly transientRetries?: number
  readonly timeoutMs?: number
}

const defaults = {
  transientRetries: 3,
  timeoutMs: 20_000,
} satisfies Required<Options>

// --- wire shapes (loose on purpose: the metric fields are generated server-side) ---

const Period = Schema.Record(Schema.String, Schema.Unknown)
const MetricsResponse = Schema.Struct({ periods: Schema.Array(Period) })

// A count or amount as Polar sends it: a number, or null for a metric it
// could not compute. Anything else is zero rather than NaN in the ledger.
const asCount = (value: unknown): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

// A period's `timestamp` is an aware datetime at the start of its day in the
// zone asked ("2026-09-01T00:00:00+02:00"). The calendar day is taken in that
// same zone, so the row lands on the day Polar bucketed it into whether the
// instant is serialised with its offset or in UTC.
const dayIn = (timeZone: string, timestamp: unknown): string => {
  const text = typeof timestamp === "string" ? timestamp : ""
  const instant = new Date(text)
  if (Number.isNaN(instant.getTime())) return text.slice(0, 10)
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant)
  } catch {
    return text.slice(0, 10)
  }
}

// Consecutive spans of at most `maxSpanDays` days covering the sorted dates.
const spansOf = (sorted: ReadonlyArray<string>): Array<[string, string]> => {
  const spans: Array<[string, string]> = []
  let start = sorted[0]!
  for (let index = 1; index < sorted.length; index += 1) {
    const date = sorted[index]!
    const days =
      (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000
    if (days >= maxSpanDays) {
      spans.push([start, sorted[index - 1]!])
      start = date
    }
  }
  spans.push([start, sorted[sorted.length - 1]!])
  return spans
}

class TransientError extends Schema.TaggedErrorClass<TransientError>()(
  "PolarTransientError",
  {
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTransientStatus = (status: number) => status === 429 || status >= 500
const isOkStatus = (status: number) => status >= 200 && status < 300

// Build the adapter for one site. Fails (so the site reads as not ready) when
// the key is absent or blank; every other failure waits for the first fetch.
export const makeWith =
  (options: Options = {}): ProviderFactory =>
  (source) =>
    Effect.gen(function* () {
      const settings = { ...defaults, ...options }
      const keyVariable = source.keyVariable

      const apiKey = yield* Config.redacted(keyVariable).pipe(
        Config.option,
        Effect.mapError(
          (cause) =>
            new RevenueError({
              message: `${keyVariable} could not be read from the environment.`,
              cause,
            }),
        ),
      )
      if (Option.isNone(apiKey) || Redacted.value(apiKey.value).trim() === "")
        return yield* Effect.fail(
          new RevenueError({
            message:
              `${keyVariable} is not set, so Polar cannot be read for this site. ` +
              "Create an organization access token in Polar (Settings → Developers) " +
              "with the metrics:read scope and set it in the server environment.",
          }),
        )

      const httpClient = yield* HttpClient.HttpClient
      const origin = source.baseUrl ?? cloudOrigin
      const authorization = `Bearer ${Redacted.value(apiKey.value)}`

      const retrySchedule = Schedule.exponential(Duration.millis(500), 2).pipe(
        Schedule.jittered,
        Schedule.upTo({ times: settings.transientRetries }),
      )

      const decodeOk = <A>(
        schema: Schema.Codec<A, unknown>,
        response: HttpClientResponse.HttpClientResponse,
        what: string,
      ): Effect.Effect<A, RevenueError> =>
        Effect.gen(function* () {
          const status = response.status
          if (!isOkStatus(status)) {
            const message =
              status === 401 || status === 403
                ? `Polar rejected ${keyVariable} (HTTP ${status}). ` +
                  "The token may be revoked, expired, or missing the metrics:read scope."
                : status === 422
                  ? `Polar rejected the ${what} request's parameters (HTTP 422). ` +
                    "Check revenue.accountId and revenue.timeZone for this site in config.json."
                  : `Polar answered the ${what} request with HTTP ${status}.`
            return yield* Effect.fail(new RevenueError({ message }))
          }
          const json = yield* response.json.pipe(
            Effect.mapError(
              (cause) =>
                new RevenueError({
                  message: `The Polar ${what} response body could not be read.`,
                  cause,
                }),
            ),
          )
          return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError(
              (cause) =>
                new RevenueError({
                  message: `The Polar ${what} response did not match its documented shape.`,
                  cause,
                }),
            ),
          )
        })

      // One GET with the token, a timeout, and transient retries. `params`
      // may repeat a key (`metrics=orders&metrics=revenue`), hence the pairs.
      const request = <A>(
        schema: Schema.Codec<A, unknown>,
        path: string,
        params: ReadonlyArray<readonly [string, string]>,
        what: string,
      ): Effect.Effect<A, RevenueError> => {
        const url = new URL(`${origin}${path}`)
        for (const [key, value] of params) url.searchParams.append(key, value)
        return httpClient
          .execute(
            HttpClientRequest.get(url.toString()).pipe(
              HttpClientRequest.setHeader("authorization", authorization),
              HttpClientRequest.setHeader("accept", "application/json"),
            ),
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: `${settings.timeoutMs} millis`,
              orElse: () => Effect.fail(new TransientError({})),
            }),
            Effect.mapError((cause) =>
              cause instanceof TransientError
                ? cause
                : new TransientError({ cause }),
            ),
            Effect.flatMap((response) =>
              isTransientStatus(response.status)
                ? Effect.fail(new TransientError({ status: response.status }))
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: retrySchedule,
              while: (error) => error._tag === "PolarTransientError",
            }),
            Effect.mapError(
              (error) =>
                new RevenueError({
                  message:
                    error.status === undefined
                      ? `Polar at ${origin} did not answer the ${what} request.`
                      : error.status === 429
                        ? `Polar rate-limited the ${what} request (HTTP 429).`
                        : `Polar returned a server error for the ${what} request (HTTP ${error.status}).`,
                  cause: error,
                }),
            ),
            Effect.flatMap((response) => decodeOk(schema, response, what)),
          )
      }

      const spanDays = (
        start: string,
        end: string,
      ): Effect.Effect<ReadonlyArray<RevenueDay>, RevenueError> =>
        request(
          MetricsResponse,
          "/v1/metrics",
          [
            ["start_date", start],
            ["end_date", end],
            ["interval", "day"],
            ["timezone", source.timeZone],
            ["metrics", "orders"],
            ["metrics", "revenue"],
            ["metrics", "net_revenue"],
            ...(source.accountId
              ? [["organization_id", source.accountId] as const]
              : []),
          ],
          "metrics",
        ).pipe(
          Effect.map((body) =>
            body.periods.map((period) => ({
              date: dayIn(source.timeZone, period["timestamp"]),
              orders: asCount(period["orders"]),
              revenue: asCount(period["revenue"]),
              net: asCount(period["net_revenue"]),
              currency,
            })),
          ),
        )

      const provider: Provider = {
        fetchRevenue: Effect.fn("Polar.fetchRevenue")(function* (dates) {
          const sorted = [...new Set(dates)].sort()
          if (sorted.length === 0) return []
          const wanted = new Set(sorted)
          // A span with gaps fetches a few extra day rows, which is cheaper
          // than one call per run of consecutive dates; they are trimmed here.
          const spans = yield* Effect.forEach(
            spansOf(sorted),
            ([start, end]) => spanDays(start, end),
            { concurrency: 2 },
          )
          return spans.flat().filter((day) => wanted.has(day.date))
        }),
      }
      return provider
    })

export const make: ProviderFactory = makeWith()

export * as Polar from "./polar"
