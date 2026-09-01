# apps/desktop — Electron client

A desktop window over the same data as `bun run seo`. It is a **remote-only**
client, like the TUI: one `GET /api/dashboard?site=<id>` returns the whole
dashboard model, and nothing is recomputed here.

## Running it

```sh
bun run desktop
```

(from the repository root; equal to `bun --cwd apps/desktop run start`, which
builds the bundles and then launches Electron).

If Electron's binary is missing — Bun skips a dependency's install script until
the package is trusted — download it once with:

```sh
node apps/desktop/node_modules/electron/install.js
```

## Its name

`productName` in `package.json` is what Electron reports as `app.getName()`, and
`app.setName()` in `src/main/main.ts` sets the same string for `electron .`,
where the workspace name `@rp/desktop` would otherwise leak into the profile
path. The window title and `index.html` carry it too.

That name also decides the profile directory, so the app now keeps its Chromium
cache in `~/Library/Application Support/Ranksta’s Paradise` instead of
`…/@rp/desktop`. Nothing is lost in the move — the app stores no state of its
own, and every byte it draws is read from the server.

On macOS the menu-bar title comes from the running `.app` bundle, so a `bun run
desktop` session still shows "Electron" there. Only a packaged build carries the
real name into the menu bar, and this app has no packaging step yet.

## Its icon

`assets/icon.png` is the app icon, copied into `dist/` by the build and loaded
from there like every other asset. It is set twice, because the two platforms
disagree: `BrowserWindow({ icon })` is what Windows and Linux read, while macOS
ignores it and takes the icon from the running bundle — so `app.dock.setIcon()`
covers the dev run, which would otherwise show Electron's own icon.

Three things were done to the supplied artwork, and the first two are the ones
that matter:

- **It sits on Apple's icon grid.** A macOS app icon is not meant to fill its
  canvas: on 1024x1024 the rounded square is 824x824 centred, leaving a 100px
  transparent margin. Artwork drawn edge to edge renders about a quarter larger
  than every neighbouring icon in the dock, which is exactly how this one first
  looked.
- **Its corners are transparent.** The source had no alpha channel, so the
  rounded corners were opaque black, and macOS does not mask app icons the way
  iOS does — the dock would have shown a black square around the red squircle.
  The corners are flood-filled from each edge, which removes only the black
  *outside* the artwork and leaves the ninja's black body untouched.
- It is quantised to 128 colours. The source carried 722 KB of anti-aliasing
  noise for what is flat art; this is 49 KB at 0.24% deviation.

A packaged build would take its icon from an `.icns` in the bundle rather than
from either of these calls. There is no packaging step yet, so none is committed.

## Configuration

The app reads the **same client config as the TUI**, in the same order:

1. `RP_API_URL` + `RP_TOKEN` from the environment, otherwise
2. `$XDG_CONFIG_HOME/rankstas-paradise/client.json` (`~/.config/…` by default).

With neither, the window shows the failure and the path it looked at instead of
an empty dashboard.

## The screens

The sidebar is a source list: the wordmark, **Overview**, then every configured
site with its views nested under it. A site's own name IS its Home — clicking it
opens that site's overview — so Home is not repeated as a child row, and the page
it opens is titled with the site's name rather than "Overview", which already
names the cross-site screen.

Every site stays open. There are a handful of them, and collapsing would hide
exactly the counts the list exists to show. The counts beside a view are the size
of the collection it opens; they appear per site as that site's snapshot lands,
which the startup sweep fills in for all of them.

A sync's outcome appears as a pill floating above **Sync**, positioned out of
flow. In flow it changed the footer's height whenever a sync started or ended,
and the whole sidebar jumped with it. It clamps to three lines and carries the
full text in its `title`.

The message is a receipt, not a state. It clears itself after five seconds,
because otherwise the sidebar sat there reading "Refreshing Shadertown on the
server…" from a sweep that had finished at launch — a line that looks live and is
not. A failure sticks and turns red, since the pill is the only place the reason
is shown.

**Sync** at the foot says what it will do. On the cross-site overview no single
site is in view, so it walks every site — sequentially, because the server holds
one sync lock and parallel requests would only 409 against each other. Inside a
site it syncs that site alone.

- **Overview** — the only screen not scoped to a site, and the one the app opens
  on. Every site on its own row, columns aligned: clicks, impressions, CTR and
  average position, each against **that site's own** previous period, plus its
  Ahrefs **DR** (Domain Rating) and its move over the selected range. Then one
  daily impressions-and-clicks chart per site, side by side. Below those, the
  largest signals on any site, ranked by impressions; clicking one opens that
  site's Opportunities view on that exact row.

