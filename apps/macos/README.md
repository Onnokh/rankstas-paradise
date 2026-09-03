# Ranksta's Paradise for macOS

A minimal native SwiftUI client proving the macOS technology path against the
existing hosted Ranksta's Paradise API. Its homepage loads every configured site
and shows basic totals from `GET /api/dashboard` in one native table.

After the first successful load, the app keeps a small local snapshot in
Application Support. Later launches render that snapshot immediately and refresh
it in the background, so the full overview is not gated on network latency.

## Configure

The app uses the same configuration convention as the TUI and Electron client:

1. `RP_API_URL` and `RP_TOKEN` from the process environment, or
2. `$XDG_CONFIG_HOME/rankstas-paradise/client.json` (`~/.config` by default).

The config file is JSON:

```json
{
  "apiUrl": "https://rp.example.com",
  "token": "your-bearer-token"
}
```

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
