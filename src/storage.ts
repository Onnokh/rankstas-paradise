import { Database } from "bun:sqlite"

import { databasePath } from "./config.ts"
import type { DailySnapshot, DailyTotals, PageIndexStatus } from "./google.ts"
import type { RegistryEntry } from "./registry.ts"

export const database = () => {
  const db = new Database(databasePath, { create: true })
  db.run(`
    create table if not exists search_snapshot (
      date text not null,
      query text not null,
      page text not null,
      device text not null,
      country text not null,
      clicks integer not null,
      impressions integer not null,
      ctr real not null,
      position real not null,
      collected_at text not null default current_timestamp,
      primary key (date, query, page, device, country)
    )
  `)
  db.run(`
    create table if not exists page_baseline (
      target_url text primary key,
      baseline_date text not null,
      window_start text not null,
      window_end text not null,
      clicks integer not null,
      impressions integer not null,
      ctr real not null,
      position real not null,
      captured_at text not null default current_timestamp
    )
  `)
  db.run(`
    create table if not exists synced_day (
      date text primary key,
      rows integer not null,
      fetched_at text not null default current_timestamp
    )
  `)
  db.run(`
    create table if not exists site_daily (
      date text primary key,
      clicks integer not null,
      impressions integer not null,
      ctr real not null,
      position real not null,
      collected_at text not null default current_timestamp
    )
  `)
  db.run(`
    create table if not exists page_daily (
      date text not null,
      page text not null,
      clicks integer not null,
      impressions integer not null,
      ctr real not null,
      position real not null,
      collected_at text not null default current_timestamp,
      primary key (date, page)
    )
  `)
  db.run(`
    create table if not exists action_log (
      id integer primary key autoincrement,
      date text not null,
      path text not null,
      kind text not null,
      note text not null default '',
      created_at text not null default current_timestamp
    )
  `)
  db.run(`
    create table if not exists page_index_status (
      target_url text primary key,
      status text not null,
      verdict text not null,
      coverage_state text not null default '',
      inspected_at text not null default current_timestamp
    )
  `)
  db.run(`
    insert into synced_day (date, rows)
    select date, count(*) from search_snapshot group by date
    on conflict(date) do nothing
  `)
  return db
}

export const saveSnapshots = (snapshots: readonly DailySnapshot[], fetchedDates: readonly string[] = [...new Set(snapshots.map((snapshot) => snapshot.date))]) => {
  const db = database()
  const insert = db.prepare(`
    insert into search_snapshot (date, query, page, device, country, clicks, impressions, ctr, position)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(date, query, page, device, country) do update set
      clicks = excluded.clicks,
      impressions = excluded.impressions,
      ctr = excluded.ctr,
      position = excluded.position,
      collected_at = current_timestamp
  `)
  const markFetched = db.prepare(`
    insert into synced_day (date, rows) values (?, ?)
    on conflict(date) do update set rows = excluded.rows, fetched_at = current_timestamp
  `)
  const deleteDate = db.prepare(`delete from search_snapshot where date = ?`)
  const rowCounts = new Map<string, number>()
  for (const snapshot of snapshots) rowCounts.set(snapshot.date, (rowCounts.get(snapshot.date) ?? 0) + 1)
  const transaction = db.transaction(() => {
    for (const date of fetchedDates) deleteDate.run(date)
    snapshots.forEach((snapshot) => insert.run(
      snapshot.date,
      snapshot.query,
      snapshot.page,
      snapshot.device,
      snapshot.country,
      snapshot.clicks,
      snapshot.impressions,
      snapshot.ctr,
      snapshot.position,
    ))
    for (const date of fetchedDates) markFetched.run(date, rowCounts.get(date) ?? 0)
  })
  transaction()
  db.close()
}

