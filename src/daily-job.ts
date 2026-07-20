import { syncSearchConsole } from "./automation.ts"
import { loadSites, withSite } from "./site.ts"

// Sync every configured site, not just the default. One site's failure (e.g. a
// Search Console timeout) must not block the others, so we log and continue,
// then exit non-zero if any site failed.
let failed = false
for (const site of await loadSites()) {
  try {
    console.log(`[${site.id}] ${await withSite(site, () => syncSearchConsole())}`)
  } catch (cause) {
    failed = true
    console.error(`[${site.id}]`, cause)
  }
}
if (failed) process.exit(1)
