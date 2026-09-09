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
import { KeywordMetrics } from "@rp/domain/keyword-metrics/keyword-metrics"
import { Market } from "@rp/domain/keyword-metrics/market"
import { UnservedMarketError } from "@rp/domain/keyword-metrics/schema"
import type {
  MarketSetResult,
  MarketSettings,
} from "@rp/domain/keyword-metrics/schema"
import { Registry } from "@rp/domain/registry/registry"
import { Reports } from "@rp/domain/reports/reports"
import { ReportsError } from "@rp/domain/reports/schema"
import { Sites } from "@rp/domain/sites/sites"
import { SiteId, type Site } from "@rp/domain/sites/schema"
import type {
  KeywordProposalsReport,
  LogAddResult,
  StatusReport,
} from "@rp/domain/reports/schema"

import { buildMcpServer, type MarketTool, type RunTool } from "./mcp.ts"

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
  proposedKeywords: () => Effect.succeed(fakeProposalsReport),
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

// The report envelope the HTTP route answers with, which `keywords_proposed`
// has to answer with too — same data, one shape.
const fakeProposalsReport: KeywordProposalsReport = {
  market: {
    locationCode: 2840,
    languageCode: "en",
    label: "United States",
    provider: "labs",
  },
  totals: { proposals: 1, monthlyVolume: 320 },
  proposals: [fakeProposal],
}

// Mock KeywordDiscovery: `dismiss` succeeds, `propose` succeeds, and `discover`
// fails with the domain's tagged error, so the discovery tools' own error
// mapping is exercised rather than assumed to match Reports'. `proposed` is not
// here: that tool reads through `Reports`, so a mock of it would hide a
// regression rather than catch one.
const discoveryMock = Layer.mock(KeywordDiscovery.Service)({
  dismiss: () => Effect.succeed(1),
  propose: (keywords) =>
    Effect.succeed({
      named: keywords.length,
      stored: keywords.length,
      skippedKnown: 0,
      skippedBrandOrOperator: 0,
      skippedDuplicate: 0,
    }),
  discover: () =>
    Effect.fail(new KeywordDiscoveryError({ message: "no DataForSEO key" })),
})

// Mock KeywordMetrics and the Registry behind `keywords_refresh`. The tool
// calls the domain's `refreshPlanned`, so the plan really is read here and the
// keywords really are handed to `refresh` — a mock of the whole effect would
// prove only that the tool calls something.
const fakeEntry = {
  cluster: "widgets",
  keyword: "Acme Widget Sizes",
  targetUrl: "/widgets",
  intent: "informational",
  whyOpportunity: "",
  priority: "high",
  publishedAt: "",
  baselineDate: "",
  status: "",
}

const registryMock = Layer.mock(Registry.Service)({
  loadRegistry: () =>
    Effect.succeed([
      fakeEntry,
      // A second row for the same keyword, differently cased, plus an
      // inventory-only row: neither may reach the vendor as its own term.
      { ...fakeEntry, keyword: "acme widget sizes", targetUrl: "/sizes" },
      { ...fakeEntry, keyword: "", targetUrl: "/about" },
    ]),
})

const metricsMock = (
  refresh: KeywordMetrics.Interface["refresh"],
) => Layer.mock(KeywordMetrics.Service)({ refresh })

const testLayer = Layer.mergeAll(
  reportsMock,
  sitesMock,
  configMock,
  discoveryMock,
  registryMock,
  metricsMock(() =>
    Effect.succeed({ asked: 1, answered: 1, unreported: 0, requests: 1 }),
  ),
)

// The Market seam, faked as a recorder: the two tools are the only callers, so
// what reaches it and what does NOT are both assertions worth making.
const fakeMarketSettings: MarketSettings = Market.settingsFor(undefined, "nether")

const marketRecorder = () => {
  const set: Array<{ site: string; locationCode: number; languageCode: string }> = []
  const read: Array<{ site: string; search?: string }> = []
  const tool: MarketTool = {
    read: (site, search) => {
      read.push({ site, search })
      return Promise.resolve(fakeMarketSettings)
    },
    set: (site, chosen) => {
      set.push({ site, ...chosen })
      return Promise.resolve(
        Market.setResult(undefined, chosen) satisfies MarketSetResult,
      )
    },
  }
  return { tool, read, set }
}

