// Rybbit adapter: the first analytics provider behind the port in analytics.ts.
//
// Rybbit's Stats API is read with three calls, all under
// `/api/sites/:site` on the instance named by the site's `baseUrl` (or Rybbit's
// cloud when there is none):
//
//   - `GET /overview/time-series?bucket=day` for the site totals — one call for
//     the whole span of dates asked, its rows then trimmed to those dates;
//   - `GET /metric?parameter=pathname` for the per-page breakdown — one call
//     PER DAY (start_date = end_date), paginated, because the metric endpoint
//     sums over its range and has no day dimension;
//   - `GET /metric?parameter=event_name` for event counts, the same way. For
//     this parameter Rybbit's `count` is the number of occurrences, not sessions;
//   - `GET /live-user-count?minutes=N` for the people active right now, and
//     `GET /overview/time-series?bucket=minute&past_minutes_start=N` for how
//     many were seen in each of those minutes.
//
// Everything Rybbit-specific ends at this file: its envelope (`{ data }` around
// the series, `{ data: { data, totalCount } }` around a metric page), its column
// names (`sessions`, `users`, `count`), and its key variable. The rows leaving
// here are the canonical shapes in schema.ts, and nothing else in the domain
// knows Rybbit exists except the one line in providers.ts.
//
// Auth is an organisation API key sent as a bearer token; it comes from
// RYBBIT_API_KEY in the environment, redacted, never from config.json. The API
// is marked beta by Rybbit, which is one more reason the wire shapes are decoded
// loosely here (ClickHouse may serialise big counts as strings) and mapped
// once, rather than trusted anywhere else.
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
import {
  AnalyticsError,
  type EventCountDay,
  type PageVisitsDay,
  type SiteVisitsDay,
  type VisitsDays,
} from "./schema.ts"

// The name a site's config uses to pick this adapter, and the environment
// variable that holds its key.
export const providerName = "rybbit"
export const apiKeyVariable = "RYBBIT_API_KEY"

// Rybbit's hosted instance, used when a site names no baseUrl.
const cloudOrigin = "https://app.rybbit.io"

export interface Options {
  // Rows per metric page. Rybbit does not cap `limit`; 500 keeps a busy site's
  // day to one or two calls without asking ClickHouse for everything at once.
  readonly pageSize?: number
  // Transient failures (no answer, 429, 5xx) are retried this many times with
  // exponential backoff. Tests pass 0.
  readonly transientRetries?: number
  // Days fetched at once. Self-hosted instances are not rate limited; the cloud
  // allows a burst of 50 and refills at 5/s, which four in flight stay under.
  readonly concurrency?: number
  readonly timeoutMs?: number
}

const defaults = {
  pageSize: 500,
  transientRetries: 3,
  concurrency: 4,
  timeoutMs: 20_000,
} satisfies Required<Options>

// --- wire shapes (loose on purpose; see the header) ---

const Row = Schema.Record(Schema.String, Schema.Unknown)
const TimeSeriesResponse = Schema.Struct({ data: Schema.Array(Row) })
const MetricResponse = Schema.Struct({
  data: Schema.Struct({
    data: Schema.Array(Row),
    totalCount: Schema.Unknown,
  }),
})
const LiveCountResponse = Schema.Struct({ count: Schema.Unknown })

// A count as Rybbit sends it — a number, or a numeric string when ClickHouse
// quotes a 64-bit integer. Anything else is zero rather than NaN in the ledger.
const asCount = (value: unknown): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

const asText = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : String(value)

// A bucket's `time` is "YYYY-MM-DD HH:MM:SS" in the requested zone; the date
// is its first ten characters, the hour the two after the space.
const dayOf = (time: unknown): string => asText(time).slice(0, 10)
const hourOf = (time: unknown): number => asCount(asText(time).slice(11, 13))

