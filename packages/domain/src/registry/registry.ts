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

// --- CSV quoting ------------------------------------------------------------
// A field is quoted when it holds a comma or a double quote, and an inner quote
// doubles, which is RFC 4180's subset of itself. Commas used to be refused
// outright, which pushed the storage format into the API: a rationale is prose
// and prose has commas in it, so every caller writing a readable one got an
// error naming a CSV column it had never heard of.
//
// Newlines are still refused. The reader below is line-oriented — it splits the
// file on "\n" before it looks at any field — so a field holding one would need
// a parser that reads across lines, and no field here wants a line break.

const needsQuotes = (value: string): boolean =>
  value.includes(",") || value.includes('"')

const quoteValue = (value: string): string =>
  needsQuotes(value) ? `"${value.replaceAll('"', '""')}"` : value

// One CSV line as its fields, or null when a quote is opened and never closed —
// which is a corrupt line, not a field with a quote in it.
const splitCsvLine = (line: string): Array<string> | null => {
  const values: Array<string> = []
  let value = ""
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char !== '"') {
        value += char
      } else if (line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = false
      }
      continue
    }
    // A quote only opens a field at its start; anywhere else it is literal, so
    // a legacy row holding `24" monitor` still reads as it always did.
    if (char === '"' && value === "") quoted = true
    else if (char === ",") {
      values.push(value)
      value = ""
    } else value += char
  }

  if (quoted) return null
  values.push(value)
  return values
}

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

// The patch fields the reports answer once per target rather than once per row.
//
// `registryReport` and `dashboardReport` both read these off the target's FIRST
// row and present them as the target's own, while the per-keyword array carries
// only the keyword, its cluster and its intent. So a patch that sets one of
// these for a single keyword writes a state no report can show: either the
// change is invisible, or — when the row happens to be first — it silently
// relabels the whole target. Setting `/3d-background`'s status through one of
// its three keywords did exactly that on 2026-09-09, and the target read as
// "Duplicate" afterwards.
const targetLevelPatchFields = [
  "status",
  "whyOpportunity",
  "priority",
  "publishedAt",
  "baselineDate",
] as const satisfies ReadonlyArray<keyof RegistryPatch>

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
  const values = splitCsvLine(line)
  if (values === null || values.length !== columns.length) {
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
  return registryColumnsV2.map((column) => quoteValue(encoded[column])).join(",")
}

// The whole file, header included, as V2.
const serializeFile = (rows: ReadonlyArray<RegistryCsvRowV2>): string =>
  `${registryHeaderV2}\n${rows.map(serializeRow).join("\n")}${rows.length > 0 ? "\n" : ""}`

// --- validation -------------------------------------------------------------

const validateEntry = Effect.fnUntraced(function* (entry: RegistryEntry) {
  const row = entryToRow(entry)
  for (const column of registryColumnsV2) {
    const value = row[column]
    if (value.includes("\n")) {
      return yield* fail(
        `Registry field ${column} must not contain newlines: ${value}`,
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
    if (typeof value === "string" && value.includes("\n")) {
      return yield* fail(
        `Registry field ${field} must not contain newlines: ${value}`,
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
  // Delete rows matching `targetUrl` (and `keyword`, if given); returns the
  // number removed. Removing every row of a target retires it from the plan,
  // which is allowed — a page can stop being a target without being deleted.
  readonly removeRegistryRows: (
    targetUrl: string,
    keyword: string | undefined,
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
      if (keyword !== undefined) {
        const flattened = targetLevelPatchFields.filter(
          (field) => patch[field] !== undefined,
        )
        if (flattened.length > 0) {
          return yield* fail(
            `The registry reports ${flattened.join(", ")} once per target rather than per keyword, so setting ${flattened.length === 1 ? "it" : "them"} for "${keyword}" alone would either not show at all or relabel the whole of ${targetUrl}. Patch the target without a keyword instead.`,
          )
        }
      }
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

    const removeRegistryRows: Interface["removeRegistryRows"] = Effect.fn(
      "Registry.removeRegistryRows",
    )(function* (targetUrl: string, keyword: string | undefined) {
      const path = yield* registryPath()
      if (!(yield* fileExists(path))) {
        return yield* fail(`No registry rows found for target ${targetUrl}`)
      }
      const rows = yield* readRows(path)
      const kept = rows.filter((row) => {
        if (row.target_url !== targetUrl) return true
        if (keyword === undefined) return false
        return row.keyword.toLowerCase() !== keyword.toLowerCase()
      })
      const removed = rows.length - kept.length
      // Refused rather than answered with zero, matching updateRegistryRows: a
      // caller naming a row that is not there has the wrong row, and a silent
      // success would let a cleanup script report work it never did.
      if (removed === 0) {
        return yield* fail(
          keyword !== undefined
            ? `No registry row found for target ${targetUrl} with keyword "${keyword}"`
            : `No registry rows found for target ${targetUrl}`,
        )
      }
      yield* writeRows(path, kept)
      return removed
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
      removeRegistryRows,
      markMissingBaselines,
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Registry from "./registry"
