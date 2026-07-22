// Golden/snapshot suite: captures TODAY's server HTTP contract against a
// deterministic debug fixture, so downstream refactors (PLO-275/276) are
// provably behaviour-preserving. Point it at a different server by setting
// RP_GOLDEN_SERVER_ENTRY; if behaviour is preserved the snapshots still match.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  FIXTURE_SITE_ID,
  FIXTURE_TOKEN,
  normalize,
  requestJson,
  requestText,
  startServer,
  waitForJob,
  type RunningServer,
} from "./lib/harness.ts"

const site = `?site=${FIXTURE_SITE_ID}`

let server: RunningServer

beforeAll(async () => {
  server = await startServer()
  // Debug mode starts with an empty DB and read-triggered sync disabled; seed
  // it by kicking the sync job and polling to completion.
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

// --- JSON read surfaces (envelope mode + normalized generatedAt + body) ---

const jsonRoutes: ReadonlyArray<readonly [string, string]> = [
  ["sites", "/api/sites"],
  ["status", `/api/status${site}`],
  ["dashboard", `/api/dashboard${site}`],
  ["pages", `/api/pages${site}`],
  ["page", `/api/page${site}&path=/pocket-alternative`],
  ["queries", `/api/queries${site}`],
  ["opportunities", `/api/opportunities${site}`],
  ["registry", `/api/registry${site}`],
  ["log", `/api/log${site}`],
  ["history", `/api/history${site}`],
  ["jobs", "/api/jobs"],
]

describe("JSON routes", () => {
  for (const [name, path] of jsonRoutes) {
    test(name, async () => {
      const { status, body } = await requestJson(server, path)
      expect(status).toBe(200)
      expect(normalize(body)).toMatchSnapshot()
    })
  }
})

// --- plain-text feeds ---

const textRoutes: ReadonlyArray<readonly [string, string]> = [
  ["sites.txt", "/sites.txt"],
  ["pages.txt", `/pages.txt${site}`],
  ["tui-home", `/tui/home.txt${site}`],
  ["tui-opportunities", `/tui/opportunities.txt${site}`],
  ["tui-history", `/tui/history.txt${site}`],
  ["tui-registry", `/tui/registry.txt${site}`],
  ["tui-log", `/tui/log.txt${site}`],
]

describe("text feeds", () => {
  for (const [name, path] of textRoutes) {
    test(name, async () => {
      const { status, body } = await requestText(server, path)
      expect(status).toBe(200)
      expect(body).toMatchSnapshot()
    })
  }
})

// --- bearer auth + argument validation ---

describe("auth and validation", () => {
  test("valid token → 200", async () => {
    const { status } = await requestJson(server, `/api/status${site}`)
    expect(status).toBe(200)
  })

  test("wrong token → 401", async () => {
    const { status } = await requestJson(server, `/api/status${site}`, {
      token: "not-the-token",
    })
    expect(status).toBe(401)
  })

  test("missing token → 401", async () => {
    const { status } = await requestJson(server, `/api/status${site}`, {
      token: null,
    })
    expect(status).toBe(401)
  })

  test("missing ?site= → 400", async () => {
    const { status } = await requestJson(server, "/api/status")
    expect(status).toBe(400)
  })

  test("server without RP_TOKEN → 503", async () => {
    const misconfigured = await startServer({ token: null })
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
