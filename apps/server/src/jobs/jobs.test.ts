import { describe, expect, test } from "bun:test"
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Ref,
} from "effect"
import { TestClock } from "effect/testing"

import { type Site, SiteId } from "@rp/domain/sites/schema"
import { Sites } from "@rp/domain/sites/sites"
import { reconciliationTtlHours } from "@rp/domain/sync/schema"
import { Sync } from "@rp/domain/sync/sync"

import { Jobs } from "./jobs.ts"
import { JobAlreadyRunningError } from "./schema.ts"

const siteId = SiteId.make("example")
const site: Site = {
  id: siteId,
  name: "example",
  property: "sc-domain:example.com",
  origin: "https://example.com",
  sitemapUrl: "https://example.com/sitemap.xml",
  brandTerms: ["example"],
}

// A Sites fake that resolves the one test site.
const fakeSites = Layer.mock(Sites.Service)({
  loadSites: () => Effect.succeed([site]),
  siteFor: () => Effect.succeed(site),
})

// A Sync fake whose syncSearchConsole counts its invocations, so tests can
// assert exactly how many syncs the warm-on-read gate actually triggered.
const countingSync = (counter: Ref.Ref<number>) =>
  Layer.mock(Sync.Service)({
    syncSearchConsole: () =>
      Ref.update(counter, (n) => n + 1).pipe(Effect.as("synced")),
    backfillSearchConsole: () => Effect.succeed("backfilled"),
  })

// Wire the Jobs layer on top of the fakes.
const jobsLayer = (counter: Ref.Ref<number>) =>
  Jobs.layer.pipe(
    Layer.provide(countingSync(counter)),
    Layer.provide(fakeSites),
  )

// A logger that keeps every line instead of printing it, so a test can read what
// the server would have written to its container log. Logger.layer replaces the
// default logger for the effect it is provided to.
interface CapturedLog {
  readonly level: string
  readonly message: string
}
const capturingLogger = (lines: Array<CapturedLog>) =>
  Logger.layer([
    Logger.make<unknown, void>(({ logLevel, message }) => {
      lines.push({ level: String(logLevel), message: String(message) })
    }),
  ])

// Let detached background fibers make progress until no job is still running.
// forkDetach fibers run on the runtime's global scope, so we hand them turns
// with yieldNow rather than awaiting a handle.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 500; i++) {
    const running = (yield* Jobs.use.list()).filter(
      (job) => job.status === "running",
    )
    if (running.length === 0) return
    yield* Effect.yieldNow
  }
})

// Every run captures its log rather than printing it: a test that deliberately
// fails a job now produces a real error line, and that line belongs in the
// assertion, not in the suite's output. Pass `lines` to read it back.
const run = <A, E>(
  effect: Effect.Effect<A, E, Jobs.Service | TestClock.TestClock>,
  counter: Ref.Ref<number>,
  lines: Array<CapturedLog> = [],
): Promise<Exit.Exit<A, E>> =>
  effect.pipe(
    Effect.provide(jobsLayer(counter)),
    Effect.provide(TestClock.layer()),
    Effect.provide(capturingLogger(lines)),
    Effect.scoped,
    Effect.runPromiseExit,
  )

