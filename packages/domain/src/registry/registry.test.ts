// Registry service tests. Each test runs against a fresh temp dir via a fake
// CurrentSite layer whose registryPath points at that dir, and a fake Config
// layer supplying debugMode.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { Registry } from "./registry.ts"
import { type RegistryEntry, RegistryError } from "./schema.ts"
import { registryHeaderV1 } from "./schema.v1.ts"
import { registryHeaderV2 } from "./schema.v2.ts"

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  cluster: "cluster-a",
  keyword: "best widgets",
  targetUrl: "/widgets",
  intent: "informational",
  whyOpportunity: "high volume",
  priority: "1",
  publishedAt: "",
  baselineDate: "",
  status: "planned",
  ...over,
})

const makeEnv = (path: string, debug = false) =>
  Registry.layer.pipe(
    Layer.provide(
      Layer.mock(Config.Service)({
        debugMode: () => Effect.succeed(debug),
      }),
    ),
    Layer.provide(
      Layer.mock(CurrentSite.Service)({
        registryPath: () => Effect.succeed(path),
      }),
    ),
  )

const withTemp = async <A>(
  fn: (registryPath: string) => Promise<A>,
): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "rp-registry-"))
  try {
    return await fn(join(dir, "keyword-registry.csv"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const run = <A, E>(
  path: string,
  eff: Effect.Effect<A, E, Registry.Service>,
  debug = false,
): Promise<A> => eff.pipe(Effect.provide(makeEnv(path, debug)), Effect.runPromise)

const runExit = <A, E>(
  path: string,
  eff: Effect.Effect<A, E, Registry.Service>,
  debug = false,
) => eff.pipe(Effect.provide(makeEnv(path, debug)), Effect.runPromiseExit)

const expectRegistryError = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toBeInstanceOf(RegistryError)
  }
}

test("loadRegistry returns [] when the file is absent", async () => {
  await withTemp(async (path) => {
    const rows = await run(path, Registry.use.loadRegistry())
    expect(rows).toEqual([])
  })
})

test("append then load round-trips through the CSV", async () => {
  await withTemp(async (path) => {
    const e = entry({ publishedAt: "2026-01-02", baselineDate: "2026-01-01" })
    await run(path, Registry.use.appendRegistryEntry(e))
    const rows = await run(path, Registry.use.loadRegistry())
    expect(rows).toEqual([e])

    // Header + column order is the frozen V2 layout — what writes now emit.
    const text = await Bun.file(path).text()
    const [header] = text.trim().split("\n")
    expect(header).toBe(registryHeaderV2)
  })
})

// --- the V1 -> V2 column drop -----------------------------------------------

// A V1 file as it sits on a real volume: ten columns, with a `country` cell
// holding one of the values sites actually used.
const v1File = [
  registryHeaderV1,
  "Alternatives,pocket alternative,/pocket-alternative,comparison,Worldwide,P1,2026-05-20,2026-05-18,Measuring,High-intent switchers",
  "Extension,chrome read later,/chrome-extension,product-solution,USA,P2,,,Planned,Strong demand",
].join("\n")

test("a V1 file still loads, and its country cell is simply not read", async () => {
  await withTemp(async (path) => {
    await writeFile(path, `${v1File}\n`)
    const rows = await run(path, Registry.use.loadRegistry())

    // Both rows decode, every remaining cell lands in the right field. The
    // point of keeping V1 readable is that nobody's plan has to be re-typed.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(
      entry({
        cluster: "Alternatives",
        keyword: "pocket alternative",
        targetUrl: "/pocket-alternative",
        intent: "comparison",
        whyOpportunity: "High-intent switchers",
        priority: "P1",
        publishedAt: "2026-05-20",
        baselineDate: "2026-05-18",
        status: "Measuring",
      }),
    )
    expect(rows[1]?.priority).toBe("P2")
    expect(rows[1]?.whyOpportunity).toBe("Strong demand")
    // Nothing on the entry carries the old cell.
    expect(rows[0]).not.toHaveProperty("country")

    // Reading alone does not rewrite the file: a deployment that only reads
    // keeps its V1 file untouched.
    expect((await Bun.file(path).text()).trim()).toBe(v1File)
  })
})

test("the first write upgrades a V1 file to V2 and drops the country cells", async () => {
  await withTemp(async (path) => {
    await writeFile(path, `${v1File}\n`)
    await run(
      path,
      Registry.use.updateRegistryRows("/chrome-extension", undefined, {
        status: "Measuring",
      }),
    )

    const lines = (await Bun.file(path).text()).trim().split("\n")
    expect(lines[0]).toBe(registryHeaderV2)
    // Nine cells per row now, and neither "Worldwide" nor "USA" survives.
    expect(lines).toHaveLength(3)
    for (const line of lines.slice(1)) expect(line.split(",")).toHaveLength(9)
    expect(await Bun.file(path).text()).not.toContain("Worldwide")
    expect(await Bun.file(path).text()).not.toContain("USA")

    // The patch landed, and the untouched row kept every one of its own cells:
    // this is what a column drop must not get wrong.
    const rows = await run(path, Registry.use.loadRegistry())
    expect(rows[1]?.status).toBe("Measuring")
    expect(rows[0]).toEqual(
      entry({
        cluster: "Alternatives",
        keyword: "pocket alternative",
        targetUrl: "/pocket-alternative",
        intent: "comparison",
        whyOpportunity: "High-intent switchers",
        priority: "P1",
        publishedAt: "2026-05-20",
        baselineDate: "2026-05-18",
        status: "Measuring",
      }),
    )
  })
})

