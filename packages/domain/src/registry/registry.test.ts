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

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  cluster: "cluster-a",
  keyword: "best widgets",
  targetUrl: "/widgets",
  intent: "informational",
  whyOpportunity: "high volume",
  country: "us",
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

    // Header + column order is the frozen V1 layout.
    const text = await Bun.file(path).text()
    const [header] = text.trim().split("\n")
    expect(header).toBe(registryHeaderV1)
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
