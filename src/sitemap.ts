import { Effect } from "effect"

import { dataDirectory, ensureDataDirectory, loadConfig } from "./config.ts"
import type { RegistryEntry } from "./registry.ts"

export type SitemapPage = {
  readonly url: string
  readonly path: string
  readonly lastModified: string | null
}

const cachePath = `${dataDirectory}/sitemap.json`
const tagValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1] ?? null

const parseSitemap = (xml: string): SitemapPage[] => [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].flatMap((match) => {
  const url = tagValue(match[1] ?? "", "loc")
  if (!url) return []
  return [{ url, path: new URL(url).pathname, lastModified: tagValue(match[1] ?? "", "lastmod") }]
})

export const refreshSitemapPages = Effect.gen(function* () {
  const config = yield* loadConfig
  yield* ensureDataDirectory
  const hostname = config.siteUrl.startsWith("sc-domain:")
    ? config.siteUrl.slice("sc-domain:".length)
    : new URL(config.siteUrl).hostname
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(`https://${hostname}/sitemap.xml`, { signal }),
    catch: (cause) => new Error(`Could not fetch the sitemap: ${String(cause)}`),
  })
  if (!response.ok) return yield* Effect.fail(new Error(`Sitemap request failed with HTTP ${response.status}.`))
  const xml = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new Error(`Could not read the sitemap: ${String(cause)}`),
  })
  const pages = parseSitemap(xml)
  yield* Effect.tryPromise({
    try: () => Bun.write(cachePath, `${JSON.stringify(pages, null, 2)}\n`),
    catch: (cause) => new Error(`Could not cache the sitemap: ${String(cause)}`),
  })
  return pages
})

export const loadCachedSitemapPages = async (): Promise<readonly SitemapPage[]> => {
  if (!await Bun.file(cachePath).exists()) return []
  try {
    return JSON.parse(await Bun.file(cachePath).text()) as SitemapPage[]
  } catch {
    return []
  }
}

export const unmappedSitemapPages = (pages: readonly SitemapPage[], registry: readonly RegistryEntry[]) => {
  const targets = new Set(registry.map((entry) => entry.targetUrl))
  return pages.filter((page) => !targets.has(page.path))
}
