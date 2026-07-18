import { AsyncLocalStorage } from "node:async_hooks"

import { Effect } from "effect"

import { dataDirectory, debugMode, loadConfig } from "./config.ts"

export type Site = {
  readonly id: string
  readonly name: string
  readonly property: string
  readonly origin: string
  readonly sitemapUrl: string
  readonly brandTerms: readonly string[]
}

type ConfigSite = {
  readonly id: string
  readonly name?: string
  readonly siteUrl: string
  readonly origin?: string
  readonly sitemapUrl?: string
  readonly brandTerms?: readonly string[]
}

const siteStorage = new AsyncLocalStorage<Site>()
const defaultSiteId = "sleevy"

const originFor = (siteUrl: string, explicitOrigin?: string) => explicitOrigin ?? (
  siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice("sc-domain:".length)}` : siteUrl
)

const normalize = (site: ConfigSite): Site => {
  const origin = originFor(site.siteUrl, site.origin)
  const hostname = new URL(origin).hostname
  return {
    id: site.id,
    name: site.name ?? site.id,
    property: site.siteUrl,
    origin: origin.replace(/\/$/, ""),
    sitemapUrl: site.sitemapUrl ?? `https://${hostname}/sitemap.xml`,
    brandTerms: site.brandTerms ?? [site.id],
  }
}

export const loadSites = async (): Promise<readonly Site[]> => {
  try {
    const config = await Effect.runPromise(loadConfig)
    const configured = (config.sites ?? []).map((site) => normalize(site))
    if (configured.length > 0) return configured
    return [normalize({ id: defaultSiteId, name: "Sleevy", siteUrl: config.siteUrl, brandTerms: ["sleevy"] })]
  } catch (cause) {
    throw new Error(`Could not load site catalog: ${String(cause)}`)
  }
}

export const siteFor = async (siteId = currentSiteId()): Promise<Site> => {
  const sites = await loadSites()
  const site = sites.find((candidate) => candidate.id === siteId)
  if (!site) throw new Error(`Unknown site "${siteId}". Available sites: ${sites.map((candidate) => candidate.id).join(", ")}`)
  return site
}

export const currentSiteId = () => siteStorage.getStore()?.id ?? defaultSiteId
export const withSite = <T>(site: Site | string, work: () => T): T => {
  const value = typeof site === "string"
    ? { id: site, name: site, property: site, origin: site === defaultSiteId ? "https://sleevy.app" : `https://${site}`, sitemapUrl: "", brandTerms: [site] }
    : site
  return siteStorage.run(value, work)
}
export const currentSiteOrigin = () => siteStorage.getStore()?.origin ?? "https://sleevy.app"
export const currentBrandTerms = () => siteStorage.getStore()?.brandTerms ?? ["sleevy"]

export const siteDataDirectory = (siteId = currentSiteId()) => {
  if (siteId === defaultSiteId) return dataDirectory
  return `${dataDirectory}/sites/${siteId}`
}

export const siteDatabasePath = (siteId = currentSiteId()) => `${siteDataDirectory(siteId)}/search-console${debugMode ? ".debug" : ""}.sqlite`
export const siteRegistryPath = (siteId = currentSiteId()) => siteId === defaultSiteId && !debugMode
  ? `${import.meta.dir}/../keyword-registry.csv`
  : `${siteDataDirectory(siteId)}/keyword-registry.csv`
export const siteSitemapPath = (siteId = currentSiteId()) => `${siteDataDirectory(siteId)}/sitemap.json`