export const saveDailyTotals = (totals: DailyTotals, fetchedDates: readonly string[]) => {
  const db = database()
  const insertSite = db.prepare(`
    insert into site_daily (date, clicks, impressions, ctr, position) values (?, ?, ?, ?, ?)
    on conflict(date) do update set
      clicks = excluded.clicks, impressions = excluded.impressions,
      ctr = excluded.ctr, position = excluded.position, collected_at = current_timestamp
  `)
  const insertPage = db.prepare(`
    insert into page_daily (date, page, clicks, impressions, ctr, position) values (?, ?, ?, ?, ?, ?)
    on conflict(date, page) do update set
      clicks = excluded.clicks, impressions = excluded.impressions,
      ctr = excluded.ctr, position = excluded.position, collected_at = current_timestamp
  `)
  const deletePageDate = db.prepare(`delete from page_daily where date = ?`)
  const transaction = db.transaction(() => {
    for (const date of fetchedDates) deletePageDate.run(date)
    for (const row of totals.site) insertSite.run(row.date, row.clicks, row.impressions, row.ctr, row.position)
    for (const row of totals.pages) insertPage.run(row.date, row.page, row.clicks, row.impressions, row.ctr, row.position)
  })
  transaction()
  db.close()
}

export const missingDailyTotalDates = (dates: readonly string[]): string[] => {
  const db = database()
  const stored = new Set(db.query<{ readonly date: string }, []>(`select date from site_daily`).all().map((row) => row.date))
  db.close()
  return [...new Set(dates)].filter((date) => !stored.has(date))
}

export const savePageIndexStatuses = (statuses: readonly PageIndexStatus[]) => {
  const db = database()
  const upsert = db.prepare(`
    insert into page_index_status (target_url, status, verdict, coverage_state)
    values (?, ?, ?, ?)
    on conflict(target_url) do update set
      status = excluded.status, verdict = excluded.verdict,
      coverage_state = excluded.coverage_state, inspected_at = current_timestamp
  `)
  const transaction = db.transaction(() => statuses.forEach((status) => upsert.run(status.targetUrl, status.status, status.verdict, status.coverageState)))
  transaction()
  db.close()
}

export const recentlySyncedDates = (dates: readonly string[], maxAgeHours: number): string[] => {
  const db = database()
  const fresh = new Set(db.query<{ readonly date: string }, [string]>(`
    select date from synced_day where fetched_at > datetime('now', ?)
  `).all(`-${maxAgeHours} hours`).map((row) => row.date))
  db.close()
  return [...new Set(dates)].filter((date) => fresh.has(date))
}

export const recentlyInspectedUrls = (targetUrls: readonly string[], maxAgeHours: number): string[] => {
  const db = database()
  const fresh = new Set(db.query<{ readonly target_url: string }, [string]>(`
    select target_url from page_index_status where inspected_at > datetime('now', ?)
  `).all(`-${maxAgeHours} hours`).map((row) => row.target_url))
  db.close()
  return [...new Set(targetUrls)].filter((targetUrl) => fresh.has(targetUrl))
}

export const missingSnapshotDates = (dates: readonly string[]): string[] => {
  const db = database()
  const fetched = new Set(db.query<{ readonly date: string }, []>(`select date from synced_day`).all().map((row) => row.date))
  db.close()
  return [...new Set(dates)].filter((date) => !fetched.has(date))
}

export const snapshotDateRange = () => {
  const db = database()
  const range = db.query<{ readonly first: string | null; readonly last: string | null }, []>(`
    select min(date) as first, max(date) as last from synced_day
  `).get() ?? { first: null, last: null }
  db.close()
  return range
}

export type Opportunity = {
  readonly query: string
  readonly page: string
  readonly impressions: number
  readonly clicks: number
  readonly ctr: number
  readonly position: number
}

export type HistoryDay = {
  readonly date: string
  readonly impressions: number
  readonly clicks: number
  readonly ctr: number
  readonly position: number
}

export type Metrics = {
  readonly impressions: number
  readonly clicks: number
  readonly ctr: number
  readonly position: number
}

export type OpportunityKind = "striking-distance" | "ctr" | "new-demand" | "cannibalization" | "launch-readout"

export type OpportunitySignal = {
  readonly kind: OpportunityKind
  readonly label: string
  readonly query: string | null
  readonly page: string
  readonly pages: readonly string[]
  readonly current: Metrics
  readonly previous: Metrics | null
  readonly mapped: boolean
  readonly recommendation: string
  readonly score: number
  readonly launch?: {
    readonly daysSinceLaunch: number
    readonly day28: Metrics
    readonly day56: Metrics
    readonly day84: Metrics
  }
}

