# Ranksta's Paradise for macOS

A minimal native SwiftUI client proving the macOS technology path against the
existing hosted Ranksta's Paradise API. Its homepage loads every configured site
and shows basic totals from `GET /api/dashboard` in one native table.

After the first successful load, the app keeps a small local snapshot in
Application Support. Later launches render that snapshot immediately and refresh
it in the background, so the full overview is not gated on network latency.

## Configure

The app resolves the server and its bearer token from `RP_API_URL` and `RP_TOKEN` in the
process environment, else from `$XDG_CONFIG_HOME/rankstas-paradise/client.json` (`~/.config`
by default), the same convention the TUI uses. Prefer a per-client token from
`POST /api/clients` over the shared `RP_TOKEN` (see [docs/http-api.md](../../docs/http-api.md)).
The file is JSON:

```json
{
  "apiUrl": "https://rp.example.com",
  "token": "your-bearer-token"
}
```

## Settings (⌘,)

One window without a title bar, two columns. Down the left, under a search field, the pages
stand in three groups: **Account** is the server this Mac is signed in to (its address,
whether a token is set, and where both were read from); **Sites** is one page per site,
each with its favicon; **Vendors** holds *Keys*, the two account-wide vendor keys, Ahrefs
and DataForSEO — the vendors no Site setting names, because each is one account serving
every Site. A site's page shows its settings as rows — property, origin, sitemap, brand
terms, and the analytics and revenue provider fields — with the words on the left and the
field on the right, then one row per vendor key saying where it comes from (stored, the
server's environment, or not set) with a field to store a new one. Edits go to the server
with the Save button in the page's header, or Enter. The search narrows the pages and the
rows on the open page. Adding sites, clients, and removing keys are API-only for now (see
[docs/http-api.md](../../docs/http-api.md)).

## Run

Open `RankstasParadise.xcodeproj` in Xcode and run the
`RankstasParadise` scheme, or build it from the command line:

```sh
cd apps/macos
xcodebuild -project RankstasParadise.xcodeproj \
  -scheme RankstasParadise \
  -destination 'platform=macOS' \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise" \
  build
open "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise/Build/Products/Debug/Ranksta's Paradise.app"
```

For representative launch performance, build the optimized configuration:

```sh
xcodebuild -project RankstasParadise.xcodeproj \
  -scheme RankstasParadise \
  -configuration Release \
  -destination 'platform=macOS' \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise" \
  build
open "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise/Build/Products/Release/Ranksta's Paradise.app"
```

The product is `Ranksta's Paradise.app`: the bundle, the menu bar and the Dock carry the
real name, and only the module keeps the identifier `RankstasParadise` so `import
RankstasParadise` in the tests stays valid (see `project.yml`). Quote the path — it holds an
apostrophe and a space.

Keeping DerivedData outside a Documents-synced checkout also prevents Finder or
file-provider metadata from being attached to generated bundles before signing.

Regenerate the Xcode project after changing `project.yml` with:

```sh
xcodegen generate
```

## Install

To keep the app around — in the Dock, in Spotlight — build the Release configuration above and
copy the product into `/Applications`. `ditto` rather than `cp`, so the bundle's signature and
extended attributes survive the copy:

```sh
ditto "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise/Build/Products/Release/Ranksta's Paradise.app" \
  "/Applications/Ranksta's Paradise.app"
open -a "/Applications/Ranksta's Paradise.app"
```

The bundle is ad-hoc signed and names no development team, which is all a local install needs:
`codesign --verify --deep --strict` passes, and a bundle that was never downloaded carries no
quarantine flag for Gatekeeper to act on. It would not open on another Mac, though — that needs
a Developer ID signature and notarisation.

A copy already in `/Applications` is replaced by the same command, so quit the running app
first. Its data lives in `~/Library/Application Support/com.rankstasparadise.mac`, outside the
bundle, and a replacement leaves it alone.

## Layout

- `Sources/App` — the app entry and its menu bar additions (`ViewCommands`).
- `Sources/Model` — API client, DTOs, cache-first repository, `OverviewModel`, `OverviewGlance` and `ProjectTrajectory` (the Overview's per-site arithmetic: the strip's totals, and each project's period against the period before), `LiveStore` (live counts and the live feed, polled, never cached). Data only, shared by every tab.
- `Sources/Workspace` — `Workspace` (the site tabs, the pane in front, bounded mounted set), per-tab state, `PeekProgress` (0 closed, 1 strip, 2 grid).
- `Sources/Gesture` — three-finger trackpad drag recogniser streaming travel and velocity.
- `Sources/UI` — `RootView`, `TabBar`, `PeekOverlay`, `TabContentStack`, `ScreenRail`, and `PeekLayout`, the pure struct that turns window size plus peek progress into every frame.
- `Sources/UI/Screens` — one screen per pane kind, rendered from its state. A site's peek preview always shows its dashboard.
  Only the sites are tabs. The Overview and the Realtime are the two screens every server has, reached from the
  rail and never from the tab bar, so no tab is active while one of them is in front. The Overview is the projects compared: the strip sums the
  sites over a chosen period, and under it one card per project says how it does — the site in a zone of its own
  with what it sold, then Search, Visitors and Plan, each the period against the period before as a percentage
  with a word (Growing, Flat, Slipping at ten percent either way) and as two runs on one small chart, the period
  in the source's colour over the period before in grey. Read from what is stored and never polled. The Realtime is the sites watched: who is on each site now,
  the last half hour by the minute, today so far, and the feed of what visitors are doing — the one screen that polls.
  The rail stands beside every pane: the app icon at the top, the Overview and the Realtime right under it so
  they can be reached from anywhere, a site's own screens centred below, and a stand-in account icon at the bottom.
  A site tab has four screens, peers chosen from the rail beside the pane: Dashboard, the period's Search
  Console figures and chart with the provider's cards under them — realtime, visits, revenue, the period's
  events, and where its visits came from as two cards, referrers and channels beside the UTM tags, each row
  a count over a bar with its move against the period before; Registry, which lists
  every target page with its window, phase and keywords; Planning, which judges the plan's keywords on
  demand; and Log, the site's work record as a timeline of days. Pages Google reports as not indexed are
  dimmed in the Registry and in the ranking card. One header row — favicon, name, origin, people online, the
  period on the dashboard, refresh — is pinned above all four.

Peek: swipe down with three fingers (or ⌘⇧P) to reveal live previews under the tabs; keep swiping for the grid. Esc or a click closes it. ⌘1…⌘9 select tabs (⌘1 is the first site); ⌘← and ⌘→ step between them. ⌘⇧O opens the Overview and ⌘⇧R the Realtime. ⌘⌥1…⌘⌥4 choose a site's screen in the rail's order. View > Refresh (⌘R) refreshes the pane in front.

Refreshing and loading never blank the screen. Every store keeps what it shows until the server's answer lands, and the overview, history, ranked lists and work record are read from a local cache first, so a warm launch and a refresh only change the numbers, not the layout. The live count and the feed are the one exception: they are never cached, because a stale "3 people" would be a lie, and only the Realtime and a site's dashboard read them.

## Judging animation feel

Use a Release build. Debug builds run SwiftUI unoptimised and drop frames during the peek:

```bash
xcodebuild -project RankstasParadise.xcodeproj -scheme RankstasParadise -configuration Release -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/rankstas-paradise-derived build && open "/tmp/rankstas-paradise-derived/Build/Products/Release/Ranksta's Paradise.app"
```
