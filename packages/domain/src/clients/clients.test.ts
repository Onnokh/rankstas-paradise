// Clients service tests: a temp-directory table, exercised through create,
// authenticate, revoke, and the "could anything authenticate" question.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Redacted } from "effect"

import { AppDatabase } from "../app-database/app-database.ts"
import { Config } from "../config/config.ts"
import { Clients } from "./clients.ts"
import { InvalidClientError, UnknownClientError } from "./schema.ts"

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

const makeRuntime = (dir: string) =>
  ManagedRuntime.make(
    Clients.layer.pipe(
      Layer.provideMerge(AppDatabase.layer),
      Layer.provide(fakeConfig(dir)),
    ),
  )

let dir: string
let runtime: ReturnType<typeof makeRuntime>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-clients-"))
  runtime = makeRuntime(dir)
})

afterEach(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("Clients", () => {
  test("starts with no clients and nothing that could authenticate", async () => {
    expect(await runtime.runPromise(Clients.use.list())).toEqual([])
    expect(await runtime.runPromise(Clients.use.hasActive())).toBe(false)
  })

  test("create issues an rp_ token whose plaintext is not stored", async () => {
    const { client, token } = await runtime.runPromise(Clients.use.create("  Mac  "))
    const plain = Redacted.value(token)
    expect(plain.startsWith("rp_")).toBe(true)
    expect(plain.length).toBeGreaterThan(40)
    expect(client.label).toBe("Mac")
    expect(client.revokedAt).toBeNull()

    const listed = await runtime.runPromise(Clients.use.list())
    expect(listed).toEqual([client])
    expect(JSON.stringify(listed)).not.toContain(plain)
    expect(await runtime.runPromise(Clients.use.hasActive())).toBe(true)
  })

  test("authenticate accepts the issued token, stamps last use, and rejects others", async () => {
    const { client, token } = await runtime.runPromise(Clients.use.create("Mac"))
    const accepted = await runtime.runPromise(Clients.use.authenticate(Redacted.value(token)))
    expect(Option.isSome(accepted)).toBe(true)
    if (Option.isSome(accepted)) {
      expect(accepted.value.id).toBe(client.id)
      expect(accepted.value.lastUsedAt).not.toBeNull()
    }
    const wrong = await runtime.runPromise(Clients.use.authenticate("rp_not-a-real-token"))
    expect(Option.isNone(wrong)).toBe(true)
    const foreign = await runtime.runPromise(Clients.use.authenticate("some-shared-token"))
    expect(Option.isNone(foreign)).toBe(true)
  })

  test("revoke stops the token and keeps the client on the list", async () => {
    const { client, token } = await runtime.runPromise(Clients.use.create("Mac"))
    const revoked = await runtime.runPromise(Clients.use.revoke(client.id))
    expect(revoked.revokedAt).not.toBeNull()
    const again = await runtime.runPromise(Clients.use.revoke(client.id))
    expect(again.revokedAt).toBe(revoked.revokedAt)

    const after = await runtime.runPromise(Clients.use.authenticate(Redacted.value(token)))
    expect(Option.isNone(after)).toBe(true)
    expect(await runtime.runPromise(Clients.use.hasActive())).toBe(false)
    expect((await runtime.runPromise(Clients.use.list())).map((c) => c.id)).toEqual([client.id])
  })

  test("rejects a blank label and an unknown id", async () => {
    const blank = await runtime.runPromiseExit(Clients.use.create("   "))
    expect(failure(blank)).toBeInstanceOf(InvalidClientError)
    const unknown = await runtime.runPromiseExit(Clients.use.revoke("nope"))
    expect(failure(unknown)).toBeInstanceOf(UnknownClientError)
  })
})
