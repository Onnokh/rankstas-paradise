// Secrets service: vendor keys, encrypted at rest in the app-level database.
//
// Encryption is AES-256-GCM under one master key from the environment,
// RP_MASTER_KEY (32 random bytes, base64). Each value gets a fresh 96-bit nonce,
// and the scope and purpose are bound in as additional authenticated data, so a
// ciphertext cannot be moved to another row. The master key is the only secret
// left in the environment once every vendor key is stored here; anyone who
// holds it can decrypt the vault, so this protects copies of the volume, not
// against an operator with env access.
//
// Values are `Redacted` on both sides of the boundary. Nothing here logs,
// serializes, or returns a plaintext except `reveal`, whose one caller builds
// the per-site ConfigProvider the vendor adapters read their key from.
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { type SqlError } from "effect/unstable/sql"

import { AppDatabase } from "../app-database/app-database.ts"
import { defaultKeyVariable } from "../revenue/schema.ts"
import { serviceUse } from "../service-use.ts"
import { type Site } from "../sites/schema.ts"
import {
  type EncryptionStatus,
  EncryptionUnavailableError,
  InvalidSecretError,
  type SecretStatus,
  SecretsError,
  UnknownSecretError,
} from "./schema.ts"

export interface Interface {
  // Whether values can be stored and read back on this deployment.
  readonly encryption: () => Effect.Effect<EncryptionStatus>
  // The stored secrets of one scope (a site id, or null for app-wide), oldest
  // first. Statuses only, never values.
  readonly list: (
    scope: string | null,
  ) => Effect.Effect<ReadonlyArray<SecretStatus>, SecretsError>
  // Store or replace one secret.
  readonly set: (
    scope: string | null,
    purpose: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<
    SecretStatus,
    SecretsError | EncryptionUnavailableError | InvalidSecretError
  >
  // Remove one secret.
  readonly remove: (
    scope: string | null,
    purpose: string,
  ) => Effect.Effect<void, SecretsError | UnknownSecretError>
  // The one-time import of keys the environment already holds: stores every
  // entry whose slot is empty and records that the import ran. Null when it
  // did not run — encryption is not configured yet (it runs on a later start),
  // or it ran before. Otherwise how many were stored.
  readonly importOnce: (
    entries: ReadonlyArray<{
      readonly scope: string | null
      readonly purpose: string
      readonly value: Redacted.Redacted<string>
    }>,
  ) => Effect.Effect<number | null, SecretsError>
  // Decrypt every secret of one scope. Empty when encryption is not
  // configured. For the server's ConfigProvider only.
  readonly reveal: (
    scope: string | null,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly purpose: string; readonly value: Redacted.Redacted<string> }>,
    SecretsError
  >
}

export class Service extends Context.Service<Service, Interface>()("@rp/Secrets") {}

export const use = serviceUse(Service)

export const masterKeyVariable = "RP_MASTER_KEY"
const masterKeyBytes = 32
const nonceBytes = 12
const keyVersion = 1
// App-wide secrets are stored under this scope; SQLite primary keys do not
// take null.
const appScope = ""

const purposePattern = /^[a-z0-9][a-z0-9-]*$/
const importedKey = "environment_imported_at"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")
// Copied into a fresh ArrayBuffer, which is what WebCrypto's BufferSource wants.
const bytesOf = (buffer: Buffer) => new Uint8Array(buffer) as Uint8Array<ArrayBuffer>
const fromBase64 = (text: string) => bytesOf(Buffer.from(text, "base64"))

// The master key as raw bytes, or the reason it is unusable. Accepts base64
// (standard or URL-safe) and hex; `openssl rand -base64 32` produces the
// expected form.
const parseMasterKey = (text: string): Uint8Array<ArrayBuffer> | string => {
  const trimmed = text.trim()
  if (trimmed === "") return `${masterKeyVariable} is blank.`
  const candidates = [
    /^[0-9a-fA-F]{64}$/.test(trimmed) ? bytesOf(Buffer.from(trimmed, "hex")) : null,
    fromBase64(trimmed.replace(/-/g, "+").replace(/_/g, "/")),
  ]
  const key = candidates.find((bytes) => bytes !== null && bytes.length === masterKeyBytes)
  return (
    key ??
    `${masterKeyVariable} must be ${masterKeyBytes} random bytes, base64-encoded (openssl rand -base64 32).`
  )
}

const last4Of = (value: string) => (value.length >= 8 ? value.slice(-4) : "")

interface Row {
  scope: string
  purpose: string
  nonce: string
  ciphertext: string
  last4: string
  updated_at: string
}

// The environment variable a vendor adapter reads the key for `purpose` from,
// for a site (or app-wide when `site` is null). The site's commerce provider
// names its own variable (`revenue.keyVariable`, because commerce keys are per
// account); every other provider reads `<PROVIDER>_API_KEY`. The server puts a
// revealed secret under this name in the site's ConfigProvider, so no adapter
// has to know the vault exists.
export const variableFor = (site: Site | null, purpose: string): string =>
  site?.revenue && site.revenue.provider === purpose
    ? site.revenue.keyVariable
    : defaultKeyVariable(purpose)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { client: sql } = yield* AppDatabase.Service

