// Clients service: per-client bearer tokens, in the app-level database.
//
// A token is `rp_` followed by 32 random bytes, base64url. The server stores
// only its SHA-256 hash, so the database never holds anything that grants
// access; the plaintext is returned exactly once, from `create`, and the
// client keeps it. `authenticate` looks a presented token up by hash and
// stamps the client's last use, at most once a minute so a busy client does
// not turn every read into a write.
//
// The shared RP_TOKEN in the environment stays valid beside these, as the
// bootstrap credential that creates the first client and as the break-glass
// one if every client is revoked. The bearer middleware checks it first.
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { type SqlError } from "effect/unstable/sql"

import { AppDatabase } from "../app-database/app-database.ts"
import { serviceUse } from "../service-use.ts"
import {
  type Client,
  ClientsError,
  InvalidClientError,
  UnknownClientError,
} from "./schema.ts"

export interface Interface {
  // Every client, oldest first, revoked ones included.
  readonly list: () => Effect.Effect<ReadonlyArray<Client>, ClientsError>
  // Issue a token for a new client. The plaintext is returned here and never
  // again.
  readonly create: (
    label: string,
  ) => Effect.Effect<
    { readonly client: Client; readonly token: Redacted.Redacted<string> },
    ClientsError | InvalidClientError
  >
  // Revoke a client's token. Idempotent for an already revoked client.
  readonly revoke: (
    id: string,
  ) => Effect.Effect<Client, ClientsError | UnknownClientError>
  // The client a presented token belongs to, if it is known and not revoked.
  // Stamps the client's last use.
  readonly authenticate: (
    token: string,
  ) => Effect.Effect<Option.Option<Client>, ClientsError>
  // Whether any client has an active token: the bearer middleware's answer to
  // "could anything authenticate at all" when RP_TOKEN is unset.
  readonly hasActive: () => Effect.Effect<boolean, ClientsError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Clients") {}

export const use = serviceUse(Service)

export const tokenPrefix = "rp_"
const tokenBytes = 32
// How often a client's last use is written, in milliseconds.
const lastUsedResolution = 60_000

const hashToken = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex")

const mintToken = (): string =>
  tokenPrefix + Buffer.from(crypto.getRandomValues(new Uint8Array(tokenBytes))).toString("base64url")

interface Row {
  id: string
  label: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

const clientOf = (row: Row): Client => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { client: sql } = yield* AppDatabase.Service

    const clientsError =
      (operation: string) => (cause: SqlError.SqlError) =>
        new ClientsError({ message: `Clients.${operation} failed`, cause })
    const mapErr =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E | SqlError.SqlError, R>) =>
        Effect.mapError(effect, (error) =>
          error instanceof ClientsError ||
          error instanceof InvalidClientError ||
          error instanceof UnknownClientError
            ? error
            : clientsError(operation)(error as SqlError.SqlError),
        )

    // `client_token` is created by the AppDatabase migrations, which have run
    // by the time this layer is built.

    const listI = Effect.map(
      sql<Row>`select id, label, created_at, last_used_at, revoked_at
        from client_token order by created_at, id`,
      (rows) => rows.map(clientOf),
    )

    const createI = (label: string) =>
      Effect.gen(function* () {
        const trimmed = label.trim()
        if (trimmed === "")
          return yield* new InvalidClientError({ message: "A client needs a label" })
        const token = mintToken()
        const client: Client = {
          id: crypto.randomUUID(),
          label: trimmed,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        }
        yield* sql`insert into client_token (id, label, token_hash, created_at)
          values (${client.id}, ${client.label}, ${hashToken(token)}, ${client.createdAt})`
        return { client, token: Redacted.make(token) }
      })

    const revokeI = (id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<Row>`select id, label, created_at, last_used_at, revoked_at
          from client_token where id = ${id}`
        const row = rows[0]
        if (!row) return yield* new UnknownClientError({ clientId: id })
        if (row.revoked_at) return clientOf(row)
        const revokedAt = new Date().toISOString()
        yield* sql`update client_token set revoked_at = ${revokedAt} where id = ${id}`
        return clientOf({ ...row, revoked_at: revokedAt })
      })

    const authenticateI = (token: string) =>
      Effect.gen(function* () {
        if (!token.startsWith(tokenPrefix)) return Option.none<Client>()
        const rows = yield* sql<Row>`select id, label, created_at, last_used_at, revoked_at
          from client_token where token_hash = ${hashToken(token)} and revoked_at is null`
        const row = rows[0]
        if (!row) return Option.none<Client>()
        const now = new Date()
        const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0
        if (now.getTime() - lastUsed >= lastUsedResolution) {
          const stamp = now.toISOString()
          yield* sql`update client_token set last_used_at = ${stamp} where id = ${row.id}`
          return Option.some(clientOf({ ...row, last_used_at: stamp }))
        }
        return Option.some(clientOf(row))
      })

    const hasActiveI = Effect.map(
      sql<{ n: number }>`select count(*) as n from client_token where revoked_at is null`,
      (rows) => (rows[0]?.n ?? 0) > 0,
    )

    return {
      list: Effect.fn("Clients.list")(() => listI.pipe(mapErr("list"))),
      create: Effect.fn("Clients.create")((label) => createI(label).pipe(mapErr("create"))),
      revoke: Effect.fn("Clients.revoke")((id) => revokeI(id).pipe(mapErr("revoke"))),
      authenticate: Effect.fn("Clients.authenticate")((token) =>
        authenticateI(token).pipe(mapErr("authenticate")),
      ),
      hasActive: Effect.fn("Clients.hasActive")(() => hasActiveI.pipe(mapErr("hasActive"))),
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppDatabase.defaultLayer))

export * as Clients from "./clients"
