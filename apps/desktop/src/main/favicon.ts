// Site favicons, fetched here rather than in the renderer.
//
// The renderer's CSP is `default-src 'none'` with no remote origins, so an
// `<img src="https://sleevy.app/favicon.ico">` would simply be blocked — and
// relaxing the policy to allow the tracked sites would give every string the
// server sends a way to reach the network. Instead the main process, which
// already owns all network access, fetches the icon and hands back a `data:`
// URL, which `img-src` already permits.
//
// This is the one place the app talks to a site instead of to the Ranksta's
// Paradise server. It is a read of a public asset with no credentials attached.

// Favicons do not change while the window is open, and a failure is worth
// remembering too — otherwise every repaint retries a site that has no icon.
const cache = new Map<string, string | null>()

// Enough for an icon, small enough that a misconfigured host cannot stream the
// window out of memory. Icons are single-digit KB; 512 KB is pure headroom.
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 5000

const withinLimit = (response: Response): boolean => {
  const declared = Number(response.headers.get("content-length"))
  return !Number.isFinite(declared) || declared <= MAX_BYTES
}

const get = (url: string): Promise<Response> =>
  fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
    // A site may vary its markup by client; ask as a browser would so the
    // returned <head> is the one a browser would see.
    headers: { accept: "text/html,image/*,*/*" },
  })

const attribute = (tag: string, name: string): string | undefined => {
  const found = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return found ? (found[2] ?? found[3] ?? found[4]) : undefined
}

// The icons a page declares, in the order it declares them. A site's own
// <link rel="icon"> is a better answer than guessing at /favicon.ico, which many
// hosts answer with a 200 HTML error page.
const declaredIcons = (html: string, base: string): readonly string[] => {
  const icons: string[] = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, "rel")?.toLowerCase()
    const href = attribute(tag, "href")
    if (!rel || !href || !rel.split(/\s+/).includes("icon")) {
      // `apple-touch-icon` is not a plain "icon" rel but is a reliable, usually
      // higher-resolution fallback when a site declares nothing else.
      if (!rel?.includes("apple-touch-icon") || !href) continue
    }
    try {
      icons.push(new URL(href, base).toString())
    } catch {
      // A malformed href is skipped rather than failing the whole lookup.
    }
  }
  return icons
}

const asDataUrl = async (url: string): Promise<string | null> => {
  let response: Response
  try {
    response = await get(url)
  } catch {
    return null
  }
  if (!response.ok || !withinLimit(response)) return null

  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  // Hosts commonly answer a missing /favicon.ico with a 200 HTML error page, so
  // the content type is checked rather than the status alone.
  if (!type?.startsWith("image/")) return null

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`
}

// The site's icon as a `data:` URL, or null when it has none that can be read.
// Never throws: a missing icon is a cosmetic absence, and the sidebar falls back
// to its dot.
export const favicon = async (origin: string): Promise<string | null> => {
  const cached = cache.get(origin)
  if (cached !== undefined) return cached

  let base: URL
  try {
    base = new URL(origin)
  } catch {
    return null
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null

  let candidates: readonly string[] = []
  try {
    const page = await get(base.toString())
    if (page.ok && withinLimit(page)) {
      // Only the <head> can carry the icon links, so the body is not scanned.
      const html = (await page.text()).slice(0, MAX_BYTES)
      candidates = declaredIcons(html.split(/<\/head>/i)[0] ?? html, base.toString())
    }
  } catch {
    // An unreachable page still leaves the conventional path worth trying.
  }

  let resolved: string | null = null
  for (const candidate of [...candidates, new URL("/favicon.ico", base).toString()]) {
    resolved = await asDataUrl(candidate)
    if (resolved) break
  }
  cache.set(origin, resolved)
  return resolved
}
