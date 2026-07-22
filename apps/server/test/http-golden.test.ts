// Parallel golden run for the NEW HttpApi server (apps/server/src/http/serve.ts).
//
// It boots the new server through the same PLO-263 harness (pointing
// RP_GOLDEN_SERVER_ENTRY at serve.ts) and asserts it reproduces the SAME
// committed snapshots the legacy server produces — byte-for-byte for text feeds,
// value-for-value for the JSON envelopes. The committed `golden.test.ts.snap`
// is the oracle and is read directly here (never regenerated), so this test
// fails loudly if the new server's HTTP contract drifts from the legacy one.
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  FIXTURE_SITE_ID,
  FIXTURE_TOKEN,
  normalize,
  repoRoot,
  requestJson,
  requestText,
  startServer,
  waitForJob,
  type RunningServer,
} from "./lib/harness.ts"

const site = `?site=${FIXTURE_SITE_ID}`

// The new server entry under test.
const NEW_SERVER_ENTRY = resolve(repoRoot, "apps/server/src/http/serve.ts")

// Load the committed legacy snapshots as data. The .snap file is a CommonJS
// module that assigns to `exports[key]`; evaluating it yields the serialized
// snapshot strings. Each JSON snapshot body is a JS object literal (trailing
// commas, quoted keys), so it evals back to a value for structural comparison;
// each text snapshot body is a quoted string literal.
const committed: Record<string, string> = (() => {
  const text = readFileSync(
    join(repoRoot, "apps/server/test/__snapshots__/golden.test.ts.snap"),
    "utf8",
  )
  const exportsObject: Record<string, string> = {}
  new Function("exports", text)(exportsObject)
  return exportsObject
})()

// Reproduce Bun's snapshot serializer for JSON values so a normalized response
// can be string-compared against the committed block. Bun/jest pretty-format:
// two-space indent, object keys sorted, trailing comma after every entry, empty
// containers inline, strings double-quoted with inner quotes left unescaped
// (so the committed text is not itself valid JSON — hence this serializer rather
// than a parse).
const bunSerialize = (value: unknown, indent = ""): string => {
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "string") return `"${value}"`
  const next = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const items = value.map((item) => `${next}${bunSerialize(item, next)},`)
    return `[\n${items.join("\n")}\n${indent}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    )
    if (entries.length === 0) return "{}"
    const lines = entries.map(
      ([key, entry]) => `${next}"${key}": ${bunSerialize(entry, next)},`,
    )
    return `{\n${lines.join("\n")}\n${indent}}`
  }
  return String(value)
}

// The committed block for a JSON route, stripped of Bun's multi-line wrapping.
const expectedJson = (key: string): string => {
  const body = committed[key]
  if (body === undefined) throw new Error(`Missing committed snapshot: ${key}`)
  return body.trim()
}

// A text snapshot body is Bun's string serialization: the string wrapped in
// double quotes (with `"`/`\` escaped and literal newlines), and for multi-line
// values additionally wrapped in leading/trailing newlines. Recover the raw text.
const expectedText = (key: string): string => {
  const body = committed[key]
  if (body === undefined) throw new Error(`Missing committed snapshot: ${key}`)
  let s = body
  if (s.startsWith("\n") && s.endsWith("\n")) s = s.slice(1, -1)
  s = s.replace(/^"/, "").replace(/"$/, "")
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

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

// --- JSON read surfaces (compared structurally against committed values) ---

const jsonRoutes: ReadonlyArray<readonly [string, string, string]> = [
  ["sites", "/api/sites", "JSON routes sites 1"],
  ["status", `/api/status${site}`, "JSON routes status 1"],
  ["dashboard", `/api/dashboard${site}`, "JSON routes dashboard 1"],
  ["pages", `/api/pages${site}`, "JSON routes pages 1"],
  ["page", `/api/page${site}&path=/pocket-alternative`, "JSON routes page 1"],
  ["queries", `/api/queries${site}`, "JSON routes queries 1"],
  ["opportunities", `/api/opportunities${site}`, "JSON routes opportunities 1"],
  ["registry", `/api/registry${site}`, "JSON routes registry 1"],
  ["log", `/api/log${site}`, "JSON routes log 1"],
  ["history", `/api/history${site}`, "JSON routes history 1"],
  ["jobs", "/api/jobs", "JSON routes jobs 1"],
]

describe("JSON routes (new server vs committed golden)", () => {
  for (const [name, path, key] of jsonRoutes) {
    test(name, async () => {
      const { status, body } = await requestJson(server, path)
      expect(status).toBe(200)
      expect(bunSerialize(normalize(body))).toBe(expectedJson(key))
    })
  }
})

// --- plain-text feeds (byte-for-byte against committed values) ---

const textRoutes: ReadonlyArray<readonly [string, string, string]> = [
  ["sites.txt", "/sites.txt", "text feeds sites.txt 1"],
  ["pages.txt", `/pages.txt${site}`, "text feeds pages.txt 1"],
  ["tui-home", `/tui/home.txt${site}`, "text feeds tui-home 1"],
  ["tui-opportunities", `/tui/opportunities.txt${site}`, "text feeds tui-opportunities 1"],
  ["tui-history", `/tui/history.txt${site}`, "text feeds tui-history 1"],
  ["tui-registry", `/tui/registry.txt${site}`, "text feeds tui-registry 1"],
  ["tui-log", `/tui/log.txt${site}`, "text feeds tui-log 1"],
]

describe("text feeds (new server vs committed golden)", () => {
  for (const [name, path, key] of textRoutes) {
    test(name, async () => {
      const { status, body } = await requestText(server, path)
      expect(status).toBe(200)
      expect(body).toBe(expectedText(key))
    })
  }
})

// --- bearer auth + argument validation ---

describe("auth and validation (new server)", () => {
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
    const misconfigured = await startServer({ entry: NEW_SERVER_ENTRY, token: null })
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