export type OpportunityDigest = {
  readonly latestDate: string | null
  readonly currentStart: string | null
  readonly previousStart: string | null
  readonly previousEnd: string | null
  readonly signals: readonly OpportunitySignal[]
}

export type RegistryProgress = {
  readonly entry: RegistryEntry
  readonly latestDate: string | null
  readonly measuredFrom: string | null
  readonly target: Metrics
  readonly keyword: Metrics
  readonly baseline: Metrics | null
  readonly state: "awaiting-data" | "awaiting-post-baseline" | "measuring"
}

export type RegistryTargetProgress = Omit<RegistryProgress, "entry" | "keyword"> & {
  readonly entries: readonly RegistryEntry[]
  readonly targetUrl: string
  readonly indexStatus: "indexed" | "not-indexed" | "unknown"
  readonly inspectedAt: string | null
}

export type RegistryDay = Metrics & {
  readonly date: string
}

export type RegistryPerformance = {
  readonly days: readonly RegistryDay[]
  readonly total: Metrics
  readonly last7: Metrics
  readonly previous7: Metrics
}

export const snapshotSummary = () => {
  const db = database()
  const summary = db.query<{ readonly rows: number; readonly dates: number }, []>(`
    select (select count(*) from search_snapshot) as rows,
           (select count(*) from synced_day) as dates
  `).get() ?? { rows: 0, dates: 0 }
  db.close()
  return summary
}

export const history = (limit = 28): HistoryDay[] => {
  const db = database()
  const rows = db.query<HistoryDay, [number]>(`
    select date, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(clicks) * 1.0 / sum(impressions) as ctr,
           sum(position * impressions) * 1.0 / sum(impressions) as position
    from search_snapshot
    group by date
    order by date desc
    limit ?
  `).all(limit)
  db.close()
  return rows.reverse()
}

const dateDaysBefore = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

const dateDaysAfter = (date: string, days: number) => dateDaysBefore(date, -days)

const daysBetween = (start: string, end: string) => Math.max(0, Math.floor((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000))

const summariseMetrics = (days: readonly RegistryDay[]): Metrics => {
  const impressions = days.reduce((total, day) => total + day.impressions, 0)
  const clicks = days.reduce((total, day) => total + day.clicks, 0)
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? days.reduce((total, day) => total + day.position * day.impressions, 0) / impressions : 0,
  }
}

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
}

const positionBand = (position: number) => position <= 3 ? "1–3" : position <= 5 ? "4–5" : "6–10"

