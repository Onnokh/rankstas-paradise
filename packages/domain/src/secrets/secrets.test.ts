// Secrets service tests: a temp-directory vault under a fixed master key,
// exercised through set/list/reveal/remove, plus the two failure shapes that
// matter operationally — no master key, and a different master key.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect"

import { AppDatabase } from "../app-database/app-database.ts"
import { Config } from "../config/config.ts"
import {
  EncryptionUnavailableError,
  InvalidSecretError,
  SecretsError,
  UnknownSecretError,
} from "./schema.ts"
import { Secrets } from "./secrets.ts"

const fakeConfig = (dataDirectory: string) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      load: () => Effect.succeed({ siteUrl: "sc-domain:example.com" }),
      dataDirectory: () => Effect.succeed(dataDirectory),
      serviceAccountPath: () =>
        Effect.succeed(`${dataDirectory}/google-service-account.json`),
      debugMode: () => Effect.succeed(false),
      ensureDataDirectory: () => Effect.void,
    }),
  )

// 32 zero bytes and 32 one bytes, base64: valid keys that differ.
const keyA = Buffer.alloc(32, 0).toString("base64")
const keyB = Buffer.alloc(32, 1).toString("base64")

const vault = (dir: string, env: Record<string, string>) =>
  ManagedRuntime.make(
    Secrets.layer.pipe(
      Layer.provideMerge(AppDatabase.layer),
      Layer.provide(fakeConfig(dir)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  )

let dir: string
let runtime: ReturnType<typeof vault>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-secrets-"))
  runtime = vault(dir, { RP_MASTER_KEY: keyA })
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("Secrets", () => {
  test("reports encryption as configured under a valid master key", async () => {
    expect(await runtime.runPromise(Secrets.use.encryption())).toEqual({
      configured: true,
      reason: null,
    })
  })

  test("set stores a secret and list shows only its status", async () => {
    const status = await runtime.runPromise(
      Secrets.use.set("shop", "polar", Redacted.make("polar_oat_secret1234")),
    )
    expect(status.scope).toBe("shop")
    expect(status.purpose).toBe("polar")
    expect(status.last4).toBe("1234")

    const listed = await runtime.runPromise(Secrets.use.list("shop"))
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain("secret1234")
    expect(await runtime.runPromise(Secrets.use.list(null))).toEqual([])
  })

  test("reveal decrypts the values of one scope and set replaces them", async () => {
    await runtime.runPromise(Secrets.use.set("shop", "polar", Redacted.make("first-value-1")))
    await runtime.runPromise(Secrets.use.set(null, "ahrefs", Redacted.make("shared-value-2")))
    await runtime.runPromise(Secrets.use.set("shop", "polar", Redacted.make("second-value-3")))

    const own = await runtime.runPromise(Secrets.use.reveal("shop"))
    expect(own.map((s) => [s.purpose, Redacted.value(s.value)])).toEqual([
      ["polar", "second-value-3"],
    ])
    const shared = await runtime.runPromise(Secrets.use.reveal(null))
    expect(shared.map((s) => [s.purpose, Redacted.value(s.value)])).toEqual([
      ["ahrefs", "shared-value-2"],
    ])
  })

  test("remove drops a secret and fails for one that is not there", async () => {
    await runtime.runPromise(Secrets.use.set("shop", "polar", Redacted.make("value-value")))
    await runtime.runPromise(Secrets.use.remove("shop", "polar"))
    expect(await runtime.runPromise(Secrets.use.list("shop"))).toEqual([])
    const exit = await runtime.runPromiseExit(Secrets.use.remove("shop", "polar"))
    expect(failure(exit)).toBeInstanceOf(UnknownSecretError)
  })

  test("rejects an unsafe purpose and a blank value", async () => {
    const badPurpose = await runtime.runPromiseExit(
      Secrets.use.set("shop", "Polar Key", Redacted.make("value-value")),
    )
    expect(failure(badPurpose)).toBeInstanceOf(InvalidSecretError)
    const blank = await runtime.runPromiseExit(
      Secrets.use.set("shop", "polar", Redacted.make("   ")),
    )
    expect(failure(blank)).toBeInstanceOf(InvalidSecretError)
  })

  test("short values keep no last4", async () => {
    const status = await runtime.runPromise(
      Secrets.use.set("shop", "polar", Redacted.make("short")),
    )
    expect(status.last4).toBe("")
  })

  test("without a master key: not configured, writes fail, reveal is empty", async () => {
    const bare = vault(dir, {})
    try {
      const status = await bare.runPromise(Secrets.use.encryption())
      expect(status.configured).toBe(false)
      expect(status.reason).toContain("RP_MASTER_KEY")
      const exit = await bare.runPromiseExit(
        Secrets.use.set("shop", "polar", Redacted.make("value-value")),
      )
      expect(failure(exit)).toBeInstanceOf(EncryptionUnavailableError)
      expect(await bare.runPromise(Secrets.use.reveal("shop"))).toEqual([])
    } finally {
      await bare.dispose()
    }
  })

  test("a malformed master key is reported, not fatal", async () => {
    const bad = vault(dir, { RP_MASTER_KEY: "too-short" })
    try {
      const status = await bad.runPromise(Secrets.use.encryption())
      expect(status.configured).toBe(false)
      expect(status.reason).toContain("32 random bytes")
    } finally {
      await bad.dispose()
    }
  })

  test("a value stored under one master key cannot be revealed under another", async () => {
    await runtime.runPromise(Secrets.use.set("shop", "polar", Redacted.make("value-value")))
    const other = vault(dir, { RP_MASTER_KEY: keyB })
    try {
      // Statuses still list; only decryption fails, and it says why.
      expect(await other.runPromise(Secrets.use.list("shop"))).toHaveLength(1)
      const exit = await other.runPromiseExit(Secrets.use.reveal("shop"))
      const error = failure(exit)
      expect(error).toBeInstanceOf(SecretsError)
      expect((error as SecretsError).message).toContain("RP_MASTER_KEY")
    } finally {
      await other.dispose()
    }
  })
})
