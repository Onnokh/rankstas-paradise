import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"

import { Effect } from "effect"

export type SeoConfig = {
  readonly googleClientId: string
  readonly googleClientSecret: string
  readonly siteUrl: string
  readonly sites?: readonly {
    readonly id: string
    readonly name?: string
    readonly siteUrl: string
    readonly origin?: string
    readonly sitemapUrl?: string
    readonly brandTerms?: readonly string[]
  }[]
}

// Config and data live in one XDG-style app home (~/.config/rankstas-paradise,
// or $XDG_CONFIG_HOME/rankstas-paradise) — never next to the code. A global
// or `npx` install runs from an ephemeral package directory, so anything the
// tool reads or writes has to be anchored in the user's home instead.
const configHome = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`
export const dataDirectory = `${configHome}/rankstas-paradise`
const configPath = `${dataDirectory}/config.json`
export const tokenPath = `${dataDirectory}/google-token.json`
export const debugMode = Bun.argv.includes("--debug")

export const loadConfig = Effect.tryPromise({
  try: async () => {
    const file = JSON.parse(await Bun.file(configPath).text()) as Partial<SeoConfig>
    // The Google client id/secret are static, so they may come from the
    // environment (Coolify secrets) and take precedence over the file — a hosted
    // deploy then keeps them out of config.json, which only needs siteUrl and the
    // sites[] catalog. Locally, leaving the env unset falls back to the file. The
    // mutable OAuth token still lives on the volume (google.ts rewrites it on
    // refresh), so a persistent volume is required regardless.
    const config: Partial<SeoConfig> = {
      ...file,
      googleClientId: Bun.env.GOOGLE_CLIENT_ID ?? file.googleClientId,
      googleClientSecret: Bun.env.GOOGLE_CLIENT_SECRET ?? file.googleClientSecret,
    }
    if (!config.googleClientId || !config.googleClientSecret || !config.siteUrl) {
      throw new Error("Missing config: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (env or config.json), and siteUrl in config.json")
    }
    return config as SeoConfig
  },
  catch: (cause) => new Error(`Could not load ${configPath}: ${String(cause)}`),
})

export const ensureDataDirectory = Effect.tryPromise({
  try: () => mkdir(dataDirectory, { recursive: true }),
  catch: (cause) => new Error(`Could not create ${dataDirectory}: ${String(cause)}`),
})
