// Jobs service: the hosted server's background-job registry and single-job
// lock, plus the read-triggered "warm" that keeps a site's data fresh. A
// per-process singleton (one lock, one registry, one freshness cache for the
// whole server) — it lives in apps/server, not the domain.
//
// Idiomatic rewrite of the legacy src/jobs.ts:
//   - the module-global `jobs: Job[]` array          -> a `Ref`
//   - the ad-hoc `runningJob()` guard                -> a `Semaphore(1)` lock
//   - fire-and-forget `work().then(...)`             -> `Effect.forkDetach`
//   - `maybeEnqueueSync` (freshness + in-flight gate) -> a `Cache` with TTL
//
// Google-touching jobs (sync, backfill) use delete-then-insert transactions
// that must not interleave, so at most one runs at a time; a second `startJob`
// fails fast with `JobAlreadyRunningError` (the 409 signal).
import {
  Cache,
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Semaphore,
} from "effect"

import { serviceUse } from "@rp/domain/service-use"
import { type SiteId } from "@rp/domain/sites/schema"
import { Sites } from "@rp/domain/sites/sites"
import { reconciliationTtlHours } from "@rp/domain/sync/schema"
import { Sync } from "@rp/domain/sync/sync"

import { type Job, type JobName, JobAlreadyRunningError } from "./schema.ts"

export interface Interface {
  // A snapshot of every job, oldest first. Callers filter for the running one.
  readonly list: () => Effect.Effect<ReadonlyArray<Job>>
  // Start `work` as a named background job for a site. Fails fast with
  // JobAlreadyRunningError if a job is already running (the single-job lock is
  // held). Returns the freshly-registered running Job; `work` runs detached and
  // mutates the registry when it settles. `work` resolves to the run's summary.
  readonly startJob: (
    name: JobName,
    siteId: SiteId,
    work: Effect.Effect<string, unknown>,
  ) => Effect.Effect<Job, JobAlreadyRunningError>
  // Keep a site warm on read: if its data hasn't been reconciled within the
  // reconciliation TTL, kick a single background sync. Concurrent and in-flight
  // callers coalesce (the Cache dedupes), and a site refreshed within the TTL
  // starts nothing. Best-effort — never fails, so it can never disturb a read.
  readonly warmOnRead: (siteId: SiteId) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Jobs") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sync = yield* Sync.Service
    const sites = yield* Sites.Service

    // The registry and the id counter. A Ref, not a module-global array, so the
    // state is owned by this layer instance and never leaks across runtimes.
    const jobsRef = yield* Ref.make<ReadonlyArray<Job>>([])
    const idRef = yield* Ref.make(1)
    // The single-job lock. One permit -> at most one job at a time.
    const lock = yield* Semaphore.make(1)

    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
      new Date(ms).toISOString(),
    )

    // Replace a job record in the registry when its work settles.
    const settle = (
      id: number,
      status: Job["status"],
      message: string,
      finishedAt: string,
    ) =>
      Ref.update(jobsRef, (jobs) =>
        jobs.map((job) =>
          job.id === id ? { ...job, status, message, finishedAt } : job,
        ),
      )

    const startJob: Interface["startJob"] = (name, siteId, work) =>
      Effect.gen(function* () {
        // Relays the initial outcome (registered Job, or the 409) from the
        // detached fiber back to this caller synchronously.
        const gate = yield* Deferred.make<Job, JobAlreadyRunningError>()

        // The whole run holds the single permit for its entire duration — the
        // permit is released only when the background work settles, so a second
        // start during the run sees no permit and returns Option.none.
        const run = lock.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            const id = yield* Ref.modify(idRef, (n) => [n, n + 1] as const)
            const startedAt = yield* nowIso
            const job: Job = {
              id,
              name,
              siteId,
              status: "running",
              startedAt,
              finishedAt: null,
              message: null,
            }
            yield* Ref.update(jobsRef, (jobs) => [...jobs, job])
            yield* Deferred.succeed(gate, job)

            const exit = yield* Effect.exit(work)
            const finishedAt = yield* nowIso
            yield* Exit.match(exit, {
              onSuccess: (message) => settle(id, "done", message, finishedAt),
              // A failure also goes to the error log, not only into the registry.
              // The registry is per-process and in-memory, so a failure that
              // preceded the last deploy is gone and a failure on a site nobody
              // polls /api/jobs for is never seen — which is how a broken sync
              // reads exactly like a healthy one from outside the process. The
              // log line names the site and carries Cause.pretty, so the reason
              // survives in the container log whatever the client does.
              onFailure: (cause) =>
                Effect.andThen(
                  settle(id, "failed", Cause.pretty(cause), finishedAt),
                  Effect.logError(
                    `The ${name} job for site ${siteId} failed: ${Cause.pretty(cause)}`,
                  ),
                ),
            })
          }),
        )

        yield* run.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Deferred.fail(gate, new JobAlreadyRunningError()),
              onSome: () => Effect.void,
            }),
          ),
          Effect.forkDetach,
        )

        return yield* Deferred.await(gate)
      })

    // Freshness gate + in-flight dedupe. A cache hit (a site synced within the
    // TTL) starts nothing; a miss runs the lookup, and concurrent misses for
    // the same site share the one lookup — so N bursty reads coalesce into a
    // single sync. The lookup always succeeds (best-effort), so the success is
    // cached for the TTL and becomes the freshness window.
    const cache = yield* Cache.make<SiteId, void>({
      capacity: 1024,
      timeToLive: Duration.hours(reconciliationTtlHours),
      lookup: (siteId: SiteId) =>
        sites.siteFor(siteId).pipe(
          Effect.flatMap(() =>
            startJob("sync", siteId, sync.syncSearchConsole()),
          ),
          // Swallow both the "already running" signal and any sync/lookup
          // failure — warming is opportunistic and must never surface.
          Effect.ignore,
        ),
    })

    return {
      list: () => Ref.get(jobsRef),
      startJob,
      warmOnRead: (siteId) => Cache.get(cache, siteId),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Sync.defaultLayer),
  Layer.provide(Sites.defaultLayer),
)

export * as Jobs from "./jobs"
