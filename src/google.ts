import { createHash, randomBytes } from "node:crypto"
import { Effect } from "effect"

import { ensureDataDirectory, loadConfig, tokenPath, type SeoConfig } from "./config.ts"
import { siteFor } from "./site.ts"

const scope = "https://www.googleapis.com/auth/webmasters.readonly"
const callbackPort = 8765
const redirectUri = `http://127.0.0.1:${callbackPort}/oauth/callback`

type Token = {
  readonly access_token: string
  readonly refresh_token?: string
  readonly expires_in: number
  readonly created_at: number
}

type SearchRow = {
  readonly keys: readonly string[]
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly position: number
}

export type DailySnapshot = {
  readonly date: string
  readonly query: string
  readonly page: string
  readonly device: string
  readonly country: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly position: number
}

const base64Url = (value: Buffer) => value.toString("base64url")
const codeVerifier = () => base64Url(randomBytes(32))
const challengeFor = (verifier: string) => base64Url(createHash("sha256").update(verifier).digest())

const fetchJson = async <T>(url: string, options: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}

const saveToken = async (token: Token) => {
  await Bun.write(tokenPath, JSON.stringify(token, null, 2))
}

const readToken = async (): Promise<Token> => JSON.parse(await Bun.file(tokenPath).text()) as Token

export const hasGoogleConnection = Effect.tryPromise({
  try: async () => {
    if (!await Bun.file(tokenPath).exists()) return false
    const token = await readToken()
    const accessTokenIsValid = Boolean(token.access_token) && token.created_at + token.expires_in * 1_000 > Date.now()
    return Boolean(token.refresh_token) || accessTokenIsValid
  },
  catch: () => new Error("The saved Google connection could not be read."),
}).pipe(Effect.catchAll(() => Effect.succeed(false)))

const getAccessToken = async (config: SeoConfig): Promise<string> => {
  const token = await readToken()
  if (token.created_at + (token.expires_in - 60) * 1_000 > Date.now()) return token.access_token
  if (!token.refresh_token) throw new Error("The Google connection has expired and must be authorized again.")
  const refreshed = await fetchJson<Omit<Token, "created_at">>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  })
  const next = { ...refreshed, refresh_token: refreshed.refresh_token ?? token.refresh_token, created_at: Date.now() }
  await saveToken(next)
  return next.access_token
}

export const connectGoogle = Effect.gen(function* () {
  const config = yield* loadConfig
  yield* ensureDataDirectory
  const verifier = codeVerifier()
  const state = base64Url(randomBytes(24))
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  authorizationUrl.search = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    state,
  }).toString()

  const callback = yield* Effect.async<{ code: string }, Error>((resume) => {
    const server = Bun.serve({
      port: callbackPort,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== "/oauth/callback") return new Response("Not found", { status: 404 })
        const code = url.searchParams.get("code")
        const responseState = url.searchParams.get("state")
        if (!code || responseState !== state) {
          resume(Effect.fail(new Error("Google OAuth callback was missing a valid authorization code.")))
          return new Response("Authorization failed. You can close this tab.", { status: 400 })
        }
        resume(Effect.succeed({ code }))
        return new Response("Ranksta’s Paradise is connected. You can close this tab and return to the terminal.")
      },
    })
    Bun.spawn(["open", authorizationUrl.toString()])
    return Effect.sync(() => server.stop())
  })

  const token = yield* Effect.tryPromise({
    try: () => fetchJson<Omit<Token, "created_at">>("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        code: callback.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    }),
    catch: (cause) => new Error(`Could not exchange the Google OAuth code: ${String(cause)}`),
  })
  yield* Effect.tryPromise({ try: () => saveToken({ ...token, created_at: Date.now() }), catch: (cause) => new Error(String(cause)) })
  return "Connected to Google Search Console."
})

export type SiteDailyTotal = {
  readonly date: string
  readonly clicks: number
  readonly impressions: number
  readonly ctr: number
  readonly position: number
}

export type PageDailyTotal = SiteDailyTotal & {
  readonly page: string
}

export type DailyTotals = {
  readonly site: readonly SiteDailyTotal[]
  readonly pages: readonly PageDailyTotal[]
}

export type PageIndexStatus = {
  readonly targetUrl: string
  readonly status: "indexed" | "not-indexed" | "unknown"
  readonly verdict: string
  readonly coverageState: string
}

type UrlInspectionResponse = {
  readonly inspectionResult?: {
    readonly indexStatusResult?: {
      readonly verdict?: string
      readonly coverageState?: string
    }
  }
}

