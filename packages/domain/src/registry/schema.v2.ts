// Registry CSV — on-disk format, VERSION 2.
//
// V2 is V1 without the `country` column. The column was never validated and
// never read: the values sites actually put there were "USA" and "Worldwide",
// neither of which is a DataForSEO location, and nothing in the app ever
// filtered, grouped, or queried by it. The question it was reaching for —
// "which country's demand does this number describe?" — is a property of the
// Site, not of a row, and it is now answered by the Site's Market (see
// ../keyword-metrics/market.ts). Two rows of one site cannot be in different
// markets, so a per-row column could only ever disagree with the truth.
//
// V1 stays readable. The reader picks the schema by the header it sees, so an
// existing keyword-registry.csv keeps loading untouched; the file is rewritten
// as V2 the first time something writes to it, and the country values are
// dropped at that point. That is the intended outcome, not a side effect: they
// hold no information the Site does not already hold.
import { Schema } from "effect"

export const REGISTRY_CSV_VERSION = 2 as const

// Column order is load-bearing: it is the physical layout of every V2 row and
// the exact header line written to disk. Do not reorder — a new order is a new
// version.
export const registryColumnsV2 = [
  "cluster",
  "keyword",
  "target_url",
  "intent",
  "priority",
  "published_at",
  "baseline_date",
  "status",
  "why_opportunity",
] as const
export type RegistryColumnV2 = (typeof registryColumnsV2)[number]

// The exact header line that identifies a V2 file.
export const registryHeaderV2 = registryColumnsV2.join(",")

// The V2 wire row: the CSV columns as decoded fields (snake_case keys, all
// string). The Registry service maps this to and from the domain RegistryEntry.
export const RegistryCsvRowV2 = Schema.Struct({
  cluster: Schema.String,
  keyword: Schema.String,
  target_url: Schema.String,
  intent: Schema.String,
  priority: Schema.String,
  published_at: Schema.String,
  baseline_date: Schema.String,
  status: Schema.String,
  why_opportunity: Schema.String,
}).annotate({ identifier: "RegistryCsvRowV2" })
export interface RegistryCsvRowV2
  extends Schema.Schema.Type<typeof RegistryCsvRowV2> {}

export * as RegistrySchemaV2 from "./schema.v2"
