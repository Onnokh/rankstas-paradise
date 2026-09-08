import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Layer } from "effect"

import { AppDatabase } from "../app-database/app-database.ts"
import { Catalog } from "../catalog/catalog.ts"
import { Config } from "../config/config.ts"
import { ConfigLoadError, type SeoConfig } from "../config/schema.ts"
import { CurrentSite } from "./current-site.ts"
import { SiteId, UnknownSiteError } from "./schema.ts"
import { Sites } from "./sites.ts"

// A fake Config layer providing values directly — no real env/file. Only the
// fields the Sites/CurrentSite code reads matter (siteUrl, sites, dataDirectory,
// debugMode); the key path is a plausible placeholder.
const fakeConfig = (
  config: Partial<SeoConfig>,
  opts: { dataDirectory?: string; debugMode?: boolean } = {},
) => {
  const dataDirectory =
    opts.dataDirectory ?? mkdtempSync(join(tmpdir(), "rp-sites-"))
  return Layer.succeed(
    Config.Service,
    Config.Service.of({
      load: () =>
        Effect.succeed({
          siteUrl: config.siteUrl ?? "sc-domain:example.com",
          sites: config.sites,
        }),
      dataDirectory: () => Effect.succeed(dataDirectory),
      serviceAccountPath: () =>
        Effect.succeed(`${dataDirectory}/google-service-account.json`),
      debugMode: () => Effect.succeed(opts.debugMode ?? false),
      ensureDataDirectory: () => Effect.void,
    }),
  )
}

// Sites over a fresh Catalog in the fake Config's data directory (a temp dir by
// default), so each test starts from an empty catalog.
const sitesLayer = (config: Layer.Layer<Config.Service>) =>
  Sites.layer.pipe(
    Layer.provideMerge(Catalog.layer),
    Layer.provideMerge(AppDatabase.layer),
    Layer.provide(config),
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<Exit.Exit<A, E>> =>
  effect.pipe(Effect.scoped, Effect.runPromiseExit)

describe("Sites.loadSites", () => {
  test("normalizes an sc-domain property and fills defaults", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [{ id: "example", siteUrl: "sc-domain:example.com" }],
      }),
    )
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    const sites = Exit.isSuccess(exit) ? exit.value : undefined
    expect(sites).toEqual([
      {
        id: SiteId.make("example"),
        name: "example",
        property: "sc-domain:example.com",
        origin: "https://example.com",
        sitemapUrl: "https://example.com/sitemap.xml",
        brandTerms: ["example"],
        market: {
          locationCode: 2840,
          languageCode: "en",
          label: "United States",
          provider: "labs",
        },
      },
    ])
  })

  test("strips a trailing slash and keeps explicit overrides", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [
          {
            id: SiteId.make("bar"),
            name: "Bar Co",
            siteUrl: "https://bar.test/",
            sitemapUrl: "https://bar.test/custom-sitemap.xml",
            brandTerms: ["bar", "barco"],
          },
        ],
      }),
    )
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    const sites = Exit.isSuccess(exit) ? exit.value : []
    expect(sites[0]).toEqual({
      id: SiteId.make("bar"),
      name: "Bar Co",
      property: "https://bar.test/",
      origin: "https://bar.test",
      sitemapUrl: "https://bar.test/custom-sitemap.xml",
      brandTerms: ["bar", "barco"],
      market: {
        locationCode: 2840,
        languageCode: "en",
        label: "United States",
        provider: "labs",
      },
    })
  })

  test("derives a single site from legacy siteUrl when sites[] is absent", async () => {
    const layer = sitesLayer(fakeConfig({ siteUrl: "sc-domain:acme.co.uk" }))
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    const sites = Exit.isSuccess(exit) ? exit.value : []
    expect(sites).toEqual([
      {
        id: SiteId.make("acme"),
        name: "acme",
        property: "sc-domain:acme.co.uk",
        origin: "https://acme.co.uk",
        sitemapUrl: "https://acme.co.uk/sitemap.xml",
        brandTerms: ["acme"],
        market: {
          locationCode: 2840,
          languageCode: "en",
          label: "United States",
          provider: "labs",
        },
      },
    ])
  })
})

