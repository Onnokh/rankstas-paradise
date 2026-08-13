// Per-site application runtimes for the HTTP server.
//
// The domain's site-scoped services (Storage, Registry, Sitemap, Reports, Sync)
// read the active site from `CurrentSite`, which is fixed at layer-construction
// time. The server therefore builds one `ManagedRuntime` per site, each with the
// real `CurrentSite.layerForSite(site)` supplied at the bottom of the graph —
// overriding the die-stub that the domain's `AppLayer` composes for type-checking.
// Runtimes are cached by site id so each site's SQLite connection (opened as a
// scoped resource on Storage acquisition) is reused across requests.
//
// Jobs live inside each site's runtime too (the per-site single-job lock and job
// registry). `GET /api/jobs` — which is not site-scoped — reads the first
// configured site's runtime. A truly process-global job view across many sites
// is out of scope here (the golden fixture is single-site); this matches the
// legacy single-lock behaviour for the common single-site deployment.
import { Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { Config } from "@rp/domain/config/config"
import { BingWebmaster } from "@rp/domain/bing-webmaster/bing-webmaster"
import { CurrentSite } from "@rp/domain/sites/current-site"
import { Registry } from "@rp/domain/registry/registry"
import { Reports } from "@rp/domain/reports/reports"
import { SearchConsole } from "@rp/domain/search-console/search-console"
import { type Site, type SiteId } from "@rp/domain/sites/schema"
import { Sitemap } from "@rp/domain/sitemap/sitemap"
import { Sites } from "@rp/domain/sites/sites"
import { Storage } from "@rp/domain/storage/storage"
import { Sync } from "@rp/domain/sync/sync"

import { Jobs } from "../jobs/jobs.ts"

// The full per-site graph: every site-scoped service plus Jobs, wired onto a
// concrete CurrentSite. Provider layers are merged in so the services are also
// exposed for direct use (native-feed calls Storage/Registry/Sitemap directly).
const siteLayer = (site: Site) =>
  Jobs.layer.pipe(
    Layer.provideMerge(Reports.layer),
    Layer.provideMerge(Sync.layer),
    Layer.provideMerge(Sites.layer),
    Layer.provideMerge(SearchConsole.layer),
    Layer.provideMerge(BingWebmaster.layer),
    Layer.provideMerge(Storage.layer),
    Layer.provideMerge(Registry.layer),
    Layer.provideMerge(Sitemap.layer),
    Layer.provideMerge(CurrentSite.layerForSite(site)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Config.defaultLayer),
  )

export type SiteRuntime = ManagedRuntime.ManagedRuntime<
  | Jobs.Service
  | Reports.Service
  | Sync.Service
  | Sites.Service
  | SearchConsole.Service
  | BingWebmaster.Service
  | Storage.Service
  | Registry.Service
  | Sitemap.Service
  | CurrentSite.Service,
  never
>

export interface ServerContext {
  readonly debug: boolean
  readonly loadSites: () => Promise<ReadonlyArray<Site>>
  // Resolve one site by id; rejects (UnknownSiteError) when it is not configured.
  readonly siteFor: (id: SiteId) => Promise<Site>
  readonly firstSite: () => Promise<Site>
  // The cached runtime for a resolved site.
  readonly runtimeFor: (site: Site) => SiteRuntime
}

// Build the server context: read the debug flag + site catalog once, and set up
// the per-site runtime cache.
export const makeServerContext = async (): Promise<ServerContext> => {
  const configRuntime = ManagedRuntime.make(Config.defaultLayer)
  const debug = await configRuntime.runPromise(Config.use.debugMode())

  const sitesRuntime = ManagedRuntime.make(Sites.defaultLayer)
  const cache = new Map<string, SiteRuntime>()

  const runtimeFor = (site: Site): SiteRuntime => {
    const existing = cache.get(site.id)
    if (existing) return existing
    const runtime = ManagedRuntime.make(siteLayer(site)) as SiteRuntime
    cache.set(site.id, runtime)
    return runtime
  }

  return {
    debug,
    loadSites: () => sitesRuntime.runPromise(Sites.use.loadSites()),
    siteFor: (id) => sitesRuntime.runPromise(Sites.use.siteFor(id)),
    firstSite: async () => {
      const sites = await sitesRuntime.runPromise(Sites.use.loadSites())
      const first = sites[0]
      if (!first) throw new Error("No sites configured")
      return first
    },
    runtimeFor,
  }
}
