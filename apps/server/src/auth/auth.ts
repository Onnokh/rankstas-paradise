// Better Auth: the server's identity, and the one place an API key is minted or
// checked.
//
// Two kinds of caller reach this server, and they are NOT the same thing:
//   - a person, who signs in with Google and gets a session cookie. Login scopes
//     only (`openid`, `email`, `profile`).
//   - a machine, which is the Mac app, the TUI or an agent. It carries a
//     long-lived API key and never has a session.
//
// The scope split is deliberate and load-bearing, not tidiness. Google revokes
// refresh tokens after 7 DAYS when the consent screen is External + Testing,
// "unless the only OAuth scopes requested are a subset of name, email address,
// and user profile". A login-only grant is therefore exempt and needs no
// verification review; adding one sensitive scope (`webmasters.readonly`,
// `adsense.readonly`) would make the whole grant, and so the front door, expire
// every week until Google finished reviewing the app. Those scopes get their own
// separate authorization later. Do not add them here.
//
// Better Auth opens its OWN handle on the app database: the Effect SqliteClient
// does not expose the underlying `bun:sqlite` Database, so the file now has two
// connections. `busy_timeout` is set on this one because the pragma is
// per-connection. WAL is a property of the file; the wait is not.
//
// Better Auth NEVER migrates. Its tables are generated once with its CLI and
// checked in as `0002_auth` in the domain's migrations, so the schema keeps the
// single owner it gained in ADR 0006.
import { Database } from "bun:sqlite"

import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"

// The prefix every issued key carries, kept from the Clients service this
// replaces so an existing key reads the same and the middleware can still reject
// an obvious non-key without touching the database.
export const KEY_PREFIX = "rp_"

// Where Better Auth's own routes live. The bearer middleware exempts this
// subtree: signing in cannot require being signed in.
export const AUTH_PATH = "/api/auth"

// What this server uses Better Auth for, named explicitly rather than inferred.
//
// Two reasons, one forced and one welcome. Forced: `betterAuth(...)` infers a
// type that reaches into `@better-auth/core/db/internal` and zod's internals,
// which TypeScript cannot write into a declaration file from this package
// (TS2883), and the domain builds with declarations. Welcome: the server
// depends on four calls, and saying so keeps the rest of the library out of the
// codebase. Every shape below was checked against the running library, not the
// documentation.
export interface Auth {
  // The Web-standard handler behind `/api/auth/*`.
  readonly handler: (request: Request) => Promise<Response>
  readonly api: {
    readonly createApiKey: (input: {
      body: { name: string; userId: string }
    }) => Promise<{
      id: string
      name: string | null
      start: string | null
      enabled: boolean | null
      lastRequest: Date | null
      createdAt: Date
      updatedAt: Date
      // The plaintext, returned exactly once.
      key: string
    }>
    readonly verifyApiKey: (input: {
      body: { key: string }
    }) => Promise<{ valid: boolean }>
    readonly getSession: (input: { headers: Headers }) => Promise<unknown | null>
  }
  readonly $context: Promise<AuthContext>
}

// The slice of Better Auth's request context this server reaches for: the
// generic adapter, which reads and writes the same rows the endpoints do but
// needs no session (see keys.ts).
export interface AuthContext {
  readonly adapter: {
    readonly create: <A>(input: { model: string; data: Record<string, unknown> }) => Promise<A>
    readonly findOne: <A>(input: {
      model: string
      where: ReadonlyArray<{ field: string; value: unknown }>
    }) => Promise<A | null>
    readonly findMany: <A>(input: {
      model: string
      where?: ReadonlyArray<{ field: string; value: unknown }>
    }) => Promise<ReadonlyArray<A>>
    readonly update: <A>(input: {
      model: string
      where: ReadonlyArray<{ field: string; value: unknown }>
      update: Record<string, unknown>
    }) => Promise<A | null>
  }
}

