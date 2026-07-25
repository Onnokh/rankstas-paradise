# Google auth is a service-account key, not user OAuth

## Status

accepted — supersedes the Google-authentication decision in
[0001-rp-as-hosted-service.md](0001-rp-as-hosted-service.md) (§Decision,
"Google"). Everything else in ADR 0001 still holds.

## Context

ADR 0001 chose the path of least change for auth: keep the desktop OAuth flow
that already existed, mint the token once on the Mac, seed it onto the volume,
and let the server refresh headlessly. It also flagged the known trap — the
consent screen has to be **"In production"**, because a "Testing" app's refresh
token expires after 7 days.

That trap fired. On 2026-07-23 the refresh token died (`invalid_grant: Token has
been expired or revoked`) and every sync failed for the next two days while the
read endpoints kept cheerfully serving stale data. The dashboard's newest row was
four days old and nothing in the UI said why; the only evidence was nine failed
jobs in `/api/jobs`.

Fixing it properly inside the OAuth model meant publishing the consent screen to
an external "general audience" — plausible for a single-user internal tool, but
it is consent-screen paperwork in service of a browser flow that no headless
server should have needed in the first place. The whole interactive apparatus
existed only to produce a credential.

## Decision

**Authenticate with a Google service-account key, and delete the OAuth path
entirely.**

The server reads `google-service-account.json` off the volume, signs a one-hour
RS256 JWT asserting the `webmasters.readonly` scope, and exchanges it for an
access token at Google's token endpoint (the `urn:ietf:params:oauth:grant-type:jwt-bearer`
grant). Tokens are cached in memory with a 60-second expiry margin.

Consequences that made this the right shape, not just a smaller one:

- **Nothing expires on a timer.** The key is valid until deleted in Google Cloud.
  There is no consent screen, no publishing status, no verification, and no
  7-day clock.
- **The credential is immutable.** The OAuth path had to *rewrite* its token file
  on every refresh, which is why the volume had to be writable and why a
  half-written token was a plausible failure. Nothing is written now, so the key
  can be a read-only secret mount.
- **No browser anywhere.** `connectGoogle`, the loopback callback server, the
  PKCE helpers, and the `google-token.json` reader/writer are gone, along with
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and the client credentials in
  `SeoConfig`. The desktop-OAuth-shaped hole in a headless service is closed
  rather than papered over.

The cost, accepted: **access is granted per property, not per account.** The
service-account email must be added under Search Console → Settings → Users and
permissions for each property, as **Owner** (the URL Inspection API is
owner-gated; search-analytics alone would accept Full user). A missing grant
produces a 403, so `decodeOk` now distinguishes 401 (credential stale) from 403
(credential fine, no permission) and says which fix applies.

## Notes

There is no migration path or fallback: a missing or malformed key is a hard
`SearchConsoleAuthError` naming the path it looked at. Rotation is a file swap —
mint a new key, copy it over, restart, delete the old key.

Deployment steps live in [../deploy.md](../deploy.md) §4.
