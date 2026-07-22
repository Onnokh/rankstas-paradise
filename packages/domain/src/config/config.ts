// Config service: resolves the application config (env-wins-over-file) and the
// derived data-home paths. Uses Effect `Config` recipes internally; the secret
// is a `Redacted<string>`. FROZEN CONTRACT — stub only (methods die).
import { Context, Effect, Layer } from "effect"

import { serviceUse } from "../service-use.ts"
import { ConfigLoadError, type SeoConfig } from "./schema.ts"

export interface Interface {
  // Resolve the full config: file merged with GOOGLE_CLIENT_ID/SECRET from the
  // environment (env wins), validated for the required fields.
  readonly load: () => Effect.Effect<SeoConfig, ConfigLoadError>
  // The XDG-style app home ($XDG_CONFIG_HOME/rankstas-paradise or ~/.config/...).
  readonly dataDirectory: () => Effect.Effect<string>
  // Path to the mutable Google OAuth token on the persistent volume.
  readonly tokenPath: () => Effect.Effect<string>
  // Whether the process was launched with --debug (isolated fake database).
  readonly debugMode: () => Effect.Effect<boolean>
  // Create the data directory if it does not exist.
  readonly ensureDataDirectory: () => Effect.Effect<void, ConfigLoadError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Config") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return {
      load: () => Effect.die("unimplemented: Config.load"),
      dataDirectory: () => Effect.die("unimplemented: Config.dataDirectory"),
      tokenPath: () => Effect.die("unimplemented: Config.tokenPath"),
      debugMode: () => Effect.die("unimplemented: Config.debugMode"),
      ensureDataDirectory: () =>
        Effect.die("unimplemented: Config.ensureDataDirectory"),
    }
  }),
)

export const defaultLayer = layer

export * as Config from "./config"
