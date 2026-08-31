// DomainRating service tests. No network: a fake HttpClient returns canned
// Ahrefs payloads, a fake CurrentSite points the cache at a fresh temp dir, and
// the API key is injected through a fake ConfigProvider — so the
// key-absent path is exercised without touching the developer's environment.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { DomainRating } from "./domain-rating.ts"

const site = Schema.decodeUnknownSync(Site)({
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://www.example.com",
  sitemapUrl: "https://www.example.com/sitemap.xml",
  brandTerms: [],
})

// The exact shape Ahrefs returns, repeated key and all.
const payload = JSON.stringify({
  domain_rating: {
    domain_rating: 4.7,
    license: "http://ahrefs.com/legal/domain-rating-license",
  },
})

const fakeHttp = (status: number, body: string, seen?: { url?: string; auth?: string }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (seen) {
        seen.url = request.url
        seen.auth = request.headers["authorization"]
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status })),
      )
    }),
  )

const buildLayer = (
  directory: string,
  http: Layer.Layer<HttpClient.HttpClient>,
  env: Record<string, string> = { AHREFS_API_KEY: "test-key" },
) =>
  DomainRating.layer.pipe(
    Layer.provide(
      Layer.mock(CurrentSite.Service)({
        current: () => Effect.succeed(site),
        dataDirectory: () => Effect.succeed(directory),
      }),
    ),
    Layer.provide(http),
    Layer.provide(
      Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  )

const withTemp = async <A>(fn: (directory: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "rp-domain-rating-"))
  try {
    return await fn(join(dir, "nested"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("refresh reads the rating, asks about the bare host, and caches it", () =>
  withTemp(async (directory) => {
    const seen: { url?: string; auth?: string } = {}
    const reading = await Effect.runPromise(
      DomainRating.use
        .refresh()
        .pipe(Effect.provide(buildLayer(directory, fakeHttp(200, payload, seen)))),
    )

    expect(reading?.rating).toBe(4.7)
    // The site's origin is a URL; Ahrefs is asked about the host alone.
    expect(seen.url).toContain("target=www.example.com")
    expect(seen.auth).toBe("Bearer test-key")

    // The reading is on the volume, so a restart costs no quota.
    const cached = await Effect.runPromise(
      DomainRating.use
        .cached()
        .pipe(Effect.provide(buildLayer(directory, fakeHttp(500, "")))),
    )
    expect(cached?.rating).toBe(4.7)
    expect(cached?.target).toBe("www.example.com")
  }))

test("no API key yields no rating and never calls Ahrefs", () =>
  withTemp(async (directory) => {
    const seen: { url?: string } = {}
    const reading = await Effect.runPromise(
      DomainRating.use
        .refresh()
        .pipe(Effect.provide(buildLayer(directory, fakeHttp(200, payload, seen), {}))),
    )

    expect(reading).toBeNull()
    expect(seen.url).toBeUndefined()
  }))

test("a blank key counts as absent rather than becoming a 401", () =>
  withTemp(async (directory) => {
    const seen: { url?: string } = {}
    const reading = await Effect.runPromise(
      DomainRating.use
        .refresh()
        .pipe(
          Effect.provide(
            buildLayer(directory, fakeHttp(200, payload, seen), { AHREFS_API_KEY: "  " }),
          ),
        ),
    )

    expect(reading).toBeNull()
    expect(seen.url).toBeUndefined()
  }))

test("a rejected key fails loudly rather than reading as no data", () =>
  withTemp(async (directory) => {
    const exit = await Effect.runPromiseExit(
      DomainRating.use
        .refresh()
        .pipe(Effect.provide(buildLayer(directory, fakeHttp(401, "nope")))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  }))

test("cached returns null when the site has no reading", () =>
  withTemp(async (directory) => {
    const cached = await Effect.runPromise(
      DomainRating.use
        .cached()
        .pipe(Effect.provide(buildLayer(directory, fakeHttp(200, payload)))),
    )
    expect(cached).toBeNull()
  }))