export const opportunityDigest = (entries: readonly RegistryEntry[]): OpportunityDigest => {
  const db = database()
  const latestDate = db.query<{ readonly date: string | null }, []>(`select max(date) as date from search_snapshot`).get()?.date ?? null
  if (!latestDate) {
    db.close()
    return { latestDate: null, currentStart: null, previousStart: null, previousEnd: null, signals: [] }
  }
  const currentStart = dateDaysBefore(latestDate, 27)
  const previousEnd = dateDaysBefore(currentStart, 1)
  const previousStart = dateDaysBefore(previousEnd, 27)
  const windowRows = (start: string, end: string) => db.query<Opportunity, [string, string]>(`
    select query, page, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(clicks) * 1.0 / sum(impressions) as ctr,
           sum(position * impressions) * 1.0 / sum(impressions) as position
    from search_snapshot
    where date between ? and ? and lower(query) not like '%sleevy%'
    group by query, page
  `).all(start, end)
  const current = windowRows(currentStart, latestDate)
  const previous = windowRows(previousStart, previousEnd)
  const previousByKey = new Map(previous.map((row) => [`${row.query}\u0000${row.page}`, row]))
  const registryKeywords = new Set(entries.filter((entry) => entry.keyword.trim()).map((entry) => entry.keyword.toLowerCase()))
  const comparableCtr = new Map<string, number>()
  const comparableRows = current.filter((row) => row.impressions >= 20 && row.position <= 10)
  const siteMedianCtr = median(comparableRows.map((row) => row.ctr))
  for (const band of ["1–3", "4–5", "6–10"] as const) {
    const bandCtr = comparableRows.filter((row) => positionBand(row.position) === band).map((row) => row.ctr)
    comparableCtr.set(band, bandCtr.length >= 3 ? median(bandCtr) : siteMedianCtr)
  }
  const signals: OpportunitySignal[] = []
  for (const row of current) {
    const prior = previousByKey.get(`${row.query}\u0000${row.page}`) ?? null
    const mapped = registryKeywords.has(row.query.toLowerCase())
    if (row.impressions >= 20 && row.position >= 4 && row.position <= 20 && row.ctr < 0.1) {
      signals.push({
        kind: "striking-distance",
        label: row.query,
        query: row.query,
        page: row.page,
        pages: [row.page],
        current: row,
        previous: prior,
        mapped,
        recommendation: mapped ? "Improve the mapped page before creating another page." : "Check whether the ranking page satisfies intent before adding a new page.",
        score: row.impressions * (21 - row.position),
      })
    }
    const benchmark = row.position <= 10 ? comparableCtr.get(positionBand(row.position)) ?? 0 : 0
    if (row.position <= 10 && row.impressions >= 50 && benchmark > 0 && row.ctr < benchmark * 0.8) {
      signals.push({
        kind: "ctr",
        label: row.query,
        query: row.query,
        page: row.page,
        pages: [row.page],
        current: row,
        previous: prior,
        mapped,
        recommendation: "Test title, description, and snippet alignment; do not repeat keywords.",
        score: row.impressions * (benchmark - row.ctr),
      })
    }
  }
  const byQuery = new Map<string, Opportunity[]>()
  for (const row of current) byQuery.set(row.query, [...(byQuery.get(row.query) ?? []), row])
  const previousByQuery = new Map<string, Opportunity[]>()
  for (const row of previous) previousByQuery.set(row.query, [...(previousByQuery.get(row.query) ?? []), row])
  const combineRows = (rows: readonly Opportunity[]): Metrics => {
    const impressions = rows.reduce((total, row) => total + row.impressions, 0)
    const clicks = rows.reduce((total, row) => total + row.clicks, 0)
    return {
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? rows.reduce((total, row) => total + row.position * row.impressions, 0) / impressions : 0,
    }
  }
  for (const [query, rows] of byQuery) {
    const pages = [...new Set(rows.map((row) => row.page))]
    const currentMetrics = combineRows(rows)
    const priorRows = previousByQuery.get(query) ?? []
    if (currentMetrics.impressions >= 20 && !registryKeywords.has(query.toLowerCase())) {
      const ranksOnRegisteredTarget = pages.some((page) => entries.some((entry) => page === `https://sleevy.app${entry.targetUrl}`))
      signals.push({
        kind: "new-demand",
        label: query,
        query,
        page: pages[0]!,
        pages,
        current: currentMetrics,
        previous: priorRows.length > 0 ? combineRows(priorRows) : null,
        mapped: false,
        recommendation: ranksOnRegisteredTarget
          ? "Review whether the existing ranking page satisfies this intent before adding a registry mapping."
          : "Cluster the phrase and map it only if no existing page satisfies the intent.",
        score: currentMetrics.impressions,
      })
    }
    if (pages.length < 2) continue
    signals.push({
      kind: "cannibalization",
      label: query,
      query,
      page: pages[0]!,
      pages,
      current: currentMetrics,
      previous: null,
      mapped: registryKeywords.has(query.toLowerCase()),
      recommendation: "Consolidate content and internal links, or clarify canonicals and page intent.",
      score: currentMetrics.impressions * pages.length,
    })
  }
  const uniqueTargets = new Map(entries.filter((entry) => entry.keyword.trim()).map((entry) => [entry.targetUrl, entry]))
  const pageWindow = db.prepare(`
    select coalesce(sum(clicks), 0) as clicks, coalesce(sum(impressions), 0) as impressions,
           case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
           case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
    from search_snapshot
    where page = ? and date between ? and ? and lower(query) not like '%sleevy%'
  `)
  for (const [targetUrl, entry] of uniqueTargets) {
    const start = entry.publishedAt || entry.baselineDate
    if (!start || latestDate <= start) continue
    const fullUrl = `https://sleevy.app${targetUrl}`
    const milestone = (days: number) => pageWindow.get(fullUrl, start, [latestDate, dateDaysAfter(start, days - 1)].sort().at(0)!) as Metrics
    const day28 = milestone(28)
    const day56 = milestone(56)
    const day84 = milestone(84)
    const baselineEnd = dateDaysBefore(entry.baselineDate || start, 3)
    const baselineStart = dateDaysBefore(baselineEnd, 27)
    const baselineMetrics = pageWindow.get(fullUrl, baselineStart, baselineEnd) as Metrics
    signals.push({
      kind: "launch-readout",
      label: targetUrl,
      query: null,
      page: fullUrl,
      pages: [fullUrl],
      current: day28,
      previous: baselineMetrics,
      mapped: true,
      recommendation: "Review 28/56/84-day visibility against baseline and check UTM-attributed product outcomes separately.",
      score: Math.abs(day28.impressions - baselineMetrics.impressions),
      launch: { daysSinceLaunch: daysBetween(start, latestDate), day28, day56, day84 },
    })
  }
  db.close()
  return { latestDate, currentStart, previousStart, previousEnd, signals: signals.sort((left, right) => right.score - left.score) }
}

