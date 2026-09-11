# Identity is Better Auth's; access is an API key

## Status

accepted. Replaces the Clients service and the front door it guarded. No
report, route, or vendor boundary changes: `GET/POST/DELETE /api/clients` answer
the same shapes they always did.

## Context

Adding AdSense as a revenue provider forced this. The AdSense Management API has
no API keys and no service accounts — OAuth 2.0 is the only way in — so the
server has to hold a Google authorization on somebody's behalf. It had nowhere
to put one. The vault (ADR 0005's sibling) stores flat vendor keys addressed by
scope and purpose; it has no concept of a person, a grant, a refresh, or an
expiry.

The server's own front door was hand-rolled: `client_token` rows holding a
SHA-256 of a `rp_`-prefixed token, minted and checked by a Clients service in the
domain. It worked, but every feature the next year needs — a key that expires, a
key with a scope, a person who signs in, a token that refreshes itself — was
another table and another hand-rolled check.

### The scope finding that shaped the decision

Google revokes refresh tokens after **7 days** when the consent screen is
External with publishing status Testing, *"unless the only OAuth scopes requested
are a subset of name, email address, and user profile"*.

This is the root cause of the incident in ADR 0003 — the 2026-07-23
`invalid_grant` that killed every sync for two days and made us adopt a service
account. It was a configuration fault, not a weakness of user OAuth, and ADR 0003
should be read with that correction in mind.

It also decides the shape here. A login-only grant is exempt: it needs no
verification review and its refresh token does not expire weekly. Add one
sensitive scope (`webmasters.readonly`, `adsense.readonly`) to the same grant and
the whole grant — including the ability to sign in — expires every 7 days until
Google finishes reviewing the app, which takes weeks.

## Decision

**Better Auth owns identity and mints every API key. Sign-in and data access are
two separate Google authorizations.**

- **The sign-in grant is `openid`, `email`, `profile` and nothing else.** Sign-in
  therefore works today, unverified, with no 7-day expiry. `auth.ts` says so in
  its header, next to the list, because the cost of a careless addition is the
  front door.
- **Machines carry an API key; people carry a session.** The bearer wall accepts
  `RP_TOKEN` (break-glass, checked first and touching no database), a live API
  key, then a valid session, in that order — so a machine never pays for a
  session lookup it will not use.
- **Better Auth never migrates.** Its DDL is generated with
  `getMigrations(...).compileMigrations()` and checked in as `0002_auth` in the
  domain's migrations, so the app database keeps the single schema owner it
  gained in ADR 0006. `@better-auth/cli migrate` is never run against a real
  database. A test compares the checked-in migration against what the installed
  library asks for, so an upgrade that changes the schema fails the suite instead
  of failing a request months later.
- **Key management does not go through the key endpoints.** `listApiKeys` and
  `deleteApiKey` require a session, and the callers that manage keys here are
  machines holding a key. Reads and revokes use Better Auth's generic context
  adapter, which needs no session. Minting still goes through `createApiKey`,
  which owns the generation and hashing rules.
- **One owner row, created from the environment.** An API key must reference an
  owner, so the server finds or creates a single user on start, named by
  `RP_OWNER_EMAIL`. It is written straight through the adapter, deliberately
  skipping the sign-in allowlist: that allowlist exists to stop a stranger
  signing in, and running it here would stop the server issuing its own first key
  whenever no allowlist is set. The row carries no password and no linked
  account, so nothing can authenticate as it until someone on the allowlist signs
  in with a Google account of the same address.
- **A revoked key is disabled, not deleted**, so it stays on the list with the
  date — as `client_token` behaved.

## Consequences

- **Every existing client token stops working.** The stored SHA-256 hashes cannot
  be migrated into Better Auth's table, and pretending otherwise would mean
  reimplementing its hashing. The Mac, the TUI and the agent must each be issued
  a new key. `RP_TOKEN` is the credential that issues them.
- **The app database now has a second connection.** The Effect `SqliteClient`
  does not expose its underlying `bun:sqlite` Database, so Better Auth opens its
  own. This is precisely the case ADR 0006 anticipated when it set
  `busy_timeout`; that pragma is per-connection, so Better Auth's handle sets it
  too.
- **Order of construction is now load-bearing.** Better Auth checks its tables
  when it first touches the database and caches the verdict, so an instance built
  before the migrations run stays broken for the life of the process even after
  the tables appear. The server awaits the app database — and therefore its
  migrations — before constructing Better Auth.
- **A rejected key logs at error level inside Better Auth.** That is an ordinary
  401, so the logger drops that one message and passes everything else through;
  otherwise anything scanning the deployment would bury the errors that matter.
- **Sign-in is configured but has no page yet.** `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` are optional: absent, the social provider is simply not
  registered and the server runs on API keys alone. The Login page and the Mac
  app's "Connect" button come later.
- **`RP_ALLOWED_EMAILS` decides who may sign in, and defaults to nobody.** A
  server whose owner has not said who they are must not accept an arbitrary
  Google account, because a valid session opens the wall.