describe("Sites catalog import", () => {
  test("imports config.json once; later changes to the file are not read", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "rp-sites-"))
    const first = sitesLayer(
      fakeConfig(
        { sites: [{ id: "one", siteUrl: "sc-domain:one.example" }] },
        { dataDirectory },
      ),
    )
    const before = await run(Sites.use.loadSites().pipe(Effect.provide(first)))
    expect(Exit.isSuccess(before) ? before.value.map((s) => String(s.id)) : []).toEqual(["one"])

    // Same catalog, different file contents: the catalog wins.
    const second = sitesLayer(
      fakeConfig(
        { sites: [{ id: "two", siteUrl: "sc-domain:two.example" }] },
        { dataDirectory },
      ),
    )
    const after = await run(Sites.use.loadSites().pipe(Effect.provide(second)))
    expect(Exit.isSuccess(after) ? after.value.map((s) => String(s.id)) : []).toEqual(["one"])
  })

  test("a deployment with no config and no SITE_URL has an empty catalog", async () => {
    const layer = Sites.layer.pipe(
      Layer.provideMerge(Catalog.layer),
      Layer.provideMerge(AppDatabase.layer),
      Layer.provide(
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            load: () =>
              Effect.fail(
                new ConfigLoadError({
                  message: "Missing config: set siteUrl in config.json (or SITE_URL in the environment)",
                }),
              ),
            dataDirectory: () => Effect.succeed(mkdtempSync(join(tmpdir(), "rp-sites-"))),
            serviceAccountPath: () => Effect.succeed("/nowhere"),
            debugMode: () => Effect.succeed(false),
            ensureDataDirectory: () => Effect.void,
          }),
        ),
      ),
    )
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual([])
  })
})

describe("Sites.siteFor", () => {
  test("resolves a known site", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [{ id: "example", siteUrl: "sc-domain:example.com" }],
      }),
    )
    const exit = await run(
      Sites.use.siteFor(SiteId.make("example")).pipe(Effect.provide(layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.id).toBe(SiteId.make("example"))
  })

  test("fails with UnknownSiteError listing available ids", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [
          { id: "one", siteUrl: "sc-domain:one.com" },
          { id: "two", siteUrl: "sc-domain:two.com" },
        ],
      }),
    )
    const exit = await run(
      Sites.use.siteFor(SiteId.make("missing")).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit)
      ? Cause.squash(exit.cause)
      : undefined
    expect(error).toBeInstanceOf(UnknownSiteError)
    expect((error as UnknownSiteError).siteId).toBe("missing")
    expect((error as UnknownSiteError).available).toEqual(["one", "two"])
  })
})