export const targetPerformance = (targetUrl: string, includeBrand = false): RegistryPerformance => {
  const db = database()
  const latestDate = db.query<{ readonly date: string | null }, []>(`select max(date) as date from search_snapshot`).get()?.date ?? null
  const zero: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }
  if (!latestDate) {
    db.close()
    return { days: [], total: zero, last7: zero, previous7: zero }
  }
  const start = dateDaysBefore(latestDate, 27)
  const rows = db.query<RegistryDay, [string, string, string, number]>(`
    select date, sum(clicks) as clicks, sum(impressions) as impressions,
           sum(clicks) * 1.0 / sum(impressions) as ctr,
           sum(position * impressions) * 1.0 / sum(impressions) as position
    from search_snapshot
    where page = ? and date between ? and ?
      and (? = 1 or lower(query) not like '%sleevy%')
    group by date
  `).all(`https://sleevy.app${targetUrl}`, start, latestDate, includeBrand ? 1 : 0)
  const byDate = new Map(rows.map((row) => [row.date, row]))
  const days = Array.from({ length: 28 }, (_, index) => {
    const date = new Date(`${start}T00:00:00.000Z`)
    date.setUTCDate(date.getUTCDate() + index)
    const key = date.toISOString().slice(0, 10)
    return byDate.get(key) ?? { date: key, ...zero }
  })
  db.close()
  return {
    days,
    total: summariseMetrics(days),
    last7: summariseMetrics(days.slice(-7)),
    previous7: summariseMetrics(days.slice(-14, -7)),
  }
}

export const registryProgress = (entries: readonly RegistryEntry[]): RegistryProgress[] => {
  const db = database()
  const latestDate = db.query<{ readonly date: string | null }, []>(`select max(date) as date from search_snapshot`).get()?.date ?? null
  const zero: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }
  const metrics = db.prepare(`
    select coalesce(sum(clicks), 0) as clicks,
           coalesce(sum(impressions), 0) as impressions,
           case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
           case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
    from search_snapshot
    where page = ? and date between ? and ? and lower(query) not like '%sleevy%'
  `)
  const keywordMetrics = db.prepare(`
    select coalesce(sum(clicks), 0) as clicks,
           coalesce(sum(impressions), 0) as impressions,
           case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
           case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
    from search_snapshot
    where page = ? and lower(query) = lower(?) and date between ? and ?
  `)
  const baseline = db.prepare(`
    select clicks, impressions, ctr, position from page_baseline where target_url = ?
  `)
  const result = entries.map((entry) => {
    const targetUrl = `https://sleevy.app${entry.targetUrl}`
    const baselineRow = baseline.get(targetUrl) as Metrics | null
    const progressStart = entry.publishedAt || entry.baselineDate
    if (!latestDate) return { entry, latestDate, measuredFrom: null, target: zero, keyword: zero, baseline: baselineRow, state: "awaiting-data" as const }
    if (!entry.keyword.trim()) {
      const windowStart = dateDaysBefore(latestDate, 27)
      return { entry, latestDate, measuredFrom: windowStart, target: zero, keyword: zero, baseline: null, state: "measuring" as const }
    }
    if (!progressStart || latestDate <= progressStart) return { entry, latestDate, measuredFrom: progressStart || null, target: zero, keyword: zero, baseline: baselineRow, state: "awaiting-post-baseline" as const }
    const windowStart = [dateDaysBefore(latestDate, 27), progressStart].sort().at(-1)!
    return {
      entry,
      latestDate,
      measuredFrom: windowStart,
      target: metrics.get(targetUrl, windowStart, latestDate) as Metrics,
      keyword: keywordMetrics.get(targetUrl, entry.keyword, windowStart, latestDate) as Metrics,
      baseline: baselineRow,
      state: "measuring" as const,
    }
  })
  db.close()
  return result
}