// A test client connected to the adapter over the given runtime seam.
const connectClient = async (
  run: RunTool,
  market: MarketTool = marketRecorder().tool,
): Promise<Client> => {
  const server = buildMcpServer(run, market)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

const withClient = async (
  fn: (client: Client) => Promise<void>,
  market?: MarketTool,
): Promise<void> => {
  const runtime = ManagedRuntime.make(testLayer)
  // The test uses a single site whose services the mock provides, so the run
  // ignores the site arg and runs every tool effect on the one test runtime.
  const run: RunTool = (_site, effect) => runtime.runPromise(effect)
  const client = await connectClient(run, market)
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

test("keywords_proposed answers with the report envelope, not a bare array", async () => {
  // The same document as `GET /api/keywords/proposed`. It used to call
  // `KeywordDiscovery.proposed()` straight through and answer with the array
  // alone, so the market and the totals were missing over MCP and a client
  // reading both surfaces had to know which one it was on.
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "keywords_proposed",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(textOf(result))
    expect(payload).toEqual(fakeProposalsReport)
    expect(payload.totals).toEqual({ proposals: 1, monthlyVolume: 320 })
    expect(Array.isArray(payload)).toBe(false)
  })
})

test("keywords_propose hands the rows to the domain and reports what it stored", async () => {
  const seen: Array<unknown> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reportsMock,
      sitesMock,
      configMock,
      registryMock,
      metricsMock(() => Effect.succeed(null)),
      Layer.mock(KeywordDiscovery.Service)({
        propose: (keywords) =>
          Effect.sync(() => {
            seen.push(keywords)
            return {
              named: keywords.length,
              stored: keywords.length,
              skippedKnown: 0,
              skippedBrandOrOperator: 0,
              skippedDuplicate: 0,
            }
          }),
      }),
    ),
  )
  const client = await connectClient((_site, effect) => runtime.runPromise(effect))
  try {
    const result = await client.callTool({
      name: "keywords_propose",
      arguments: {
        site: "acme",
        // Pasted back verbatim from a discover result, which is how the tool
        // description tells a caller to send them: the market, the status and
        // the instant come along and are not the caller's to set, so they are
        // dropped at the boundary rather than trusted.
        keywords: [fakeProposal],
      },
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual({
      named: 1,
      stored: 1,
      skippedKnown: 0,
      skippedBrandOrOperator: 0,
      skippedDuplicate: 0,
    })
    expect(seen).toEqual([
      [
        {
          keyword: "acme widget sizes",
          seed: "acme widget",
          source: "suggestions",
          searchVolume: 320,
          difficulty: 18,
          costPerClick: 0.9,
          competition: 0.3,
          intent: "informational",
        },
      ],
    ])
  } finally {
    await client.close()
    await runtime.dispose()
  }
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
      registryMock,
      metricsMock(() => Effect.succeed(null)),
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
      registryMock,
      metricsMock(() => Effect.succeed(null)),
      Layer.mock(KeywordDiscovery.Service)({
        discover: (request) =>
          Effect.sync(() => {
            seen.push(request)
            return {
              seed: request.seed,
              source: "suggestions" as const,
              returned: 0,
              droppedUnusable: 0,
              droppedKnown: 0,
              droppedBrandOrOperator: 0,
              droppedBelowVolume: 0,
              droppedAboveDifficulty: 0,
              droppedByIntent: 0,
              keywords: [],
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

test("market answers with the settings report and passes the search through", async () => {
  const recorder = marketRecorder()
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "market",
      arguments: { site: "acme", search: "nether" },
    })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(textOf(result))
    // `configured` is the field the report exists for: it is what tells a
    // reader that nobody chose the United States, and the resolved Market
    // cannot say so on its own.
    expect(payload.configured).toBe(false)
    expect(payload.market).toEqual({
      locationCode: 2840,
      languageCode: "en",
      label: "United States",
      provider: "labs",
    })
    expect(payload.served).toEqual([
      {
        locationCode: 2528,
        label: "Netherlands",
        shortLabel: "NL",
        languageCodes: ["nl"],
        provider: "labs",
      },
    ])
    expect(recorder.read).toEqual([{ site: "acme", search: "nether" }])
  }, recorder.tool)
})

test("market_set fills in the country's primary language when none is named", async () => {
  const recorder = marketRecorder()
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "market_set",
      arguments: { site: "acme", locationCode: 2528 },
    })
    expect(result.isError).toBeFalsy()
    // The seam is handed a complete pair, never a bare country: the Catalog
    // stores what was resolved, so a later read cannot resolve it differently.
    expect(recorder.set).toEqual([
      { site: "acme", locationCode: 2528, languageCode: "nl" },
    ])
    const payload = JSON.parse(textOf(result))
    expect(payload.market.languageCode).toBe("nl")
    expect(payload.previous.label).toBe("United States")
    expect(payload.changed).toBe(true)
    // The consequence of the change is in the answer, not left for the reader
    // to work out from an empty `registry_health`.
    expect(payload.demand.stale).toBe(true)
    expect(payload.demand.note).toContain("Netherlands")
  }, recorder.tool)
})

