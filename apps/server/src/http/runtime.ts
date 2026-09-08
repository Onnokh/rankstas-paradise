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
// Each site runtime also gets its own ConfigProvider: the site's vendor keys
// from the Secrets vault (and the app-wide ones), decrypted and placed under the
// environment variable names the adapters already read, in front of the real
// environment. A stored key therefore wins over an env var; an env var still
// works as the fallback. Building that provider is async, so `runtimeFor` is.
// A settings or secret write drops the affected cached runtimes (`forget`,
// `forgetAll`), because the Site or the keys they were built around are now
// stale; the next request builds fresh ones.
//
// Jobs live inside each site's runtime too (the per-site single-job lock and job
// registry). `GET /api/jobs` — which is not site-scoped — reads the first
// configured site's runtime. A truly process-global job view across many sites
// is out of scope here (the golden fixture is single-site); this matches the
// legacy single-lock behaviour for the common single-site deployment.
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { Analytics } from "@rp/domain/analytics/analytics"
import { AppDatabase } from "@rp/domain/app-database/app-database"
import { Catalog } from "@rp/domain/catalog/catalog"
import { type Client } from "@rp/domain/clients/schema"
import { Clients } from "@rp/domain/clients/clients"
import { Config } from "@rp/domain/config/config"
import { type ConfigSite } from "@rp/domain/config/schema"
import { CurrentSite } from "@rp/domain/sites/current-site"
import { DomainRating } from "@rp/domain/domain-rating/domain-rating"
import { KeywordMetrics } from "@rp/domain/keyword-metrics/keyword-metrics"
import { Registry } from "@rp/domain/registry/registry"
import { Reports } from "@rp/domain/reports/reports"
import { Revenue } from "@rp/domain/revenue/revenue"
import { SearchConsole } from "@rp/domain/search-console/search-console"
import { type EncryptionStatus, type SecretStatus } from "@rp/domain/secrets/schema"
import { Secrets } from "@rp/domain/secrets/secrets"
import { type Site, type SiteId } from "@rp/domain/sites/schema"
import { Sitemap } from "@rp/domain/sitemap/sitemap"
import { Sites } from "@rp/domain/sites/sites"
import { Storage } from "@rp/domain/storage/storage"
import { Sync } from "@rp/domain/sync/sync"

import { Jobs } from "../jobs/jobs.ts"

// The full per-site graph: every site-scoped service plus Jobs, wired onto a
// concrete CurrentSite and the site's ConfigProvider. Provider layers are
// merged in so the services are also exposed for direct use (native-feed calls
// Storage/Registry/Sitemap directly).
const siteLayer = (site: Site, provider: ConfigProvider.ConfigProvider) =>
  Jobs.layer.pipe(
    Layer.provideMerge(Reports.layer),
    Layer.provideMerge(Sync.layer),
    Layer.provideMerge(Sites.layer),
    Layer.provideMerge(Catalog.layer),
    Layer.provideMerge(AppDatabase.layer),
    Layer.provideMerge(SearchConsole.layer),
    Layer.provideMerge(Analytics.layer),
    Layer.provideMerge(Revenue.layer),
    // Above Storage: DomainRating and KeywordMetrics both read the ledger, and
    // in a provideMerge chain a layer's own requirements are satisfied by the
    // entries below it.
    Layer.provideMerge(DomainRating.layer),
    Layer.provideMerge(KeywordMetrics.layer),
    Layer.provideMerge(Storage.layer),
    Layer.provideMerge(Registry.layer),
    Layer.provideMerge(Sitemap.layer),
    Layer.provideMerge(CurrentSite.layerForSite(site)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Config.defaultLayer),
    // Last, so every layer above — the vendor adapters in particular — reads
    // its configuration through the site's provider.
    Layer.provide(ConfigProvider.layer(provider)),
  )

export type SiteRuntime = ManagedRuntime.ManagedRuntime<
  | Jobs.Service
  | Reports.Service
  | Sync.Service
  | Sites.Service
  | SearchConsole.Service
  | Analytics.Service
  | Revenue.Service
  | Storage.Service
  | Registry.Service
  | Sitemap.Service
  | CurrentSite.Service,
  never
>

