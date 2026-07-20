// Background-job registry for the hosted server, shared by the HTTP routes
// (server.ts) and the MCP surface (mcp.ts) so a read on either can warm the
// site's data. Google-touching jobs (sync, backfill) run one at a time: they
// use delete-then-insert transactions that must not interleave.
//
// Plain imperative TS to match server.ts. The idiomatic-Effect rewrite of this
// subsystem (a Semaphore for the single-job lock, forkDaemon for the
// background run, a Cache with TTL for the freshness gate + in-flight dedupe)
// is a separate task, only worthwhile if server.ts moves to Effect wholesale.
import { reconciliationTtlHours, syncSearchConsole } from "./automation.ts"
import { debugMode } from "./config.ts"
import { siteFor, withSite } from "./site.ts"
import { syncedWithinHours } from "./storage.ts"

export type JobName = "sync" | "backfill"

export type Job = {
  readonly id: number
  readonly name: JobName
  readonly siteId: string
  status: "running" | "done" | "failed"
  readonly startedAt: string
  finishedAt: string | null
  message: string | null
}

export const jobs: Job[] = []
let nextJobId = 1

export const runningJob = () => jobs.find((job) => job.status === "running")

// Start a job unless one is already running (returns null then — the single
// caller turns that into a 409). Fire-and-forget: the work runs in the
// background and mutates the job record as it settles.
export const startJob = (name: JobName, siteId: string, work: () => Promise<string>): Job | null => {
  if (runningJob()) return null
  const job: Job = { id: nextJobId++, name, siteId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, message: null }
  jobs.push(job)
  work()
    .then((message) => {
      job.status = "done"
      job.message = message
    })
    .catch((cause) => {
      job.status = "failed"
      job.message = cause instanceof Error ? cause.message : String(cause)
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString()
    })
  return job
}

// Keep a site warm on read: if its ledger hasn't been reconciled within the
// reconciliation TTL, kick a background sync. Fire-and-forget — the read that
// triggered this never awaits it and always returns current data. Concurrent
// or in-flight callers coalesce (a fresh site, or one with a job already
// running, no-ops), so bursty agent traffic can't stack syncs or hit Google's
// quota. The daily cron (see docs/deploy.md) stays the cold-start floor for
// sites that nothing reads. Best-effort: any failure is swallowed so warming
// can never disturb the read.
export const maybeEnqueueSync = async (siteId: string): Promise<void> => {
  try {
    if (debugMode || runningJob()) return
    const site = await siteFor(siteId)
    if (await withSite(site, () => syncedWithinHours(reconciliationTtlHours))) return
    startJob("sync", site.id, () => withSite(site, syncSearchConsole))
  } catch {
    // Warming is opportunistic; never surface its failure to the caller.
  }
}
