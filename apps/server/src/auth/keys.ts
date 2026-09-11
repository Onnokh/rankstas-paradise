// The server's key and identity operations, on top of Better Auth.
//
// This replaces the Clients service the domain used to own. The routes it feeds
// (`GET/POST/DELETE /api/clients`) and the `Client` shape they answer with are
// unchanged, so the Mac app, the TUI and the docs all still read the same; only
// what is behind them moved.
//
// Two things here are not obvious:
//
//   - The key operations do NOT go through `auth.api.listApiKeys` /
//     `deleteApiKey`. Those endpoints demand a SESSION, and the callers that
//     manage keys here are machines holding a key, which never have one. The
//     generic `ctx.adapter` is Better Auth's own server-side door to the same
//     rows and needs no session, so reads and revokes go through it. Minting
//     still goes through `auth.api.createApiKey`, which owns the generation and
//     hashing rules and must not be reimplemented.
//
//   - A revoked key is DISABLED, not deleted. `enabled = false` keeps the row,
//     so a revoked client still appears in the list with the date it was
//     revoked, exactly as the `client_token` table used to behave.
import { Redacted } from "effect"

import {
  type Client,
  InvalidClientError,
  UnknownClientError,
} from "@rp/domain/clients/schema"

import { type Auth, KEY_PREFIX } from "./auth.ts"

// One row of Better Auth's `apikey` table, as this module reads it.
interface KeyRow {
  readonly id: string
  readonly name: string | null
  readonly start: string | null
  readonly enabled: boolean | null
  readonly lastRequest: Date | string | null
  readonly createdAt: Date | string
  readonly updatedAt: Date | string
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// An api key row as the Client the API has always answered with. A disabled key
// reports the moment it was last written as its revocation: nothing else records
// when it happened, and disabling is the only write a revoke makes.
const clientOf = (row: KeyRow): Client => ({
  id: row.id,
  label: row.name ?? row.start ?? row.id,
  createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
  lastUsedAt: iso(row.lastRequest),
  revokedAt: row.enabled === false ? iso(row.updatedAt) : null,
})

export interface AuthOperations {
  readonly list: () => Promise<ReadonlyArray<Client>>
  readonly create: (
    label: string,
  ) => Promise<{ readonly client: Client; readonly token: Redacted.Redacted<string> }>
  readonly revoke: (id: string) => Promise<Client>
  // Whether a presented token is a live API key.
  readonly accepts: (token: string) => Promise<boolean>
  // Whether a request's own headers carry a valid session, so a signed-in person
  // reaches the API with no key at all.
  readonly acceptsSession: (headers: Headers) => Promise<boolean>
  // Whether anything could authenticate: the middleware's answer to "is this
  // server merely unconfigured" when RP_TOKEN is unset.
  readonly hasActiveClient: () => Promise<boolean>
}

// The single user every API key hangs off. Better Auth requires a key to
// reference an owner, and this deployment has exactly one: whoever the
// environment names. The row is created on first start and found on every start
// after, so issuing a key never waits for anybody to sign in with Google — the
// machines can be re-keyed before the OAuth client even exists.
const ownerEmail = (): string => {
  const named = (Bun.env.RP_OWNER_EMAIL ?? "").trim()
  if (named !== "") return named
  const [first] = (Bun.env.RP_ALLOWED_EMAILS ?? "").split(",")
  return (first ?? "").trim() || "owner@rankstas-paradise.local"
}

export const makeAuthOperations = async (auth: Auth): Promise<AuthOperations> => {
  const ctx = await auth.$context

  const email = ownerEmail()
  const existing = await ctx.adapter.findOne<{ id: string }>({
    model: "user",
    where: [{ field: "email", value: email }],
  })
  const owner =
    existing ??
    // Written straight through the adapter, which deliberately SKIPS the
    // `databaseHooks` allowlist in auth.ts. That allowlist exists to stop a
    // stranger signing in with Google; running it here would instead stop the
    // server issuing its own first key whenever no allowlist is set, which is
    // every deployment that wants machine access and no Google login at all.
    //
    // The row is not a way in. It carries no password and no linked account, so
    // nothing can authenticate AS it until someone on the allowlist signs in
    // with a Google account of the same address, at which point Better Auth
    // adopts this row as that person.
    (await ctx.adapter.create<{ id: string }>({
      model: "user",
      data: {
        // No id: Better Auth generates one and warns if it is handed a value.
        email,
        name: "Owner",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    }))

  const rows = () =>
    ctx.adapter.findMany<KeyRow>({
      model: "apikey",
      where: [{ field: "referenceId", value: owner.id }],
    })

  const list = async (): Promise<ReadonlyArray<Client>> => {
    const found = await rows()
    return [...found]
      .map(clientOf)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  const create = async (label: string) => {
    const trimmed = label.trim()
    if (trimmed === "")
      throw new InvalidClientError({ message: "A client needs a label" })
    const created = await auth.api.createApiKey({
      body: { name: trimmed, userId: owner.id },
    })
    return {
      client: clientOf(created as unknown as KeyRow),
      // The one time the plaintext exists outside the caller's hands.
      token: Redacted.make((created as unknown as { key: string }).key),
    }
  }

  const revoke = async (id: string): Promise<Client> => {
    const found = await ctx.adapter.findOne<KeyRow>({
      model: "apikey",
      where: [{ field: "id", value: id }],
    })
    if (!found) throw new UnknownClientError({ clientId: id })
    if (found.enabled === false) return clientOf(found)
    const updated = await ctx.adapter.update<KeyRow>({
      model: "apikey",
      where: [{ field: "id", value: id }],
      update: { enabled: false, updatedAt: new Date() },
    })
    return clientOf(updated ?? { ...found, enabled: false, updatedAt: new Date() })
  }

  const accepts = async (token: string): Promise<boolean> => {
    // Cheap reject before touching the database, as the hashed-token lookup did.
    if (!token.startsWith(KEY_PREFIX)) return false
    const result = await auth.api.verifyApiKey({ body: { key: token } })
    return result.valid === true
  }

  const acceptsSession = async (headers: Headers): Promise<boolean> => {
    const session = await auth.api.getSession({ headers })
    return session !== null
  }

  const hasActiveClient = async (): Promise<boolean> => {
    const found = await rows()
    return found.some((row) => row.enabled !== false)
  }

  return { list, create, revoke, accepts, acceptsSession, hasActiveClient }
}
