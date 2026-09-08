// Registry service: reads and writes the per-site keyword-registry.csv.
// Site-scoped (the CSV path comes from CurrentSite) and debug-aware (Config).
import { Context, Effect, Layer, Schema } from "effect"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import {
  type RegistryEntry,
  RegistryError,
  type RegistryPatch,
} from "./schema.ts"
import { RegistryCsvRowV1, registryColumnsV1, registryHeaderV1 } from "./schema.v1.ts"
import {
  type RegistryColumnV2,
  RegistryCsvRowV2,
  registryColumnsV2,
  registryHeaderV2,
} from "./schema.v2.ts"

// --- CSV codec (V2 on disk, V1 still readable) ------------------------------
// Parse and serialize go through the versioned row schemas, so the on-disk
// shape is owned by schema.v1.ts and schema.v2.ts. The domain <-> wire mapping
// below is the only place that knows both key sets.
//
// Reads accept either version and answer in V2; writes are always V2. A V1
// file is therefore rewritten as V2 the first time anything writes to it, and
// its `country` cells are dropped then. Every writer here already rewrote the
// whole file, so this costs no new risk — see schema.v2.ts for why the column
// went.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const fail = (message: string): Effect.Effect<never, RegistryError> =>
  Effect.fail(new RegistryError({ message }))

// Domain patch field -> V2 column (newTargetUrl is handled separately).
const patchColumn: Record<
  Exclude<keyof RegistryPatch, "newTargetUrl">,
  RegistryColumnV2
> = {
  cluster: "cluster",
  intent: "intent",
  priority: "priority",
  publishedAt: "published_at",
  baselineDate: "baseline_date",
  status: "status",
  whyOpportunity: "why_opportunity",
}

const rowToEntry = (row: RegistryCsvRowV2): RegistryEntry => ({
  cluster: row.cluster,
  keyword: row.keyword,
  targetUrl: row.target_url,
  intent: row.intent,
  whyOpportunity: row.why_opportunity,
  priority: row.priority,
  publishedAt: row.published_at,
  baselineDate: row.baseline_date,
  status: row.status,
})

const entryToRow = (entry: RegistryEntry): RegistryCsvRowV2 => ({
  cluster: entry.cluster,
  keyword: entry.keyword,
  target_url: entry.targetUrl,
  intent: entry.intent,
  priority: entry.priority,
  published_at: entry.publishedAt,
  baseline_date: entry.baselineDate,
  status: entry.status,
  why_opportunity: entry.whyOpportunity,
})

// A V1 row read as a V2 one: the `country` cell is dropped. Nothing else moves,
// because V2 is V1 with that one column removed and the rest in order.
const v1ToV2 = ({
  country: _country,
  ...rest
}: RegistryCsvRowV1): RegistryCsvRowV2 => rest

const decodeRowV1 = Schema.decodeEffect(RegistryCsvRowV1)
const decodeRowV2 = Schema.decodeEffect(RegistryCsvRowV2)
const encodeRow = Schema.encodeSync(RegistryCsvRowV2)

// The on-disk version a header line names, or null when it names neither.
const versionOfHeader = (header: string | undefined): 1 | 2 | null =>
  header === registryHeaderV2 ? 2 : header === registryHeaderV1 ? 1 : null

// Split one CSV line into a validated row, decoded through the schema of the
// version the file's header named, and answered as V2.
const parseLine = Effect.fnUntraced(function* (version: 1 | 2, line: string) {
  const columns = version === 1 ? registryColumnsV1 : registryColumnsV2
  const values = line.split(",")
  if (values.length !== columns.length) {
    return yield* fail(`Invalid registry row: ${line}`)
  }
  const input = Object.fromEntries(
    columns.map((column, index) => [column, values[index] ?? ""]),
  )
  const invalid = (cause: unknown) =>
    new RegistryError({ message: `Invalid registry row: ${line}`, cause })
  return version === 1
    ? v1ToV2(
        yield* decodeRowV1(input as RegistryCsvRowV1).pipe(
          Effect.mapError(invalid),
        ),
      )
    : yield* decodeRowV2(input as RegistryCsvRowV2).pipe(
        Effect.mapError(invalid),
      )
})

