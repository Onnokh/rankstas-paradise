// SearchConsole client tests. No network: a fake HttpClient layer returns canned
// responses so we can exercise the behaviours that matter — service-account
// token minting and caching, remint-on-401-then-retry, and retry-then-give-up on
// persistent 5xx/429.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Schema } from "effect"
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
  Schema.Struct({ siteUrl: Schema.String }),
)({ siteUrl: "https://example.com" })

let serviceAccountPath = ""

// A throwaway RSA keypair, generated once for the whole file: the JWT-bearer
// path really signs its assertion, so the tests need a key the crypto layer
// accepts. Only the private half is used.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const writeServiceAccountKey = (
  overrides: Record<string, unknown> = {},
) =>
  Bun.write(
    serviceAccountPath,
    JSON.stringify({
      type: "service_account",
      client_email: "rp@example.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: "https://oauth2.googleapis.com/token",
      ...overrides,
    }),
  )

beforeEach(() => {
  serviceAccountPath = join(tmpdir(), `rp-sc-sa-${crypto.randomUUID()}.json`)
})

afterEach(() => {
  try {
    unlinkSync(serviceAccountPath)
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
  serviceAccountPath: () => Effect.succeed(serviceAccountPath),
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

test("mints a fresh token on a 401, then retries the request", async () => {
  await writeServiceAccountKey()

  let queryCalls = 0
  let grantCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("oauth2.googleapis.com/token")) {
      grantCalls += 1
      return {
        status: 200,
        body: { access_token: `access-${grantCalls}`, expires_in: 3600 },
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

  expect(queryCalls).toBe(2) // initial 401 + one retry with a fresh token
  expect(grantCalls).toBe(2) // the 401 forces a remint past the cache
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0]).toMatchObject({ query: "shirt", clicks: 5 })
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
  await writeServiceAccountKey()

  let queryCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("oauth2.googleapis.com/token"))
      return { status: 200, body: { access_token: "sa-access", expires_in: 3600 } }
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
  await writeServiceAccountKey()

  let queryCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("oauth2.googleapis.com/token"))
      return { status: 200, body: { access_token: "sa-access", expires_in: 3600 } }
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
  await writeServiceAccountKey()

  let queryCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("oauth2.googleapis.com/token"))
      return { status: 200, body: { access_token: "sa-access", expires_in: 3600 } }
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

// --- service-account auth ---

test("a service-account key mints a token via the JWT-bearer grant", async () => {
  await writeServiceAccountKey()

  let assertion: string | undefined
  let grantType: string | undefined
  let bearer: string | undefined
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      if (url.href.includes("oauth2.googleapis.com/token")) {
        // bodyUrlParams encodes to a Uint8Array; decode it back to read the form.
        const encoded = (request.body as { body: Uint8Array }).body
        const body = new URLSearchParams(new TextDecoder().decode(encoded))
        grantType = body.get("grant_type") ?? undefined
        assertion = body.get("assertion") ?? undefined
        return Effect.succeed(
          jsonResponse(request, 200, {
            access_token: "sa-access",
            expires_in: 3600,
          }),
        )
      }
      bearer = request.headers.authorization
      return Effect.succeed(
        jsonResponse(request, 200, {
          rows: [
            {
              keys: ["2024-01-01"],
              clicks: 3,
              impressions: 30,
              ctr: 0.1,
              position: 4,
            },
          ],
        }),
      )
    }),
  )

  const totals = await SearchConsole.use
    .fetchDailyTotals(["2024-01-01"])
    .pipe(Effect.provide(buildLayer(http)), Effect.runPromise)

  expect(totals.site).toHaveLength(1)
  expect(bearer).toBe("Bearer sa-access")
  expect(grantType).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")

  // A three-segment RS256 assertion whose claims name the service account and
  // the read-only Search Console scope.
  const segments = (assertion ?? "").split(".")
  expect(segments).toHaveLength(3)
  const header = JSON.parse(Buffer.from(segments[0]!, "base64url").toString())
  const claims = JSON.parse(Buffer.from(segments[1]!, "base64url").toString())
  expect(header).toMatchObject({ alg: "RS256", typ: "JWT" })
  expect(claims.iss).toBe("rp@example.iam.gserviceaccount.com")
  expect(claims.scope).toBe(
    "https://www.googleapis.com/auth/webmasters.readonly",
  )
  expect(claims.exp - claims.iat).toBe(3600)
})

