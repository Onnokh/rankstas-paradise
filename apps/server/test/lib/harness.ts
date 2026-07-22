// Test harness for the golden/snapshot suite. Boots a Ranksta's Paradise HTTP
// server as a subprocess against a deterministic debug fixture, and exposes
// request + normalization helpers.
//
// PARAMETERIZABLE by design: the server entry path, port, bearer token, and
// data home are all inputs. Today the suite points at the legacy src/server.ts
// (via RP_GOLDEN_SERVER_ENTRY or the default below); PLO-275/276 repoint it at
// the new apps/server entry by setting RP_GOLDEN_SERVER_ENTRY — no snapshot
// changes if behaviour is preserved.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// apps/server/test/lib -> repo root is four levels up.
export const repoRoot = resolve(import.meta.dir, "../../../..")

// Resolving the server entry:
//
// The legacy server in src/ is written for Effect v3 (it uses Effect.catchAll
// and other v3 APIs that were removed in the v4-beta the workspace pins). Since
// module resolution for src/*.ts picks the workspace-root `effect` (v4), the
// legacy server cannot boot under the pinned deps. To capture a faithful
// baseline we run it in an isolated temp workspace pinned to Effect v3 (a copy
// of src/ + its own node_modules). The install is offline (bun cache).
//
// PLO-275/276 repoint the suite at the new v4 server by setting
// RP_GOLDEN_SERVER_ENTRY — the isolated-baseline path is then skipped entirely.
let baselineEntry: string | undefined

export const resolveServerEntry = (): string => {
  if (Bun.env.RP_GOLDEN_SERVER_ENTRY) return Bun.env.RP_GOLDEN_SERVER_ENTRY
  if (baselineEntry) return baselineEntry
  const base = mkdtempSync(join(tmpdir(), "rp-baseline-"))
  cpSync(join(repoRoot, "src"), join(base, "src"), { recursive: true })
  const pkg = {
    name: "rp-baseline",
    private: true,
    type: "module",
    // Effect pinned to the version the legacy code was written against.
    dependencies: {
      effect: "3.22.0",
      "@modelcontextprotocol/sdk": "^1.29.0",
      "@opentui/core": "latest",
      zod: "^4.4.3",
    },
  }
  writeFileSync(join(base, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
  const install = Bun.spawnSync(["bun", "install", "--no-save"], { cwd: base })
  if (install.exitCode !== 0) {
    throw new Error(
      `Failed to install the Effect v3 baseline: ${install.stderr.toString()}`,
    )
  }
  baselineEntry = join(base, "src/server.ts")
  return baselineEntry
}

// The deterministic fixture site. Its origin matches the debug data in
// src/debug.ts (pages under https://sleevy.app/...).
export const FIXTURE_SITE_ID = "sleevy"
export const FIXTURE_TOKEN = "test-token"

export interface RunningServer {
  readonly baseUrl: string
  readonly port: number
  readonly token: string
  readonly stop: () => void
}

// Write a config.json + sites catalog into a fresh XDG data home and return it.
export const makeFixtureHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "rp-golden-"))
  const appHome = join(home, "rankstas-paradise")
  mkdirSync(appHome, { recursive: true })
  const config = {
    siteUrl: "https://sleevy.app",
    sites: [
      {
        id: FIXTURE_SITE_ID,
        name: "Sleevy",
        siteUrl: "https://sleevy.app",
        origin: "https://sleevy.app",
        sitemapUrl: "https://sleevy.app/sitemap.xml",
        brandTerms: ["sleevy"],
      },
    ],
  }
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`)
  return home
}

// Bind an ephemeral port, then release it so the server can claim it.
export const freePort = async (): Promise<number> => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = server.port ?? 0
  await server.stop(true)
  return port
}

export interface StartServerOptions {
  readonly entry?: string
  readonly port?: number
  readonly configHome?: string
  readonly token?: string | null
  readonly debug?: boolean
}

// Boot the server as a subprocess and wait until it accepts connections.
export const startServer = async (
  options: StartServerOptions = {},
): Promise<RunningServer> => {
  const entry = options.entry ?? resolveServerEntry()
  const port = options.port ?? (await freePort())
  const token = options.token === undefined ? FIXTURE_TOKEN : options.token
  const configHome = options.configHome ?? makeFixtureHome()
  const debug = options.debug ?? true

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: configHome,
    SEO_PORT: String(port),
    GOOGLE_CLIENT_ID: "dummy-client-id",
    GOOGLE_CLIENT_SECRET: "dummy-client-secret",
  }
  if (token === null) delete env.RP_TOKEN
  else env.RP_TOKEN = token

  const args = ["run", entry, ...(debug ? ["--debug"] : [])]
  const proc = Bun.spawn(["bun", ...args], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error(`Server did not start within 15s (entry: ${entry})`)
    }
    try {
      // Any HTTP response (even 401/503) means the server is listening.
      await fetch(`${baseUrl}/sites.txt`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
      break
    } catch {
      await Bun.sleep(150)
    }
  }

  return {
    baseUrl,
    port,
    token: token ?? "",
    stop: () => proc.kill(),
  }
}

export interface RequestOptions {
  readonly method?: string
  readonly token?: string | null
  readonly body?: unknown
}

// Perform a request; returns the status and parsed JSON body.
export const requestJson = async (
  server: RunningServer,
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: unknown }> => {
  const token = options.token === undefined ? server.token : options.token
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (options.body !== undefined) headers["content-type"] = "application/json"
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

// Perform a request; returns the status and raw text body.
export const requestText = async (
  server: RunningServer,
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; body: string }> => {
  const token = options.token === undefined ? server.token : options.token
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
  })
  return { status: response.status, body: await response.text() }
}

// Replace non-deterministic timestamp fields (and the sole job id) with stable
// placeholders so snapshots are comparable across runs.
const timestampKeys = new Set(["generatedAt", "startedAt", "finishedAt"])
export const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = timestampKeys.has(key) ? "<normalized>" : normalize(entry)
    }
    return out
  }
  return value
}

// Poll GET /api/jobs until the given job id leaves the "running" state.
export const waitForJob = async (
  server: RunningServer,
  jobId: number,
): Promise<void> => {
  const deadline = Date.now() + 20_000
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Job ${jobId} did not finish in 20s`)
    const { body } = await requestJson(server, "/api/jobs")
    const jobs = (body as { jobs?: ReadonlyArray<{ id: number; status: string }> }).jobs ?? []
    const job = jobs.find((candidate) => candidate.id === jobId)
    if (job && job.status !== "running") {
      if (job.status === "failed") throw new Error(`Seed job ${jobId} failed`)
      return
    }
    await Bun.sleep(150)
  }
}
