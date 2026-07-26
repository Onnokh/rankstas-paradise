// BingWebmaster client tests. No network: a fake HttpClient returns canned
// responses so we can pin .NET date parsing, the "d" envelope, ErrorCode-based
// auth classification, and transient retry behaviour.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { ConfigProvider } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { BingWebmaster, parseDotNetDate } from "./bing-webmaster.ts"
import {
  BingAuthError,
  BingHttpError,
  type BingError,
} from "./schema.ts"

const site = Schema.decodeUnknownSync(Site)({
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: [],
})

const jsonResponse = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const fakeHttp = (handler: (href: string) => { status: number; body: unknown }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const { status, body } = handler(url.href)
      return Effect.succeed(jsonResponse(request, status, body))
    }),
  )

const configLayer = (key?: string) =>
  Config.layerFromProvider(
    ConfigProvider.fromEnv({
      env: key ? { BING_API_KEY: key } : {},
    }),
  )

const currentSiteLayer = Layer.mock(CurrentSite.Service)({
  current: () => Effect.succeed(site),
})

const buildLayer = (http: Layer.Layer<HttpClient.HttpClient>, key?: string) =>
  BingWebmaster.layer.pipe(
    Layer.provide(configLayer(key)),
    Layer.provide(currentSiteLayer),
    Layer.provide(http),
  ) as Layer.Layer<BingWebmaster.Service>

test("parseDotNetDate converts ms epoch to ISO date", () => {
  expect(parseDotNetDate("/Date(1784876400000-0700)/")).toBe("2026-07-24")
})

test("fetchSiteDailyTotals unwraps d and parses rows", async () => {
  let href = ""
  const http = fakeHttp((url) => {
    href = url
    return {
      status: 200,
      body: {
        d: [
          {
            __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api",
            Date: "/Date(1784876400000-0700)/",
            Clicks: 4,
            Impressions: 70,
          },
        ],
      },
    }
  })

  const rows = await BingWebmaster.use
    .fetchSiteDailyTotals()
    .pipe(Effect.provide(buildLayer(http, "secret-key")), Effect.runPromise)

  expect(href).toContain("siteUrl=https%3A%2F%2Fexample.com")
  expect(href).toContain("apikey=secret-key")
  expect(rows).toEqual([
    { date: "2026-07-24", clicks: 4, impressions: 70 },
  ])
})

test("InvalidApiKey (ErrorCode 3) surfaces as BingAuthError", async () => {
  const http = fakeHttp(() => ({
    status: 400,
    body: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" },
  }))

  const exit = await BingWebmaster.use
    .fetchSiteDailyTotals()
    .pipe(Effect.exit, Effect.provide(buildLayer(http, "bad")), Effect.runPromise)

  expect(Exit.isFailure(exit)).toBe(true)
  expect(squashError(exit)).toBeInstanceOf(BingAuthError)
})

test("NotAuthorized (ErrorCode 14) surfaces as BingAuthError", async () => {
  const http = fakeHttp(() => ({
    status: 400,
    body: { ErrorCode: 14, Message: "ERROR!!! NotAuthorized" },
  }))

  const exit = await BingWebmaster.use
    .fetchSiteDailyTotals()
    .pipe(Effect.exit, Effect.provide(buildLayer(http, "key")), Effect.runPromise)

  expect(squashError(exit)).toBeInstanceOf(BingAuthError)
})

const squashError = <A>(exit: Exit.Exit<A, BingError>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as BingError) : undefined

const runToExitWithClock = <A, R>(
  effect: Effect.Effect<A, BingError, R>,
  layer: Layer.Layer<R>,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(effect)
    for (let guard = 0; guard < 500 && fiber.pollUnsafe() === undefined; guard++) {
      yield* TestClock.adjust(Duration.seconds(30))
      yield* TestClock.withLive(Effect.sleep(Duration.millis(2)))
    }
    return yield* Fiber.await(fiber)
  }).pipe(
    Effect.scoped,
    Effect.provide(layer),
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  )

test("retries then gives up on a persistent 503", async () => {
  let calls = 0
  const http = fakeHttp(() => {
    calls += 1
    return { status: 503, body: { error: "unavailable" } }
  })

  const exit = await runToExitWithClock(
    BingWebmaster.use.fetchSiteDailyTotals(),
    buildLayer(http, "key"),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  expect(squashError(exit)).toBeInstanceOf(BingHttpError)
  expect(calls).toBe(6)
})

test("hasBingConnection reflects whether a key is configured", async () => {
  const http = fakeHttp(() => ({ status: 200, body: { d: [] } }))
  const check = (key?: string) =>
    BingWebmaster.use
      .hasBingConnection()
      .pipe(Effect.provide(buildLayer(http, key)), Effect.runPromise)

  expect(await check()).toBe(false)
  expect(await check("configured")).toBe(true)
})

test("fetch without a key fails as BingAuthError", async () => {
  const http = fakeHttp(() => ({ status: 200, body: { d: [] } }))
  const exit = await BingWebmaster.use
    .fetchSiteDailyTotals()
    .pipe(Effect.exit, Effect.provide(buildLayer(http)), Effect.runPromise)

  expect(squashError(exit)).toBeInstanceOf(BingAuthError)
})


test("fetchQueryWindow unwraps d and maps AvgImpressionPosition", async () => {
  let href = ""
  const http = fakeHttp((url) => { href = url; return { status: 200, body: { d: [{ __type: "QueryStats:#Microsoft.Bing.Webmaster.Api", Query: "pocket alternative", Clicks: 2, Impressions: 25, AvgImpressionPosition: 6, AvgClickPosition: -1 }] } } })
  const rows = await BingWebmaster.use.fetchQueryWindow().pipe(Effect.provide(buildLayer(http, "secret-key")), Effect.runPromise)
  expect(href).toContain("GetQueryStats")
  expect(rows).toEqual([{ query: "pocket alternative", clicks: 2, impressions: 25, position: 6 }])
})
