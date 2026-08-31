// ApiClient tests. No real server: a fake HttpClient layer returns canned
// responses so we can exercise a round-trip per method group (read, catalog,
// write, job), the ?site= / option→query-param mapping, envelope-field
// tolerance, and the three tagged-error failure modes.
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { SiteId } from "@rp/domain/sites/schema"

import { ApiClient } from "./client.ts"
import { ClientConfig } from "./client-config.ts"
import {
  ApiDecodeError,
  ApiHttpError,
  type ApiError,
} from "./schema.ts"

// --- fake transport ---

type Call = {
  readonly method: string
  readonly url: URL
  readonly authorization: string | undefined
}

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

// Build a fake HttpClient plus the list of calls it observed.
const fakeHttp = (
  handler: (call: Call) => { status: number; body: unknown },
) => {
  const calls: Array<Call> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const call: Call = {
        method: request.method,
        url,
        authorization: (request.headers as Record<string, string>)[
          "authorization"
        ],
      }
      calls.push(call)
      const { status, body } = handler(call)
      return Effect.succeed(jsonResponse(request, status, body))
    }),
  )
  return { layer, calls }
}

const clientConfigLayer = Layer.mock(ClientConfig.Service)({
  load: () =>
    Effect.succeed({
      apiUrl: "http://rp.test/",
      token: Redacted.make("secret-token"),
    }),
  isRemoteMode: () => Effect.succeed(true),
  resolveMode: () => Effect.succeed("remote" as const),
})

const buildLayer = (http: Layer.Layer<HttpClient.HttpClient>) =>
  ApiClient.layer.pipe(Layer.provide(clientConfigLayer), Layer.provide(http))

const squash = <A>(exit: Exit.Exit<A, ApiError>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as ApiError) : undefined

// --- canned bodies ---

const siteId = Schema.decodeUnknownSync(SiteId)("sleevy")

const site = {
  id: "sleevy",
  name: "Sleevy",
  property: "sc-domain:sleevy.com",
  origin: "https://sleevy.com",
  sitemapUrl: "https://sleevy.com/sitemap.xml",
  brandTerms: ["sleevy"],
}

const statusBody = {
  // Envelope fields the HTTP layer adds — must be ignored on decode.
  generatedAt: "2024-01-01T00:00:00Z",
  mode: "remote",
  data: {
    firstDate: "2024-01-01",
    lastDate: "2024-01-10",
    syncedDays: 10,
    snapshotRows: 100,
    dailyTotalsDays: 10,
    lastSyncedAt: "2024-01-11T04:00:00Z",
    lastCheckedAt: "2024-01-11T10:00:00Z",
    note: "ok",
  },
  registry: { targets: 3, keywords: 5, clusters: 2 },
  sitemap: { pages: 20, unmapped: ["/x"] },
  actions: 4,
}

const registryAddBody = {
  added: {
    keyword: "k",
    cluster: "c",
    intent: "i",
    country: "us",
    priority: "high",
    publishedAt: null,
    baselineDate: null,
    status: "planned",
    whyOpportunity: "why",
  },
  targetUrl: "/foo",
}

const jobBody = {
  job: {
    id: 1,
    name: "sync",
    siteId: "sleevy",
    status: "running",
    startedAt: "2024-01-01T00:00:00Z",
    finishedAt: null,
    message: null,
  },
}

// --- tests ---

test("read: status decodes and drops the envelope fields, with a bearer token", async () => {
  const http = fakeHttp(() => ({ status: 200, body: statusBody }))
  const report = await ApiClient.use
    .status(siteId)
    .pipe(Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  expect(report.data.syncedDays).toBe(10)
  expect(report.data.lastSyncedAt).toBe("2024-01-11T04:00:00Z")
  expect(report.data.lastCheckedAt).toBe("2024-01-11T10:00:00Z")
  expect(report.registry.targets).toBe(3)
  // The envelope keys are not present on the decoded value.
  expect((report as Record<string, unknown>).generatedAt).toBeUndefined()

  const call = http.calls[0]!
  expect(call.method).toBe("GET")
  expect(call.url.pathname).toBe("/api/status")
  expect(call.url.searchParams.get("site")).toBe("sleevy")
  expect(call.authorization).toBe("Bearer secret-token")
})

test("catalog: sites decodes the { sites } envelope", async () => {
  const http = fakeHttp(() => ({ status: 200, body: { sites: [site] } }))
  const result = await ApiClient.use
    .sites()
    .pipe(Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  expect(result.sites).toHaveLength(1)
  expect(String(result.sites[0]!.id)).toBe("sleevy")
  expect(http.calls[0]!.url.pathname).toBe("/api/sites")
})

test("queries: options map to the wire query params", async () => {
  const http = fakeHttp(() => ({
    status: 200,
    body: {
      window: {
        currentStart: null,
        currentEnd: null,
        previousStart: null,
        previousEnd: null,
      },
      queries: [],
    },
  }))

  await ApiClient.use
    .queries(
      {
        page: "/p",
        windowDays: 28,
        minImpressions: 10,
        includeBrand: true,
        limit: 5,
      },
      siteId,
    )
    .pipe(Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  const params = http.calls[0]!.url.searchParams
  expect(params.get("page")).toBe("/p")
  expect(params.get("window")).toBe("28")
  expect(params.get("min-impressions")).toBe("10")
  expect(params.get("include-brand")).toBe("true")
  expect(params.get("limit")).toBe("5")
  expect(params.get("site")).toBe("sleevy")
})

test("write: registryAdd POSTs and decodes the result", async () => {
  const http = fakeHttp(() => ({ status: 200, body: registryAddBody }))
  const result = await ApiClient.use
    .registryAdd({ target: "/foo", keyword: "k" }, siteId)
    .pipe(Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  expect(result.targetUrl).toBe("/foo")
  expect(result.added.keyword).toBe("k")
  const call = http.calls[0]!
  expect(call.method).toBe("POST")
  expect(call.url.pathname).toBe("/api/registry")
})

test("job: syncJob POSTs to /api/jobs/sync and decodes the job", async () => {
  const http = fakeHttp(() => ({ status: 200, body: jobBody }))
  const result = await ApiClient.use
    .syncJob(siteId)
    .pipe(Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  expect(result.job.status).toBe("running")
  const call = http.calls[0]!
  expect(call.method).toBe("POST")
  expect(call.url.pathname).toBe("/api/jobs/sync")
})

test("error: a non-2xx status becomes an ApiHttpError carrying the status", async () => {
  const http = fakeHttp(() => ({ status: 500, body: { error: "boom" } }))
  const exit = await ApiClient.use
    .status(siteId)
    .pipe(Effect.exit, Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  expect(Exit.isFailure(exit)).toBe(true)
  const error = squash(exit)
  expect(error).toBeInstanceOf(ApiHttpError)
  expect((error as ApiHttpError).status).toBe(500)
  expect((error as ApiHttpError).path).toBe("/api/status")
})

test("error: a malformed 2xx body becomes an ApiDecodeError", async () => {
  const http = fakeHttp(() => ({ status: 200, body: { sites: "nope" } }))
  const exit = await ApiClient.use
    .sites()
    .pipe(Effect.exit, Effect.provide(buildLayer(http.layer)), Effect.runPromise)

  expect(Exit.isFailure(exit)).toBe(true)
  expect(squash(exit)).toBeInstanceOf(ApiDecodeError)
})
