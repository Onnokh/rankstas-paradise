// SearchConsole client tests. No network: a fake HttpClient layer returns canned
// responses so we can exercise the two resilience behaviours that matter —
// refresh-on-401-then-retry, and retry-then-give-up on persistent 5xx/429.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { SearchConsole } from "./search-console.ts"
import {
  SearchConsoleAuthError,
  SearchConsoleHttpError,
  type SearchConsoleError,
} from "./schema.ts"

// --- fixtures ---

const site = Schema.decodeUnknownSync(Site)({
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: [],
})

const seoConfig = Schema.decodeUnknownSync(
  Schema.Struct({
    googleClientId: Schema.String,
    googleClientSecret: Schema.Redacted(Schema.String),
    siteUrl: Schema.String,
  }),
)({
  googleClientId: "client-id",
  googleClientSecret: Redacted.make("client-secret") as never,
  siteUrl: "https://example.com",
})

let tokenPath = ""

const writeToken = (token: {
  access_token: string
  refresh_token?: string
  expires_in: number
  created_at: number
}) => Bun.write(tokenPath, JSON.stringify(token, null, 2))

const readTokenFile = async () =>
  JSON.parse(await Bun.file(tokenPath).text()) as {
    access_token: string
    refresh_token?: string
  }

beforeEach(() => {
  tokenPath = join(tmpdir(), `rp-sc-token-${crypto.randomUUID()}.json`)
})

afterEach(() => {
  try {
    unlinkSync(tokenPath)
  } catch {
    // best-effort cleanup
  }
})

// --- fake layers ---

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

// Build a fake HttpClient from a URL-keyed handler.
const fakeHttp = (handler: (href: string) => { status: number; body: unknown }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const { status, body } = handler(url.href)
      return Effect.succeed(jsonResponse(request, status, body))
    }),
  )

const configLayer = Layer.mock(Config.Service)({
  load: () => Effect.succeed(seoConfig),
  tokenPath: () => Effect.succeed(tokenPath),
})

const currentSiteLayer = Layer.mock(CurrentSite.Service)({
  current: () => Effect.succeed(site),
})

const buildLayer = (http: Layer.Layer<HttpClient.HttpClient>) =>
  SearchConsole.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(currentSiteLayer),
    Layer.provide(http),
  )

// --- tests ---

test("refreshes the token on a 401, then retries the request", async () => {
  await writeToken({
    access_token: "stale-access",
    refresh_token: "refresh-1",
    expires_in: 3600,
    created_at: Date.now(),
  })

  let queryCalls = 0
  let refreshCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("oauth2.googleapis.com/token")) {
      refreshCalls += 1
      return {
        status: 200,
        body: { access_token: "fresh-access", expires_in: 3600 },
      }
    }
    if (href.includes("searchAnalytics/query")) {
      queryCalls += 1
      if (queryCalls === 1) return { status: 401, body: { error: "expired" } }
      return {
        status: 200,
        body: {
          rows: [
            {
              keys: ["shirt", "https://example.com/p", "DESKTOP", "usa"],
              clicks: 5,
              impressions: 50,
              ctr: 0.1,
              position: 2.5,
            },
          ],
        },
      }
    }
    return { status: 404, body: {} }
  })

  const snapshots = await SearchConsole.use
    .fetchSearchConsoleSnapshots(["2024-01-01"])
    .pipe(Effect.provide(buildLayer(http)), Effect.runPromise)

  expect(queryCalls).toBe(2) // initial 401 + one retry after refresh
  expect(refreshCalls).toBe(1)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({ query: "shirt", clicks: 5 })

  // The refreshed token was persisted to the token file.
  const persisted = await readTokenFile()
  expect(persisted.access_token).toBe("fresh-access")
  expect(persisted.refresh_token).toBe("refresh-1")
})

const squashError = <A>(exit: Exit.Exit<A, SearchConsoleError>) =>
  Exit.isFailure(exit)
    ? (Cause.squash(exit.cause) as SearchConsoleError)
    : undefined

// Run an effect to its Exit while driving the TestClock forward so the retry
// backoff resolves in virtual time (no real sleeping). Polling in a loop makes
// this deterministic regardless of when the forked fiber schedules each sleep.
const runToExitWithClock = <A, R>(
  effect: Effect.Effect<A, SearchConsoleError, R>,
  layer: Layer.Layer<R>,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(effect)
    // Advance virtual time to fire pending retry sleeps, then give real time a
    // slice so the fiber's real-async token-file IO can progress. Repeat until
    // the fiber settles (bounded so a genuine hang still fails fast).
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

test("retries then gives up on a persistent 5xx", async () => {
  await writeToken({
    access_token: "valid-access",
    refresh_token: "refresh-1",
    expires_in: 3600,
    created_at: Date.now(),
  })

  let queryCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("searchAnalytics/query")) {
      queryCalls += 1
      return { status: 503, body: { error: "unavailable" } }
    }
    return { status: 404, body: {} }
  })

  const exit = await runToExitWithClock(
    SearchConsole.use.fetchSearchConsoleSnapshots(["2024-01-01"]),
    buildLayer(http),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  const error = squashError(exit)
  expect(error).toBeInstanceOf(SearchConsoleHttpError)
  expect((error as SearchConsoleHttpError).status).toBe(503)
  expect(queryCalls).toBe(6) // 1 initial attempt + 5 retries
})

test("retries then gives up on a persistent 429", async () => {
  await writeToken({
    access_token: "valid-access",
    refresh_token: "refresh-1",
    expires_in: 3600,
    created_at: Date.now(),
  })

  let queryCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("searchAnalytics/query")) {
      queryCalls += 1
      return { status: 429, body: { error: "rate limited" } }
    }
    return { status: 404, body: {} }
  })

  const exit = await runToExitWithClock(
    SearchConsole.use.fetchSearchConsoleSnapshots(["2024-01-01"]),
    buildLayer(http),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  const error = squashError(exit)
  expect(error).toBeInstanceOf(SearchConsoleHttpError)
  expect((error as SearchConsoleHttpError).status).toBe(429)
  expect(queryCalls).toBe(6)
})

test("a permanent 403 surfaces as an auth error without retrying", async () => {
  await writeToken({
    access_token: "valid-access",
    refresh_token: "refresh-1",
    expires_in: 3600,
    created_at: Date.now(),
  })

  let queryCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("searchAnalytics/query")) {
      queryCalls += 1
      return { status: 403, body: { error: "forbidden" } }
    }
    return { status: 404, body: {} }
  })

  const exit = await SearchConsole.use
    .fetchSearchConsoleSnapshots(["2024-01-01"])
    .pipe(Effect.exit, Effect.provide(buildLayer(http)), Effect.runPromise)

  expect(Exit.isFailure(exit)).toBe(true)
  expect(squashError(exit)).toBeInstanceOf(SearchConsoleAuthError)
  expect(queryCalls).toBe(1) // 403 is not transient — no retries
})
