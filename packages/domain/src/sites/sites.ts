// Sites service: loads and resolves the site catalog from config. Read-only and
// process-global (the catalog is the same for everyone); the *active* site is a
// separate per-scope concern — see CurrentSite. FROZEN CONTRACT — stub only.
import { Context, Effect, Layer } from "effect"

import { Config } from "../config/config.ts"
import { serviceUse } from "../service-use.ts"
import { type Site, type SiteId, UnknownSiteError } from "./schema.ts"

export interface Interface {
  // The full catalog, normalized. Legacy single-site config yields one site.
  readonly loadSites: () => Effect.Effect<ReadonlyArray<Site>>
  // Resolve one site by id, or fail if it is not in the catalog.
  readonly siteFor: (id: SiteId) => Effect.Effect<Site, UnknownSiteError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Sites") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* Config.Service
    return {
      loadSites: () => Effect.die("unimplemented: Sites.loadSites"),
      siteFor: () => Effect.die("unimplemented: Sites.siteFor"),
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Sites from "./sites"
