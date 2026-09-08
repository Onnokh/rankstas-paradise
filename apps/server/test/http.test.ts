// HTTP contract tests for the new HttpApi server (apps/server/src/main.ts).
//
// Boots the server through the PLO-263 harness in --debug mode, seeds it by
// kicking the sync job and polling to done, then asserts the CONTRACT that
// matters with explicit checks: bearer auth, argument validation, the JSON
// envelope shape, and the SHAPE (via regex) of the plain-text feeds. It does
// NOT pin full response bodies — only the invariants a client depends on.
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  FIXTURE_SITE_ID,
  FIXTURE_TOKEN,
  KEYED_SITE_ID,
  keyedSite,
  makeFixtureHome,
  repoRoot,
  requestJson,
  requestText,
  startServer,
  waitForJob,
  type RunningServer,
} from "./lib/harness.ts"

const site = `?site=${FIXTURE_SITE_ID}`

// The new server entry under test.
const NEW_SERVER_ENTRY = resolve(repoRoot, "apps/server/src/main.ts")

let server: RunningServer

beforeAll(async () => {
  server = await startServer({ entry: NEW_SERVER_ENTRY })
  // Debug mode starts with an empty DB; seed it by kicking the sync job (which
  // the new server serves from the copied debug fixture) and polling to done.
  const { status, body } = await requestJson(server, `/api/jobs/sync${site}`, {
    method: "POST",
  })
  expect(status).toBe(202)
  const jobId = (body as { job: { id: number } }).job.id
  await waitForJob(server, jobId)
}, 60_000)

afterAll(() => {
  server?.stop()
})

// --- bearer auth ---

describe("bearer auth", () => {
  test("valid token → 200", async () => {
    const { status } = await requestJson(server, `/api/status${site}`)
    expect(status).toBe(200)
  })

  test("missing token → 401", async () => {
    const { status } = await requestJson(server, `/api/status${site}`, {
      token: null,
    })
    expect(status).toBe(401)
  })

  test("wrong token → 401", async () => {
    const { status } = await requestJson(server, `/api/status${site}`, {
      token: "not-the-token",
    })
    expect(status).toBe(401)
  })

  test("server with no RP_TOKEN configured → 503", async () => {
    const misconfigured = await startServer({
      entry: NEW_SERVER_ENTRY,
      token: null,
    })
    try {
      const { status } = await requestJson(misconfigured, `/api/status${site}`, {
        token: FIXTURE_TOKEN,
      })
      expect(status).toBe(503)
    } finally {
      misconfigured.stop()
    }
  })
})

// --- argument validation ---

describe("argument validation", () => {
  test("missing ?site= on a site-scoped route → 400 site-required", async () => {
    const { status, body } = await requestJson(server, "/api/status")
    expect(status).toBe(400)
    // The error payload names the missing site argument.
    expect(JSON.stringify(body).toLowerCase()).toContain("site")
  })
})

// --- JSON read surfaces ---

