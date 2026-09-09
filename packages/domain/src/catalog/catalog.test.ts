// Catalog service tests: a temp-directory SQLite catalog, exercised through
// add/get/update/remove and the one-time import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"

import { AppDatabase } from "../app-database/app-database.ts"
import { Config } from "../config/config.ts"
import { type ConfigSite } from "../config/schema.ts"
import { SiteExistsError, UnknownSiteError } from "../sites/schema.ts"
import { Catalog } from "./catalog.ts"

const fakeConfig = (dataDirectory: string, debugMode = false) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      load: () => Effect.succeed({ siteUrl: "sc-domain:example.com" }),
      dataDirectory: () => Effect.succeed(dataDirectory),
      serviceAccountPath: () =>
        Effect.succeed(`${dataDirectory}/google-service-account.json`),
      debugMode: () => Effect.succeed(debugMode),
      ensureDataDirectory: () => Effect.void,
    }),
  )

const makeRuntime = (dir: string, debugMode = false) =>
  ManagedRuntime.make(
    Catalog.layer.pipe(
      Layer.provideMerge(AppDatabase.layer),
      Layer.provide(fakeConfig(dir, debugMode)),
    ),
  )

let dir: string
let runtime: ReturnType<typeof makeRuntime>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-catalog-"))
  runtime = makeRuntime(dir)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Catalog.Service>) =>
  runtime.runPromise(effect)
const runExit = <A, E>(effect: Effect.Effect<A, E, Catalog.Service>) =>
  runtime.runPromiseExit(effect)

const example: ConfigSite = {
  id: "example",
  name: "Example",
  siteUrl: "sc-domain:example.com",
  brandTerms: ["example"],
  analytics: { provider: "rybbit", siteId: "1" },
}

describe("Catalog", () => {
  test("starts empty and lists entries in the order they were added", async () => {
    expect(await run(Catalog.use.list())).toEqual([])
    await run(Catalog.use.add({ id: "zeta", siteUrl: "sc-domain:zeta.example" }))
    await run(Catalog.use.add({ id: "alpha", siteUrl: "sc-domain:alpha.example" }))
    const ids = (await run(Catalog.use.list())).map((site) => site.id)
    expect(ids).toEqual(["zeta", "alpha"])
  })

  test("stores every setting and returns it unchanged", async () => {
    await run(Catalog.use.add(example))
    expect(await run(Catalog.use.get("example"))).toEqual(example)
  })

  test("refuses a second entry under the same id", async () => {
    await run(Catalog.use.add(example))
    const exit = await runExit(Catalog.use.add(example))
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(SiteExistsError)
  })

  test("update replaces the settings of an existing entry", async () => {
    await run(Catalog.use.add(example))
    const changed = { ...example, name: "Renamed", analytics: undefined }
    await run(Catalog.use.update(changed))
    const stored = await run(Catalog.use.get("example"))
    expect(stored.name).toBe("Renamed")
    expect(stored.analytics).toBeUndefined()
  })

  test("patch changes the named settings and leaves the rest as stored", async () => {
    // The whole reason `patch` exists beside `update`: a caller that holds one
    // setting must not have to resend the other six, and a caller that forgot
    // one must not silently lose it. A Market write from an agent is exactly
    // that caller.
    const full: ConfigSite = {
      ...example,
      sitemapUrl: "https://example.com/sitemap-index.xml",
      revenue: { provider: "polar" },
      market: { locationCode: 2840, languageCode: "en" },
    }
    await run(Catalog.use.add(full))

    const patched = await run(
      Catalog.use.patch("example", { market: { locationCode: 2528, languageCode: "nl" } }),
    )
    expect(patched).toEqual({ ...full, market: { locationCode: 2528, languageCode: "nl" } })
    // Answered from the same transaction that wrote it, so the answer and the
    // store cannot disagree.
    expect(await run(Catalog.use.get("example"))).toEqual(patched)
  })

  test("patch adds a setting the entry never had", async () => {
    // The printfeest case: the entry names no Market at all, so the patch has
    // nothing to replace and must still land.
    await run(Catalog.use.add(example))
    const patched = await run(
      Catalog.use.patch("example", { market: { locationCode: 2528 } }),
    )
    expect(patched.market).toEqual({ locationCode: 2528 })
    expect(patched.analytics).toEqual(example.analytics)
    expect(patched.brandTerms).toEqual(["example"])
  })

  test("patch ignores a key whose value is undefined", async () => {
    // A caller building a patch from optional fields sends `{ market:
    // undefined }` without meaning to clear the Market. Clearing a setting is
    // `update`'s job, where it is written out.
    const withMarket = { ...example, market: { locationCode: 2528, languageCode: "nl" } }
    await run(Catalog.use.add(withMarket))
    const patched = await run(Catalog.use.patch("example", { market: undefined }))
    expect(patched.market).toEqual({ locationCode: 2528, languageCode: "nl" })
  })

  test("patch cannot change the id it was addressed by", async () => {
    await run(Catalog.use.add(example))
    const patched = await run(
      Catalog.use.patch("example", { name: "Renamed" } as Partial<ConfigSite>),
    )
    expect(patched.id).toBe("example")
    expect(patched.name).toBe("Renamed")
  })

  test("get, patch, update, and remove fail with UnknownSiteError for a missing id", async () => {
    await run(Catalog.use.add(example))
    for (const effect of [
      Catalog.use.get("missing"),
      Catalog.use.patch("missing", { market: { locationCode: 2528 } }),
      Catalog.use.update({ id: "missing", siteUrl: "sc-domain:m.example" }),
      Catalog.use.remove("missing"),
    ]) {
      const exit = await runExit(effect)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(UnknownSiteError)
      expect((error as UnknownSiteError).available).toEqual(["example"])
    }
  })

  test("remove drops the entry", async () => {
    await run(Catalog.use.add(example))
    await run(Catalog.use.remove("example"))
    expect(await run(Catalog.use.list())).toEqual([])
  })

  test("importOnce stores the entries the first time and nothing afterwards", async () => {
    const first = await run(
      Catalog.use.importOnce([
        example,
        { id: "second", siteUrl: "sc-domain:second.example" },
      ]),
    )
    expect(first).toBe(true)
    expect((await run(Catalog.use.list())).map((site) => site.id)).toEqual([
      "example",
      "second",
    ])

    // Even with the catalog emptied, the import does not run again.
    await run(Catalog.use.remove("example"))
    await run(Catalog.use.remove("second"))
    const second = await run(Catalog.use.importOnce([example]))
    expect(second).toBe(false)
    expect(await run(Catalog.use.list())).toEqual([])
  })

  test("uses a .debug database in debug mode", async () => {
    const debugRuntime = makeRuntime(dir, true)
    try {
      await debugRuntime.runPromise(Catalog.use.add(example))
      expect(await run(Catalog.use.list())).toEqual([])
      expect(await Bun.file(join(dir, "rankstas-paradise.debug.sqlite")).exists()).toBe(true)
    } finally {
      await debugRuntime.dispose()
    }
  })
})