// The cookie/session signing secret. API keys are hashed with a plain SHA-256
// and do NOT involve it, so a changed or regenerated secret invalidates sessions
// only, and every machine caller keeps working. That is why the fallback below
// is acceptable rather than a startup failure.
const authSecret = (): string => {
  const explicit = Bun.env.RP_AUTH_SECRET
  if (explicit && explicit.trim() !== "") return explicit
  // Derived from the vault's master key with a domain-separation label, so the
  // two uses never share key material even though they share an origin.
  const master = Bun.env.RP_MASTER_KEY
  if (master && master.trim() !== "")
    return new Bun.CryptoHasher("sha256")
      .update(`rankstas-paradise/auth-secret/v1 ${master}`)
      .digest("hex")
  console.warn(
    "No RP_AUTH_SECRET or RP_MASTER_KEY: sessions will not survive a restart. API keys are unaffected.",
  )
  return crypto.randomUUID()
}

// Only these addresses may become a user. Without it, anybody with a Google
// account could sign in and, because a valid session opens the bearer wall, read
// every site's data. Empty means nobody can sign in, which is the right default
// for a server whose owner has not said who they are.
const allowedEmails = (): ReadonlyArray<string> =>
  (Bun.env.RP_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")

export const makeAuth = (databasePath: string, baseUrl: string): Auth => {
  const database = new Database(databasePath)
  // Per-connection, like on the Effect client: this handle waits for a writer
  // instead of failing the request with SQLITE_BUSY.
  database.exec("pragma busy_timeout = 5000")

  const allowed = allowedEmails()
  const googleId = Bun.env.GOOGLE_CLIENT_ID
  const googleSecret = Bun.env.GOOGLE_CLIENT_SECRET

  // The one cast in the module, and the reason the interface above exists: the
  // real return type is wider than `Auth` in ways that cannot cross a
  // declaration boundary. Narrowing it here is safe precisely because `Auth`
  // describes what was observed from the library, so every caller is still
  // checked against a real shape.
  return betterAuth({
    database,
    secret: authSecret(),
    logger: {
      // A rejected API key is an ordinary 401, not a fault of this server, and
      // Better Auth logs one at error level. Anything scanning the deployment
      // would otherwise fill the log with errors that need no action, and hide
      // the ones that do. Everything else passes through untouched.
      log: (level, message, ...rest) => {
        if (level === "error" && message.includes("Failed to validate API key"))
          return
        console[level === "warn" ? "warn" : level === "error" ? "error" : "log"](
          `[auth] ${message}`,
          ...rest,
        )
      },
    },
    baseURL: baseUrl,
    basePath: AUTH_PATH,
    // No passwords to store, leak, or reset: Google is the only way a person
    // signs in, and a machine uses an API key.
    emailAndPassword: { enabled: false },
    socialProviders:
      googleId && googleSecret
        ? {
            google: {
              clientId: googleId,
              clientSecret: googleSecret,
              // Login only. Read the file header before adding to this list.
              scope: ["openid", "email", "profile"],
            },
          }
        : {},
    account: {
      // AES-256-GCM at rest. Not needed for login scopes, which carry nothing
      // worth stealing, but the data-scope connection lands in this same table
      // later and must never be written in the clear even once.
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!allowed.includes(user.email.toLowerCase())) return false
            return { data: user }
          },
        },
      },
    },
    plugins: [
      apiKey({
        defaultPrefix: KEY_PREFIX,
        // The key is shown once, at creation. Storing its first characters lets
        // a list say which key a row is without holding anything that opens the
        // door.
        startingCharactersConfig: { shouldStore: true, charactersLength: 10 },
        requireName: true,
        // A machine key that stops working on a timer is a 3am outage. Expiry
        // stays opt-in, per key.
        keyExpiration: { defaultExpiresIn: null, disableCustomExpiresTime: false },
        // These callers are trusted and poll; a rate limit here would throttle
        // the Mac app's own dashboard.
        rateLimit: { enabled: false },
      }),
    ],
  }) as unknown as Auth
}
