// Registry service: reads and writes the per-site keyword-registry.csv.
// Site-scoped (the CSV path comes from CurrentSite) and debug-aware (Config).
// FROZEN CONTRACT — stub only (methods die).
import { Context, Effect, Layer } from "effect"

import { Config } from "../config/config.ts"
import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import {
  type RegistryEntry,
  RegistryError,
  type RegistryPatch,
} from "./schema.ts"

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
    yield* Config.Service
    yield* CurrentSite.Service
    return {
      loadRegistry: () => Effect.die("unimplemented: Registry.loadRegistry"),
      appendRegistryEntry: () =>
        Effect.die("unimplemented: Registry.appendRegistryEntry"),
      updateRegistryRows: () =>
        Effect.die("unimplemented: Registry.updateRegistryRows"),
      markMissingBaselines: () =>
        Effect.die("unimplemented: Registry.markMissingBaselines"),
    }
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(CurrentSite.defaultLayer),
)

export * as Registry from "./registry"