export const registryTargetProgress = (entries: readonly RegistryEntry[]): RegistryTargetProgress[] => {
  const progress = registryProgress(entries)
  const db = database()
  const indexRows = db.query<{ readonly target_url: string; readonly status: "indexed" | "not-indexed" | "unknown"; readonly inspected_at: string }, []>(`
    select target_url, status, inspected_at from page_index_status
  `).all()
  db.close()
  const indexByUrl = new Map(indexRows.map((row) => [row.target_url, row]))
  const grouped = new Map<string, RegistryProgress[]>()
  for (const row of progress) grouped.set(row.entry.targetUrl, [...(grouped.get(row.entry.targetUrl) ?? []), row])
  const targets = [...grouped.entries()].map(([targetUrl, rows]) => {
    const first = rows[0]!
    const inventoryOnly = rows.every((row) => !row.entry.keyword.trim())
    return {
      entries: rows.map((row) => row.entry),
      targetUrl,
      latestDate: first.latestDate,
      measuredFrom: first.measuredFrom,
      target: targetPerformance(targetUrl, inventoryOnly).total,
      baseline: first.baseline,
      state: first.state,
      indexStatus: indexByUrl.get(`https://sleevy.app${targetUrl}`)?.status ?? "unknown",
      inspectedAt: indexByUrl.get(`https://sleevy.app${targetUrl}`)?.inspected_at ?? null,
    }
  })
  const priorityRank = (priority: string) => /^P\d+$/.test(priority) ? Number(priority.slice(1)) : Number.POSITIVE_INFINITY
  const keywordCount = (target: RegistryTargetProgress) => target.entries.filter((entry) => entry.keyword.trim()).length
  return targets.sort((left, right) =>
    priorityRank(left.entries[0]?.priority ?? "") - priorityRank(right.entries[0]?.priority ?? "")
    || keywordCount(right) - keywordCount(left)
    || left.targetUrl.localeCompare(right.targetUrl)
  )
}

export type PageWindowRow = {
  readonly page: string
  readonly nonBrand: { readonly current: Metrics; readonly previous: Metrics }
  readonly allQueries: { readonly current: Metrics; readonly previous: Metrics }
  readonly trueTotals: { readonly current: Metrics; readonly previous: Metrics } | null
}

export type PagesWindowOverview = {
  readonly latestDate: string | null
  readonly currentStart: string | null
  readonly previousStart: string | null
  readonly previousEnd: string | null
  readonly totalsCoverage: { readonly siteDays: number; readonly pageDays: number }
  readonly rows: readonly PageWindowRow[]
}

const zeroMetrics: Metrics = { impressions: 0, clicks: 0, ctr: 0, position: 0 }