test("market_set refuses an unserved pair and stores nothing", async () => {
  const recorder = marketRecorder()
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "market_set",
      arguments: { site: "acme", locationCode: 2528, languageCode: "de" },
    })
    expect(result.isError).toBe(true)
    const payload = JSON.parse(textOf(result))
    expect(payload.error).toBe("UnservedMarketError")
    // The error has to name the languages the country IS served in: the fix is
    // a different pair, and a caller cannot guess one.
    expect(payload.message).toContain("Netherlands")
    expect(payload.message).toContain("nl")
    // Nothing reached the settings seam, so nothing was stored — and nothing
    // will be sent to DataForSEO, which bills for a task it rejects.
    expect(recorder.set).toEqual([])
  }, recorder.tool)
})

test("keywords_refresh offers the plan's keywords once each and reports the run", async () => {
  const asked: Array<ReadonlyArray<string>> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reportsMock,
      sitesMock,
      configMock,
      discoveryMock,
      registryMock,
      metricsMock((candidates) =>
        Effect.sync(() => {
          asked.push(candidates)
          return { asked: 1, answered: 1, unreported: 0, requests: 1 }
        }),
      ),
    ),
  )
  const client = await connectClient((_site, effect) => runtime.runPromise(effect))
  try {
    const result = await client.callTool({
      name: "keywords_refresh",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBeFalsy()
    // Three Registry rows, one keyword: two rows name the same term in
    // different cases and the third is an inventory-only row. Paying twice for
    // one term, or once for an empty one, is money for nothing.
    expect(asked).toEqual([["acme widget sizes"]])
    expect(JSON.parse(textOf(result))).toEqual({
      market: {
        locationCode: 2840,
        languageCode: "en",
        label: "United States",
        provider: "labs",
      },
      candidates: 1,
      refreshed: { asked: 1, answered: 1, unreported: 0, requests: 1 },
    })
  } finally {
    await client.close()
    await runtime.dispose()
  }
})

test("keywords_refresh answers with a null run when no vendor key is set", async () => {
  // A deployment with no DataForSEO key must read as "nothing was asked",
  // never as an error: the feature is optional, and an error here would tell a
  // caller to retry something that can never work.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reportsMock,
      sitesMock,
      configMock,
      discoveryMock,
      registryMock,
      metricsMock(() => Effect.succeed(null)),
    ),
  )
  const client = await connectClient((_site, effect) => runtime.runPromise(effect))
  try {
    const result = await client.callTool({
      name: "keywords_refresh",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(textOf(result))
    expect(payload.refreshed).toBeNull()
    // The plan is still counted, so a reader can see what would have been
    // asked about.
    expect(payload.candidates).toBe(1)
  } finally {
    await client.close()
    await runtime.dispose()
  }
})

test("an unserved Market on a refresh names the pair, like a discovery run", async () => {
  // The same error from the other spending path: a Market stored before this
  // check existed, or set over HTTP, still has to fail with the pair in it.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      reportsMock,
      sitesMock,
      configMock,
      discoveryMock,
      registryMock,
      metricsMock(() =>
        Effect.fail(
          new UnservedMarketError({
            locationCode: 2528,
            languageCode: "de",
            reason: "DataForSEO serves Netherlands in nl, not \"de\".",
          }),
        ),
      ),
    ),
  )
  const client = await connectClient((_site, effect) => runtime.runPromise(effect))
  try {
    const result = await client.callTool({
      name: "keywords_refresh",
      arguments: { site: "acme" },
    })
    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({
      error: "UnservedMarketError",
      message:
        'DataForSEO serves Netherlands in nl, not "de". (location 2528, language de)',
    })
  } finally {
    await client.close()
    await runtime.dispose()
  }
})
