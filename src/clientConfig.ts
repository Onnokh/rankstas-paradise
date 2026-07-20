// Client-side config for tools that talk to a REMOTE Ranksta's Paradise: the
// TUI in HTTP-client mode and the CLI in remote mode. This is the small half
// of the config split (see ADR 0001) — apps and agents need only
// { apiUrl, token }; the Google credentials never leave the server.
import { homedir } from "node:os"

export type ClientConfig = {
  readonly apiUrl: string
  readonly token: string
}

// Same app-home convention as config.ts, so a machine's server config and
// client config sit side by side under one directory.
const configHome = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`
export const clientConfigPath = `${configHome}/rankstas-paradise/client.json`

// Env wins over the file, so a run can point at any deployment without
// rewriting client.json.
const fromEnv = (): ClientConfig | null => {
  const apiUrl = Bun.env.RP_API_URL
  const token = Bun.env.RP_TOKEN
  return apiUrl && token ? { apiUrl, token } : null
}

export const loadClientConfig = async (): Promise<ClientConfig> => {
  const env = fromEnv()
  if (env) return env
  const file = Bun.file(clientConfigPath)
  if (await file.exists()) {
    const config = JSON.parse(await file.text()) as Partial<ClientConfig>
    if (config.apiUrl && config.token) return { apiUrl: config.apiUrl, token: config.token }
  }
  throw new Error("No client config found: run `rp init` or set RP_API_URL and RP_TOKEN.")
}

// Bun.write creates parent directories, so no explicit mkdir is needed.
export const saveClientConfig = async (config: ClientConfig): Promise<void> => {
  await Bun.write(clientConfigPath, JSON.stringify(config, null, 2))
}

// True when a remote target is configured either way, so callers can pick
// direct-vs-remote without catching a throw from loadClientConfig.
export const isRemoteMode = async (): Promise<boolean> =>
  fromEnv() !== null || await Bun.file(clientConfigPath).exists()

export type Mode = "local" | "remote"

// The effective data source for the TUI and CLI. An explicit flag wins:
// `--local` forces direct SQLite/CSV, `--network` (or `--remote`) forces the
// HTTP client. With no flag, a configured client (env or client.json) means
// remote, otherwise local — so a plain `bun run seo` keeps working offline.
export const resolveMode = async (): Promise<Mode> => {
  if (Bun.argv.includes("--local")) return "local"
  if (Bun.argv.includes("--network") || Bun.argv.includes("--remote")) return "remote"
  return (await isRemoteMode()) ? "remote" : "local"
}
