// The app's whole data layer, as TanStack Query options objects.
//
// Every read is a query keyed by what it depends on, so the cache — not this
// module and not a component — decides when a fetch happens. Two consequences
// the window depends on: switching to a site already in the cache paints from
// it immediately instead of blanking, and a completed sync invalidates exactly
// the keys it changed.
//
// The transport is the preload bridge, which answers `{ ok, value } | { ok,
// message }` rather than throwing, so each `queryFn` re-throws the failure —
// that is the shape Query expects for `isError`.
import { queryOptions } from "@tanstack/react-query"

import type { DashboardSnapshot } from "@rp/api-client/schema"

import type { StatusWithFreshness } from "../main/api.ts"

import { TREND_WINDOW } from "./format.ts"
import type { Site, TrendDay } from "./types.ts"

const unwrap = async <A>(
  result: Promise<{ ok: true; value: A } | { ok: false; message: string }>,
): Promise<A> => {
  const settled = await result
  if (!settled.ok) throw new Error(settled.message)
  return settled.value
}

// One factory for every key in the app, so an invalidation can name a site's
// whole subtree (`["dashboard", siteId]`) without guessing at string shapes.
export const keys = {
  sites: ["sites"] as const,
  dashboards: ["dashboard"] as const,
  dashboard: (siteId: string) => ["dashboard", siteId] as const,
  histories: ["history"] as const,
  // Every window length stored for a site, for invalidating them all at once.
  historiesFor: (siteId: string) => ["history", siteId] as const,
  history: (siteId: string, days: number) => ["history", siteId, days] as const,
  status: (siteId: string) => ["status", siteId] as const,
  favicon: (origin: string) => ["favicon", origin] as const,
}

// The site catalog changes only when the server's config does, so it never goes
// stale inside a session.
export const sitesQuery = () =>
  queryOptions({
    queryKey: keys.sites,
    queryFn: () => unwrap<readonly Site[]>(window.rp.sites()),
    staleTime: Infinity,
  })

// The whole dashboard model for one site. The raw snapshot is what lives in the
// cache; `toDashboard` runs in the component so the cached value stays a plain
// serialisable object that structural sharing can diff.
export const dashboardQuery = (siteId: string | undefined) =>
  queryOptions({
    queryKey: keys.dashboard(siteId ?? ""),
    queryFn: () => unwrap<DashboardSnapshot>(window.rp.dashboard(siteId!)),
    enabled: Boolean(siteId),
    // A sync is the only thing that changes this, and a sync invalidates it, so
    // nothing is gained by refetching on every mount.
    staleTime: 5 * 60_000,
  })

// Two comparison periods of daily totals: the selected span and the one before
// it. Separate from the dashboard because the snapshot only carries a fixed
// 28-day window. Each span is its own key, so switching between them refetches
// once and is instant every time after.
export const historyQuery = (siteId: string | undefined, days: number = TREND_WINDOW) =>
  queryOptions({
    queryKey: keys.history(siteId ?? "", days * 2),
    queryFn: async () =>
      (await unwrap(window.rp.history(siteId!, days * 2))).days as readonly TrendDay[],
    enabled: Boolean(siteId),
    staleTime: 5 * 60_000,
  })

// Freshness: when the site's data last changed and when Ranksta last asked
// Google. Cheap and small, so it is refetched on mount and after every sync.
export const statusQuery = (siteId: string | undefined) =>
  queryOptions({
    queryKey: keys.status(siteId ?? ""),
    queryFn: () => unwrap<StatusWithFreshness>(window.rp.status(siteId!)),
    enabled: Boolean(siteId),
    staleTime: 60_000,
  })

// A site's own icon, as a `data:` URL the main process fetched for us. It cannot
// change while the window is open, and the query never rejects — a site with no
// readable icon resolves to null and the sidebar shows its dot instead.
export const faviconQuery = (origin: string | undefined) =>
  queryOptions({
    queryKey: keys.favicon(origin ?? ""),
    queryFn: () => window.rp.favicon(origin!),
    enabled: Boolean(origin),
    staleTime: Infinity,
    retry: false,
  })