export const pagesWindowOverview = (windowDays = 28): PagesWindowOverview => {
  const db = database()
  const latestDate = db.query<{ readonly date: string | null }, []>(`select max(date) as date from search_snapshot`).get()?.date ?? null
  const coverage = db.query<{ readonly siteDays: number; readonly pageDays: number }, []>(`
    select (select count(*) from site_daily) as siteDays,
           (select count(distinct date) from page_daily) as pageDays
  `).get() ?? { siteDays: 0, pageDays: 0 }
  if (!latestDate) {
    db.close()
    return { latestDate: null, currentStart: null, previousStart: null, previousEnd: null, totalsCoverage: coverage, rows: [] }
  }
  const currentStart = dateDaysBefore(latestDate, windowDays - 1)
  const previousEnd = dateDaysBefore(currentStart, 1)
  const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
  type Grouped = Metrics & { readonly page: string }
  const snapshotWindow = (start: string, end: string, includeBrand: boolean) => db.query<Grouped, [string, string, number]>(`
    select page, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(clicks) * 1.0 / sum(impressions) as ctr,
           sum(position * impressions) * 1.0 / sum(impressions) as position
    from search_snapshot
    where date between ? and ? and (? = 1 or lower(query) not like '%sleevy%')
    group by page
  `).all(start, end, includeBrand ? 1 : 0)
  const totalsWindow = (start: string, end: string) => db.query<Grouped, [string, string]>(`
    select page, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(clicks) * 1.0 / sum(impressions) as ctr,
           sum(position * impressions) * 1.0 / sum(impressions) as position
    from page_daily
    where date between ? and ?
    group by page
  `).all(start, end)
  const asMap = (rows: readonly Grouped[]) => new Map(rows.map(({ page, ...metrics }) => [page, metrics as Metrics]))
  const nonBrandCurrent = asMap(snapshotWindow(currentStart, latestDate, false))
  const nonBrandPrevious = asMap(snapshotWindow(previousStart, previousEnd, false))
  const allCurrent = asMap(snapshotWindow(currentStart, latestDate, true))
  const allPrevious = asMap(snapshotWindow(previousStart, previousEnd, true))
  const trueCurrent = asMap(totalsWindow(currentStart, latestDate))
  const truePrevious = asMap(totalsWindow(previousStart, previousEnd))
  db.close()
  const pages = [...new Set([...allCurrent.keys(), ...allPrevious.keys(), ...trueCurrent.keys()])]
  const rows = pages.map((page) => ({
    page,
    nonBrand: { current: nonBrandCurrent.get(page) ?? zeroMetrics, previous: nonBrandPrevious.get(page) ?? zeroMetrics },
    allQueries: { current: allCurrent.get(page) ?? zeroMetrics, previous: allPrevious.get(page) ?? zeroMetrics },
    trueTotals: trueCurrent.has(page) || truePrevious.has(page)
      ? { current: trueCurrent.get(page) ?? zeroMetrics, previous: truePrevious.get(page) ?? zeroMetrics }
      : null,
  }))
  return { latestDate, currentStart, previousStart, previousEnd, totalsCoverage: coverage, rows }
}

export type QueryWindowRow = {
  readonly query: string
  readonly page: string
  readonly current: Metrics
  readonly previous: Metrics | null
}

export type TopQueriesOptions = {
  readonly page?: string
  readonly windowDays?: number
  readonly minImpressions?: number
  readonly includeBrand?: boolean
  readonly limit?: number
}

export const topQueries = (options: TopQueriesOptions = {}): { readonly latestDate: string | null; readonly currentStart: string | null; readonly previousStart: string | null; readonly previousEnd: string | null; readonly rows: readonly QueryWindowRow[] } => {
  const { page, windowDays = 28, minImpressions = 0, includeBrand = false, limit = 50 } = options
  const db = database()
  const latestDate = db.query<{ readonly date: string | null }, []>(`select max(date) as date from search_snapshot`).get()?.date ?? null
  if (!latestDate) {
    db.close()
    return { latestDate: null, currentStart: null, previousStart: null, previousEnd: null, rows: [] }
  }
  const currentStart = dateDaysBefore(latestDate, windowDays - 1)
  const previousEnd = dateDaysBefore(currentStart, 1)
  const previousStart = dateDaysBefore(previousEnd, windowDays - 1)
  type Grouped = Metrics & { readonly query: string; readonly page: string }
  const windowRows = (start: string, end: string) => db.query<Grouped, [string, string, number, string, string]>(`
    select query, page, sum(impressions) as impressions, sum(clicks) as clicks,
           sum(clicks) * 1.0 / sum(impressions) as ctr,
           sum(position * impressions) * 1.0 / sum(impressions) as position
    from search_snapshot
    where date between ? and ?
      and (? = 1 or lower(query) not like '%sleevy%')
      and (? = '' or page = ?)
    group by query, page
  `).all(start, end, includeBrand ? 1 : 0, page ?? "", page ?? "")
  const current = windowRows(currentStart, latestDate)
  const previous = new Map(windowRows(previousStart, previousEnd).map((row) => [`${row.query}\u0000${row.page}`, row]))
  db.close()
  const rows = current
    .filter((row) => row.impressions >= minImpressions)
    .sort((left, right) => right.impressions - left.impressions)
    .slice(0, limit)
    .map(({ query, page: rowPage, ...metrics }) => {
      const prior = previous.get(`${query}\u0000${rowPage}`)
      return {
        query,
        page: rowPage,
        current: metrics as Metrics,
        previous: prior ? { impressions: prior.impressions, clicks: prior.clicks, ctr: prior.ctr, position: prior.position } : null,
      }
    })
  return { latestDate, currentStart, previousStart, previousEnd, rows }
}

