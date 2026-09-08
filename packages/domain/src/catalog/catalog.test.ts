// Catalog service tests: a temp-directory SQLite catalog, exercised through
// add/get/update/remove and the one-time import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"

import { Config } from "../config/config.ts"
import { type ConfigSite } from "../config/schema.ts"
import { SiteExistsError, UnknownSiteError } from "../sites/schema.ts"
import { Catalog } from "./catalog.ts"
import { type CatalogError } from "./schema.ts"

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

let dir: string
let runtime: ManagedRuntime.ManagedRuntime<Catalog.Service, CatalogError>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-catalog-"))
  runtime = ManagedRuntime.make(
    Catalog.layer.pipe(Layer.provide(fakeConfig(dir))),
  )
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

  test("get, update, and remove fail with UnknownSiteError for a missing id", async () => {
    await run(Catalog.use.add(example))
    for (const effect of [
      Catalog.use.get("missing"),
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
    const debugRuntime = ManagedRuntime.make(
      Catalog.layer.pipe(Layer.provide(fakeConfig(dir, true))),
    )
    try {
      await debugRuntime.runPromise(Catalog.use.add(example))
      expect(await run(Catalog.use.list())).toEqual([])
      expect(await Bun.file(join(dir, "rankstas-paradise.debug.sqlite")).exists()).toBe(true)
    } finally {
      await debugRuntime.dispose()
    }
  })
})
