// CurrentSite: the active site in the current scope. This replaces the legacy
// thread-local `withSite(...)` context (node:async_hooks) — instead of an
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

import { serviceUse } from "../service-use.ts"
import { type Site } from "./schema.ts"

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

export * as CurrentSite from "./current-site"
