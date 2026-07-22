// Storage service: the per-site SQLite ledger. Site-scoped — it reads the
// active site (and thus its database path, origin, and brand terms) from
// CurrentSite; no method takes a site parameter. Downstream this is backed by
// @effect/sql-sqlite-bun's SqlClient keyed off CurrentSite. FROZEN CONTRACT —
// stub only (methods die).
import { Context, Effect, Layer } from "effect"

import { CurrentSite } from "../sites/current-site.ts"
import {
  type DailySnapshot,
  type DailyTotals,
  type PageIndexStatus,
} from "../search-console/schema.ts"
import { type RegistryEntry } from "../registry/schema.ts"
import { serviceUse } from "../service-use.ts"
import {
  type BaselineCapture,
  type HistoryDay,
  type LogEntry,
  type LogEntryInput,
  type Metrics,
  type OpportunityDigest,
  type PagesWindowOverview,
  type RegistryPerformance,
  type RegistryProgress,
  type RegistryTargetProgress,
  StorageError,
  type SnapshotDateRange,
  type SnapshotSummary,
  type TopQueriesOptions,
  type TopQueriesResult,
} from "./schema.ts"

export interface Interface {
  // --- writes ---
  readonly saveSnapshots: (
    snapshots: ReadonlyArray<DailySnapshot>,
    fetchedDates?: ReadonlyArray<string>,
  ) => Effect.Effect<void, StorageError>
  readonly saveDailyTotals: (
    totals: DailyTotals,
    fetchedDates: ReadonlyArray<string>,
  ) => Effect.Effect<void, StorageError>
  readonly savePageIndexStatuses: (
    statuses: ReadonlyArray<PageIndexStatus>,
  ) => Effect.Effect<void, StorageError>
  readonly pruneIndexStatuses: (
    targetUrls: ReadonlyArray<string>,
  ) => Effect.Effect<number, StorageError>
  readonly addLogEntry: (
    entry: LogEntryInput,
  ) => Effect.Effect<LogEntry, StorageError>
  readonly capturePageBaselines: (
    entries: ReadonlyArray<RegistryEntry>,
    baselineDate: string,
  ) => Effect.Effect<BaselineCapture, StorageError>

  // --- freshness / coverage queries ---
  readonly missingDailyTotalDates: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly missingSnapshotDates: (
    dates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly recentlySyncedDates: (
    dates: ReadonlyArray<string>,
    maxAgeHours: number,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly syncedWithinHours: (
    maxAgeHours: number,
  ) => Effect.Effect<boolean, StorageError>
  readonly recentlyInspectedUrls: (
    targetUrls: ReadonlyArray<string>,
    maxAgeHours: number,
  ) => Effect.Effect<ReadonlyArray<string>, StorageError>
  readonly snapshotDateRange: () => Effect.Effect<
    SnapshotDateRange,
    StorageError
  >
  readonly snapshotSummary: () => Effect.Effect<SnapshotSummary, StorageError>
  readonly latestSnapshotDate: () => Effect.Effect<string | null, StorageError>
  // The last date whose numbers are trusted as final (today − 3, UTC). Pure.
  readonly finalizationCutoff: () => Effect.Effect<string>

  // --- reads / analysis ---
  readonly history: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<HistoryDay>, StorageError>
  readonly historyWithPending: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<HistoryDay>, StorageError>
  readonly opportunityDigest: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<OpportunityDigest, StorageError>
  readonly targetPerformance: (
    targetUrl: string,
    includeBrand?: boolean,
  ) => Effect.Effect<RegistryPerformance, StorageError>
  readonly registryProgress: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<ReadonlyArray<RegistryProgress>, StorageError>
  readonly registryTargetProgress: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<ReadonlyArray<RegistryTargetProgress>, StorageError>
  readonly pagesWindowOverview: (
    windowDays?: number,
  ) => Effect.Effect<PagesWindowOverview, StorageError>
  readonly topQueries: (
    options?: TopQueriesOptions,
  ) => Effect.Effect<TopQueriesResult, StorageError>
  readonly listLog: (
    path?: string,
  ) => Effect.Effect<ReadonlyArray<LogEntry>, StorageError>
  readonly metricsBetween: (
    targetUrl: string,
    start: string,
    end: string,
    includeBrand?: boolean,
  ) => Effect.Effect<Metrics, StorageError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Storage",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* CurrentSite.Service
    return {
      saveSnapshots: () => Effect.die("unimplemented: Storage.saveSnapshots"),
      saveDailyTotals: () =>
        Effect.die("unimplemented: Storage.saveDailyTotals"),
      savePageIndexStatuses: () =>
        Effect.die("unimplemented: Storage.savePageIndexStatuses"),
      pruneIndexStatuses: () =>
        Effect.die("unimplemented: Storage.pruneIndexStatuses"),
      addLogEntry: () => Effect.die("unimplemented: Storage.addLogEntry"),
      capturePageBaselines: () =>
        Effect.die("unimplemented: Storage.capturePageBaselines"),
      missingDailyTotalDates: () =>
        Effect.die("unimplemented: Storage.missingDailyTotalDates"),
      missingSnapshotDates: () =>
        Effect.die("unimplemented: Storage.missingSnapshotDates"),
      recentlySyncedDates: () =>
        Effect.die("unimplemented: Storage.recentlySyncedDates"),
      syncedWithinHours: () =>
        Effect.die("unimplemented: Storage.syncedWithinHours"),
      recentlyInspectedUrls: () =>
        Effect.die("unimplemented: Storage.recentlyInspectedUrls"),
      snapshotDateRange: () =>
        Effect.die("unimplemented: Storage.snapshotDateRange"),
      snapshotSummary: () =>
        Effect.die("unimplemented: Storage.snapshotSummary"),
      latestSnapshotDate: () =>
        Effect.die("unimplemented: Storage.latestSnapshotDate"),
      finalizationCutoff: () =>
        Effect.die("unimplemented: Storage.finalizationCutoff"),
      history: () => Effect.die("unimplemented: Storage.history"),
      historyWithPending: () =>
        Effect.die("unimplemented: Storage.historyWithPending"),
      opportunityDigest: () =>
        Effect.die("unimplemented: Storage.opportunityDigest"),
      targetPerformance: () =>
        Effect.die("unimplemented: Storage.targetPerformance"),
      registryProgress: () =>
        Effect.die("unimplemented: Storage.registryProgress"),
      registryTargetProgress: () =>
        Effect.die("unimplemented: Storage.registryTargetProgress"),
      pagesWindowOverview: () =>
        Effect.die("unimplemented: Storage.pagesWindowOverview"),
      topQueries: () => Effect.die("unimplemented: Storage.topQueries"),
      listLog: () => Effect.die("unimplemented: Storage.listLog"),
      metricsBetween: () => Effect.die("unimplemented: Storage.metricsBetween"),
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CurrentSite.defaultLayer))

export * as Storage from "./storage"