    // The master key, read once. Absent or malformed is not a failure of the
    // layer: the vault stays readable as "nothing stored" and every write says
    // why it cannot proceed.
    const masterKey = yield* Config.redacted(masterKeyVariable).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none()),
    )
    const parsed = Option.isNone(masterKey)
      ? `${masterKeyVariable} is not set.`
      : parseMasterKey(Redacted.value(masterKey.value))
    const cryptoKey =
      typeof parsed === "string"
        ? null
        : yield* Effect.promise(() =>
            crypto.subtle.importKey("raw", parsed, "AES-GCM", false, [
              "encrypt",
              "decrypt",
            ]),
          )
    const encryption: EncryptionStatus =
      typeof parsed === "string"
        ? { configured: false, reason: parsed }
        : { configured: true, reason: null }

    const secretsError =
      (operation: string) => (cause: SqlError.SqlError) =>
        new SecretsError({ message: `Secrets.${operation} failed`, cause })
    const mapErr =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E | SqlError.SqlError, R>) =>
        Effect.mapError(effect, (error) =>
          error instanceof SecretsError ||
          error instanceof EncryptionUnavailableError ||
          error instanceof InvalidSecretError ||
          error instanceof UnknownSecretError
            ? error
            : secretsError(operation)(error as SqlError.SqlError),
        )

    yield* sql
      .unsafe(
        `create table if not exists secret (
          scope text not null,
          purpose text not null,
          nonce text not null,
          ciphertext text not null,
          key_version integer not null,
          last4 text not null,
          updated_at text not null,
          primary key (scope, purpose)
        )`,
      )
      .pipe(mapErr("initialize"))
    yield* sql
      .unsafe(
        `create table if not exists secret_meta (
          key text primary key,
          value text not null
        )`,
      )
      .pipe(mapErr("initialize"))

    const storedScope = (scope: string | null) => scope ?? appScope
    const publicScope = (scope: string) => (scope === appScope ? null : scope)
    const aad = (scope: string, purpose: string) => encoder.encode(`${scope} ${purpose}`)

    const encrypt = (key: CryptoKey, scope: string, purpose: string, value: string) =>
      Effect.tryPromise({
        try: async () => {
          const nonce = crypto.getRandomValues(new Uint8Array(nonceBytes))
          const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce, additionalData: aad(scope, purpose) },
            key,
            encoder.encode(value),
          )
          return { nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) }
        },
        catch: (cause) => new SecretsError({ message: "Encryption failed", cause }),
      })

    const decrypt = (
      key: CryptoKey,
      scope: string,
      purpose: string,
      row: { nonce: string; ciphertext: string },
    ) =>
      Effect.tryPromise({
        try: async () => {
          const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: fromBase64(row.nonce), additionalData: aad(scope, purpose) },
            key,
            fromBase64(row.ciphertext),
          )
          return decoder.decode(plain)
        },
        catch: (cause) =>
          new SecretsError({
            message: `The "${purpose}" secret for ${publicScope(scope) ?? "the app"} could not be decrypted with the current ${masterKeyVariable}.`,
            cause,
          }),
      })

    const statusOf = (
      row: Pick<Row, "scope" | "purpose" | "last4" | "updated_at">,
    ): SecretStatus => ({
      scope: publicScope(row.scope),
      purpose: row.purpose,
      last4: row.last4,
      updatedAt: row.updated_at,
    })

    const listI = (scope: string | null) =>
      Effect.map(
        sql<Row>`select scope, purpose, nonce, ciphertext, last4, updated_at
          from secret where scope = ${storedScope(scope)} order by updated_at, purpose`,
        (rows) => rows.map(statusOf),
      )

    const setI = (scope: string | null, purpose: string, value: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        if (!cryptoKey)
          return yield* new EncryptionUnavailableError({ reason: encryption.reason ?? "" })
        if (!purposePattern.test(purpose))
          return yield* new InvalidSecretError({
            message: `Purpose "${purpose}" must be lower-case letters, digits, and hyphens`,
          })
        const plain = Redacted.value(value)
        if (plain.trim() === "")
          return yield* new InvalidSecretError({ message: "A secret value cannot be blank" })
        const stored = storedScope(scope)
        const sealed = yield* encrypt(cryptoKey, stored, purpose, plain)
        const updatedAt = new Date().toISOString()
        yield* sql`insert into secret (scope, purpose, nonce, ciphertext, key_version, last4, updated_at)
          values (${stored}, ${purpose}, ${sealed.nonce}, ${sealed.ciphertext}, ${keyVersion}, ${last4Of(plain)}, ${updatedAt})
          on conflict (scope, purpose) do update set
            nonce = excluded.nonce, ciphertext = excluded.ciphertext,
            key_version = excluded.key_version, last4 = excluded.last4,
            updated_at = excluded.updated_at`
        return statusOf({ scope: stored, purpose, last4: last4Of(plain), updated_at: updatedAt })
      })

    const removeI = (scope: string | null, purpose: string) =>
      Effect.gen(function* () {
        const stored = storedScope(scope)
        const rows = yield* sql<{ n: number }>`select count(*) as n from secret
          where scope = ${stored} and purpose = ${purpose}`
        if ((rows[0]?.n ?? 0) === 0)
          return yield* new UnknownSecretError({ scope, purpose })
        yield* sql`delete from secret where scope = ${stored} and purpose = ${purpose}`
      })

    const importOnceI = (
      entries: ReadonlyArray<{
        readonly scope: string | null
        readonly purpose: string
        readonly value: Redacted.Redacted<string>
      }>,
    ) =>
      Effect.gen(function* () {
        if (!cryptoKey) return null
        const done = yield* sql<{ value: string }>`
          select value from secret_meta where key = ${importedKey}`
        if (done.length > 0) return null
        let stored = 0
        for (const entry of entries) {
          const existing = yield* sql<{ n: number }>`select count(*) as n from secret
            where scope = ${storedScope(entry.scope)} and purpose = ${entry.purpose}`
          if ((existing[0]?.n ?? 0) > 0) continue
          // A value the vault would refuse (blank, odd purpose) is skipped, not
          // fatal: the import must not stop the server from starting.
          const result = yield* setI(entry.scope, entry.purpose, entry.value).pipe(
            Effect.catchTag("InvalidSecretError", () => Effect.succeed(null)),
            Effect.catchTag("EncryptionUnavailableError", (error) => Effect.die(error)),
          )
          if (result !== null) stored += 1
        }
        yield* sql`insert into secret_meta (key, value)
          values (${importedKey}, ${new Date().toISOString()})`
        return stored
      })

    const revealI = (scope: string | null) =>
      Effect.gen(function* () {
        if (!cryptoKey) return []
        const stored = storedScope(scope)
        const rows = yield* sql<Row>`select scope, purpose, nonce, ciphertext, last4, updated_at
          from secret where scope = ${stored}`
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(decrypt(cryptoKey, stored, row.purpose, row), (plain) => ({
            purpose: row.purpose,
            value: Redacted.make(plain),
          })),
        )
      })

    return {
      encryption: () => Effect.succeed(encryption),
      list: Effect.fn("Secrets.list")((scope) => listI(scope).pipe(mapErr("list"))),
      set: Effect.fn("Secrets.set")((scope, purpose, value) =>
        setI(scope, purpose, value).pipe(mapErr("set")),
      ),
      remove: Effect.fn("Secrets.remove")((scope, purpose) =>
        removeI(scope, purpose).pipe(mapErr("remove")),
      ),
      importOnce: Effect.fn("Secrets.importOnce")((entries) =>
        importOnceI(entries).pipe(mapErr("importOnce")),
      ),
      reveal: Effect.fn("Secrets.reveal")((scope) => revealI(scope).pipe(mapErr("reveal"))),
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppDatabase.defaultLayer))

export * as Secrets from "./secrets"
