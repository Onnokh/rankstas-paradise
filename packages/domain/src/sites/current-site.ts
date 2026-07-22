// CurrentSite: the active site in the current scope. This replaces the legacy
// ambient thread-local site context (node:async_hooks) — instead of an
// ambient thread-local,
// the active site is a scoped service that site-scoped services (Storage,
// Registry, Sitemap, Reports, Sync, and the site-scoped parts of SearchConsole)
// read from context. A real per-scope layer supplies a resolved Site; the
// `defaultLayer` here is a die stub with no site bound.
//
// The per-site path derivations live here (they depend only on the active site
// and the data home), so a site-scoped service never recomputes them. FROZEN
// CONTRACT — stub only.
import { Context, Effect, Layer } from "effect"

import { Config } from "../config/config.ts"
import { serviceUse } from "../service-use.ts"
import { type Site, type SiteId, type UnknownSiteError } from "./schema.ts"
import { Sites } from "./sites.ts"

export interface Interface {
  // The resolved active site for this scope.
  readonly current: () => Effect.Effect<Site>
  // data/sites/<id>/
  readonly dataDirectory: () => Effect.Effect<string>
  // data/sites/<id>/search-console(.debug).sqlite
  readonly databasePath: () => Effect.Effect<string>
  // data/sites/<id>/keyword-registry.csv
  readonly registryPath: () => Effect.Effect<string>
  // data/sites/<id>/sitemap.json
  readonly sitemapPath: () => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/CurrentSite",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return {
      current: () => Effect.die("unimplemented: CurrentSite.current"),
      dataDirectory: () => Effect.die("unimplemented: CurrentSite.dataDirectory"),
      databasePath: () => Effect.die("unimplemented: CurrentSite.databasePath"),
      registryPath: () => Effect.die("unimplemented: CurrentSite.registryPath"),
      sitemapPath: () => Effect.die("unimplemented: CurrentSite.sitemapPath"),
    }
  }),
)

export const defaultLayer = layer

// --- real per-scope layers ---------------------------------------------------
//
// The `layer`/`defaultLayer` above are the die-stub placeholder that lets the
// site-scoped services (Storage, Registry, …) type-check with no site bound.
// The two factories below are what the server (per request, from `?site=`) and
// the CLI (per invocation) actually provide at their boundary, overriding the
// stub with a concrete active site. Path derivations depend only on the site and
// the data home (Config), so a site-scoped service never recomputes them.

// Build the CurrentSite shape for an already-resolved site, reading the data
// home and debug flag from Config.
const forSite = Effect.fnUntraced(function* (site: Site) {
  const dataDirectory = yield* Config.use.dataDirectory()
  const debugMode = yield* Config.use.debugMode()
  const siteDirectory = `${dataDirectory}/sites/${site.id}`
  return Service.of({
    current: () => Effect.succeed(site),
    dataDirectory: () => Effect.succeed(siteDirectory),
    databasePath: () =>
      Effect.succeed(
        `${siteDirectory}/search-console${debugMode ? ".debug" : ""}.sqlite`,
      ),
    registryPath: () => Effect.succeed(`${siteDirectory}/keyword-registry.csv`),
    sitemapPath: () => Effect.succeed(`${siteDirectory}/sitemap.json`),
  })
})

// Provide CurrentSite for a site the caller already holds. Depends on Config.
export const layerForSite = (
  site: Site,
): Layer.Layer<Service, never, Config.Service> =>
  Layer.effect(Service, forSite(site))

// Provide CurrentSite for a site id, resolving it through the Sites catalog.
// Fails with UnknownSiteError if the id is not in the catalog. Depends on Sites
// (and Config for the path derivations).
export const layerFor = (
  id: SiteId,
): Layer.Layer<Service, UnknownSiteError, Sites.Service | Config.Service> =>
  Layer.effect(
    Service,
    Effect.flatMap(Sites.use.siteFor(id), forSite),
  )

export * as CurrentSite from "./current-site"
