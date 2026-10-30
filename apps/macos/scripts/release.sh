#!/bin/sh
# Builds build/RankstasParadise-<version>.dmg: signed with Developer ID and notarized, so it opens without a Gatekeeper
# warning on any Mac. scripts/publish.sh puts it on GitHub Releases, where the Homebrew cask downloads it.
#
# Needs:
# - A "Developer ID Application" certificate of the personal team (5Q5AZ5596L) in the keychain.
# - The asc CLI with an App Store Connect API key of that team. RP_ASC_PROFILE selects the asc profile
#   (default: personal).
set -eu
cd "$(dirname "$0")/.."

team=5Q5AZ5596L
profile="${RP_ASC_PROFILE:-personal}"
identity=$(security find-identity -v -p codesigning | sed -n "s/.*\"\(Developer ID Application: .*($team)\)\".*/\1/p" | head -1)
[ -n "$identity" ] || { echo "No Developer ID Application certificate for team $team in the keychain." >&2; exit 1; }

# Notarization refuses a bundle without the hardened runtime and a secure timestamp, or with the get-task-allow
# entitlement that Xcode adds to a plain build for the debugger. A DerivedData of its own keeps the ad-hoc signed
# local builds (README.md) apart from the release.
derived="$HOME/Library/Developer/Xcode/DerivedData/RankstasParadise-Release"
xcodebuild -quiet -project RankstasParadise.xcodeproj -scheme RankstasParadise -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath "$derived" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="$identity" DEVELOPMENT_TEAM="$team" \
  ENABLE_HARDENED_RUNTIME=YES OTHER_CODE_SIGN_FLAGS=--timestamp CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
  build
app="$derived/Build/Products/Release/Ranksta's Paradise.app"
codesign --verify --deep --strict "$app"

version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$app/Contents/Info.plist")
# The file name leaves out the apostrophe and the space: it ends up in a download URL.
dmg="build/RankstasParadise-$version.dmg"
mkdir -p build
# The disk image shows the app and a link to Applications, to drag it into.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Ranksta's Paradise.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -ov -volname "Ranksta's Paradise" -srcfolder "$stage" -format UDZO "$dmg"
codesign -s "$identity" --timestamp "$dmg"

# Read the status: a rejected image is a completed submission, not an error.
result=$(asc --profile "$profile" notarization submit --file "$dmg" --wait)
echo "$result"
echo "$result" | grep -Eq '"status": ?"Accepted"' \
  || { echo "Notarization failed. See: asc --profile $profile notarization log --id <id>" >&2; exit 1; }
xcrun stapler staple -q "$dmg"
spctl -a -t open --context context:primary-signature "$dmg"
echo "released $dmg ($(du -h "$dmg" | cut -f1))"
