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
    const raw = await Bun.file(configPath).text()
    const config = JSON.parse(raw) as Partial<SeoConfig>
    if (!config.googleClientId || !config.googleClientSecret || !config.siteUrl) {
      throw new Error("config.json must include googleClientId, googleClientSecret, and siteUrl")
    }
    return config as SeoConfig
  },
  catch: (cause) => new Error(`Could not load ${configPath}: ${String(cause)}`),
})

export const ensureDataDirectory = Effect.tryPromise({
  try: () => mkdir(dataDirectory, { recursive: true }),
  catch: (cause) => new Error(`Could not create ${dataDirectory}: ${String(cause)}`),
})
