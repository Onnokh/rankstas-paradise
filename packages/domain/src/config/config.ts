// Config service: resolves the application config (env-wins-over-file) and the
// derived data-home paths. Uses Effect `Config` recipes internally; the secret
// is a `Redacted<string>` so it never leaks into logs or serialized output.
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"

import { Config, ConfigProvider, Context, Effect, Layer } from "effect"

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

// The raw shape of config.json before merge/validation. Only `id`/`siteUrl` in a
// site are required; everything else is optional (see the frozen schema).
interface RawConfigFile {
  googleClientId?: string
  googleClientSecret?: string
  siteUrl?: string
  sites?: SeoConfig["sites"]
}

// The static credentials + siteUrl that participate in env-wins-over-file
// precedence, read through the ambient `ConfigProvider`. `sites` and the
// XDG/debug values are not part of this recipe: `sites` comes from the file and
// the paths/flags are read once at layer construction.
const credentials = Config.all({
  googleClientId: Config.string("GOOGLE_CLIENT_ID"),
  googleClientSecret: Config.redacted("GOOGLE_CLIENT_SECRET"),
  siteUrl: Config.string("SITE_URL"),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Capture the active provider at construction — in production this is the
    // environment; tests inject a fake via `layerFromProvider`. The file is
    // layered behind it as a fallback so the environment wins for shared keys.
    const ambient = yield* ConfigProvider.ConfigProvider

    // Config and data live in one XDG-style app home
    // (~/.config/rankstas-paradise, or $XDG_CONFIG_HOME/rankstas-paradise) —
    // never next to the code, which may be an ephemeral npx/global install.
    const configHome = yield* Config.string("XDG_CONFIG_HOME").pipe(
      Config.withDefault(`${homedir()}/.config`),
    )
    const dataDir = `${configHome}/rankstas-paradise`
    const configPath = `${dataDir}/config.json`
    const tokenFile = `${dataDir}/google-token.json`

    // `--debug` inspection is gone: debug is config now (DEBUG env / provider),
    // defaulting to false. A typo'd value fails loudly instead of silently off.
    const debug = yield* Config.boolean("DEBUG").pipe(Config.withDefault(false))

    // Read config.json off the volume. A missing file is soft (the environment
    // may satisfy every required field); an unreadable or malformed file is a
    // hard, fail-closed error.
    const readConfigFile = Effect.fnUntraced(function* () {
      const exists = yield* Effect.promise(() => Bun.file(configPath).exists())
      if (!exists) return {} as RawConfigFile
      const text = yield* Effect.tryPromise({
        try: () => Bun.file(configPath).text(),
        catch: (cause) =>
          new ConfigLoadError({ message: `Could not read ${configPath}`, cause }),
      })
      return yield* Effect.try({
        try: () => JSON.parse(text) as RawConfigFile,
        catch: (cause) =>
          new ConfigLoadError({ message: `Invalid JSON in ${configPath}`, cause }),
      })
    })

    const load = Effect.fn("Config.load")(function* () {
      const file = yield* readConfigFile()

      // The Google client id/secret are static, so they may come from the
      // environment (Coolify secrets) and take precedence over the file — a
      // hosted deploy then keeps them out of config.json, which only needs
      // siteUrl and the sites[] catalog. The file becomes a fallback provider
      // behind the ambient one, so the environment wins for any shared key.
      const fileEnv: Record<string, string> = {}
      if (file.googleClientId !== undefined)
        fileEnv.GOOGLE_CLIENT_ID = file.googleClientId
      if (file.googleClientSecret !== undefined)
        fileEnv.GOOGLE_CLIENT_SECRET = file.googleClientSecret
      if (file.siteUrl !== undefined) fileEnv.SITE_URL = file.siteUrl

      const provider = ConfigProvider.orElse(
        ambient,
        ConfigProvider.fromEnv({ env: fileEnv }),
      )

      const resolved = yield* credentials.parse(provider).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigLoadError({
              message:
                "Missing config: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (env or config.json), and siteUrl in config.json",
              cause,
            }),
        ),
      )

      return {
        googleClientId: resolved.googleClientId,
        googleClientSecret: resolved.googleClientSecret,
        siteUrl: resolved.siteUrl,
        sites: file.sites,
      } satisfies SeoConfig
    })

    return {
      load,
      dataDirectory: () => Effect.succeed(dataDir),
      tokenPath: () => Effect.succeed(tokenFile),
      debugMode: () => Effect.succeed(debug),
      ensureDataDirectory: () =>
        Effect.tryPromise({
          try: () => mkdir(dataDir, { recursive: true }),
          catch: (cause) =>
            new ConfigLoadError({
              message: `Could not create ${dataDir}`,
              cause,
            }),
        }).pipe(Effect.asVoid),
    }
  }),
)

export const defaultLayer = layer

// Test seam: wire the Config service on top of an explicit in-memory provider so
// tests can inject config without touching the real environment or filesystem.
// Production leaves the default ambient provider (env) in place.
export const layerFromProvider = (provider: ConfigProvider.ConfigProvider) =>
  layer.pipe(Layer.provide(ConfigProvider.layer(provider)))

export * as Config from "./config"