const rowLimit = 25_000

const queryAllRows = (config: SeoConfig, property: string, accessToken: string, date: string, dimensions: readonly string[]) => Effect.gen(function* () {
  const rows: SearchRow[] = []
  for (let startRow = 0; ; startRow += rowLimit) {
    const result = yield* Effect.tryPromise({
      try: () => fetchJson<{ rows?: SearchRow[] }>(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          startDate: date,
          endDate: date,
          dimensions,
          type: "web",
          rowLimit,
          startRow,
          dataState: "final",
        }),
      }),
      catch: (cause) => new Error(`Search Console query for ${date} failed: ${String(cause)}`),
    })
    rows.push(...(result.rows ?? []))
    if ((result.rows ?? []).length < rowLimit) return rows
  }
})

export const fetchSearchConsoleSnapshots = (dates: readonly string[]) => Effect.gen(function* () {
  const config = yield* loadConfig
  const site = yield* Effect.tryPromise({ try: () => siteFor(), catch: (cause) => new Error(String(cause)) })
  const accessToken = yield* Effect.tryPromise({ try: () => getAccessToken(config), catch: (cause) => new Error(String(cause)) })
  const snapshots: DailySnapshot[] = []
  for (const date of dates) {
    const rows = yield* queryAllRows(config, site.property, accessToken, date, ["query", "page", "device", "country"])
    snapshots.push(...rows.map((row) => ({
      date,
      query: row.keys[0] ?? "",
      page: row.keys[1] ?? "",
      device: row.keys[2] ?? "",
      country: row.keys[3] ?? "",
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })))
  }
  return snapshots
})

// Queries without the query dimension include anonymized long-tail traffic that
// query-grouped rows omit, so these totals are the true daily numbers.
export const fetchDailyTotals = (dates: readonly string[]) => Effect.gen(function* () {
  const config = yield* loadConfig
  const site = yield* Effect.tryPromise({ try: () => siteFor(), catch: (cause) => new Error(String(cause)) })
  const accessToken = yield* Effect.tryPromise({ try: () => getAccessToken(config), catch: (cause) => new Error(String(cause)) })
  const siteTotals: SiteDailyTotal[] = []
  const pages: PageDailyTotal[] = []
  for (const date of dates) {
    const siteRows = yield* queryAllRows(config, site.property, accessToken, date, [])
    const siteRow = siteRows[0]
    if (siteRow) siteTotals.push({ date, clicks: siteRow.clicks, impressions: siteRow.impressions, ctr: siteRow.ctr, position: siteRow.position })
    const pageRows = yield* queryAllRows(config, site.property, accessToken, date, ["page"])
    pages.push(...pageRows.map((row) => ({
      date,
      page: row.keys[0] ?? "",
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    })))
  }
  return { site: siteTotals, pages } satisfies DailyTotals
})

// URL Inspection returns the state of Google's indexed version of a URL. Each
// call is slow (~seconds), so we inspect the registry targets concurrently. The
// bounded concurrency keeps peak request rate well under the API's per-property
// limit (600/minute) even for a full registry.
const inspectionConcurrency = 8

export const fetchPageIndexStatuses = (targetUrls: readonly string[]) => Effect.gen(function* () {
  const config = yield* loadConfig
  const site = yield* Effect.tryPromise({ try: () => siteFor(), catch: (cause) => new Error(String(cause)) })
  const accessToken = yield* Effect.tryPromise({ try: () => getAccessToken(config), catch: (cause) => new Error(String(cause)) })
  const results = yield* Effect.forEach([...new Set(targetUrls)], (targetUrl) =>
    Effect.tryPromise({
      try: () => fetchJson<UrlInspectionResponse>("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ inspectionUrl: targetUrl, siteUrl: site.property, languageCode: "en-US" }),
      }),
      catch: () => null,
    }).pipe(Effect.map((result): PageIndexStatus | null => {
      if (!result) return null
      const indexStatus = result.inspectionResult?.indexStatusResult
      const verdict = indexStatus?.verdict ?? "VERDICT_UNSPECIFIED"
      return {
        targetUrl,
        status: verdict === "PASS" ? "indexed" : verdict === "FAIL" || verdict === "NEUTRAL" ? "not-indexed" : "unknown",
        verdict,
        coverageState: indexStatus?.coverageState ?? "",
      }
    })), { concurrency: inspectionConcurrency })
  const inspections = results.filter((result): result is PageIndexStatus => result !== null)
  return { inspections, failed: results.length - inspections.length }
})
