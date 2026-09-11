// Tests for the API keys that replaced the Clients service.
//
// The contract these hold is the one the deployment depends on: a key opens the
// door, a revoked key does not, the plaintext is never stored, and the server
// can issue its first key with nobody signed in. The last one matters because
// the machines are re-keyed before the Google client even exists.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, ManagedRuntime, Redacted } from "effect"

import { AppDatabase } from "@rp/domain/app-database/app-database"
import { Config } from "@rp/domain/config/config"

import { makeAuth } from "./auth.ts"
import { makeAuthOperations } from "./keys.ts"

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

let dir: string
const dbPath = () => `${dir}/rankstas-paradise.sqlite`

// Run the real migrations, then let the file go, exactly as the server does
// before it builds Better Auth.
const migrate = async () => {
  const runtime = ManagedRuntime.make(
    AppDatabase.layer.pipe(Layer.provide(fakeConfig(dir))),
  )
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* AppDatabase.Service
    }),
  )
  await runtime.dispose()
}

const operations = async () =>
  makeAuthOperations(makeAuth(dbPath(), "http://localhost:8790"))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rp-keys-"))
  process.env.RP_OWNER_EMAIL = "owner@example.com"
  process.env.RP_AUTH_SECRET = "test-secret-not-used-for-keys"
  delete process.env.RP_ALLOWED_EMAILS
  await migrate()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("a key is issued with nobody signed in, and opens the door", async () => {
  // No allowlist, no Google client, no session: the deployment has only its
  // environment. Issuing must still work, or the machines could never be
  // re-keyed.
  const keys = await operations()
  const { client, token } = await keys.create("Onno's MacBook")

  expect(client.label).toBe("Onno's MacBook")
  expect(client.revokedAt).toBeNull()
  expect(Redacted.value(token).startsWith("rp_")).toBe(true)
  expect(await keys.accepts(Redacted.value(token))).toBe(true)
})

test("the plaintext is never stored", async () => {
  const keys = await operations()
  const { token } = await keys.create("Agent")
  const plaintext = Redacted.value(token)

  const db = new Database(dbPath())
  const rows = db.query(`select key, start from apikey`).all() as Array<{
    key: string
    start: string | null
  }>
  db.close()

  expect(rows).toHaveLength(1)
  expect(rows[0]!.key).not.toBe(plaintext)
  // What IS kept is a leading fragment, so a list can name a key without
  // holding one that works.
  expect(plaintext.startsWith(rows[0]!.start!)).toBe(true)
  expect(await keys.accepts(rows[0]!.key)).toBe(false)
})

test("a revoked key stops working and stays on the list", async () => {
  const keys = await operations()
  const { client, token } = await keys.create("Old laptop")
  expect(await keys.accepts(Redacted.value(token))).toBe(true)

  const revoked = await keys.revoke(client.id)
  expect(revoked.revokedAt).not.toBeNull()
  expect(await keys.accepts(Redacted.value(token))).toBe(false)

  const listed = await keys.list()
  expect(listed.map((entry) => entry.id)).toEqual([client.id])
  expect(listed[0]!.revokedAt).not.toBeNull()
})

test("a well-formed token that was never issued is refused", async () => {
  // Neuter the check the cheap way: keep the prefix the middleware looks for,
  // so the only thing that can reject this token is the lookup itself.
  const keys = await operations()
  await keys.create("Mac")
  expect(await keys.accepts("rp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
    false,
  )
  expect(await keys.accepts("not-even-a-key")).toBe(false)
})

test("a blank label is refused, and an unknown id cannot be revoked", async () => {
  const keys = await operations()
  expect(keys.create("   ")).rejects.toMatchObject({ _tag: "InvalidClientError" })
  expect(keys.revoke("nope")).rejects.toMatchObject({
    _tag: "UnknownClientError",
  })
})

test("hasActiveClient follows the only key there is", async () => {
  // This is what decides 503 (nothing could ever authenticate) against 401
  // (you just did not), so it has to track the last key going away.
  const keys = await operations()
  expect(await keys.hasActiveClient()).toBe(false)

  const { client } = await keys.create("TUI")
  expect(await keys.hasActiveClient()).toBe(true)

  await keys.revoke(client.id)
  expect(await keys.hasActiveClient()).toBe(false)
})

test("keys survive a restart, because the owner row is found and not remade", async () => {
  const first = await operations()
  const { token } = await first.create("Mac")

  // A second process against the same file: a NEW owner row here would orphan
  // every key issued by the first, and the Mac would get a 401 after a deploy.
  const second = await operations()
  expect(await second.accepts(Redacted.value(token))).toBe(true)
  expect((await second.list()).map((entry) => entry.label)).toEqual(["Mac"])

  const db = new Database(dbPath())
  const users = db.query(`select id from user`).all()
  db.close()
  expect(users).toHaveLength(1)
})
