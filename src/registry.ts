import { debugMode } from "./config.ts"

export type RegistryEntry = {
  readonly cluster: string
  readonly keyword: string
  readonly targetUrl: string
  readonly intent: string
  readonly whyOpportunity: string
  readonly country: string
  readonly priority: string
  readonly publishedAt: string
  readonly baselineDate: string
  readonly status: string
}

const registryPath = `${import.meta.dir}/../keyword-registry.csv`
const columns = ["cluster", "keyword", "target_url", "intent", "country", "priority", "published_at", "baseline_date", "status", "why_opportunity"] as const

export const loadRegistry = async (): Promise<readonly RegistryEntry[]> => {
  const [header, ...lines] = (await Bun.file(registryPath).text()).trim().split("\n")
  if (header !== columns.join(",")) throw new Error("keyword-registry.csv has an unexpected header")
  return lines.map((line) => {
    const values = line.split(",")
    if (values.length !== columns.length) throw new Error(`Invalid registry row: ${line}`)
    const entry = {
      cluster: values[0] ?? "",
      keyword: values[1] ?? "",
      targetUrl: values[2] ?? "",
      intent: values[3] ?? "",
      whyOpportunity: values[9] ?? "",
      country: values[4] ?? "",
      priority: values[5] ?? "",
      publishedAt: values[6] ?? "",
      baselineDate: values[7] ?? "",
      status: values[8] ?? "",
    }
    return debugMode
      ? { ...entry, publishedAt: "2026-06-16", baselineDate: "2026-06-15", status: "Debug: measuring" }
      : entry
  })
}

const fieldFor = (entry: RegistryEntry, column: (typeof columns)[number]) => ({
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
})[column]

const validateEntry = (entry: RegistryEntry) => {
  for (const column of columns) {
    const value = fieldFor(entry, column)
    if (value.includes(",") || value.includes("\n")) throw new Error(`Registry field ${column} must not contain commas or newlines: ${value}`)
  }
  if (!entry.targetUrl.startsWith("/")) throw new Error(`target_url must be a path starting with "/": ${entry.targetUrl}`)
  for (const date of [entry.publishedAt, entry.baselineDate]) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Dates must use YYYY-MM-DD: ${date}`)
  }
}

export const appendRegistryEntry = async (entry: RegistryEntry): Promise<void> => {
  validateEntry(entry)
  const existing = await loadRegistry()
  if (entry.keyword.trim() && existing.some((row) => row.keyword.toLowerCase() === entry.keyword.toLowerCase())) {
    throw new Error(`Keyword is already mapped: ${entry.keyword}`)
  }
  if (!entry.keyword.trim() && existing.some((row) => row.targetUrl === entry.targetUrl && !row.keyword.trim())) {
    throw new Error(`An inventory-only row for ${entry.targetUrl} already exists.`)
  }
  const source = (await Bun.file(registryPath).text()).trimEnd()
  const line = columns.map((column) => fieldFor(entry, column)).join(",")
  await Bun.write(registryPath, `${source}\n${line}\n`)
}

export type RegistryPatch = {
  readonly cluster?: string
  readonly intent?: string
  readonly country?: string
  readonly priority?: string
  readonly publishedAt?: string
  readonly baselineDate?: string
  readonly status?: string
  readonly whyOpportunity?: string
  readonly newTargetUrl?: string
}

const patchColumnIndex: Record<Exclude<keyof RegistryPatch, "newTargetUrl">, number> = {
  cluster: 0,
  intent: 3,
  country: 4,
  priority: 5,
  publishedAt: 6,
  baselineDate: 7,
  status: 8,
  whyOpportunity: 9,
}

export const updateRegistryRows = async (targetUrl: string, keyword: string | undefined, patch: RegistryPatch): Promise<number> => {
  for (const value of [patch.publishedAt, patch.baselineDate]) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Dates must use YYYY-MM-DD: ${value}`)
  }
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined && (value.includes(",") || value.includes("\n"))) throw new Error(`Registry field ${field} must not contain commas or newlines: ${value}`)
  }
  if (patch.newTargetUrl !== undefined && !patch.newTargetUrl.startsWith("/")) throw new Error(`new target must be a path starting with "/": ${patch.newTargetUrl}`)
  const source = await Bun.file(registryPath).text()
  const [header, ...lines] = source.trim().split("\n")
  if (header !== columns.join(",")) throw new Error("keyword-registry.csv has an unexpected header")
  let updated = 0
  const nextLines = lines.map((line) => {
    const values = line.split(",")
    if (values.length !== columns.length) throw new Error(`Invalid registry row: ${line}`)
    if (values[2] !== targetUrl) return line
    if (keyword !== undefined && (values[1] ?? "").toLowerCase() !== keyword.toLowerCase()) return line
    for (const [field, index] of Object.entries(patchColumnIndex)) {
      const value = patch[field as keyof typeof patchColumnIndex]
      if (value !== undefined) values[index] = value
    }
    if (patch.newTargetUrl !== undefined) values[2] = patch.newTargetUrl
    updated += 1
    return values.join(",")
  })
  if (updated === 0) throw new Error(keyword !== undefined ? `No registry row found for target ${targetUrl} with keyword "${keyword}"` : `No registry rows found for target ${targetUrl}`)
  await Bun.write(registryPath, `${header}\n${nextLines.join("\n")}\n`)
  return updated
}

export const markMissingBaselines = async (baselineDate: string): Promise<number> => {
  const source = await Bun.file(registryPath).text()
  const [header, ...lines] = source.trim().split("\n")
  if (header !== columns.join(",")) throw new Error("keyword-registry.csv has an unexpected header")
  let updated = 0
  const nextLines = lines.map((line) => {
    const values = line.split(",")
    if (values.length !== columns.length) throw new Error(`Invalid registry row: ${line}`)
    if (values[7]) return line
    values[7] = baselineDate
    updated += 1
    return values.join(",")
  })
  await Bun.write(registryPath, `${header}\n${nextLines.join("\n")}\n`)
  return updated
}