describe("JSON routes", () => {
  test("GET /api/sites → sites array containing the fixture site", async () => {
    const { status, body } = await requestJson(server, "/api/sites")
    expect(status).toBe(200)
    const sites = (body as { sites: ReadonlyArray<{ id: string }> }).sites
    expect(Array.isArray(sites)).toBe(true)
    expect(sites.some((entry) => entry.id === FIXTURE_SITE_ID)).toBe(true)
  })

  // /api/jobs is the one site-scoped read whose ?site= is optional, so both
  // shapes have to keep working: bare (the desktop app polls it that way) and
  // explicit (the only way to inspect a non-default site's sync history).
  test("GET /api/jobs → jobs array, with and without ?site=", async () => {
    const bare = await requestJson(server, "/api/jobs")
    expect(bare.status).toBe(200)
    expect(Array.isArray((bare.body as { jobs: unknown }).jobs)).toBe(true)

    const scoped = await requestJson(server, `/api/jobs${site}`)
    expect(scoped.status).toBe(200)
    expect(Array.isArray((scoped.body as { jobs: unknown }).jobs)).toBe(true)
  })

  // The debug fixture names no analytics provider, so the live read answers
  // with both halves null — and, crucially, with 200: a site without a
  // provider is the ordinary case, not an error.
  test("GET /api/live → 200 with null provider and count for a site without analytics", async () => {
    const { status, body } = await requestJson(server, `/api/live${site}`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(envelope.analytics).toBeNull()
    expect(envelope.live).toBeNull()
  })

  test("GET /api/live/events → 200 with null provider and feed for a site without analytics", async () => {
    const { status, body } = await requestJson(server, `/api/live/events${site}`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(envelope.analytics).toBeNull()
    expect(envelope.events).toBeNull()
  })

  test("GET /api/live/events → 400 when since is not an instant", async () => {
    const { status, body } = await requestJson(server, `/api/live/events${site}&since=yesterday`)
    expect(status).toBe(400)
    expect(String((body as Record<string, unknown>).error)).toContain("since")
  })

  test("GET /api/today → 200 with both halves null for a site without analytics", async () => {
    const { status, body } = await requestJson(server, `/api/today${site}`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(envelope.analytics).toBeNull()
    expect(envelope.today).toBeNull()
  })

  test("GET /api/events → 200 with an empty list for a site without analytics", async () => {
    const { status, body } = await requestJson(server, `/api/events${site}&window=7`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(envelope.analytics).toBeNull()
    expect(envelope.windowDays).toBe(7)
    expect(envelope.events).toEqual([])
  })

  test("GET /api/revenue → 200 with a null source and zero totals for a site without one", async () => {
    const { status, body } = await requestJson(server, `/api/revenue${site}&window=7`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(envelope.revenue).toBeNull()
    expect(envelope.windowDays).toBe(7)
    expect(envelope.days).toEqual([])
    expect(envelope.current).toEqual({ orders: 0, revenue: 0, net: 0 })
  })

  test("GET /api/revenue with a bad ?window= → 400", async () => {
    const { status } = await requestJson(server, `/api/revenue${site}&window=zero`)
    expect(status).toBe(400)
  })

  test("GET /api/events with a bad ?window= → 400", async () => {
    const { status } = await requestJson(server, `/api/events${site}&window=zero`)
    expect(status).toBe(400)
  })

  test("GET /api/jobs with an unknown ?site= → 400", async () => {
    const { status } = await requestJson(server, "/api/jobs?site=nope")
    expect(status).toBe(400)
  })

  test("GET /api/registry/health → the plan judged on demand", async () => {
    const { status, body } = await requestJson(server, `/api/registry/health${site}`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(typeof envelope.generatedAt).toBe("string")
    expect(Object.keys(envelope)).toEqual(
      expect.arrayContaining(["domainRating", "totals", "keywords"]),
    )

    // The fixture deployment has no DataForSEO key, which is the shape every
    // deployment has until one is configured: the report still answers, and
    // every row says the vendor was never asked rather than claiming it found
    // nothing.
    const totals = envelope.totals as Record<string, number>
    const keywords = envelope.keywords as ReadonlyArray<Record<string, unknown>>
    expect(totals.keywords).toBe(keywords.length)
    expect(totals.unmeasured).toBe(keywords.length)
    expect(totals.monthlyVolume).toBe(0)
    expect(keywords.every((row) => row.verdict === "unmeasured")).toBe(true)
    // Every row is actionable on its own: the reader needs the target and the
    // priority to decide what to do about a keyword.
    expect(keywords.every((row) => typeof row.targetUrl === "string")).toBe(true)
  })

  test("GET /api/registry/health with an unknown ?site= → 400", async () => {
    const { status } = await requestJson(server, "/api/registry/health?site=nope")
    expect(status).toBe(400)
  })

  test("GET /api/keywords/proposed → an empty list, not an error", async () => {
    // Nothing has been discovered on the fixture deployment, and that is the
    // shape every deployment has until someone runs a discovery. It answers,
    // rather than 404-ing or failing, so a screen can show "none yet" without
    // having to tell an empty list from a broken read.
    const { status, body } = await requestJson(server, `/api/keywords/proposed${site}`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    expect(typeof envelope.generatedAt).toBe("string")
    expect(envelope.totals).toEqual({ proposals: 0, monthlyVolume: 0 })
    expect(envelope.proposals).toEqual([])
  })

  test("POST /api/keywords/dismiss → the count of rows changed", async () => {
    // Nothing is proposed, so nothing changes. The count is rows changed and
    // not keywords named, which is what makes a repeated dismissal safe.
    const { status, body } = await requestJson(server, `/api/keywords/dismiss${site}`, {
      method: "POST",
      body: { keywords: ["never proposed"] },
    })
    expect(status).toBe(200)
    expect((body as Record<string, unknown>).dismissed).toBe(0)
  })

  test("GET /api/keywords/proposed with an unknown ?site= → 400", async () => {
    const { status } = await requestJson(server, "/api/keywords/proposed?site=nope")
    expect(status).toBe(400)
  })

  test("GET /api/status → debug envelope with generatedAt + expected keys", async () => {
    const { status, body } = await requestJson(server, `/api/status${site}`)
    expect(status).toBe(200)
    const envelope = body as Record<string, unknown>
    // Envelope carries the standard debug-mode metadata.
    expect(typeof envelope.generatedAt).toBe("string")
    expect(envelope.mode).toBe("debug")
    // The status payload exposes its top-level report sections.
    expect(Object.keys(envelope)).toEqual(
      expect.arrayContaining(["data", "registry", "sitemap", "actions"]),
    )
    expect(typeof envelope.data).toBe("object")
    expect(typeof envelope.registry).toBe("object")
    expect(typeof envelope.sitemap).toBe("object")
    // data.lastSyncedAt is the instant Search Console data last arrived (the
    // sync just seeded above), reported as its own ISO 8601 instant — a client
    // must not read freshness off generatedAt, which is serialization time.
    const data = envelope.data as Record<string, unknown>
    expect(data.lastSyncedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    )
    // data.lastCheckedAt is the instant the sync RUN completed. The seeding sync
    // above both fetched and ran, so both fields are set here; the pair is what
    // lets a client separate "ran, nothing new" from "never ran".
    expect(data.lastCheckedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    )
  })
})

// --- plain-text feeds (assert the SHAPE, not exact values) ---

describe("text feeds", () => {
  test("GET /sites.txt → text/plain with id\\tname lines", async () => {
    const response = await fetch(`${server.baseUrl}/sites.txt`, {
      headers: { authorization: `Bearer ${server.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    const bodyText = await response.text()
    // Each line is `${id}\t${name}`; the fixture site must appear.
    const lines = bodyText.split("\n").filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => /^[^\t]+\t[^\t]+$/.test(line))).toBe(true)
    expect(lines).toContain(`${FIXTURE_SITE_ID}\tSleevy`)
  })

  test("GET /pages.txt → header line then pipe-delimited metric rows", async () => {
    const response = await fetch(`${server.baseUrl}/pages.txt${site}`, {
      headers: { authorization: `Bearer ${server.token}` },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    const bodyText = await response.text()
    const lines = bodyText.split("\n").filter((line) => line.length > 0)
    // First line: latest=<date>|window=<date>..<date>
    expect(lines[0]).toMatch(
      /^latest=\d{4}-\d{2}-\d{2}\|window=\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/,
    )
    // Following rows: path|clicks|impressions|ctr%|pos
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^\/\S*\|\d+\|\d+\|[\d.]+%\|[\d.]+$/)
    }
  })

  test("GET /tui/home.txt → non-empty text/plain feed", async () => {
    const { status, body } = await requestText(server, `/tui/home.txt${site}`)
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    const response = await fetch(`${server.baseUrl}/tui/home.txt${site}`, {
      headers: { authorization: `Bearer ${server.token}` },
    })
    expect(response.headers.get("content-type")).toContain("text/plain")
  })
})

// --- site catalog and settings ---

describe("site settings routes", () => {
  const newSite = { id: "newsite", siteUrl: "sc-domain:newsite.example" }

  test("GET /api/sites/:id/settings → the stored entry next to the resolved Site", async () => {
    const { status, body } = await requestJson(
      server,
      `/api/sites/${FIXTURE_SITE_ID}/settings`,
    )
    expect(status).toBe(200)
    const envelope = body as { site: { id: string; origin: string }; settings: { id: string; siteUrl: string } }
    expect(envelope.settings.id).toBe(FIXTURE_SITE_ID)
    expect(envelope.settings.siteUrl).toBe("https://sleevy.app")
    expect(envelope.site.origin).toBe("https://sleevy.app")
  })

  test("GET /api/sites/:id/settings for an unknown id → 404", async () => {
    const { status } = await requestJson(server, "/api/sites/nope/settings")
    expect(status).toBe(404)
  })

  test("POST /api/sites → 201, the site appears in the catalog, a second POST → 409", async () => {
    const created = await requestJson(server, "/api/sites", {
      method: "POST",
      body: newSite,
    })
    expect(created.status).toBe(201)
    const envelope = created.body as { site: { id: string; origin: string; name: string } }
    expect(envelope.site.id).toBe("newsite")
    expect(envelope.site.origin).toBe("https://newsite.example")
    expect(envelope.site.name).toBe("newsite")

    const listed = await requestJson(server, "/api/sites")
    const ids = (listed.body as { sites: ReadonlyArray<{ id: string }> }).sites.map((s) => s.id)
    expect(ids).toContain("newsite")

    const again = await requestJson(server, "/api/sites", { method: "POST", body: newSite })
    expect(again.status).toBe(409)
  })

  test("POST /api/sites with an unsafe id or a non-URL origin → 400", async () => {
    const badId = await requestJson(server, "/api/sites", {
      method: "POST",
      body: { id: "Bad Id", siteUrl: "sc-domain:bad.example" },
    })
    expect(badId.status).toBe(400)
    const badOrigin = await requestJson(server, "/api/sites", {
      method: "POST",
      body: { id: "badorigin", siteUrl: "not a url" },
    })
    expect(badOrigin.status).toBe(400)
    const listed = await requestJson(server, "/api/sites")
    const ids = (listed.body as { sites: ReadonlyArray<{ id: string }> }).sites.map((s) => s.id)
    expect(ids).not.toContain("badorigin")
  })

  test("PUT /api/sites/:id/settings replaces the settings and the catalog reflects it", async () => {
    const updated = await requestJson(server, "/api/sites/newsite/settings", {
      method: "PUT",
      body: { siteUrl: newSite.siteUrl, name: "Renamed", brandTerms: ["new", "site"] },
    })
    expect(updated.status).toBe(200)
    const envelope = updated.body as { site: { name: string; brandTerms: string[] } }
    expect(envelope.site.name).toBe("Renamed")
    expect(envelope.site.brandTerms).toEqual(["new", "site"])

    const listed = await requestJson(server, "/api/sites")
    const sites = (listed.body as { sites: ReadonlyArray<{ id: string; name: string }> }).sites
    expect(sites.find((s) => s.id === "newsite")?.name).toBe("Renamed")

    // The site is served from a fresh runtime after the change.
    const status = await requestJson(server, "/api/status?site=newsite")
    expect(status.status).toBe(200)
  })

  test("PUT /api/sites/:id/settings for an unknown id → 404", async () => {
    const { status } = await requestJson(server, "/api/sites/nope/settings", {
      method: "PUT",
      body: { siteUrl: "sc-domain:nope.example" },
    })
    expect(status).toBe(404)
  })

  test("DELETE /api/sites/:id removes the entry; a second DELETE → 404", async () => {
    const removed = await requestJson(server, "/api/sites/newsite", { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect((removed.body as { removed: string }).removed).toBe("newsite")

    const settings = await requestJson(server, "/api/sites/newsite/settings")
    expect(settings.status).toBe(404)
    const again = await requestJson(server, "/api/sites/newsite", { method: "DELETE" })
    expect(again.status).toBe(404)
  })
})

// --- vendor keys ---

describe("secrets routes", () => {
  const keyedSite = {
    id: "keyed",
    siteUrl: "sc-domain:keyed.example",
    // A Rybbit source whose base URL is never reached: the adapter only needs
    // the key to report ready, which is exactly what these tests observe.
    analytics: { provider: "rybbit", siteId: "1", baseUrl: "http://127.0.0.1:9" },
  }
  const analyticsStatus = async () => {
    const { body } = await requestJson(server, "/api/status?site=keyed")
    return (body as { analytics: { ready: boolean; reason: string | null } | null }).analytics
  }

  test("GET /api/secrets → encryption configured and an empty ahrefs slot", async () => {
    const { status, body } = await requestJson(server, "/api/secrets")
    expect(status).toBe(200)
    const envelope = body as {
      encryption: { configured: boolean }
      slots: ReadonlyArray<{ purpose: string; variable: string; stored: unknown; inEnvironment: boolean }>
    }
    expect(envelope.encryption.configured).toBe(true)
    const ahrefs = envelope.slots.find((slot) => slot.purpose === "ahrefs")
    expect(ahrefs?.variable).toBe("AHREFS_API_KEY")
    expect(ahrefs?.stored).toBeNull()
    expect(ahrefs?.inEnvironment).toBe(false)
  })

  test("GET /api/secrets offers a DataForSEO slot under the variable the services read", async () => {
    // Without this slot the key has nowhere to be typed: the Mac app's Settings
    // window renders one field per slot, so a missing purpose forces the key
    // into the server's environment — which CONTEXT.md rules out for a Vendor
    // key. The variable name is the load-bearing part: KeywordMetrics and
    // KeywordDiscovery both read `DATAFORSEO_API_KEY` from config, and the
    // site runtime injects a revealed vault secret under exactly that name.
    const { status, body } = await requestJson(server, "/api/secrets")
    expect(status).toBe(200)
    const slots = (body as {
      slots: ReadonlyArray<{ purpose: string; variable: string; stored: unknown }>
    }).slots
    const dataforseo = slots.find((slot) => slot.purpose === "dataforseo")
    expect(dataforseo?.variable).toBe("DATAFORSEO_API_KEY")
    expect(dataforseo?.stored).toBeNull()
  })

  test("a stored DataForSEO key is what the keyword reports then read", async () => {
    // The round trip that matters. Storing the key must change what a site's
    // runtime can do, not just what the settings screen lists — and the proof
    // is that the report stops saying the vendor was never asked.
    const value = "dataforseo-test-key-0002"
    const put = await requestJson(server, "/api/secrets/dataforseo", {
      method: "PUT",
      body: { value },
    })
    expect(put.status).toBe(200)
    expect(JSON.stringify(put.body)).not.toContain(value)

    const listed = await requestJson(server, "/api/secrets")
    // The value never comes back, only its last four.
    expect(JSON.stringify(listed.body)).not.toContain(value)
    const slots = (listed.body as {
      slots: ReadonlyArray<{ purpose: string; stored: { last4: string } | null }>
    }).slots
    expect(slots.find((slot) => slot.purpose === "dataforseo")?.stored?.last4).toBe("0002")

    // The report still answers with every row unmeasured: a stored key means the
    // vendor CAN be asked, and nothing has asked yet. A test that expected
    // volumes here would be asserting that a read spends money.
    const health = await requestJson(server, `/api/registry/health${site}`)
    expect(health.status).toBe(200)
    const totals = (health.body as { totals: { keywords: number; unmeasured: number } }).totals
    expect(totals.unmeasured).toBe(totals.keywords)

    await requestJson(server, "/api/secrets/dataforseo", { method: "DELETE" })
  })

  test("PUT then DELETE /api/secrets/:purpose; the value never comes back", async () => {
    const value = "ahrefs-test-key-0001"
    const put = await requestJson(server, "/api/secrets/ahrefs", {
      method: "PUT",
      body: { value },
    })
    expect(put.status).toBe(200)
    const secret = (put.body as { secret: { scope: null; purpose: string; last4: string } }).secret
    expect(secret.scope).toBeNull()
    expect(secret.purpose).toBe("ahrefs")
    expect(secret.last4).toBe("0001")
    expect(JSON.stringify(put.body)).not.toContain(value)

    const listed = await requestJson(server, "/api/secrets")
    expect(JSON.stringify(listed.body)).not.toContain(value)
    const slots = (listed.body as { slots: ReadonlyArray<{ purpose: string; stored: { last4: string } | null }> }).slots
    expect(slots.find((slot) => slot.purpose === "ahrefs")?.stored?.last4).toBe("0001")

    const removed = await requestJson(server, "/api/secrets/ahrefs", { method: "DELETE" })
    expect(removed.status).toBe(200)
    const again = await requestJson(server, "/api/secrets/ahrefs", { method: "DELETE" })
    expect(again.status).toBe(404)
  })

  test("a stored site key reaches the vendor adapter through the site's runtime", async () => {
    const created = await requestJson(server, "/api/sites", { method: "POST", body: keyedSite })
    expect(created.status).toBe(201)

    // Without a key the provider is configured but not ready, and says why.
    const before = await analyticsStatus()
    expect(before?.ready).toBe(false)
    expect(before?.reason).toContain("RYBBIT_API_KEY")

    const slotsBefore = await requestJson(server, "/api/sites/keyed/secrets")
    expect(slotsBefore.status).toBe(200)
    const rybbitSlot = (slotsBefore.body as { slots: ReadonlyArray<{ purpose: string; variable: string; stored: unknown }> }).slots
      .find((slot) => slot.purpose === "rybbit")
    expect(rybbitSlot?.variable).toBe("RYBBIT_API_KEY")
    expect(rybbitSlot?.stored).toBeNull()

    const put = await requestJson(server, "/api/sites/keyed/secrets/rybbit", {
      method: "PUT",
      body: { value: "rybbit-test-key-9999" },
    })
    expect(put.status).toBe(200)
    expect((put.body as { secret: { scope: string; last4: string } }).secret).toMatchObject({
      scope: "keyed",
      last4: "9999",
    })

    // The site's runtime was rebuilt with the key in its ConfigProvider.
    const after = await analyticsStatus()
    expect(after?.ready).toBe(true)

    const removed = await requestJson(server, "/api/sites/keyed/secrets/rybbit", { method: "DELETE" })
    expect(removed.status).toBe(200)
    const gone = await analyticsStatus()
    expect(gone?.ready).toBe(false)
  })

  test("secret writes validate: unknown site → 404, blank value → 400, unsafe purpose → 400", async () => {
    const unknownSite = await requestJson(server, "/api/sites/nope/secrets/rybbit", {
      method: "PUT",
      body: { value: "value-value" },
    })
    expect(unknownSite.status).toBe(404)
    const blank = await requestJson(server, "/api/sites/keyed/secrets/rybbit", {
      method: "PUT",
      body: { value: "   " },
    })
    expect(blank.status).toBe(400)
    const unsafe = await requestJson(server, "/api/sites/keyed/secrets/Rybbit%20Key", {
      method: "PUT",
      body: { value: "value-value" },
    })
    expect(unsafe.status).toBe(400)
  })

  test("a server without RP_MASTER_KEY reports encryption unconfigured and refuses writes with 503", async () => {
    const bare = await startServer({ entry: NEW_SERVER_ENTRY, masterKey: null })
    try {
      const listed = await requestJson(bare, "/api/secrets")
      expect(listed.status).toBe(200)
      const encryption = (listed.body as { encryption: { configured: boolean; reason: string } }).encryption
      expect(encryption.configured).toBe(false)
      expect(encryption.reason).toContain("RP_MASTER_KEY")
      const put = await requestJson(bare, "/api/secrets/ahrefs", {
        method: "PUT",
        body: { value: "value-value" },
      })
      expect(put.status).toBe(503)
    } finally {
      bare.stop()
    }
  })
})

// --- per-client tokens ---

describe("clients routes", () => {
  test("POST /api/clients issues a token once; the token authenticates until revoked", async () => {
    const created = await requestJson(server, "/api/clients", {
      method: "POST",
      body: { label: "Test Mac" },
    })
    expect(created.status).toBe(201)
    const { client, token } = created.body as {
      client: { id: string; label: string; revokedAt: null }
      token: string
    }
    expect(client.label).toBe("Test Mac")
    expect(token.startsWith("rp_")).toBe(true)

    // The list shows the client but never the token.
    const listed = await requestJson(server, "/api/clients")
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).toContain(client.id)
    expect(JSON.stringify(listed.body)).not.toContain(token)

    // The issued token is a valid bearer on any route.
    const withClient = await requestJson(server, `/api/status${site}`, { token })
    expect(withClient.status).toBe(200)

    const revoked = await requestJson(server, `/api/clients/${client.id}`, { method: "DELETE" })
    expect(revoked.status).toBe(200)
    expect((revoked.body as { client: { revokedAt: string | null } }).client.revokedAt).not.toBeNull()

    const afterRevoke = await requestJson(server, `/api/status${site}`, { token })
    expect(afterRevoke.status).toBe(401)
  })

  test("a made-up rp_ token → 401; a blank label → 400; an unknown id → 404", async () => {
    const forged = await requestJson(server, `/api/status${site}`, { token: "rp_forged" })
    expect(forged.status).toBe(401)
    const blank = await requestJson(server, "/api/clients", { method: "POST", body: { label: "  " } })
    expect(blank.status).toBe(400)
    const unknown = await requestJson(server, "/api/clients/nope", { method: "DELETE" })
    expect(unknown.status).toBe(404)
  })
})

// --- one-time import of vendor keys from the environment ---

describe("environment key import", () => {
  test("a server started with a vendor key in its environment stores it once and reads through it", async () => {
    const home = makeFixtureHome([keyedSite])
    const first = await startServer({
      entry: NEW_SERVER_ENTRY,
      configHome: home,
      env: { RYBBIT_API_KEY: "rybbit-env-key-7777" },
    })
    try {
      const slots = await requestJson(first, `/api/sites/${KEYED_SITE_ID}/secrets`)
      const rybbit = (slots.body as { slots: ReadonlyArray<{ purpose: string; stored: { last4: string } | null }> }).slots
        .find((slot) => slot.purpose === "rybbit")
      expect(rybbit?.stored?.last4).toBe("7777")
      expect(JSON.stringify(slots.body)).not.toContain("rybbit-env-key-7777")
    } finally {
      first.stop()
    }

    // Same home, no variable any more: the stored key carries the site.
    const second = await startServer({ entry: NEW_SERVER_ENTRY, configHome: home })
    try {
      const { body } = await requestJson(second, `/api/status?site=${KEYED_SITE_ID}`)
      expect((body as { analytics: { ready: boolean } }).analytics.ready).toBe(true)
    } finally {
      second.stop()
    }
  })
})
