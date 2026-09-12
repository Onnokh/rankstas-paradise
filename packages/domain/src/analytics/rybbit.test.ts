// Rybbit adapter tests. No network: a fake HttpClient answers by URL with the
// exact envelopes Rybbit's server sends (`{ data: [...] }` around a series,
// `{ data: { data, totalCount } }` around a metric page) and records every
// request, so the tests pin the three calls, their parameters, the auth header,
// the mapping to canonical rows, pagination, and the words each failure gets.
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { type ProviderFactory } from "./providers.ts"
import { Rybbit } from "./rybbit.ts"
import { AnalyticsError, type AnalyticsSource } from "./schema.ts"

const source: AnalyticsSource = {
  provider: "rybbit",
  siteId: "12",
  baseUrl: "https://rybbit.example.com",
  timeZone: "Europe/Amsterdam",
}

interface Seen {
  readonly requests: Array<{ url: URL; auth: string | undefined }>
}

type Answer = (url: URL) => { status: number; body: unknown }

// Rybbit's wire envelopes, built the way the server's route handlers send them.
const seriesEnvelope = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  data: rows,
})
const metricEnvelope = (
  rows: ReadonlyArray<Record<string, unknown>>,
  totalCount: unknown = rows.length,
) => ({ data: { data: rows, totalCount } })

const fakeHttp = (seen: Seen, answer: Answer) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url)
      seen.requests.push({ url, auth: request.headers["authorization"] })
      const { status, body } = answer(url)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    }),
  )

const configLayer = (env: Record<string, string>) =>
  Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnv({ env }),
  )

// Build the adapter and run one fetch against it.
const fetchWith = (
  factory: ProviderFactory,
  http: Layer.Layer<HttpClient.HttpClient>,
  dates: ReadonlyArray<string>,
  env: Record<string, string> = { RYBBIT_API_KEY: "rb_org_test" },
) =>
  Effect.runPromiseExit(
    factory(source).pipe(
      Effect.flatMap((provider) => provider.fetchVisits(dates)),
      Effect.provide(Layer.mergeAll(http, configLayer(env))),
    ),
  )