// A failure worth retrying: no answer at all, or a 429/5xx. Internal to this
// file — the port's one error class is what leaves it.
class TransientError extends Schema.TaggedErrorClass<TransientError>()(
  "RybbitTransientError",
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

      // Redacted so the key cannot reach a log line or an error message. A
      // blank value counts as absent, for the reason DomainRating gives.
      const apiKey = yield* Config.redacted(apiKeyVariable).pipe(
        Config.option,
        Effect.mapError(
          (cause) =>
            new AnalyticsError({
              message: `${apiKeyVariable} could not be read from the environment.`,
              cause,
            }),
        ),
      )
      if (Option.isNone(apiKey) || Redacted.value(apiKey.value).trim() === "")
        return yield* Effect.fail(
          new AnalyticsError({
            message:
              `${apiKeyVariable} is not set, so Rybbit cannot be read for this site. ` +
              "Create an organisation API key in Rybbit (Settings → Organization → " +
              "Organization API Keys) and set it in the server environment.",
          }),
        )

      const httpClient = yield* HttpClient.HttpClient
      const origin = source.baseUrl ?? cloudOrigin
      const siteBase = `${origin}/api/sites/${encodeURIComponent(source.siteId)}`
      const authorization = `Bearer ${Redacted.value(apiKey.value)}`

      const retrySchedule = Schedule.exponential(Duration.millis(500), 2).pipe(
        Schedule.jittered,
        Schedule.upTo({ times: settings.transientRetries }),
      )

      // Classify a settled response and decode its body. 401/403 and 404 get
      // their own words because their fixes differ: the key vs. the site id.
      const decodeOk = <A>(
        schema: Schema.Codec<A, unknown>,
        response: HttpClientResponse.HttpClientResponse,
        what: string,
      ): Effect.Effect<A, AnalyticsError> =>
        Effect.gen(function* () {
          const status = response.status
          if (!isOkStatus(status)) {
            const message =
              status === 401 || status === 403
                ? `Rybbit rejected ${apiKeyVariable} for site "${source.siteId}" (HTTP ${status}). ` +
                  "The key may be revoked, or belong to an organisation that does not own this site."
                : status === 404
                  ? `Rybbit at ${origin} has no site "${source.siteId}" (HTTP 404). ` +
                    "Check analytics.siteId for this site in config.json."
                  : `Rybbit answered the ${what} request with HTTP ${status}.`
            return yield* Effect.fail(new AnalyticsError({ message }))
          }
          const json = yield* response.json.pipe(
            Effect.mapError(
              (cause) =>
                new AnalyticsError({
                  message: `The Rybbit ${what} response body could not be read.`,
                  cause,
                }),
            ),
          )
          return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError(
              (cause) =>
                new AnalyticsError({
                  message: `The Rybbit ${what} response did not match its documented shape.`,
                  cause,
                }),
            ),
          )
        })

      // One GET under the site, with the key, a timeout, and transient retries.
      const request = <A>(
        schema: Schema.Codec<A, unknown>,
        path: string,
        params: Record<string, string>,
        what: string,
      ): Effect.Effect<A, AnalyticsError> => {
        const url = new URL(`${siteBase}${path}`)
        for (const [key, value] of Object.entries(params))
          url.searchParams.set(key, value)
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
              while: (error) => error._tag === "RybbitTransientError",
            }),
            Effect.mapError(
              (error) =>
                new AnalyticsError({
                  message:
                    error.status === undefined
                      ? `Rybbit at ${origin} did not answer the ${what} request.`
                      : error.status === 429
                        ? `Rybbit rate-limited the ${what} request (HTTP 429).`
                        : `Rybbit returned a server error for the ${what} request (HTTP ${error.status}).`,
                  cause: error,
                }),
            ),
            Effect.flatMap((response) => decodeOk(schema, response, what)),
          )
      }

      // Site totals: one time-series call over the span, trimmed to the dates
      // asked. A span with gaps fetches a few extra day rows, which is cheaper
      // than one call per run of consecutive dates.
      const siteDays = (
        sorted: ReadonlyArray<string>,
      ): Effect.Effect<ReadonlyArray<SiteVisitsDay>, AnalyticsError> =>
        request(
          TimeSeriesResponse,
          "/overview/time-series",
          {
            bucket: "day",
            start_date: sorted[0]!,
            end_date: sorted[sorted.length - 1]!,
            time_zone: source.timeZone,
          },
          "time-series",
        ).pipe(
          Effect.map((body) => {
            const wanted = new Set(sorted)
            return body.data
              .map((row) => ({
                date: dayOf(row["time"]),
                pageviews: asCount(row["pageviews"]),
                visits: asCount(row["sessions"]),
                visitors: asCount(row["users"]),
              }))
              .filter((day) => wanted.has(day.date))
          }),
        )

      // Every row of one metric for one day, following totalCount across pages.
      const metricRows = (
        parameter: "pathname" | "event_name",
        date: string,
      ): Effect.Effect<ReadonlyArray<Record<string, unknown>>, AnalyticsError> =>
        Effect.gen(function* () {
          const rows: Array<Record<string, unknown>> = []
          for (let page = 1; ; page += 1) {
            const body = yield* request(
              MetricResponse,
              "/metric",
              {
                parameter,
                start_date: date,
                end_date: date,
                time_zone: source.timeZone,
                limit: String(settings.pageSize),
                page: String(page),
              },
              `${parameter} metric`,
            )
            rows.push(...body.data.data)
            const total = asCount(body.data.totalCount)
            if (body.data.data.length === 0 || rows.length >= total) break
          }
          return rows
        })

      const provider: Provider = {
        fetchHours: Effect.fn("Rybbit.fetchHours")(function* (date) {
          // One day, one bucket per hour, in the site's zone. Rybbit fills the
          // day's 24 buckets; the port pads whatever is missing.
          const body = yield* request(
            TimeSeriesResponse,
            "/overview/time-series",
            {
              bucket: "hour",
              start_date: date,
              end_date: date,
              time_zone: source.timeZone,
            },
            "hourly time-series",
          )
          return body.data
            .filter((row) => dayOf(row["time"]) === date)
            .map((row) => ({
              hour: hourOf(row["time"]),
              pageviews: asCount(row["pageviews"]),
              visits: asCount(row["sessions"]),
              visitors: asCount(row["users"]),
            }))
        }),
        liveVisitors: Effect.fn("Rybbit.liveVisitors")(function* (windowMinutes, onlineMinutes) {
          // Rybbit's live-user-count takes one window per call, so the whole
          // window and the "online" window are two calls, made together with
          // the minute series. The series is the trailing window, one bucket
          // per minute: Rybbit fills quiet minutes with zero rows and orders
          // by time, so the rows are taken as they come; the port pads or
          // trims to the window's length.
          const [count, online, series] = yield* Effect.all(
            [
              request(
                LiveCountResponse,
                "/live-user-count",
                { minutes: String(windowMinutes) },
                "live-user-count",
              ),
              request(
                LiveCountResponse,
                "/live-user-count",
                { minutes: String(onlineMinutes) },
                "live-user-count (online)",
              ),
              request(
                TimeSeriesResponse,
                "/overview/time-series",
                {
                  bucket: "minute",
                  past_minutes_start: String(windowMinutes),
                  past_minutes_end: "0",
                },
                "live time-series",
              ),
            ],
            { concurrency: 3 },
          )
          return {
            visitors: asCount(count.count),
            online: asCount(online.count),
            perMinute: [...series.data]
              .sort((left, right) => asText(left["time"]).localeCompare(asText(right["time"])))
              .map((row) => asCount(row["users"])),
          }
        }),
        fetchVisits: Effect.fn("Rybbit.fetchVisits")(function* (dates) {
          const sorted = [...new Set(dates)].sort()
          if (sorted.length === 0) return { site: [], pages: [], events: [] }

          const site = yield* siteDays(sorted)
          const perDay = yield* Effect.forEach(
            sorted,
            (date) =>
              Effect.gen(function* () {
                const pageRows = yield* metricRows("pathname", date)
                const eventRows = yield* metricRows("event_name", date)
                return { date, pageRows, eventRows }
              }),
            { concurrency: settings.concurrency },
          )

          const pages: Array<PageVisitsDay> = []
          const events: Array<EventCountDay> = []
          for (const { date, pageRows, eventRows } of perDay) {
            for (const row of pageRows) {
              const page = asText(row["value"])
              if (!page) continue
              pages.push({
                date,
                page,
                pageviews: asCount(row["pageviews"]),
                // For pathname, Rybbit's `count` is distinct sessions: a visit.
                visits: asCount(row["count"]),
              })
            }
            for (const row of eventRows) {
              const name = asText(row["value"])
              if (!name) continue
              // For event_name, `count` is the number of occurrences.
              events.push({ date, name, count: asCount(row["count"]) })
            }
          }

          return { site, pages, events } satisfies VisitsDays
        }),
      }
      return provider
    })

export const make: ProviderFactory = makeWith()

export * as Rybbit from "./rybbit"
