import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"

import { Config } from "../config/config.ts"
import { type SeoConfig } from "../config/schema.ts"
import { CurrentSite } from "./current-site.ts"
import { SiteId, UnknownSiteError } from "./schema.ts"
import { Sites } from "./sites.ts"

// A fake Config layer providing values directly — no real env/file. Only the
// fields the Sites/CurrentSite code reads matter (siteUrl, sites, dataDirectory,
// debugMode); the rest are filled with plausible placeholders.
const fakeConfig = (
  config: Partial<SeoConfig>,
  opts: { dataDirectory?: string; debugMode?: boolean } = {},
) => {
  const dataDirectory = opts.dataDirectory ?? "/data"
  return Layer.succeed(
    Config.Service,
    Config.Service.of({
      load: () =>
        Effect.succeed({
          googleClientId: config.googleClientId ?? "client-id",
          googleClientSecret:
            config.googleClientSecret ?? Redacted.make("secret"),
          siteUrl: config.siteUrl ?? "sc-domain:example.com",
          sites: config.sites,
        }),
      dataDirectory: () => Effect.succeed(dataDirectory),
      tokenPath: () => Effect.succeed(`${dataDirectory}/google-token.json`),
      debugMode: () => Effect.succeed(opts.debugMode ?? false),
      ensureDataDirectory: () => Effect.void,
    }),
  )
}

const run = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<Exit.Exit<A, E>> =>
  effect.pipe(Effect.scoped, Effect.runPromiseExit)

describe("Sites.loadSites", () => {
  test("normalizes an sc-domain property and fills defaults", async () => {
    const layer = Sites.layer.pipe(
      Layer.provide(
        fakeConfig({
          sites: [{ id: "example", siteUrl: "sc-domain:example.com" }],
        }),
      ),
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
      },
    ])
  })

  test("strips a trailing slash and keeps explicit overrides", async () => {
    const layer = Sites.layer.pipe(
      Layer.provide(
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
      ),
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
    })
  })

  test("derives a single site from legacy siteUrl when sites[] is absent", async () => {
    const layer = Sites.layer.pipe(
      Layer.provide(fakeConfig({ siteUrl: "sc-domain:acme.co.uk" })),
    )
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
      },
    ])
  })
})

describe("Sites.siteFor", () => {
  test("resolves a known site", async () => {
    const layer = Sites.layer.pipe(
      Layer.provide(
        fakeConfig({
          sites: [{ id: "example", siteUrl: "sc-domain:example.com" }],
        }),
      ),
    )
    const exit = await run(
      Sites.use.siteFor(SiteId.make("example")).pipe(Effect.provide(layer)),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.id).toBe(SiteId.make("example"))
  })

  test("fails with UnknownSiteError listing available ids", async () => {
    const layer = Sites.layer.pipe(
      Layer.provide(
        fakeConfig({
          sites: [
            { id: "one", siteUrl: "sc-domain:one.com" },
            { id: "two", siteUrl: "sc-domain:two.com" },
          ],
        }),
      ),
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
      Layer.provide(fakeConfig({}, { debugMode: true })),
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
      { dataDirectory: "/data" },
    )
    const sitesLayer = Sites.layer.pipe(Layer.provide(config))
    const layer = CurrentSite.layerFor(SiteId.make("example")).pipe(
      Layer.provide(Layer.mergeAll(sitesLayer, config)),
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
    const sitesLayer = Sites.layer.pipe(Layer.provide(config))
    const layer = CurrentSite.layerFor(SiteId.make("nope")).pipe(
      Layer.provide(Layer.mergeAll(sitesLayer, config)),
    )
    const exit = await run(
      CurrentSite.use.current().pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(UnknownSiteError)
  })
})