// A healthy instance: a flat day of visits, two pages, one event, for any date,
// and three people on the site right now.
const healthy: Answer = (url) => {
  if (url.pathname.endsWith("/live-user-count"))
    // Three people over the whole window, one of them in the last few minutes.
    return {
      status: 200,
      body: { count: url.searchParams.get("minutes") === "5" ? "1" : "3" },
    }
  if (url.searchParams.get("bucket") === "hour")
    return {
      status: 200,
      body: seriesEnvelope([
        { time: "2026-09-07 00:00:00", users: 0, sessions: 0, pageviews: 0 },
        { time: "2026-09-07 09:00:00", users: "2", sessions: 2, pageviews: 3 },
        // A neighbouring day's bucket, which the adapter must drop.
        { time: "2026-09-06 23:00:00", users: 9, sessions: 9, pageviews: 9 },
      ]),
    }
  if (url.searchParams.get("bucket") === "minute")
    return {
      status: 200,
      // Out of order on purpose: the adapter sorts by time.
      body: seriesEnvelope([
        { time: "2026-09-07 19:02:00", users: 2, sessions: 2, pageviews: 5 },
        { time: "2026-09-07 19:00:00", users: 1, sessions: 1, pageviews: 1 },
        { time: "2026-09-07 19:01:00", users: 0, sessions: 0, pageviews: 0 },
      ]),
    }
  if (url.pathname.endsWith("/events"))
    return {
      status: 200,
      // Newest first, as Rybbit sends them; the middle row is out of order on
      // purpose. ClickHouse's "YYYY-MM-DD HH:MM:SS.mmm" in UTC, props as JSON text.
      body: {
        data: [
          {
            timestamp: "2026-09-08 10:13:40.120",
            type: "pageview",
            event_name: "",
            properties: "{}",
            user_id: "u-1",
            pathname: "/shaders/julia",
            country: "DE",
            browser: "Chrome",
            operating_system: "macOS",
            device_type: "Desktop",
            referrer: "",
          },
          {
            timestamp: "2026-09-08 10:12:47.000",
            type: "outbound",
            event_name: "",
            properties: '{"url":"https://github.com/x","text":"GitHub"}',
            user_id: "u-1",
            pathname: "/pricing",
            country: "DE",
            browser: "Chrome",
            operating_system: "macOS",
            device_type: "Desktop",
            referrer: "https://x.com/",
          },
          {
            timestamp: "2026-09-08 10:13:05.500",
            type: "custom_event",
            event_name: "purchase",
            properties: '{"plan":"pro","amount":29,"meta":{"a":1}}',
            user_id: "u-2",
            pathname: "",
            country: "",
            browser: "Firefox",
            operating_system: "Windows",
            device_type: "Desktop",
            referrer: null,
          },
        ],
      },
    }
  if (url.pathname.endsWith("/users"))
    return {
      status: 200,
      // The flat page `/users` sends, most recently seen first. ClickHouse
      // quotes the session count of the first row and leaves the second bare;
      // the third is a first-time visitor, and the fourth has no device id.
      body: {
        data: [
          {
            user_id: "u-1",
            sessions: "7",
            pageviews: 31,
            events: 2,
            first_seen: "2026-08-12 08:04:11",
            last_seen: "2026-09-08 10:13:40",
            country: "DE",
          },
          {
            user_id: "u-2",
            sessions: 1,
            pageviews: 1,
            events: 0,
            first_seen: "2026-09-08 10:13:05",
            last_seen: "2026-09-08 10:13:05",
            country: "",
          },
          {
            user_id: "u-3",
            sessions: 2,
            first_seen: "",
            last_seen: "",
          },
          { user_id: "", sessions: 99, first_seen: "", last_seen: "" },
        ],
        totalCount: 4,
        page: 1,
        pageSize: 200,
      },
    }
  if (url.pathname.endsWith("/overview/time-series")) {
    const start = url.searchParams.get("start_date")!
    const end = url.searchParams.get("end_date")!
    // Rybbit fills every bucket of the span; here the span is at most 3 days.
    const days = ["2026-09-01", "2026-09-02", "2026-09-03"].filter(
      (day) => day >= start && day <= end,
    )
    return {
      status: 200,
      body: seriesEnvelope(
        days.map((day) => ({
          time: `${day} 00:00:00`,
          // ClickHouse may quote 64-bit integers: sessions arrives as a string.
          sessions: "60",
          pageviews: 100,
          users: 50,
          bounce_rate: 42.1,
        })),
      ),
    }
  }
  const parameter = url.searchParams.get("parameter")
  if (parameter === "pathname")
    return {
      status: 200,
      body: metricEnvelope([
        { value: "/pricing", count: 25, pageviews: 40, percentage: 41.6 },
        { value: "/", count: 20, pageviews: 30, percentage: 33.3 },
        // Rybbit never sends an empty pathname, but a row without a value must
        // not become a page called "".
        { value: "", count: 1, pageviews: 1 },
      ]),
    }
  if (parameter === "event_name")
    return {
      status: 200,
      body: metricEnvelope([{ value: "purchase", count: 2, percentage: 100 }]),
    }
  return { status: 404, body: { error: "unknown route" } }
}

const noRetries = Rybbit.makeWith({ transientRetries: 0, concurrency: 1 })

test("fetches the series once and the two metrics once per day, with the key", async () => {
  const seen: Seen = { requests: [] }
  const exit = await fetchWith(
    noRetries,
    fakeHttp(seen, healthy),
    ["2026-09-03", "2026-09-01"],
  )

  expect(Exit.isSuccess(exit)).toBe(true)
  // 1 time-series + 2 days × (pathname + event_name) = 5 requests, all bearer.
  expect(seen.requests).toHaveLength(5)
  for (const { auth } of seen.requests) expect(auth).toBe("Bearer rb_org_test")

  const series = seen.requests.find((r) => r.url.pathname.endsWith("/time-series"))!
  // Under the configured instance and site, spanning the sorted dates, in the
  // site's zone.
  expect(series.url.origin).toBe("https://rybbit.example.com")
  expect(series.url.pathname).toBe("/api/sites/12/overview/time-series")
  expect(series.url.searchParams.get("bucket")).toBe("day")
  expect(series.url.searchParams.get("start_date")).toBe("2026-09-01")
  expect(series.url.searchParams.get("end_date")).toBe("2026-09-03")
  expect(series.url.searchParams.get("time_zone")).toBe("Europe/Amsterdam")

  // Each metric call covers exactly one day: the endpoint sums over its range.
  const metrics = seen.requests.filter((r) => r.url.pathname.endsWith("/metric"))
  expect(metrics).toHaveLength(4)
  for (const { url } of metrics) {
    expect(url.searchParams.get("start_date")).toBe(url.searchParams.get("end_date"))
    expect(url.searchParams.get("time_zone")).toBe("Europe/Amsterdam")
    expect(url.searchParams.get("limit")).toBe("500")
  }
  expect(
    metrics.map((r) => r.url.searchParams.get("parameter")).sort(),
  ).toEqual(["event_name", "event_name", "pathname", "pathname"])
})