// Serialize a wire row into a CSV line in the frozen V2 column order.
const serializeRow = (row: RegistryCsvRowV2): string => {
  const encoded = encodeRow(row)
  return registryColumnsV2.map((column) => encoded[column]).join(",")
}

// The whole file, header included, as V2.
const serializeFile = (rows: ReadonlyArray<RegistryCsvRowV2>): string =>
  `${registryHeaderV2}\n${rows.map(serializeRow).join("\n")}${rows.length > 0 ? "\n" : ""}`

// --- validation -------------------------------------------------------------

const validateEntry = Effect.fnUntraced(function* (entry: RegistryEntry) {
  const row = entryToRow(entry)
  for (const column of registryColumnsV2) {
    const value = row[column]
    if (value.includes(",") || value.includes("\n")) {
      return yield* fail(
        `Registry field ${column} must not contain commas or newlines: ${value}`,
      )
    }
  }
  if (!entry.targetUrl.startsWith("/")) {
    return yield* fail(`target_url must be a path starting with "/": ${entry.targetUrl}`)
  }
  for (const date of [entry.publishedAt, entry.baselineDate]) {
    if (date && !DATE_RE.test(date)) {
      return yield* fail(`Dates must use YYYY-MM-DD: ${date}`)
    }
  }
})

const validatePatch = Effect.fnUntraced(function* (patch: RegistryPatch) {
  for (const value of [patch.publishedAt, patch.baselineDate]) {
    if (value && !DATE_RE.test(value)) {
      return yield* fail(`Dates must use YYYY-MM-DD: ${value}`)
    }
  }
  for (const [field, value] of Object.entries(patch)) {
    if (typeof value === "string" && (value.includes(",") || value.includes("\n"))) {
      return yield* fail(
        `Registry field ${field} must not contain commas or newlines: ${value}`,
      )
    }
  }
  if (patch.newTargetUrl !== undefined && !patch.newTargetUrl.startsWith("/")) {
    return yield* fail(`new target must be a path starting with "/": ${patch.newTargetUrl}`)
  }
})

