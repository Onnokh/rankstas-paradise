// Registry CSV — on-disk format, VERSION 1.
//
// The registry is persisted as a headed CSV. The wire format is versioned in
// parallel with the domain model rather than migrated in place (see the
// versioning convention): when the columns change, a schema.v2.ts is added
// alongside this file, and the reader picks the schema by the header it sees.
// V1 stays here, unchanged, so any existing keyword-registry.csv keeps decoding.
import { Schema } from "effect"

export const REGISTRY_CSV_VERSION = 1 as const

// Column order is load-bearing: it is the physical layout of every V1 row and
// the exact header line written to disk. Do not reorder — a new order is a new
// version.
export const registryColumnsV1 = [
  "cluster",
  "keyword",
  "target_url",
  "intent",
  "country",
  "priority",
  "published_at",
  "baseline_date",
  "status",
  "why_opportunity",
] as const
export type RegistryColumnV1 = (typeof registryColumnsV1)[number]

// The exact header line that identifies a V1 file.
export const registryHeaderV1 = registryColumnsV1.join(",")

// The V1 wire row: the CSV columns as decoded fields (snake_case keys, all
// string). The Registry service maps this to/from the domain RegistryEntry.
export const RegistryCsvRowV1 = Schema.Struct({
  cluster: Schema.String,
  keyword: Schema.String,
  target_url: Schema.String,
  intent: Schema.String,
  country: Schema.String,
  priority: Schema.String,
  published_at: Schema.String,
  baseline_date: Schema.String,
  status: Schema.String,
  why_opportunity: Schema.String,
}).annotate({ identifier: "RegistryCsvRowV1" })
export interface RegistryCsvRowV1
  extends Schema.Schema.Type<typeof RegistryCsvRowV1> {}

export * as RegistrySchemaV1 from "./schema.v1"
