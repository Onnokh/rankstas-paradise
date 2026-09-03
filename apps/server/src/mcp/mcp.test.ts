// MCP adapter tests. The adapter is driven through a real in-memory MCP
// client/server pair, over a test runtime whose `Reports` is a mock: a read
// tool and a write tool return the DTO as pretty-JSON text, and a domain tagged
// error (`ReportsError`) is mapped to a structured MCP error result rather than
// crashing the tool call.
import { expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { Config } from "@rp/domain/config/config"
import { Reports } from "@rp/domain/reports/reports"
import { ReportsError } from "@rp/domain/reports/schema"
import { Sites } from "@rp/domain/sites/sites"
import { SiteId, type Site } from "@rp/domain/sites/schema"
import type { StatusReport, LogAddResult } from "@rp/domain/reports/schema"

import { buildMcpServer, type RunTool } from "./mcp.ts"

const fakeSite: Site = {
  id: SiteId.make("acme"),
  name: "Acme",
  property: "sc-domain:acme.example",
  origin: "https://acme.example",
  sitemapUrl: "https://acme.example/sitemap.xml",
  brandTerms: ["acme"],
}

const fakeStatus: StatusReport = {
  data: {
    firstDate: "2026-01-01",
    lastDate: "2026-01-28",
    syncedDays: 28,
    snapshotRows: 100,
    dailyTotalsDays: 28,
    lastSyncedAt: "2026-01-29T06:00:00Z",
    lastCheckedAt: "2026-01-29T12:00:00Z",
    note: "n/a",
  },
  registry: { targets: 2, keywords: 3, clusters: 1 },
  sitemap: { pages: 5, unmapped: ["/orphan"] },
  actions: 4,
}

const fakeLogged: LogAddResult = {
  logged: {
    id: 1,
    date: "2026-01-28",
    path: "/pricing",
    kind: "note",
    note: "checked",
    createdAt: "2026-01-28T00:00:00.000Z",
  },
}

// Mock Reports: `statusReport` succeeds (read), `logAdd` succeeds (write), and
// `registryList` fails with a domain tagged error (error-mapping). Untouched
// methods die loudly.
const reportsMock = Layer.mock(Reports.Service)({
  statusReport: () => Effect.succeed(fakeStatus),
  logAdd: () => Effect.succeed(fakeLogged),
  registryList: () =>
    Effect.fail(new ReportsError({ message: "registry unavailable" })),
})

// `CurrentSite.layerFor(siteId)` resolves the site through Sites and reads the
// data home / debug flag from Config, so the seam's context needs both.
const sitesMock = Layer.mock(Sites.Service)({
  siteFor: () => Effect.succeed(fakeSite),
})

const configMock = Layer.mock(Config.Service)({
  dataDirectory: () => Effect.succeed("/tmp/rp-test"),
  debugMode: () => Effect.succeed(true),
})

const testLayer = Layer.mergeAll(reportsMock, sitesMock, configMock)

// A test client connected to the adapter over the given runtime seam.
const connectClient = async (run: RunTool): Promise<Client> => {
  const server = buildMcpServer(run)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

const withClient = async (fn: (client: Client) => Promise<void>): Promise<void> => {
  const runtime = ManagedRuntime.make(testLayer)
  // The test uses a single site whose services the mock provides, so the run
  // ignores the site arg and runs every tool effect on the one test runtime.
  const run: RunTool = (_site, effect) => runtime.runPromise(effect)
  const client = await connectClient(run)
  try {
    await fn(client)
  } finally {
    await client.close()
    await runtime.dispose()
  }
}

const textOf = (result: unknown): string => {
  const content = (result as { content: ReadonlyArray<{ text: string }> }).content
  return content[0]!.text
}

test("read tool returns the report DTO as pretty JSON", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "status",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual(fakeStatus)
  })
})

test("write tool runs the Reports write and returns its DTO", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "log_add",
      arguments: { site: "acme", path: "/pricing", kind: "note", note: "checked" },
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual(fakeLogged)
  })
})

test("a domain tagged error maps to a structured MCP error result", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "registry",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: "ReportsError",
      message: "registry unavailable",
    })
  })
})
