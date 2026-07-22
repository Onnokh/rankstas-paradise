// Client-side config for tools that talk to a REMOTE Ranksta's Paradise server:
// the TUI in HTTP-client mode and the CLI in remote mode. This is the small
// half of the config split — apps and agents need only { apiUrl, token }; the
// Google credentials never leave the server.
//
// Ported from the legacy `src/clientConfig.ts`. Env wins over the file, so a
// run can point at any deployment without rewriting client.json. The token is
// carried as `Redacted` so it never lands in logs or error output.
import { homedir } from "node:os"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"

import { serviceUse } from "@rp/domain/service-use"

// The resolved remote target.
export interface ResolvedConfig {
  readonly apiUrl: string
  readonly token: Redacted.Redacted<string>
}

export type Mode = "local" | "remote"

// Raised when no remote target is configured (neither env nor client.json).
export class ClientConfigError extends Schema.TaggedErrorClass<ClientConfigError>()(
  "ClientConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface Interface {
  // The resolved { apiUrl, token }, env-first then the client.json file.
  readonly load: () => Effect.Effect<ResolvedConfig, ClientConfigError>
  // True when a remote target is configured either way, so callers can pick
  // direct-vs-remote without catching a throw from load().
  readonly isRemoteMode: () => Effect.Effect<boolean>
  // The effective data source. An explicit flag wins: `--local` forces direct,
  // `--network` forces the HTTP client. With no flag, a configured client means
  // remote, otherwise local — so a plain run keeps working offline.
  readonly resolveMode: () => Effect.Effect<Mode>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/ClientConfig",
) {}

export const use = serviceUse(Service)

// Same app-home convention as the server config, so a machine's server config
// and client config sit side by side under one directory.
const configHome = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`
export const clientConfigPath = `${configHome}/rankstas-paradise/client.json`

// Env recipe: both RP_API_URL and RP_TOKEN must be present to count. Any
// ConfigError (missing/unreadable source) reads as "no env config".
const fromEnv: Effect.Effect<Option.Option<ResolvedConfig>> = Effect.gen(
  function* () {
    const apiUrl = yield* Config.option(Config.string("RP_API_URL"))
    const token = yield* Config.option(Config.redacted("RP_TOKEN"))
    if (Option.isSome(apiUrl) && Option.isSome(token))
      return Option.some<ResolvedConfig>({
        apiUrl: apiUrl.value,
        token: token.value,
      })
    return Option.none<ResolvedConfig>()
  },
).pipe(Effect.catchCause(() => Effect.succeed(Option.none<ResolvedConfig>())))

// File recipe: read client.json if it exists and carries both fields.
const fromFile = Effect.gen(function* () {
  const file = Bun.file(clientConfigPath)
  const exists = yield* Effect.promise(() => file.exists())
  if (!exists) return Option.none<ResolvedConfig>()
  const parsed = yield* Effect.tryPromise({
    try: async () =>
      JSON.parse(await file.text()) as Partial<{
        apiUrl: string
        token: string
      }>,
    catch: (cause) =>
      new ClientConfigError({
        message: `The client config at ${clientConfigPath} is not valid JSON.`,
        cause,
      }),
  })
  if (typeof parsed.apiUrl === "string" && typeof parsed.token === "string")
    return Option.some<ResolvedConfig>({
      apiUrl: parsed.apiUrl,
      token: Redacted.make(parsed.token),
    })
  return Option.none<ResolvedConfig>()
})

export const layer = Layer.sync(Service, () => {
  const isRemoteMode = () =>
    Effect.gen(function* () {
      const env = yield* fromEnv
      if (Option.isSome(env)) return true
      return yield* Effect.promise(() => Bun.file(clientConfigPath).exists())
    })

  const load = () =>
    Effect.gen(function* () {
      const env = yield* fromEnv
      if (Option.isSome(env)) return env.value
      const file = yield* fromFile
      if (Option.isSome(file)) return file.value
      return yield* Effect.fail(
        new ClientConfigError({
          message:
            "No client config found: run `rp init` or set RP_API_URL and RP_TOKEN.",
        }),
      )
    })

  const resolveMode = (): Effect.Effect<Mode> =>
    Effect.gen(function* () {
      if (Bun.argv.includes("--local")) return "local" as const
      if (Bun.argv.includes("--network")) return "remote" as const
      return (yield* isRemoteMode()) ? ("remote" as const) : ("local" as const)
    })

  return { load, isRemoteMode, resolveMode }
})

export const defaultLayer = layer

export * as ClientConfig from "./client-config"
