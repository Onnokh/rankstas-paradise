import { Effect } from "effect"

export type SeoConfig = {
  readonly googleClientId: string
  readonly googleClientSecret: string
  readonly siteUrl: string
}

const configPath = `${import.meta.dir}/../config.json`
export const dataDirectory = `${import.meta.dir}/../data`
export const tokenPath = `${dataDirectory}/google-token.json`
export const debugMode = Bun.argv.includes("--debug")
export const databasePath = `${dataDirectory}/search-console${debugMode ? ".debug" : ""}.sqlite`

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
  try: () => Bun.write(`${dataDirectory}/.gitkeep`, ""),
  catch: (cause) => new Error(`Could not create ${dataDirectory}: ${String(cause)}`),
})
