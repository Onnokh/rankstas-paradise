// Polar adapter tests. No network: a fake HttpClient answers with the envelope
// Polar's metrics endpoint sends (`{ periods, totals, metrics }`) and records
// every request, so the tests pin the one call, its parameters, the auth
// header, the mapping to canonical rows, and the words each failure gets.
import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { Polar } from "./polar.ts"
import { type ProviderFactory } from "./providers.ts"
import { RevenueError, type RevenueSource } from "./schema.ts"

const source: RevenueSource = {
  provider: "polar",
  accountId: null,
  keyVariable: "POLAR_API_KEY_TEST",
  baseUrl: null,
  timeZone: "Europe/Amsterdam",
}

interface Seen {
  readonly requests: Array<{ url: URL; auth: string | undefined }>
}

type Answer = (url: URL) => { status: number; body: unknown }

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
  Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))

const fetchWith = (
  factory: ProviderFactory,
  http: Layer.Layer<HttpClient.HttpClient>,
  dates: ReadonlyArray<string>,
  env: Record<string, string> = { POLAR_API_KEY_TEST: "polar_oat_test" },
  from: RevenueSource = source,
) =>
  Effect.runPromiseExit(
    factory(from).pipe(
      Effect.flatMap((provider) => provider.fetchRevenue(dates)),
      Effect.provide(Layer.mergeAll(http, configLayer(env))),
    ),
  )

// A healthy organisation: Polar fills every day of the span, timestamps at
// local midnight with their offset, amounts in cents, a null where a metric
// could not be computed.
const healthy: Answer = (url) => {
  const start = url.searchParams.get("start_date")!
  const end = url.searchParams.get("end_date")!
  const days = ["2026-09-01", "2026-09-02", "2026-09-03"].filter(
    (day) => day >= start && day <= end,
  )
  return {
    status: 200,
    body: {
      periods: days.map((day, index) => ({
        timestamp: `${day}T00:00:00+02:00`,
        orders: index,
        revenue: index * 1999,
        net_revenue: index === 2 ? null : index * 1999,
        cumulative_revenue: 0,
      })),
      totals: { orders: 3, revenue: 5997 },
      metrics: {},
    },
  }
}

const bare = Polar.makeWith({ transientRetries: 0 })

test("one metrics call covers the span, with the token, the zone and the three metrics", async () => {
  const seen: Seen = { requests: [] }
  const exit = await fetchWith(bare, fakeHttp(seen, healthy), [
    "2026-09-03",
    "2026-09-01",
  ])

  expect(seen.requests).toHaveLength(1)
  const { url, auth } = seen.requests[0]!
  expect(url.origin).toBe("https://api.polar.sh")
  expect(url.pathname).toBe("/v1/metrics")
  expect(auth).toBe("Bearer polar_oat_test")
  expect(url.searchParams.get("start_date")).toBe("2026-09-01")
  expect(url.searchParams.get("end_date")).toBe("2026-09-03")
  expect(url.searchParams.get("interval")).toBe("day")
  expect(url.searchParams.get("timezone")).toBe("Europe/Amsterdam")
  expect(url.searchParams.getAll("metrics")).toEqual(["orders", "revenue", "net_revenue"])
  expect(url.searchParams.has("organization_id")).toBe(false)

  // The day in between was fetched (one span) but not asked for, so it is
  // dropped; a null net reads as zero rather than NaN.
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isSuccess(exit))
    expect(exit.value).toEqual([
      { date: "2026-09-01", orders: 0, revenue: 0, net: 0, currency: "USD" },
      { date: "2026-09-03", orders: 2, revenue: 3998, net: 0, currency: "USD" },
    ])
})

test("an account id becomes the organization filter, a base URL the origin", async () => {
  const seen: Seen = { requests: [] }
  await fetchWith(bare, fakeHttp(seen, healthy), ["2026-09-02"], undefined, {
    ...source,
    accountId: "org_123",
    baseUrl: "https://sandbox-api.polar.sh",
  })
  const { url } = seen.requests[0]!
  expect(url.origin).toBe("https://sandbox-api.polar.sh")
  expect(url.searchParams.get("organization_id")).toBe("org_123")
})

test("a UTC-serialised timestamp still lands on the day Polar bucketed it into", async () => {
  const seen: Seen = { requests: [] }
  // Midnight Amsterdam on 2 September is 22:00 UTC on 1 September.
  const answer: Answer = () => ({
    status: 200,
    body: {
      periods: [{ timestamp: "2026-09-01T22:00:00Z", orders: 1, revenue: 500, net_revenue: 500 }],
    },
  })
  const exit = await fetchWith(bare, fakeHttp(seen, answer), ["2026-09-02"])
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isSuccess(exit))
    expect(exit.value).toEqual([
      { date: "2026-09-02", orders: 1, revenue: 500, net: 500, currency: "USD" },
    ])
})

test("no dates means no call", async () => {
  const seen: Seen = { requests: [] }
  const exit = await fetchWith(bare, fakeHttp(seen, healthy), [])
  expect(seen.requests).toHaveLength(0)
  expect(Exit.isSuccess(exit) && exit.value).toEqual([])
})

test("a missing or blank key fails at build time with instructions", async () => {
  const seen: Seen = { requests: [] }
  const envs: Array<Record<string, string>> = [{}, { POLAR_API_KEY_TEST: "  " }]
  for (const env of envs) {
    const exit = await fetchWith(bare, fakeHttp(seen, healthy), ["2026-09-01"], env)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.isFailure(exit) ? exit.cause : undefined
      expect(String(error)).toContain("POLAR_API_KEY_TEST is not set")
      expect(String(error)).toContain("metrics:read")
    }
  }
  expect(seen.requests).toHaveLength(0)
})

test("a rejected token, bad parameters and a server error each get their own words", async () => {
  const cases: Array<[number, string]> = [
    [401, "rejected POLAR_API_KEY_TEST"],
    [403, "metrics:read"],
    [422, "revenue.accountId"],
    [500, "server error"],
  ]
  for (const [status, words] of cases) {
    const seen: Seen = { requests: [] }
    const exit = await fetchWith(
      bare,
      fakeHttp(seen, () => ({ status, body: { detail: "no" } })),
      ["2026-09-01"],
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const message = String(exit.cause)
      expect(message).toContain("RevenueError")
      expect(message).toContain(words)
    }
  }
})

test("a body that is not Polar's shape is a RevenueError, not a crash", async () => {
  const seen: Seen = { requests: [] }
  const exit = await fetchWith(
    bare,
    fakeHttp(seen, () => ({ status: 200, body: { nope: [] } })),
    ["2026-09-01"],
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(String(exit.cause)).toContain("did not match its documented shape")
    expect(String(exit.cause)).toContain(new RevenueError({ message: "" })._tag)
  }
})

test("a span longer than Polar's day limit is split into several calls", async () => {
  const seen: Seen = { requests: [] }
  const answer: Answer = () => ({ status: 200, body: { periods: [] } })
  const exit = await fetchWith(bare, fakeHttp(seen, answer), [
    "2025-01-01",
    "2026-01-02",
    "2026-06-01",
  ])
  expect(Exit.isSuccess(exit)).toBe(true)
  const spans = seen.requests
    .map(({ url }) => [url.searchParams.get("start_date"), url.searchParams.get("end_date")])
    .sort()
  expect(spans).toEqual([
    ["2025-01-01", "2025-01-01"],
    ["2026-01-02", "2026-06-01"],
  ])
})