export type ActionKind = "publish" | "content-update" | "title-change" | "internal-links" | "consolidation" | "note"
export const actionKinds: readonly ActionKind[] = ["publish", "content-update", "title-change", "internal-links", "consolidation", "note"]

export type ActionEntry = {
  readonly id: number
  readonly date: string
  readonly path: string
  readonly kind: ActionKind
  readonly note: string
  readonly createdAt: string
}

export const addAction = (action: { readonly date: string; readonly path: string; readonly kind: ActionKind; readonly note: string }): ActionEntry => {
  const db = database()
  const row = db.query<{ readonly id: number; readonly created_at: string }, [string, string, string, string]>(`
    insert into action_log (date, path, kind, note) values (?, ?, ?, ?)
    returning id, created_at
  `).get(action.date, action.path, action.kind, action.note)!
  db.close()
  return { id: row.id, createdAt: row.created_at, ...action }
}

export const listActions = (path?: string): ActionEntry[] => {
  const db = database()
  const rows = db.query<{ readonly id: number; readonly date: string; readonly path: string; readonly kind: ActionKind; readonly note: string; readonly created_at: string }, [string, string]>(`
    select id, date, path, kind, note, created_at from action_log
    where (? = '' or path = ?)
    order by date desc, id desc
  `).all(path ?? "", path ?? "")
  db.close()
  return rows.map(({ created_at, ...rest }) => ({ ...rest, createdAt: created_at }))
}

export const capturePageBaselines = (entries: readonly RegistryEntry[], baselineDate: string) => {
  const db = database()
  const windowEndDate = new Date(`${baselineDate}T00:00:00.000Z`)
  windowEndDate.setUTCDate(windowEndDate.getUTCDate() - 3)
  const windowStartDate = new Date(windowEndDate)
  windowStartDate.setUTCDate(windowStartDate.getUTCDate() - 27)
  const windowStart = windowStartDate.toISOString().slice(0, 10)
  const windowEnd = windowEndDate.toISOString().slice(0, 10)
  const targets = [...new Set(entries.map((entry) => `https://sleevy.app${entry.targetUrl}`))]
  const metrics = db.prepare(`
    select coalesce(sum(clicks), 0) as clicks,
           coalesce(sum(impressions), 0) as impressions,
           case when sum(impressions) > 0 then sum(clicks) * 1.0 / sum(impressions) else 0 end as ctr,
           case when sum(impressions) > 0 then sum(position * impressions) * 1.0 / sum(impressions) else 0 end as position
    from search_snapshot
    where page = ? and date between ? and ? and lower(query) not like '%sleevy%'
  `)
  const upsert = db.prepare(`
    insert into page_baseline (target_url, baseline_date, window_start, window_end, clicks, impressions, ctr, position)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(target_url) do nothing
  `)
  const transaction = db.transaction(() => targets.forEach((target) => {
    const row = metrics.get(target, windowStart, windowEnd) as { clicks: number; impressions: number; ctr: number; position: number }
    upsert.run(target, baselineDate, windowStart, windowEnd, row.clicks, row.impressions, row.ctr, row.position)
  }))
  transaction()
  db.close()
  return { targets: targets.length, windowStart, windowEnd }
}
