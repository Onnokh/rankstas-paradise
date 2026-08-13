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

  test("GET /api/jobs with an unknown ?site= → 400", async () => {
    const { status } = await requestJson(server, "/api/jobs?site=nope")
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

  test("GET /tui/queries.txt → non-empty text/plain feed", async () => {
    const { status, body } = await requestText(server, `/tui/queries.txt${site}`)
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    const response = await fetch(`${server.baseUrl}/tui/queries.txt${site}`, {
      headers: { authorization: `Bearer ${server.token}` },
    })
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(body).toContain("QUERY\tPAGE\tG IMPR")
  })
})