- **Home** — one site's last 30 days as headline tiles (clicks, impressions,
  CTR, average position), each with its change against the 30 days before it in
  both a count and a percentage, and a chart of daily impressions and clicks.
  Below it, one card per signal kind, the selected kind's detection rule, and
  the reporting window.
- **Opportunities**, **History**, **Registry**, **Log** — a list beside a detail
  panel, the same four collections the terminal dashboard shows.

The title bar carries two different kinds of freshness, because the difference
matters. **Finalized through** is the newest day Google has settled — History can
list days after it, and those are the provisional ones. **Fetched** is
`data.lastCheckedAt` from `/api/status`: when Ranksta last *asked* Google. The
tooltip adds `lastSyncedAt`, when the data last actually *changed*; a check newer
than the last change means the sync ran and Google had nothing new.

Those two fields are typed as optional in `src/main/api.ts`. This checkout's
frozen `StatusReport` predates them — they arrive with the commits on `main` that
this branch has not merged — so the deployed server sends them, an older one
would not, and the line simply omits the fetch time.

### Why the Overview does not add the sites up

It shows no portfolio total, deliberately. These sites differ by three orders of
magnitude — one had 20,922 impressions over a 30-day window while another had 3 —
so a single summed headline would be the largest site wearing a different label.
The small sites would round away, and a real collapse on one of them could hide
inside another's growth. Every number on that page therefore belongs to exactly
one site, and the columns are aligned so the comparison is read down the page
instead of being computed into one figure.

The row of charts follows the same rule: each keeps **its own Y scale**. A shared
one would flatten the small sites onto the axis. The shapes are comparable even
though the heights are not, which is what a row of charts is read for. Each also
covers only the days that site actually has, so a 6-month range can draw 180 days
for one site and 103 for another rather than padding the difference with zeros.

Within a single chart the two series still share one axis — clicks are a subset
of impressions, so a second scale would draw clicks above the impressions they
came from.

The one thing combined across sites is the opportunity **ranking**, which is a
list rather than a total: no site's number is altered by another's presence.

### Domain Rating has no back-history

Ahrefs' free endpoint reports only the present score — there is no historical
series to fetch. So the DR column's move is computed from a series **this app
accumulates**, one reading per calendar day, starting from the first sync that
recorded one. Two consequences worth knowing:

- Every day without a sync is a day of comparison permanently lost. That is why
  readings live in the site's SQLite ledger rather than a cache: this data cannot
  be re-fetched.
- Until the series reaches back past the selected range, the cell reads
  `no history` rather than showing a move. It does not fall back to the oldest
  reading it has, because a "6M change" measured over four days would be a lie.

A range picker (3D / 7D / 30D / 3M / 6M) appears on the Overview, Home and
History. It
sets the span of the daily totals: the headline tiles compare the selected span
with the one before it, the chart covers it, and the History list holds exactly
those days. It does not appear on Opportunities, Registry or Log, because those
collections are classified server-side over a fixed 28-day window and the picker
cannot change them.

The comparison needs two periods, and the dashboard snapshot only carries a fixed
28 days, so it reads `GET /api/history?limit=<span x 2>` separately — one cache
key per span. That read is not awaited before the first paint: until it lands the
overview shows plain totals for the snapshot's own window, and a failure costs the
deltas and nothing else.

Keys carry over from the TUI: `0`–`4` switch view, `←`/`→` cycle, `↑`/`↓` select,
`s` switches site, `r` syncs. `a` returns to the Overview; from there, any key
that addresses a row or a per-site view enters the active site first.

## Layout

| File | Role |
| --- | --- |
| `src/main/config.ts` | Resolves `{ apiUrl, token }` — a Node port of `@rp/api-client/client-config`, which reads through `Bun.file`. |
| `src/main/favicon.ts` | Fetches each site's own favicon and returns it as a `data:` URL. The one place the app talks to a tracked site rather than to the server. |
| `src/main/api.ts` | `fetch` calls to `/api/sites`, `/api/dashboard`, `/api/history`, `/api/jobs*`, including the 409-coalescing sync the TUI does. |
| `src/main/main.ts` | The window and the IPC handlers. The only process with network access. |
| `src/preload/preload.ts` | The calls exposed to the renderer. No `ipcRenderer`, no Node. |
| `src/renderer/main.tsx` | React entry: the `QueryClient` and its defaults. |
| `src/renderer/queries.ts` | Every read as a TanStack Query options object, plus the key factory. |
| `src/renderer/App.tsx` | The shell: which site, which view, which row — the only UI state. |
| `src/renderer/views/SitesOverview.tsx` | The cross-site Overview. Adds no reads — `useQueries` over the per-site keys the sidebar already warms. |
| `src/renderer/views/` | The five per-site screens. |
| `src/renderer/components/` | Cards, tiles, badges, timelines, the sidebar, sparklines. |
| `src/renderer/charts/TrendAreaChart.tsx` | The Recharts area chart (see below). |
| `build.ts` | Bundles all three entry points into `dist/` with `Bun.build`. |

