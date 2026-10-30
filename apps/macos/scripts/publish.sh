#!/bin/sh
# Publishes the newest notarized DMG of scripts/release.sh as the GitHub release macos-v<version>, at the commit this
# checkout is on. The Homebrew cask downloads it from there; its sha256 is the last line of the output.
set -eu
cd "$(dirname "$0")/.."
dmg=$(ls -t build/RankstasParadise-*.dmg | head -1)
xcrun stapler validate "$dmg"
version=${dmg#build/RankstasParadise-}
version=${version%.dmg}
gh release create "macos-v$version" "$dmg" --target "$(git rev-parse HEAD)" \
  --title "Ranksta's Paradise for macOS $version" \
  --notes "Signed with Developer ID and notarized. Install it with Homebrew, or open the DMG and drag the app to Applications."
shasum -a 256 "$dmg"