test("maps Rybbit's rows to the canonical shapes and keeps only the days asked", async () => {
  const seen: Seen = { requests: [] }
  const exit = await fetchWith(
    noRetries,
    fakeHttp(seen, healthy),
    ["2026-09-01", "2026-09-03"],
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")
  const visits = exit.value

  // The series spans 1..3 but the 2nd was not asked for, so it is dropped;
  // `sessions` arrived as a string and is a number here.
  expect(visits.site).toEqual([
    { date: "2026-09-01", pageviews: 100, visits: 60, visitors: 50 },
    { date: "2026-09-03", pageviews: 100, visits: 60, visitors: 50 },
  ])
  // pathname: `count` is sessions → visits; the empty value is skipped.
  expect(visits.pages.filter((row) => row.date === "2026-09-01")).toEqual([
    { date: "2026-09-01", page: "/pricing", pageviews: 40, visits: 25 },
    { date: "2026-09-01", page: "/", pageviews: 30, visits: 20 },
  ])
  expect(visits.pages).toHaveLength(4)
  // event_name: `count` is occurrences.
  expect(visits.events).toEqual([
    { date: "2026-09-01", name: "purchase", count: 2 },
    { date: "2026-09-03", name: "purchase", count: 2 },
  ])
})

test("follows totalCount across metric pages", async () => {
  const seen: Seen = { requests: [] }
  const paged: Answer = (url) => {
    if (url.pathname.endsWith("/time-series"))
      return { status: 200, body: seriesEnvelope([]) }
    if (url.searchParams.get("parameter") === "event_name")
      return { status: 200, body: metricEnvelope([]) }
    // Three pathname rows, two per page: page 1 → two rows, page 2 → one.
    const page = url.searchParams.get("page")
    const rows =
      page === "1"
        ? [
            { value: "/a", count: 3, pageviews: 3 },
            { value: "/b", count: 2, pageviews: 2 },
          ]
        : [{ value: "/c", count: 1, pageviews: 1 }]
    return { status: 200, body: metricEnvelope(rows, "3") }
  }
  const exit = await fetchWith(
    Rybbit.makeWith({ transientRetries: 0, pageSize: 2 }),
    fakeHttp(seen, paged),
    ["2026-09-01"],
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  expect(exit.value.pages.map((row) => row.page)).toEqual(["/a", "/b", "/c"])
  const pathnameCalls = seen.requests.filter(
    (r) => r.url.searchParams.get("parameter") === "pathname",
  )
  expect(pathnameCalls.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2"])
  expect(pathnameCalls[0]!.url.searchParams.get("limit")).toBe("2")
})

test("live visitors ask live-user-count twice and a minute series for the window", async () => {
  const seen: Seen = { requests: [] }
  const exit = await Effect.runPromiseExit(
    noRetries(source).pipe(
      Effect.flatMap((provider) => provider.liveVisitors(30, 5)),
      Effect.provide(
        Layer.mergeAll(fakeHttp(seen, healthy), configLayer({ RYBBIT_API_KEY: "k" })),
      ),
    ),
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  expect(exit.value.visitors).toBe(3)
  expect(exit.value.online).toBe(1)
  // Sorted by time, users per minute.
  expect(exit.value.perMinute).toEqual([1, 0, 2])
  expect(seen.requests).toHaveLength(3)
  const counts = seen.requests.filter((r) => r.url.pathname.endsWith("/live-user-count"))
  expect(counts.map((r) => r.url.pathname)).toEqual([
    "/api/sites/12/live-user-count",
    "/api/sites/12/live-user-count",
  ])
  expect(counts.map((r) => r.url.searchParams.get("minutes")).sort()).toEqual(["30", "5"])
  expect(counts.every((r) => r.auth === "Bearer k")).toBe(true)
  const series = seen.requests.find((r) => r.url.pathname.endsWith("/time-series"))!
  expect(series.url.searchParams.get("bucket")).toBe("minute")
  expect(series.url.searchParams.get("past_minutes_start")).toBe("30")
  expect(series.url.searchParams.get("past_minutes_end")).toBe("0")
  // A trailing window carries no dates: Rybbit takes one form or the other.
  expect(series.url.searchParams.get("start_date")).toBeNull()
})

test("live events ask /events since the window start and map rows newest first", async () => {
  const seen: Seen = { requests: [] }
  const before = Date.now()
  const exit = await Effect.runPromiseExit(
    noRetries(source).pipe(
      Effect.flatMap((provider) => provider.liveEvents(30, 500)),
      Effect.provide(
        Layer.mergeAll(fakeHttp(seen, healthy), configLayer({ RYBBIT_API_KEY: "k" })),
      ),
    ),
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  expect(seen.requests).toHaveLength(1)
  const call = seen.requests[0]!
  expect(call.url.pathname).toBe("/api/sites/12/events")
  expect(call.auth).toBe("Bearer k")
  // ClickHouse's own form, UTC, about thirty minutes ago.
  const since = call.url.searchParams.get("since_timestamp")!
  expect(since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
  const sinceMs = new Date(`${since.replace(" ", "T")}Z`).getTime()
  expect(before - sinceMs).toBeGreaterThanOrEqual(30 * 60_000 - 5)
  expect(before - sinceMs).toBeLessThan(30 * 60_000 + 5_000)

  const events = exit.value
  expect(events.map((event) => event.at)).toEqual([
    "2026-09-08T10:13:40.120Z",
    "2026-09-08T10:13:05.500Z",
    "2026-09-08T10:12:47.000Z",
  ])
  expect(events.map((event) => event.kind)).toEqual(["pageview", "event", "outbound"])
  // A pageview has no name; a custom event carries its own; an empty path is "/".
  expect(events[0]!.name).toBeNull()
  expect(events[1]!.name).toBe("purchase")
  expect(events[1]!.page).toBe("/")
  // Properties flattened to strings, nested ones kept as JSON; blanks are null.
  expect(events[1]!.properties).toEqual({ plan: "pro", amount: "29", meta: '{"a":1}' })
  expect(events[2]!.properties).toEqual({ url: "https://github.com/x", text: "GitHub" })
  expect(events[1]!.country).toBeNull()
  expect(events[0]!.referrer).toBeNull()
  expect(events[2]!.referrer).toBe("https://x.com/")
  expect(events[0]!.device).toBe("Desktop")
  expect(events[0]!.visitor).toBe("u-1")
  // Ids are stable and distinct.
  expect(new Set(events.map((event) => event.id)).size).toBe(3)
  expect(events[0]!.id).toMatch(/^[0-9a-f]{8}$/)
})

test("live events honour a lower cap", async () => {
  const seen: Seen = { requests: [] }
  const exit = await Effect.runPromiseExit(
    noRetries(source).pipe(
      Effect.flatMap((provider) => provider.liveEvents(30, 2)),
      Effect.provide(
        Layer.mergeAll(fakeHttp(seen, healthy), configLayer({ RYBBIT_API_KEY: "k" })),
      ),
    ),
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")
  expect(exit.value.map((event) => event.at)).toEqual([
    "2026-09-08T10:13:40.120Z",
    "2026-09-08T10:13:05.500Z",
  ])
})

test("visitor histories ask /users for the most recent people, over all time", async () => {
  const seen: Seen = { requests: [] }
  const exit = await Effect.runPromiseExit(
    noRetries(source).pipe(
      Effect.flatMap((provider) => provider.visitorHistory!(200)),
      Effect.provide(
        Layer.mergeAll(fakeHttp(seen, healthy), configLayer({ RYBBIT_API_KEY: "k" })),
      ),
    ),
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")

  expect(seen.requests).toHaveLength(1)
  const call = seen.requests[0]!
  expect(call.url.pathname).toBe("/api/sites/12/users")
  expect(call.auth).toBe("Bearer k")
  expect(call.url.searchParams.get("sort_by")).toBe("last_seen")
  expect(call.url.searchParams.get("sort_order")).toBe("desc")
  expect(call.url.searchParams.get("page_size")).toBe("200")
  // No window at all: Rybbit reads that as all time, which is the whole point
  // of the count. A date here would make every visitor look new.
  expect(call.url.searchParams.get("start_date")).toBeNull()
  expect(call.url.searchParams.get("end_date")).toBeNull()
  expect(call.url.searchParams.get("past_minutes_start")).toBeNull()

  // The row without a user id is dropped: it can join to no feed row.
  expect(exit.value.map((history) => history.visitor)).toEqual(["u-1", "u-2", "u-3"])
  // A quoted count and a bare one both arrive as numbers.
  expect(exit.value.map((history) => history.visits)).toEqual([7, 1, 2])
  expect(exit.value[0]!.firstSeen).toBe("2026-08-12T08:04:11.000Z")
  expect(exit.value[0]!.lastSeen).toBe("2026-09-08T10:13:40.000Z")
  // Blank instants are null, and the count still comes through.
  expect(exit.value[2]!.firstSeen).toBeNull()
  expect(exit.value[2]!.lastSeen).toBeNull()
  expect(exit.value[2]!.visits).toBe(2)
})

test("hours ask one hourly time-series for the day in the site's zone", async () => {
  const seen: Seen = { requests: [] }
  const exit = await Effect.runPromiseExit(
    noRetries(source).pipe(
      Effect.flatMap((provider) => provider.fetchHours("2026-09-07")),
      Effect.provide(
        Layer.mergeAll(fakeHttp(seen, healthy), configLayer({ RYBBIT_API_KEY: "k" })),
      ),
    ),
  )
  if (!Exit.isSuccess(exit)) throw new Error("expected success")
  expect(exit.value).toEqual([
    { hour: 0, pageviews: 0, visits: 0, visitors: 0 },
    { hour: 9, pageviews: 3, visits: 2, visitors: 2 },
  ])
  expect(seen.requests).toHaveLength(1)
  const params = seen.requests[0]!.url.searchParams
  expect(params.get("bucket")).toBe("hour")
  expect(params.get("start_date")).toBe("2026-09-07")
  expect(params.get("end_date")).toBe("2026-09-07")
  expect(params.get("time_zone")).toBe("Europe/Amsterdam")
})

test("an empty date list makes no request", async () => {
  const seen: Seen = { requests: [] }
  const exit = await fetchWith(noRetries, fakeHttp(seen, healthy), [])
  expect(Exit.isSuccess(exit)).toBe(true)
  expect(seen.requests).toHaveLength(0)
})

test("no key, or a blank key, fails at build time and names the variable", async () => {
  const envs: Array<Record<string, string>> = [{}, { RYBBIT_API_KEY: "  " }]
  for (const env of envs) {
    const seen: Seen = { requests: [] }
    const exit = await Effect.runPromiseExit(
      noRetries(source).pipe(
        Effect.provide(Layer.mergeAll(fakeHttp(seen, healthy), configLayer(env))),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.isFailure(exit) ? exit.cause : null
      expect(String(error)).toContain("RYBBIT_API_KEY")
    }
    expect(seen.requests).toHaveLength(0)
  }
})

const failWith = (status: number): Answer => () => ({
  status,
  body: { error: "nope" },
})

const messageOf = (exit: Exit.Exit<unknown, AnalyticsError>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  return String(exit.cause)
}

test("a rejected key names the key and the site", async () => {
  const exit = await fetchWith(noRetries, fakeHttp({ requests: [] }, failWith(401)), ["2026-09-01"])
  const message = messageOf(exit)
  expect(message).toContain("RYBBIT_API_KEY")
  expect(message).toContain('"12"')
  expect(message).toContain("401")
})

test("an unknown site points at analytics.siteId", async () => {
  const exit = await fetchWith(noRetries, fakeHttp({ requests: [] }, failWith(404)), ["2026-09-01"])
  const message = messageOf(exit)
  expect(message).toContain("analytics.siteId")
  expect(message).toContain("rybbit.example.com")
})

test("a server error is reported as Rybbit's, not as no data", async () => {
  const exit = await fetchWith(noRetries, fakeHttp({ requests: [] }, failWith(503)), ["2026-09-01"])
  expect(messageOf(exit)).toContain("HTTP 503")
})

test("a body that is not Rybbit's shape is a decode failure, not a crash", async () => {
  const odd: Answer = () => ({ status: 200, body: { data: "surprise" } })
  const exit = await fetchWith(noRetries, fakeHttp({ requests: [] }, odd), ["2026-09-01"])
  expect(messageOf(exit)).toContain("documented shape")
})