## Data

The renderer is React, and every read goes through
[TanStack Query](https://tanstack.com/query). `queries.ts` holds one options
object per read — the site catalog, a site's dashboard, a site's daily history —
each keyed by what it depends on, so the cache decides when a fetch happens
rather than the components.

Two things follow from that. The sidebar reads all sites' dashboards at once with
`useQueries`, so its counts are per site and every site is warm; and switching to
a site already in the cache paints from it immediately instead of blanking, which
is what removed the layout shift on navigation.

A sync is a `useMutation`. On success it invalidates the two key subtrees it can
change — `["dashboard", siteId]` and `["history", siteId]` — and the open pane
and the sidebar counts refresh themselves. The startup sweep is the same mutation
run once per site.

The cache holds the raw `/api/dashboard` document. The render shape (which turns
`performances` into a lookup) is derived in a `useMemo`, so the cached value stays
a plain object that structural sharing can diff.

## Charts

The Overview and History charts are Recharts' [Simple Area
Chart](https://recharts.github.io/en-US/examples/AreaChartExample/) bound to real
data. Kept from that example: the `responsive` chart at a 1.618 aspect ratio, its
`margin`, a `<linearGradient>` per series with stops at 5% (opacity 0.8) and 95%
(opacity 0), `<CartesianGrid>`, `<XAxis dataKey>`, `<YAxis width="auto">`,
`<Tooltip>`, and `type="monotone"` areas with `fillOpacity={1}`, a matching
`activeDot`, and the 200ms/1300ms entry animation.

Changed for this app: the example's `maxWidth: 700px` becomes a `maxHeight`
(a card here is wider than a docs page, and the aspect ratio alone would make the
chart enormous); its `#8884d8`/`#82ca9d` placeholders become `--chart-1` and
`--chart-2`, so the chart follows the system appearance; axis, grid and tooltip
colours are set, which the example can leave at their light-mode defaults but a
dark window cannot; and gradient ids are per-instance, because the example's
hardcoded `colorUv`/`colorPv` would collide between two charts.

Both series share one Y axis. Clicks are a subset of impressions, so a second
scale would draw clicks above the impressions they came from.

Days Google has not finalized are washed out with a `<ReferenceArea>` in the
card's own background colour, matching the dimmed rows in the History table.

The chart is keyed on its series and point count. Recharts interpolates its entry
animation between the old and new datasets, and interpolating between two
different lengths leaves the area drawn with the *old* number of points — a
180-day series rendered as a handful of segments. Remounting on a shape change
makes it animate from scratch instead.

Registry rows keep hand-drawn sparklines (`components/Sparkline.tsx`): a list
mounts one per row, and a Recharts tree each would cost far more than the line is
worth.

Site favicons follow the same rule as everything else. The CSP is
`default-src 'none'` with no remote origins, so an `<img>` pointing at
`https://sleevy.app/favicon.ico` would simply be blocked — and widening the
policy to allow the tracked sites would hand every string the server sends a way
to reach the network. The main process fetches the icon instead and returns a
`data:` URL, which `img-src` already permits. It reads the page's own
`<link rel="icon">` before falling back to `/favicon.ico`, because many hosts
answer that path with a 200 HTML error page; the response is rejected unless its
content type is an image. A site with no readable icon keeps the plain dot, and
the result — including a failure — is cached for the session.

The renderer is sandboxed (`contextIsolation`, no `nodeIntegration`) and its CSP
allows no remote origins, so every byte it draws arrives over the preload bridge.
Text is set through `textContent` only — a note or a query string can never be
parsed as markup. `style-src` allows `'unsafe-inline'`, which React and Recharts
need for the `style` attributes they set; nothing in this window parses HTML, so
no server string can reach a style attribute.

## Shared wording

Opportunity labels, detection rules, recommended actions, intent names, log-kind
labels and phases all come from `apps/tui/src/presentation.ts`, which was already
written as "shared presentation copy for the interactive frontends". Only the
formatting is local (`src/renderer/format.ts`), because
the TUI's helpers pad to terminal columns and draw series with block glyphs.
