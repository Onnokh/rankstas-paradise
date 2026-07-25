// Config service tests. Config is injected through a fake `ConfigProvider`
// (the "environment"), and a real temp config.json plays the file — so the
// env-wins-over-file precedence is exercised without touching the developer's
// real ~/.config or process environment.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Cause, ConfigProvider, Effect, Exit } from "effect"

import { Config } from "./config.ts"
import { ConfigLoadError } from "./schema.ts"

let home: string
let appHome: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rp-config-"))
  appHome = join(home, "rankstas-paradise")
  await mkdir(appHome, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const writeConfigFile = (contents: unknown) =>
  writeFile(join(appHome, "config.json"), JSON.stringify(contents))

// Build the Config service on top of an in-memory provider standing in for the
// environment, always pointing XDG_CONFIG_HOME at the per-test temp home.
const runWith = <A, E>(
  env: Record<string, string>,
  effect: Effect.Effect<A, E, Config.Service>,
) =>
  effect.pipe(
    Effect.provide(
      Config.layerFromProvider(
        ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: home, ...env } }),
      ),
    ),
    Effect.runPromise,
  )

describe("Config.load precedence", () => {
  test("environment wins over the file for shared keys", async () => {
    await writeConfigFile({ siteUrl: "https://file.example" })

    const config = await runWith(
      { SITE_URL: "https://env.example" },
      Config.use.load(),
    )

    expect(config.siteUrl).toBe("https://env.example")
  })

  test("file values are used when the environment is silent", async () => {
    await writeConfigFile({
      siteUrl: "https://file.example",
      sites: [{ id: "a", siteUrl: "https://a.example" }],
    })

    const config = await runWith({}, Config.use.load())

    expect(config.siteUrl).toBe("https://file.example")
    expect(config.sites).toEqual([{ id: "a", siteUrl: "https://a.example" }])
  })
})

describe("Config.load missing config", () => {
  test("fails closed with ConfigLoadError when required fields are absent", async () => {
    // No file written, empty environment: nothing satisfies the required keys.
    const result = await Config.use
      .load()
      .pipe(
        Effect.provide(
          Config.layerFromProvider(
            ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: home } }),
          ),
        ),
        Effect.runPromiseExit,
      )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = Cause.findErrorOption(result.cause)
      expect(failure._tag).toBe("Some")
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigLoadError)
      }
    }
  })
})

describe("Config.debugMode", () => {
  test("reads DEBUG from config, defaulting to false", async () => {
    const on = await runWith({ DEBUG: "true" }, Config.use.debugMode())
    const off = await runWith({}, Config.use.debugMode())
    expect(on).toBe(true)
    expect(off).toBe(false)
  })
})

describe("Config paths", () => {
  test("derives the XDG data directory and service-account key path", async () => {
    const dataDir = await runWith({}, Config.use.dataDirectory())
    const key = await runWith({}, Config.use.serviceAccountPath())
    expect(dataDir).toBe(appHome)
    expect(key).toBe(join(appHome, "google-service-account.json"))
  })

  test("GOOGLE_SERVICE_ACCOUNT_FILE overrides the default key path", async () => {
    const key = await runWith(
      { GOOGLE_SERVICE_ACCOUNT_FILE: "/run/secrets/sa.json" },
      Config.use.serviceAccountPath(),
    )
    expect(key).toBe("/run/secrets/sa.json")
  })
})
