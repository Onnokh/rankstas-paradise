// Sitemap service: fetches, caches, and diffs the site's sitemap. Site-scoped
// (cache path + sitemap URL from CurrentSite). Ports the legacy `src/sitemap.ts`
// behaviour onto Effect HttpClient with a typed SitemapError.
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { Context, Effect, Layer } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import { serviceUse } from "../service-use.ts"
import { SitemapError, type SitemapPage } from "./schema.ts"

export interface Interface {
  // Fetch sitemap.xml, parse it, cache it, and return the pages.
  readonly refreshSitemapPages: () => Effect.Effect<
    ReadonlyArray<SitemapPage>,
    SitemapError
  >
  // Read the cached sitemap; an empty/absent cache yields no pages.
  readonly loadCachedSitemapPages: () => Effect.Effect<
    ReadonlyArray<SitemapPage>
  >
  // Sitemap pages whose path is not mapped to any registry target. Pure.
  readonly unmappedSitemapPages: (
    pages: ReadonlyArray<SitemapPage>,
    registry: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<ReadonlyArray<SitemapPage>>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Sitemap",
) {}

export const use = serviceUse(Service)

// Pull the inner text of the first `<tag>…</tag>` in an XML fragment, or null.
const tagValue = (xml: string, tag: string) =>
  xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1] ?? null

// Parse `<url><loc>…</loc><lastmod>…</lastmod></url>` entries into pages. Entries
// without a usable `<loc>` are dropped. Ported verbatim from the legacy parser.
const parseSitemap = (xml: string): ReadonlyArray<SitemapPage> =>
  [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].flatMap((match) => {
    const url = tagValue(match[1] ?? "", "loc")
    if (!url) return []
    return [
      {
        url,
        path: new URL(url).pathname,
        lastModified: tagValue(match[1] ?? "", "lastmod"),
      },
    ]
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const currentSite = yield* CurrentSite.Service
    const httpClient = yield* HttpClient.HttpClient

    const impl: Interface = {
      refreshSitemapPages: Effect.fn("Sitemap.refreshSitemapPages")(
        function* () {
          const site = yield* currentSite.current()
          const response = yield* httpClient
            .execute(HttpClientRequest.get(site.sitemapUrl))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SitemapError({
                    message: `Could not fetch the sitemap: ${String(cause)}`,
                    cause,
                  }),
              ),
            )
          // execute does not fail on non-2xx — classify the status ourselves.
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(
              new SitemapError({
                message: `Sitemap request failed with HTTP ${response.status}.`,
              }),
            )
          const xml = yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new SitemapError({
                  message: "Could not read the sitemap.",
                  cause,
                }),
            ),
          )
          const pages = parseSitemap(xml)
          const cachePath = yield* currentSite.sitemapPath()
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(cachePath), { recursive: true })
              await Bun.write(cachePath, `${JSON.stringify(pages, null, 2)}\n`)
            },
            catch: (cause) =>
              new SitemapError({
                message: "Could not cache the sitemap.",
                cause,
              }),
          })
          return pages
        },
      ),

      loadCachedSitemapPages: () =>
        Effect.gen(function* () {
          const cachePath = yield* currentSite.sitemapPath()
          // A missing or malformed cache is not an error — it just yields no
          // pages, mirroring the legacy `[]`-on-failure behaviour.
          return yield* Effect.promise(async () => {
            const file = Bun.file(cachePath)
            if (!(await file.exists())) return []
            try {
              return JSON.parse(await file.text()) as ReadonlyArray<SitemapPage>
            } catch {
              return []
            }
          })
        }),

      unmappedSitemapPages: (pages, registry) =>
        Effect.sync(() => {
          const targets = new Set(registry.map((entry) => entry.targetUrl))
          return pages.filter((page) => !targets.has(page.path))
        }),
    }

    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CurrentSite.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as Sitemap from "./sitemap"