// The catalog operations the settings routes need. Each rejects with the
// domain's tagged error (UnknownSiteError, SiteExistsError, InvalidSiteError)
// so the handler can pick the status.
export interface CatalogOps {
  // The stored entry for a site.
  readonly settings: (id: SiteId) => Promise<ConfigSite>
  // Store a new entry and return the resolved Site.
  readonly add: (site: ConfigSite) => Promise<Site>
  // Replace an entry's settings and return the resolved Site.
  readonly update: (site: ConfigSite) => Promise<Site>
  // Remove an entry. Its data directory stays on disk.
  readonly remove: (id: SiteId) => Promise<void>
}

// The vault operations the secrets routes need. Scope is a site id, or null
// for an app-wide key. Each rejects with the domain's tagged error
// (EncryptionUnavailableError, InvalidSecretError, UnknownSecretError).
export interface SecretOps {
  readonly encryption: () => Promise<EncryptionStatus>
  readonly list: (scope: SiteId | null) => Promise<ReadonlyArray<SecretStatus>>
  readonly set: (
    scope: SiteId | null,
    purpose: string,
    value: Redacted.Redacted<string>,
  ) => Promise<SecretStatus>
  readonly remove: (scope: SiteId | null, purpose: string) => Promise<void>
}

// The client-token operations the clients routes need. `create` is the one
// place a plaintext token is returned.
export interface ClientOps {
  readonly list: () => Promise<ReadonlyArray<Client>>
  readonly create: (
    label: string,
  ) => Promise<{ readonly client: Client; readonly token: Redacted.Redacted<string> }>
  readonly revoke: (id: string) => Promise<Client>
}

// What the bearer middleware asks about per-client tokens.
export interface AuthOps {
  readonly accepts: (token: string) => Promise<boolean>
  readonly hasActiveClient: () => Promise<boolean>
}

// The one-time import of vendor keys from the environment into the vault; see
// `importEnvironmentKeys`.
export interface EnvironmentImport {
  // How many keys were stored, or null when the import did not run (no master
  // key yet, or it ran on an earlier start).
  readonly stored: number | null
}

export interface ServerContext {
  readonly debug: boolean
  readonly loadSites: () => Promise<ReadonlyArray<Site>>
  // Resolve one site by id; rejects (UnknownSiteError) when it is not configured.
  readonly siteFor: (id: SiteId) => Promise<Site>
  readonly firstSite: () => Promise<Site>
  // The cached runtime for a resolved site, built on first use.
  readonly runtimeFor: (site: Site) => Promise<SiteRuntime>
  // Drop a site's cached runtime after its settings or keys changed, or it was
  // removed.
  readonly forget: (id: SiteId) => Promise<void>
  // Drop every cached runtime, after an app-wide key changed.
  readonly forgetAll: () => Promise<void>
  readonly catalog: CatalogOps
  readonly secrets: SecretOps
  readonly clients: ClientOps
  readonly auth: AuthOps
  // Store, once, every vendor key the environment holds for a slot the vault
  // has nothing for: the sites' analytics and revenue providers, and Ahrefs
  // app-wide. After it the environment variables can be removed.
  readonly importEnvironmentKeys: () => Promise<EnvironmentImport>
}