export interface Interface {
  readonly loadRegistry: () => Effect.Effect<
    ReadonlyArray<RegistryEntry>,
    RegistryError
  >
  readonly appendRegistryEntry: (
    entry: RegistryEntry,
  ) => Effect.Effect<void, RegistryError>
  // Apply `patch` to rows matching `targetUrl` (and `keyword`, if given);
  // returns the number of rows updated.
  readonly updateRegistryRows: (
    targetUrl: string,
    keyword: string | undefined,
    patch: RegistryPatch,
  ) => Effect.Effect<number, RegistryError>
  // Fill the baseline_date on rows that lack one; returns the number updated.
  readonly markMissingBaselines: (
    baselineDate: string,
  ) => Effect.Effect<number, RegistryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/Registry",
) {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const currentSite = yield* CurrentSite.Service

    // --- filesystem edge (Bun) --------------------------------------------
    const registryPath = () => currentSite.registryPath()

    const fileExists = (path: string) =>
      Effect.tryPromise({
        try: () => Bun.file(path).exists(),
        catch: (cause) =>
          new RegistryError({ message: `Failed to read ${path}`, cause }),
      })

    const readFile = (path: string) =>
      Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: (cause) =>
          new RegistryError({ message: `Failed to read ${path}`, cause }),
      })

    const writeFile = (path: string, content: string) =>
      Effect.tryPromise({
        try: () => Bun.write(path, content),
        catch: (cause) =>
          new RegistryError({ message: `Failed to write ${path}`, cause }),
      })

    // Every row of the file, decoded and answered as V2 whichever version the
    // header names. A file that names neither is not this file — refused
    // rather than guessed at, because guessing the column order would write
    // somebody's plan into the wrong cells.
    const readRows = (path: string) =>
      Effect.gen(function* () {
        const source = yield* readFile(path)
        const [header, ...lines] = source.trim().split("\n")
        const version = versionOfHeader(header)
        if (version === null) {
          return yield* fail("keyword-registry.csv has an unexpected header")
        }
        const rows: Array<RegistryCsvRowV2> = []
        for (const line of lines) rows.push(yield* parseLine(version, line))
        return rows
      })

    // Every write rewrites the whole file as V2, so a V1 file is upgraded by
    // the first write and its `country` cells go then.
    const writeRows = (path: string, rows: ReadonlyArray<RegistryCsvRowV2>) =>
      writeFile(path, serializeFile(rows))

    const loadRegistry: Interface["loadRegistry"] = Effect.fn(
      "Registry.loadRegistry",
    )(function* () {
      const path = yield* registryPath()
      if (!(yield* fileExists(path))) return []
      const rows = yield* readRows(path)
      const debug = yield* config.debugMode()
      return rows.map((row) => {
        const entry = rowToEntry(row)
        return debug
          ? {
              ...entry,
              publishedAt: "2026-06-16",
              baselineDate: "2026-06-15",
              status: "Debug: measuring",
            }
          : entry
      })
    })

    const appendRegistryEntry: Interface["appendRegistryEntry"] = Effect.fn(
      "Registry.appendRegistryEntry",
    )(function* (entry: RegistryEntry) {
      yield* validateEntry(entry)
      const existing = yield* loadRegistry()
      if (
        entry.keyword.trim() &&
        existing.some(
          (row) => row.keyword.toLowerCase() === entry.keyword.toLowerCase(),
        )
      ) {
        return yield* fail(`Keyword is already mapped: ${entry.keyword}`)
      }
      if (
        !entry.keyword.trim() &&
        existing.some(
          (row) => row.targetUrl === entry.targetUrl && !row.keyword.trim(),
        )
      ) {
        return yield* fail(`An inventory-only row for ${entry.targetUrl} already exists.`)
      }
      const path = yield* registryPath()
      // Read and rewrite rather than append a line. A V1 file cannot take a V2
      // line on the end, and the other writers here already rewrite the whole
      // file, so this is the same risk they carry.
      const rows = (yield* fileExists(path)) ? yield* readRows(path) : []
      yield* writeRows(path, [...rows, entryToRow(entry)])
    })

    const updateRegistryRows: Interface["updateRegistryRows"] = Effect.fn(
      "Registry.updateRegistryRows",
    )(function* (
      targetUrl: string,
      keyword: string | undefined,
      patch: RegistryPatch,
    ) {
      yield* validatePatch(patch)
      const path = yield* registryPath()
      const rows = yield* readRows(path)
      let updated = 0
      const next = rows.map((row) => {
        if (row.target_url !== targetUrl) return row
        if (
          keyword !== undefined &&
          row.keyword.toLowerCase() !== keyword.toLowerCase()
        ) {
          return row
        }
        updated += 1
        const patched = { ...row }
        for (const [field, column] of Object.entries(patchColumn)) {
          const value = patch[field as keyof typeof patchColumn]
          if (value !== undefined) patched[column] = value
        }
        if (patch.newTargetUrl !== undefined) {
          patched.target_url = patch.newTargetUrl
        }
        return patched
      })
      if (updated === 0) {
        return yield* fail(
          keyword !== undefined
            ? `No registry row found for target ${targetUrl} with keyword "${keyword}"`
            : `No registry rows found for target ${targetUrl}`,
        )
      }
      yield* writeRows(path, next)
      return updated
    })

    const markMissingBaselines: Interface["markMissingBaselines"] = Effect.fn(
      "Registry.markMissingBaselines",
    )(function* (baselineDate: string) {
      const path = yield* registryPath()
      const rows = yield* readRows(path)
      let updated = 0
      const next = rows.map((row) => {
        if (row.baseline_date) return row
        updated += 1
        return { ...row, baseline_date: baselineDate }
      })
      yield* writeRows(path, next)
      return updated
    })

    return {
      loadRegistry,
      appendRegistryEntry,
      updateRegistryRows,
      markMissingBaselines,
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Registry from "./registry"
