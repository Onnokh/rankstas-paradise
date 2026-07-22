// The root layer and the application runtime factory.
//
// `AppLayer` composes every domain service's `defaultLayer` into one graph.
// Each `defaultLayer` already provides its own dependencies (Config, CurrentSite,
// and any sibling services), so the composed layer has no outstanding
// requirements and type-checks with all stubs in place. Shared layers that
// appear more than once are deduplicated at runtime by the ManagedRuntime's
// memo map.
//
// NOTE: CurrentSite's `defaultLayer` is a die stub — the real per-scope active
// site is supplied by a scoped layer at the request/CLI boundary, overriding
// the stub. Everything here is a compiling stub whose methods die; real
// implementations land in later tickets.
import { Layer, ManagedRuntime } from "effect"

import { Config } from "./config/config.ts"
import { CurrentSite } from "./sites/current-site.ts"
import { Registry } from "./registry/registry.ts"
import { Reports } from "./reports/reports.ts"
import { SearchConsole } from "./search-console/search-console.ts"
import { Sitemap } from "./sitemap/sitemap.ts"
import { Sites } from "./sites/sites.ts"
import { Storage } from "./storage/storage.ts"
import { Sync } from "./sync/sync.ts"

export const AppLayer = Layer.mergeAll(
  Config.defaultLayer,
  CurrentSite.defaultLayer,
  Sites.defaultLayer,
  SearchConsole.defaultLayer,
  Storage.defaultLayer,
  Registry.defaultLayer,
  Sitemap.defaultLayer,
  Sync.defaultLayer,
  Reports.defaultLayer,
)

// Build the application runtime. Construct once and reuse it; each call builds a
// fresh runtime with its own memo map (so layers are instantiated once per
// runtime).
export const makeRuntime = () => ManagedRuntime.make(AppLayer)

export type AppRuntime = ReturnType<typeof makeRuntime>

export * as Runtime from "./runtime"
