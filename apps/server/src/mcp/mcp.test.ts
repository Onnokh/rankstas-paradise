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
import { KeywordDiscovery } from "@rp/domain/keyword-discovery/keyword-discovery"
import { KeywordDiscoveryError } from "@rp/domain/keyword-discovery/schema"
import type { KeywordProposal } from "@rp/domain/keyword-discovery/schema"
import { UnservedMarketError } from "@rp/domain/keyword-metrics/schema"
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

const fakeProposal: KeywordProposal = {
  keyword: "acme widget sizes",
  seed: "acme widget",
  source: "suggestions",
  locationCode: 2840,
  languageCode: "en",
  searchVolume: 320,
  difficulty: 18,
  costPerClick: 0.9,
  competition: 0.3,
  intent: "informational",
  status: "proposed",
  discoveredAt: "2026-09-08T00:00:00.000Z",
}

// Mock KeywordDiscovery: `proposed` succeeds, `dismiss` succeeds, and `discover`
// fails with the domain's tagged error, so the discovery tools' own error
// mapping is exercised rather than assumed to match Reports'.
const discoveryMock = Layer.mock(KeywordDiscovery.Service)({
  proposed: () => Effect.succeed([fakeProposal]),
  dismiss: () => Effect.succeed(1),
  discover: () =>
    Effect.fail(new KeywordDiscoveryError({ message: "no DataForSEO key" })),
})

const testLayer = Layer.mergeAll(reportsMock, sitesMock, configMock, discoveryMock)

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

test("keywords_proposed returns the stored proposals", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "keywords_proposed",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual([fakeProposal])
  })
})

test("keywords_dismiss names the count rather than returning a bare number", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "keywords_dismiss",
      arguments: { site: "acme", keywords: ["acme widget sizes"] },
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual({ dismissed: 1 })
  })
})

test("a discovery error maps to a structured MCP error result", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "keywords_discover",
      arguments: { site: "acme", seed: "acme widget" },
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: "KeywordDiscoveryError",
      message: "no DataForSEO key",
    })
  })
})

test("an unserved market names the pair, since it carries no message", async () => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reportsMock,
      sitesMock,
      configMock,
      Layer.mock(KeywordDiscovery.Service)({
        discover: () =>
          Effect.fail(
            new UnservedMarketError({
              locationCode: 2528,
              languageCode: "de",
              reason: "The Netherlands is served in Dutch only.",
            }),
          ),
      }),
    ),
  )
  const client = await connectClient((_site, effect) => runtime.runPromise(effect))
  try {
    const result = await client.callTool({
      name: "keywords_discover",
      arguments: { site: "acme", seed: "acme widget" },
    })
    expect(result.isError).toBe(true)
    // The fix for this error is a different Market, so the pair has to be in
    // the message an agent reads — the error itself has no `message` field.
    expect(JSON.parse(textOf(result))).toEqual({
      error: "UnservedMarketError",
      message:
        "The Netherlands is served in Dutch only. (location 2528, language de)",
    })
  } finally {
    await client.close()
    await runtime.dispose()
  }
})

test("keywords_discover passes its filters through and never invents a limit", async () => {
  // The arguments an agent sends have to arrive as the domain's request, or a
  // filter silently does nothing and the reader pays for rows they asked to
  // exclude.
  const seen: Array<unknown> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reportsMock,
      sitesMock,
      configMock,
      Layer.mock(KeywordDiscovery.Service)({
        discover: (request) =>
          Effect.sync(() => {
            seen.push(request)
            return {
              seed: request.seed,
              source: "suggestions" as const,
              returned: 0,
              droppedKnown: 0,
              droppedBrandOrOperator: 0,
              droppedBelowVolume: 0,
              droppedAboveDifficulty: 0,
              droppedByIntent: 0,
              proposals: [],
            }
          }),
      }),
    ),
  )
  const client = await connectClient((_site, effect) => runtime.runPromise(effect))
  try {
    await client.callTool({
      name: "keywords_discover",
      arguments: {
        site: "acme",
        seed: "acme widget",
        source: "related",
        minVolume: 50,
        intents: ["informational"],
      },
    })
    expect(seen).toEqual([
      {
        seed: "acme widget",
        source: "related",
        minVolume: 50,
        intents: ["informational"],
      },
    ])
  } finally {
    await client.close()
    await runtime.dispose()
  }
})