describe("CurrentSite", () => {
  const site = {
    id: SiteId.make("example"),
    name: "example",
    property: "sc-domain:example.com",
    origin: "https://example.com",
    sitemapUrl: "https://example.com/sitemap.xml",
    brandTerms: ["example"],
  }

  test("layerForSite provides the active site and per-site paths", async () => {
    const layer = CurrentSite.layerForSite(site).pipe(
      Layer.provide(fakeConfig({}, { dataDirectory: "/data" })),
    )
    const exit = await run(
      Effect.gen(function* () {
        return {
          current: yield* CurrentSite.use.current(),
          dataDirectory: yield* CurrentSite.use.dataDirectory(),
          databasePath: yield* CurrentSite.use.databasePath(),
          registryPath: yield* CurrentSite.use.registryPath(),
          sitemapPath: yield* CurrentSite.use.sitemapPath(),
        }
      }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.current).toEqual(site)
      expect(exit.value.dataDirectory).toBe("/data/sites/example")
      expect(exit.value.databasePath).toBe(
        "/data/sites/example/search-console.sqlite",
      )
      expect(exit.value.registryPath).toBe(
        "/data/sites/example/keyword-registry.csv",
      )
      expect(exit.value.sitemapPath).toBe("/data/sites/example/sitemap.json")
    }
  })

  test("databasePath uses the .debug suffix in debug mode", async () => {
    const layer = CurrentSite.layerForSite(site).pipe(
      Layer.provide(fakeConfig({}, { dataDirectory: "/data", debugMode: true })),
    )
    const exit = await run(
      CurrentSite.use.databasePath().pipe(Effect.provide(layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit))
      expect(exit.value).toBe(
        "/data/sites/example/search-console.debug.sqlite",
      )
  })

  test("layerFor resolves the site id through the Sites catalog", async () => {
    const config = fakeConfig(
      { sites: [{ id: "example", siteUrl: "sc-domain:example.com" }] },
    )
    const sites = sitesLayer(config)
    const layer = CurrentSite.layerFor(SiteId.make("example")).pipe(
      Layer.provide(Layer.mergeAll(sites, config)),
    )
    const exit = await run(
      CurrentSite.use.current().pipe(Effect.provide(layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.id).toBe(SiteId.make("example"))
  })

  test("layerFor fails with UnknownSiteError for an unknown id", async () => {
    const config = fakeConfig({
      sites: [{ id: "example", siteUrl: "sc-domain:example.com" }],
    })
    const sites = sitesLayer(config)
    const layer = CurrentSite.layerFor(SiteId.make("nope")).pipe(
      Layer.provide(Layer.mergeAll(sites, config)),
    )
    const exit = await run(
      CurrentSite.use.current().pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(UnknownSiteError)
  })
})

describe("Sites.loadSites analytics", () => {
  test("fills the analytics defaults and trims the base URL", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [
          {
            id: "example",
            siteUrl: "sc-domain:example.com",
            analytics: {
              provider: "rybbit",
              siteId: "12",
              baseUrl: "https://rybbit.example.com/",
            },
          },
        ],
      }),
    )
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    const sites = Exit.isSuccess(exit) ? exit.value : undefined
    expect(sites?.[0]?.analytics).toEqual({
      provider: "rybbit",
      siteId: "12",
      baseUrl: "https://rybbit.example.com",
      timeZone: "UTC",
    })
  })

  test("fills the revenue defaults, borrowing the analytics zone", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [
          {
            id: "shop",
            siteUrl: "sc-domain:shop.example",
            analytics: { provider: "rybbit", siteId: "1", timeZone: "Europe/Amsterdam" },
            revenue: { provider: "polar" },
          },
          {
            id: "other",
            siteUrl: "sc-domain:other.example",
            revenue: {
              provider: "polar",
              accountId: "org_1",
              keyVariable: "POLAR_API_KEY_OTHER",
              baseUrl: "https://sandbox-api.polar.sh/",
              timeZone: "America/New_York",
            },
          },
        ],
      }),
    )
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    const sites = Exit.isSuccess(exit) ? exit.value : undefined
    expect(sites?.[0]?.revenue).toEqual({
      provider: "polar",
      accountId: null,
      keyVariable: "POLAR_API_KEY",
      baseUrl: null,
      timeZone: "Europe/Amsterdam",
    })
    expect(sites?.[1]?.revenue).toEqual({
      provider: "polar",
      accountId: "org_1",
      keyVariable: "POLAR_API_KEY_OTHER",
      baseUrl: "https://sandbox-api.polar.sh",
      timeZone: "America/New_York",
    })
  })

  test("a site without an analytics block has none", async () => {
    const layer = sitesLayer(
      fakeConfig({
        sites: [{ id: "example", siteUrl: "sc-domain:example.com" }],
      }),
    )
    const exit = await run(Sites.use.loadSites().pipe(Effect.provide(layer)))
    const sites = Exit.isSuccess(exit) ? exit.value : undefined
    expect(sites?.[0]?.analytics).toBeUndefined()
    expect(sites?.[0]?.revenue).toBeUndefined()
  })
})
