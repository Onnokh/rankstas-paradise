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
by default), the convention the TUI and Electron client share. Prefer a per-client token from
`POST /api/clients` over the shared `RP_TOKEN` (see [docs/http-api.md](../../docs/http-api.md)).
The file is JSON:

```json
{
  "apiUrl": "https://rp.example.com",
  "token": "your-bearer-token"
}
```

## Settings (⌘,)

Sites on the left; on the right the chosen site's settings (property, origin, sitemap, brand
terms, and the analytics and revenue provider fields) with a Save button, and one row per
vendor key showing where it comes from (`stored ····1234`, `server env`, or `not set`) with a
field to store a new one. "App keys" holds the Ahrefs key. Adding sites, clients, and
removing keys are API-only for now (see [docs/http-api.md](../../docs/http-api.md)).

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
open "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise/Build/Products/Debug/RankstasParadise.app"
```

For representative launch performance, build the optimized configuration:

```sh
xcodebuild -project RankstasParadise.xcodeproj \
  -scheme RankstasParadise \
  -configuration Release \
  -destination 'platform=macOS' \
  -derivedDataPath "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise" \
  build
open "$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise/Build/Products/Release/RankstasParadise.app"
```

Keeping DerivedData outside a Documents-synced checkout also prevents Finder or
file-provider metadata from being attached to generated bundles before signing.

Regenerate the Xcode project after changing `project.yml` with:

```sh
xcodegen generate
```

## Layout

- `Sources/App` — the app entry and its menu bar additions (`ViewCommands`).
- `Sources/Model` — API client, DTOs, cache-first repository, `OverviewModel`, `LiveStore` (live counts and the live feed, polled, never cached). Data only, shared by every tab.
- `Sources/Workspace` — `Workspace` (tabs, active tab, bounded mounted set), per-tab state, `PeekProgress` (0 closed, 1 strip, 2 grid).
- `Sources/Gesture` — three-finger trackpad drag recogniser streaming travel and velocity.
- `Sources/UI` — `RootView`, `TabBar`, `PeekOverlay`, `TabContentStack`, and `PeekLayout`, the pure struct that turns window size plus peek progress into every frame.
- `Sources/UI/Screens` — one screen per tab kind, rendered from tab state so previews match the live screen.

Peek: swipe down with three fingers (or ⌘⇧P) to reveal live previews under the tabs; keep swiping for the grid. Esc or a click closes it. ⌘1…⌘9 select tabs. View > Refresh (⌘R) refreshes the active tab.

Refreshing and loading never blank the screen. Every store keeps what it shows until the server's answer lands, and the overview, history and ranked lists are read from a local cache first, so a warm launch and a refresh only change the numbers, not the layout. The live count is the one exception: it is never cached, because a stale "3 people" would be a lie.

## Judging animation feel

Use a Release build. Debug builds run SwiftUI unoptimised and drop frames during the peek:

```bash
xcodebuild -project RankstasParadise.xcodeproj -scheme RankstasParadise -configuration Release -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/rankstas-paradise-derived build && open /tmp/rankstas-paradise-derived/Build/Products/Release/RankstasParadise.app
```
