// Remote target resolution for the desktop client. Deliberately a plain Node
// port of `@rp/api-client/client-config` rather than a reuse of it: that module
// reads the file through `Bun.file`, and the Electron main process runs on Node.
// The convention it implements is identical, so the desktop app reads the SAME
// config as the TUI — env first (RP_API_URL + RP_TOKEN), then
// `$XDG_CONFIG_HOME/rankstas-paradise/client.json`.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"

export interface RemoteTarget {
  readonly apiUrl: string
  readonly token: string
}

const configHome = process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`

export const clientConfigPath = `${configHome}/rankstas-paradise/client.json`

// Raised when no remote target is configured either way. The window shows this
// message instead of a blank dashboard, so a missing config fails loudly — the
// same contract the TUI has on its first API call.
export class ConfigError extends Error {
  readonly kind = "ConfigError"
}

const fromFile = async (): Promise<RemoteTarget | undefined> => {
  let text: string
  try {
    text = await readFile(clientConfigPath, "utf8")
  } catch {
    return undefined
  }
  let parsed: Partial<{ apiUrl: string; token: string }>
  try {
    parsed = JSON.parse(text) as Partial<{ apiUrl: string; token: string }>
  } catch (cause) {
    throw new ConfigError(`The client config at ${clientConfigPath} is not valid JSON.`, { cause })
  }
  if (typeof parsed.apiUrl !== "string" || typeof parsed.token !== "string") return undefined
  return { apiUrl: parsed.apiUrl, token: parsed.token }
}

export const resolveTarget = async (): Promise<RemoteTarget> => {
  const apiUrl = process.env.RP_API_URL
  const token = process.env.RP_TOKEN
  if (apiUrl && token) return { apiUrl, token }
  const file = await fromFile()
  if (file) return file
  throw new ConfigError(
    `No client config found. Set RP_API_URL and RP_TOKEN, or write ${clientConfigPath}.`,
  )
}