test("the minted token is used as the bearer and never written to disk", async () => {
  await writeServiceAccountKey()
  const keyBefore = await Bun.file(serviceAccountPath).text()

  let grantCalls = 0
  let bearer: string | undefined
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      if (url.href.includes("oauth2.googleapis.com/token")) {
        grantCalls += 1
        return Effect.succeed(
          jsonResponse(request, 200, {
            access_token: "sa-access",
            expires_in: 3600,
          }),
        )
      }
      bearer = request.headers.authorization
      return Effect.succeed(jsonResponse(request, 200, { rows: [] }))
    }),
  )

  await SearchConsole.use
    .fetchDailyTotals(["2024-01-01"])
    .pipe(Effect.provide(buildLayer(http)), Effect.runPromise)

  expect(grantCalls).toBe(1)
  expect(bearer).toBe("Bearer sa-access")
  // The key file is read-only to this service — nothing rotates on disk, which
  // is what lets the deploy mount it read-only.
  expect(await Bun.file(serviceAccountPath).text()).toBe(keyBefore)
})

test("the minted service-account token is cached across calls", async () => {
  await writeServiceAccountKey()

  let grantCalls = 0
  const http = fakeHttp((href) => {
    if (href.includes("oauth2.googleapis.com/token")) {
      grantCalls += 1
      return { status: 200, body: { access_token: "sa-access", expires_in: 3600 } }
    }
    return { status: 200, body: { rows: [] } }
  })

  const layer = buildLayer(http)
  await Effect.gen(function* () {
    yield* SearchConsole.use.fetchDailyTotals(["2024-01-01"])
    yield* SearchConsole.use.fetchDailyTotals(["2024-01-02"])
    yield* SearchConsole.use.fetchDailyTotals(["2024-01-03"])
  }).pipe(Effect.provide(layer), Effect.runPromise)

  expect(grantCalls).toBe(1)
})

// Regression: daily totals were requested with dataState "final", so Google
// returned zero rows for every day past the finalization cutoff. The provisional
// tail never reached site_daily and the history view silently stopped three days
// back, with `provisional` never once true. Totals must ask for "all"; the query
// breakdowns must stay "final" because the registry and opportunity maths are
// built on numbers Google has stopped revising.
test("daily totals request fresh data; query breakdowns stay finalized", async () => {
  await writeServiceAccountKey()

  const dataStates: Array<{ dimensions: ReadonlyArray<string>; dataState: string }> = []
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      if (url.href.includes("oauth2.googleapis.com/token"))
        return Effect.succeed(
          jsonResponse(request, 200, {
            access_token: "sa-access",
            expires_in: 3600,
          }),
        )
      const encoded = (request.body as { body: Uint8Array }).body
      const body = JSON.parse(new TextDecoder().decode(encoded))
      dataStates.push({ dimensions: body.dimensions, dataState: body.dataState })
      return Effect.succeed(jsonResponse(request, 200, { rows: [] }))
    }),
  )

  const layer = buildLayer(http)
  await Effect.gen(function* () {
    yield* SearchConsole.use.fetchDailyTotals(["2024-01-01"])
    yield* SearchConsole.use.fetchSearchConsoleSnapshots(["2024-01-01"])
  }).pipe(Effect.provide(layer), Effect.runPromise)

  // Site-wide totals (no dimensions) and the per-page totals both need the
  // still-being-revised trailing days.
  const totals = dataStates.filter(
    (call) => call.dimensions.length === 0 || call.dimensions[0] === "page",
  )
  expect(totals.length).toBeGreaterThan(0)
  for (const call of totals) expect(call.dataState).toBe("all")

  // The query breakdown must not chase provisional numbers.
  const breakdown = dataStates.filter((call) => call.dimensions.includes("query"))
  expect(breakdown.length).toBeGreaterThan(0)
  for (const call of breakdown) expect(call.dataState).toBe("final")
})

test("a malformed service-account key fails as an auth error", async () => {
  // Missing private_key — there is no second credential to fall back to, so this
  // must surface rather than turn into a confusing downstream failure.
  await writeServiceAccountKey({ private_key: undefined })

  const http = fakeHttp(() => ({ status: 200, body: { rows: [] } }))

  const exit = await SearchConsole.use
    .fetchDailyTotals(["2024-01-01"])
    .pipe(Effect.exit, Effect.provide(buildLayer(http)), Effect.runPromise)

  expect(Exit.isFailure(exit)).toBe(true)
  expect(squashError(exit)).toBeInstanceOf(SearchConsoleAuthError)
})

test("hasGoogleConnection reflects whether a readable key is present", async () => {
  const http = fakeHttp(() => ({ status: 200, body: {} }))
  const check = () =>
    SearchConsole.use
      .hasGoogleConnection()
      .pipe(Effect.provide(buildLayer(http)), Effect.runPromise)

  // No key file yet.
  expect(await check()).toBe(false)
  await writeServiceAccountKey()
  expect(await check()).toBe(true)
  // Present but unusable reads as "not connected" rather than throwing.
  await writeServiceAccountKey({ client_email: undefined })
  expect(await check()).toBe(false)
})
