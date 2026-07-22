// Sitemap service tests. No network: a fake HttpClient returns canned sitemap
// XML, and a fake CurrentSite points the cache at a fresh temp dir per test.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { Site } from "../sites/schema.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import { Sitemap } from "./sitemap.ts"
import { SitemapError } from "./schema.ts"

const site = Schema.decodeUnknownSync(Site)({
  id: "test",
  name: "Test Site",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: [],
})

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://example.com/widgets</loc>
    <lastmod>2026-02-02</lastmod>
  </url>
  <url>
    <loc>https://example.com/orphan</loc>
  </url>
</urlset>`

// A fake HttpClient answering with a fixed status/body regardless of URL.
const fakeHttp = (status: number, body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status })),
      ),
    ),
  )

const buildLayer = (
  sitemapPath: string,
  http: Layer.Layer<HttpClient.HttpClient>,
) =>
  Sitemap.layer.pipe(
    Layer.provide(
      Layer.mock(CurrentSite.Service)({
        current: () => Effect.succeed(site),
        sitemapPath: () => Effect.succeed(sitemapPath),
      }),
    ),
    Layer.provide(http),
  )

const withTemp = async <A>(fn: (sitemapPath: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "rp-sitemap-"))
  try {
    return await fn(join(dir, "nested", "sitemap.json"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const entry = (targetUrl: string): RegistryEntry => ({
  cluster: "",
  keyword: "",
  targetUrl,
  intent: "",
  whyOpportunity: "",
  country: "",
  priority: "",
  publishedAt: "",
  baselineDate: "",
  status: "",
})

test("refresh fetches, parses, and caches the sitemap; load reads it back", async () => {
  await withTemp(async (path) => {
    const layer = buildLayer(path, fakeHttp(200, sampleXml))

    const pages = await Sitemap.use
      .refreshSitemapPages()
      .pipe(Effect.provide(layer), Effect.runPromise)

    expect(pages).toEqual([
      { url: "https://example.com/", path: "/", lastModified: "2026-01-01" },
      {
        url: "https://example.com/widgets",
        path: "/widgets",
        lastModified: "2026-02-02",
      },
      {
        url: "https://example.com/orphan",
        path: "/orphan",
        lastModified: null,
      },
    ])

    // The cache file was written (parent dirs created) and round-trips.
    const cached = await Sitemap.use
      .loadCachedSitemapPages()
      .pipe(Effect.provide(layer), Effect.runPromise)
    expect(cached).toEqual(pages)
  })
})

test("refresh fails with SitemapError on a non-2xx response", async () => {
  await withTemp(async (path) => {
    const exit = await Sitemap.use
      .refreshSitemapPages()
      .pipe(
        Effect.provide(buildLayer(path, fakeHttp(500, "nope"))),
        Effect.exit,
        Effect.runPromise,
      )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(SitemapError)
      expect((error as SitemapError).message).toContain("HTTP 500")
    }
  })
})

test("loadCached returns [] when the cache is absent", async () => {
  await withTemp(async (path) => {
    const cached = await Sitemap.use
      .loadCachedSitemapPages()
      .pipe(
        Effect.provide(buildLayer(path, fakeHttp(200, sampleXml))),
        Effect.runPromise,
      )
    expect(cached).toEqual([])
  })
})

test("unmappedSitemapPages keeps only pages absent from the registry", async () => {
  await withTemp(async (path) => {
    const layer = buildLayer(path, fakeHttp(200, sampleXml))
    const pages = await Sitemap.use
      .refreshSitemapPages()
      .pipe(Effect.provide(layer), Effect.runPromise)

    const unmapped = await Sitemap.use
      .unmappedSitemapPages(pages, [entry("/"), entry("/widgets")])
      .pipe(Effect.provide(layer), Effect.runPromise)

    expect(unmapped.map((p) => p.path)).toEqual(["/orphan"])
  })
})
