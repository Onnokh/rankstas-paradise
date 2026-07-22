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
import {
  type RegistryColumnV1,
  RegistryCsvRowV1,
  registryColumnsV1,
  registryHeaderV1,
} from "./schema.v1.ts"

// --- CSV codec (V1) ---------------------------------------------------------
// Parse/serialize go through the versioned `RegistryCsvRowV1` schema so the
// on-disk shape is owned by schema.v1.ts. The domain <-> wire mapping is the
// only place that knows both key sets.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const fail = (message: string): Effect.Effect<never, RegistryError> =>
  Effect.fail(new RegistryError({ message }))

const colIndex = (column: RegistryColumnV1): number =>
  registryColumnsV1.indexOf(column)

// Domain patch field -> V1 column (newTargetUrl is handled separately).
const patchColumn: Record<
  Exclude<keyof RegistryPatch, "newTargetUrl">,
  RegistryColumnV1
> = {
  cluster: "cluster",
  intent: "intent",
  country: "country",
  priority: "priority",
  publishedAt: "published_at",
  baselineDate: "baseline_date",
  status: "status",
  whyOpportunity: "why_opportunity",
}

const rowToEntry = (row: RegistryCsvRowV1): RegistryEntry => ({
  cluster: row.cluster,
  keyword: row.keyword,
  targetUrl: row.target_url,
  intent: row.intent,
  whyOpportunity: row.why_opportunity,
  country: row.country,
  priority: row.priority,
  publishedAt: row.published_at,
  baselineDate: row.baseline_date,
  status: row.status,
})

const entryToRow = (entry: RegistryEntry): RegistryCsvRowV1 => ({
  cluster: entry.cluster,
  keyword: entry.keyword,
  target_url: entry.targetUrl,
  intent: entry.intent,
  country: entry.country,
  priority: entry.priority,
  published_at: entry.publishedAt,
  baseline_date: entry.baselineDate,
  status: entry.status,
  why_opportunity: entry.whyOpportunity,
})

const decodeRow = Schema.decodeEffect(RegistryCsvRowV1)
const encodeRow = Schema.encodeSync(RegistryCsvRowV1)

// Split one CSV line into a validated V1 row (decoded through the schema).
const parseLine = Effect.fnUntraced(function* (line: string) {
  const values = line.split(",")
  if (values.length !== registryColumnsV1.length) {
    return yield* fail(`Invalid registry row: ${line}`)
  }
  const input = Object.fromEntries(
    registryColumnsV1.map((column, index) => [column, values[index] ?? ""]),
  ) as RegistryCsvRowV1
  return yield* decodeRow(input).pipe(
    Effect.mapError(
      (cause) => new RegistryError({ message: `Invalid registry row: ${line}`, cause }),
    ),
  )
})

// Serialize a domain entry into a CSV line in the frozen V1 column order.
const serializeEntry = (entry: RegistryEntry): string => {
  const row = encodeRow(entryToRow(entry))
  return registryColumnsV1.map((column) => row[column]).join(",")
}

// --- validation -------------------------------------------------------------

const validateEntry = Effect.fnUntraced(function* (entry: RegistryEntry) {
  const row = entryToRow(entry)
  for (const column of registryColumnsV1) {
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

    // Read `[header, ...rows]`; fail on a header that isn't the V1 header.
    const readLines = (path: string) =>
      Effect.gen(function* () {
        const source = yield* readFile(path)
        const [header, ...lines] = source.trim().split("\n")
        if (header !== registryHeaderV1) {
          return yield* fail("keyword-registry.csv has an unexpected header")
        }
        return { source, lines }
      })

    // Rewrite one CSV line's cells; validates the row shape (column count).
    const editLine = Effect.fnUntraced(function* (
      line: string,
      edit: (values: Array<string>) => boolean,
    ) {
      const values = line.split(",")
      if (values.length !== registryColumnsV1.length) {
        return yield* fail(`Invalid registry row: ${line}`)
      }
      const changed = edit(values)
      return { line: changed ? values.join(",") : line, changed }
    })

    const loadRegistry: Interface["loadRegistry"] = Effect.fn(
      "Registry.loadRegistry",
    )(function* () {
      const path = yield* registryPath()
      if (!(yield* fileExists(path))) return []
      const { lines } = yield* readLines(path)
      const debug = yield* config.debugMode()
      const entries: Array<RegistryEntry> = []
      for (const line of lines) {
        const row = yield* parseLine(line)
        const entry = rowToEntry(row)
        entries.push(
          debug
            ? {
                ...entry,
                publishedAt: "2026-06-16",
                baselineDate: "2026-06-15",
                status: "Debug: measuring",
              }
            : entry,
        )
      }
      return entries
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
      const source = (yield* fileExists(path))
        ? (yield* readFile(path)).trimEnd()
        : registryHeaderV1
      yield* writeFile(path, `${source}\n${serializeEntry(entry)}\n`)
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
      const { lines } = yield* readLines(path)
      const targetIndex = colIndex("target_url")
      const keywordIndex = colIndex("keyword")
      let updated = 0
      const nextLines: Array<string> = []
      for (const line of lines) {
        const result = yield* editLine(line, (values) => {
          if (values[targetIndex] !== targetUrl) return false
          if (
            keyword !== undefined &&
            (values[keywordIndex] ?? "").toLowerCase() !== keyword.toLowerCase()
          ) {
            return false
          }
          for (const [field, column] of Object.entries(patchColumn)) {
            const value = patch[field as keyof typeof patchColumn]
            if (value !== undefined) values[colIndex(column)] = value
          }
          if (patch.newTargetUrl !== undefined) {
            values[targetIndex] = patch.newTargetUrl
          }
          return true
        })
        if (result.changed) updated += 1
        nextLines.push(result.line)
      }
      if (updated === 0) {
        return yield* fail(
          keyword !== undefined
            ? `No registry row found for target ${targetUrl} with keyword "${keyword}"`
            : `No registry rows found for target ${targetUrl}`,
        )
      }
      yield* writeFile(path, `${registryHeaderV1}\n${nextLines.join("\n")}\n`)
      return updated
    })

    const markMissingBaselines: Interface["markMissingBaselines"] = Effect.fn(
      "Registry.markMissingBaselines",
    )(function* (baselineDate: string) {
      const path = yield* registryPath()
      const { lines } = yield* readLines(path)
      const baselineIndex = colIndex("baseline_date")
      let updated = 0
      const nextLines: Array<string> = []
      for (const line of lines) {
        const result = yield* editLine(line, (values) => {
          if (values[baselineIndex]) return false
          values[baselineIndex] = baselineDate
          return true
        })
        if (result.changed) updated += 1
        nextLines.push(result.line)
      }
      yield* writeFile(path, `${registryHeaderV1}\n${nextLines.join("\n")}\n`)
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