// Build the server context: read the debug flag + site catalog once, and set up
// the per-site runtime cache.
export const makeServerContext = async (): Promise<ServerContext> => {
  const configRuntime = ManagedRuntime.make(Config.defaultLayer)
  const debug = await configRuntime.runPromise(Config.use.debugMode())

  // Sites, the Catalog it reads, and the Secrets vault share one app-database
  // connection here; the settings and secrets routes write through the same
  // runtime.
  const appRuntime = ManagedRuntime.make(
    Layer.mergeAll(Sites.layer, Secrets.layer, Clients.layer).pipe(
      Layer.provideMerge(Catalog.layer),
      Layer.provideMerge(AppDatabase.layer),
      Layer.provide(Config.defaultLayer),
    ),
  )
  const cache = new Map<string, Promise<SiteRuntime>>()

  // The site's ConfigProvider: its own stored keys over the app-wide ones, each
  // under the variable its adapter reads, over the real environment.
  const providerFor = async (site: Site): Promise<ConfigProvider.ConfigProvider> => {
    const [shared, own] = await Promise.all([
      appRuntime.runPromise(Secrets.use.reveal(null)),
      appRuntime.runPromise(Secrets.use.reveal(site.id)),
    ])
    const env: Record<string, string> = {}
    for (const secret of [...shared, ...own]) {
      env[Secrets.variableFor(site, secret.purpose)] = Redacted.value(secret.value)
    }
    return ConfigProvider.orElse(ConfigProvider.fromEnv({ env }), ConfigProvider.fromEnv())
  }

  const runtimeFor = (site: Site): Promise<SiteRuntime> => {
    const existing = cache.get(site.id)
    if (existing) return existing
    const building = providerFor(site).then(
      (provider) => ManagedRuntime.make(siteLayer(site, provider)) as SiteRuntime,
    )
    cache.set(site.id, building)
    // A runtime that failed to build must not be cached as such.
    building.catch(() => cache.delete(site.id))
    return building
  }

  const forget = async (id: SiteId): Promise<void> => {
    const existing = cache.get(id)
    if (!existing) return
    cache.delete(id)
    await existing.then((runtime) => runtime.dispose()).catch(() => {})
  }

  const forgetAll = async (): Promise<void> => {
    const ids = [...cache.keys()] as SiteId[]
    await Promise.all(ids.map(forget))
  }

  // Validate first, so the catalog never stores an entry Sites cannot serve.
  const resolveThenStore = (
    site: ConfigSite,
    store: (site: ConfigSite) => Effect.Effect<void, unknown, Catalog.Service>,
  ) =>
    appRuntime.runPromise(
      Effect.gen(function* () {
        const resolved = yield* Sites.resolve(site)
        yield* store(site)
        return resolved
      }),
    )

  const catalog: CatalogOps = {
    settings: (id) => appRuntime.runPromise(Catalog.use.get(id)),
    add: (site) => resolveThenStore(site, Catalog.use.add),
    update: (site) => resolveThenStore(site, Catalog.use.update),
    remove: (id) => appRuntime.runPromise(Catalog.use.remove(id)),
  }

  const secrets: SecretOps = {
    encryption: () => appRuntime.runPromise(Secrets.use.encryption()),
    list: (scope) => appRuntime.runPromise(Secrets.use.list(scope)),
    set: (scope, purpose, value) =>
      appRuntime.runPromise(Secrets.use.set(scope, purpose, value)),
    remove: (scope, purpose) => appRuntime.runPromise(Secrets.use.remove(scope, purpose)),
  }

  const clients: ClientOps = {
    list: () => appRuntime.runPromise(Clients.use.list()),
    create: (label) => appRuntime.runPromise(Clients.use.create(label)),
    revoke: (id) => appRuntime.runPromise(Clients.use.revoke(id)),
  }

  // A lookup failure reads as "not accepted" rather than a crash of the
  // middleware; the request then gets its 401.
  const auth: AuthOps = {
    accepts: (token) =>
      appRuntime
        .runPromise(Clients.use.authenticate(token))
        .then(Option.isSome, () => false),
    hasActiveClient: () =>
      appRuntime.runPromise(Clients.use.hasActive()).catch(() => false),
  }

  const importEnvironmentKeys = async (): Promise<EnvironmentImport> => {
    const sites = await appRuntime.runPromise(Sites.use.loadSites())
    const entries: Array<{ scope: string | null; purpose: string; value: Redacted.Redacted<string> }> = []
    const fromEnv = (scope: string | null, site: Site | null, purpose: string) => {
      const value = Bun.env[Secrets.variableFor(site, purpose)]
      if (value && value.trim() !== "") entries.push({ scope, purpose, value: Redacted.make(value) })
    }
    // App-wide, both of them: one Ahrefs account rates every site, and one
    // DataForSEO account answers for every Market.
    fromEnv(null, null, "ahrefs")
    fromEnv(null, null, "dataforseo")
    for (const site of sites) {
      if (site.analytics) fromEnv(site.id, site, site.analytics.provider)
      if (site.revenue) fromEnv(site.id, site, site.revenue.provider)
    }
    const stored = await appRuntime.runPromise(Secrets.use.importOnce(entries))
    if (stored !== null && stored > 0) await forgetAll()
    return { stored }
  }

  return {
    debug,
    loadSites: () => appRuntime.runPromise(Sites.use.loadSites()),
    siteFor: (id) => appRuntime.runPromise(Sites.use.siteFor(id)),
    firstSite: async () => {
      const sites = await appRuntime.runPromise(Sites.use.loadSites())
      const first = sites[0]
      if (!first) throw new Error("No sites configured")
      return first
    },
    runtimeFor,
    forget,
    forgetAll,
    catalog,
    secrets,
    clients,
    auth,
    importEnvironmentKeys,
  }
}
