// Sitemap service: fetches, caches, and diffs the site's sitemap. Site-scoped
// (cache path + origin from CurrentSite). FROZEN CONTRACT — stub only.
import { Context, Effect, Layer } from "effect"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import { serviceUse } from "../service-use.ts"
import { type SitemapError, type SitemapPage } from "./schema.ts"

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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* Config.Service
    yield* CurrentSite.Service
    return {
      refreshSitemapPages: () =>
        Effect.die("unimplemented: Sitemap.refreshSitemapPages"),
      loadCachedSitemapPages: () =>
        Effect.die("unimplemented: Sitemap.loadCachedSitemapPages"),
      unmappedSitemapPages: () =>
        Effect.die("unimplemented: Sitemap.unmappedSitemapPages"),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Sitemap from "./sitemap"