describe("Jobs single-job lock (Semaphore)", () => {
  test("a second concurrent start fails fast with JobAlreadyRunningError", async () => {
    const counter = await Effect.runPromise(Ref.make(0))
    const exit = await run(
      Effect.gen(function* () {
        // First job blocks on a latch, so it holds the single permit.
        const latch = yield* Deferred.make<void>()
        const first = yield* Jobs.use.startJob(
          "backfill",
          siteId,
          Deferred.await(latch).pipe(Effect.as("done-1")),
        )
        expect(first.status).toBe("running")

        // Second start while the first still holds the permit -> 409 signal.
        const second = yield* Effect.exit(
          Jobs.use.startJob("sync", siteId, Effect.succeed("done-2")),
        )
        expect(Exit.isFailure(second)).toBe(true)
        const error = Exit.isFailure(second)
          ? Cause.squash(second.cause)
          : undefined
        expect(error).toBeInstanceOf(JobAlreadyRunningError)

        // Only one job was ever registered.
        expect((yield* Jobs.use.list()).length).toBe(1)

        // Release the first; the lock frees and its record settles to done.
        yield* Deferred.succeed(latch, undefined)
        yield* settle
        const jobs = yield* Jobs.use.list()
        expect(jobs).toHaveLength(1)
        expect(jobs[0]!.status).toBe("done")
        expect(jobs[0]!.message).toBe("done-1")
        expect(jobs[0]!.finishedAt).not.toBeNull()
      }),
      counter,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("after a job finishes, the lock is free for the next start", async () => {
    const counter = await Effect.runPromise(Ref.make(0))
    const exit = await run(
      Effect.gen(function* () {
        yield* Jobs.use.startJob("sync", siteId, Effect.succeed("one"))
        yield* settle
        // Lock released -> a second start now succeeds.
        const second = yield* Jobs.use.startJob(
          "backfill",
          siteId,
          Effect.succeed("two"),
        )
        expect(second.status).toBe("running")
        yield* settle
        const jobs = yield* Jobs.use.list()
        expect(jobs.map((job) => job.message)).toEqual(["one", "two"])
      }),
      counter,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a failing job settles to failed with the error text", async () => {
    const counter = await Effect.runPromise(Ref.make(0))
    const exit = await run(
      Effect.gen(function* () {
        yield* Jobs.use.startJob(
          "sync",
          siteId,
          Effect.fail("boom" as const),
        )
        yield* settle
        const jobs = yield* Jobs.use.list()
        expect(jobs[0]!.status).toBe("failed")
        expect(jobs[0]!.message).toContain("boom")
      }),
      counter,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a failing job is logged at error level with its site and reason", async () => {
    const counter = await Effect.runPromise(Ref.make(0))
    const lines: Array<CapturedLog> = []
    const exit = await run(
      Effect.gen(function* () {
        yield* Jobs.use.startJob("sync", siteId, Effect.fail("boom" as const))
        yield* settle
      }),
      counter,
      lines,
    )
    expect(Exit.isSuccess(exit)).toBe(true)

    // The registry is per-process and in-memory, so this line is the only trace
    // of the failure that survives a deploy or reaches an operator who is not
    // polling /api/jobs. It has to carry both which site broke and why.
    const errors = lines.filter((line) => line.level === "Error")
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain("sync")
    expect(errors[0]!.message).toContain(siteId)
    expect(errors[0]!.message).toContain("boom")
  })
})

describe("Jobs warm-on-read (Cache TTL freshness + in-flight dedupe)", () => {
  test("N concurrent stale reads coalesce into exactly one sync; fresh reads trigger none; a stale read after the TTL syncs again", async () => {
    const counter = await Effect.runPromise(Ref.make(0))
    const exit = await run(
      Effect.gen(function* () {
        // 8 bursty concurrent reads of a never-warmed site -> one sync.
        yield* Effect.all(
          Array.from({ length: 8 }, () => Jobs.use.warmOnRead(siteId)),
          { concurrency: "unbounded" },
        )
        yield* settle
        expect(yield* Ref.get(counter)).toBe(1)

        // Still within the TTL: further reads find a fresh cache entry -> none.
        yield* Effect.all(
          Array.from({ length: 8 }, () => Jobs.use.warmOnRead(siteId)),
          { concurrency: "unbounded" },
        )
        yield* settle
        expect(yield* Ref.get(counter)).toBe(1)

        // Advance past the reconciliation TTL: the entry expires, so the next
        // read is stale again and triggers exactly one more sync.
        yield* TestClock.adjust(Duration.hours(reconciliationTtlHours + 1))
        yield* Jobs.use.warmOnRead(siteId)
        yield* settle
        expect(yield* Ref.get(counter)).toBe(2)
      }),
      counter,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