test("appending to a V1 file upgrades it rather than mixing the two layouts", async () => {
  await withTemp(async (path) => {
    await writeFile(path, `${v1File}\n`)
    await run(path, Registry.use.appendRegistryEntry(entry()))

    const lines = (await Bun.file(path).text()).trim().split("\n")
    expect(lines[0]).toBe(registryHeaderV2)
    // A ten-column line appended under a nine-column header would make every
    // later read fail, so the whole file is rewritten instead.
    for (const line of lines.slice(1)) expect(line.split(",")).toHaveLength(9)
    expect(await run(path, Registry.use.loadRegistry())).toHaveLength(3)
  })
})

test("a header that names neither version is refused, not guessed at", async () => {
  await withTemp(async (path) => {
    // Nine columns and nine cells, so the row shape alone cannot catch this —
    // only the header can. The columns are V2's, reordered. Reading them in V2
    // order would file this row's keyword under its cluster and its target
    // under its intent, which is worse than refusing to read the file: a later
    // write would then save the mangling.
    await writeFile(
      path,
      [
        "keyword,cluster,intent,target_url,priority,published_at,baseline_date,status,why_opportunity",
        "best widgets,cluster-a,informational,/widgets,1,,,planned,high volume",
      ].join("\n") + "\n",
    )
    const exit = await runExit(path, Registry.use.loadRegistry())
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

test("a V1 row with the wrong cell count fails rather than shifting columns", async () => {
  await withTemp(async (path) => {
    await writeFile(path, `${registryHeaderV1}\nonly,three,cells\n`)
    const exit = await runExit(path, Registry.use.loadRegistry())
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

test("append rejects a targetUrl that is not a path", async () => {
  await withTemp(async (path) => {
    const exit = await runExit(
      path,
      Registry.use.appendRegistryEntry(entry({ targetUrl: "widgets" })),
    )
    expectRegistryError(exit)
  })
})

test("append rejects fields with commas and bad dates", async () => {
  await withTemp(async (path) => {
    expectRegistryError(
      await runExit(
        path,
        Registry.use.appendRegistryEntry(entry({ cluster: "a,b" })),
      ),
    )
    expectRegistryError(
      await runExit(
        path,
        Registry.use.appendRegistryEntry(entry({ publishedAt: "2026/01/01" })),
      ),
    )
  })
})

test("append rejects a duplicate keyword (case-insensitive)", async () => {
  await withTemp(async (path) => {
    await run(path, Registry.use.appendRegistryEntry(entry()))
    const exit = await runExit(
      path,
      Registry.use.appendRegistryEntry(
        entry({ keyword: "BEST WIDGETS", targetUrl: "/other" }),
      ),
    )
    expectRegistryError(exit)
  })
})

test("append rejects a duplicate inventory-only row", async () => {
  await withTemp(async (path) => {
    const inv = entry({ keyword: "", targetUrl: "/page" })
    await run(path, Registry.use.appendRegistryEntry(inv))
    const exit = await runExit(
      path,
      Registry.use.appendRegistryEntry(entry({ keyword: "", targetUrl: "/page" })),
    )
    expectRegistryError(exit)
  })
})

test("updateRegistryRows returns the number updated and applies the patch", async () => {
  await withTemp(async (path) => {
    await run(path, Registry.use.appendRegistryEntry(entry()))
    const count = await run(
      path,
      Registry.use.updateRegistryRows("/widgets", undefined, {
        status: "published",
        publishedAt: "2026-03-03",
        newTargetUrl: "/widgets-v2",
      }),
    )
    expect(count).toBe(1)
    const rows = await run(path, Registry.use.loadRegistry())
    expect(rows[0]?.status).toBe("published")
    expect(rows[0]?.publishedAt).toBe("2026-03-03")
    expect(rows[0]?.targetUrl).toBe("/widgets-v2")
  })
})

test("updateRegistryRows fails when nothing matches", async () => {
  await withTemp(async (path) => {
    await run(path, Registry.use.appendRegistryEntry(entry()))
    const exit = await runExit(
      path,
      Registry.use.updateRegistryRows("/missing", undefined, { status: "x" }),
    )
    expectRegistryError(exit)
  })
})

test("markMissingBaselines fills only empty baselines and returns the count", async () => {
  await withTemp(async (path) => {
    await run(path, Registry.use.appendRegistryEntry(entry({ keyword: "a" })))
    await run(
      path,
      Registry.use.appendRegistryEntry(
        entry({ keyword: "b", targetUrl: "/b", baselineDate: "2025-12-31" }),
      ),
    )
    const count = await run(path, Registry.use.markMissingBaselines("2026-06-15"))
    expect(count).toBe(1)
    const rows = await run(path, Registry.use.loadRegistry())
    expect(rows.find((r) => r.keyword === "a")?.baselineDate).toBe("2026-06-15")
    expect(rows.find((r) => r.keyword === "b")?.baselineDate).toBe("2025-12-31")
  })
})

test("loadRegistry rejects an unexpected header", async () => {
  await withTemp(async (path) => {
    await writeFile(path, "wrong,header\nfoo,bar\n")
    const exit = await runExit(path, Registry.use.loadRegistry())
    expectRegistryError(exit)
  })
})

test("debugMode overrides publishedAt, baselineDate, and status on load", async () => {
  await withTemp(async (path) => {
    await run(
      path,
      Registry.use.appendRegistryEntry(
        entry({ publishedAt: "2026-01-02", baselineDate: "2026-01-01" }),
      ),
    )
    const rows = await run(path, Registry.use.loadRegistry(), true)
    expect(rows[0]?.publishedAt).toBe("2026-06-16")
    expect(rows[0]?.baselineDate).toBe("2026-06-15")
    expect(rows[0]?.status).toBe("Debug: measuring")
  })
})
