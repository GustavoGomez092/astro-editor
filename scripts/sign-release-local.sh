#!/usr/bin/env bash
# Re-signs a draft release with the Developer ID on this Mac, notarises and
# staples it, and replaces its assets. CI builds the universal app (this Mac
# can't), but the Developer ID key lives only in this Mac's login keychain, so
# the signing happens here:
#
#   gh workflow run release.yml --ref main -f tag=v1.0.20-plus.N -f draft=true
#   scripts/sign-release-local.sh v1.0.20-plus.N            # sign and upload
#   scripts/sign-release-local.sh v1.0.20-plus.N --publish  # ...then publish
#
# Notarisation uses a notarytool keychain profile, so no password is ever in
# the environment. The updater tarball is re-made from the stapled app and
# signed again with the updater key, and latest.json points at the new asset.
#
# Apple can take hours over a new team's first submissions. If the wait runs
# out, run it again with APP_SUBMISSION=<the id it printed>: signing the same
# app gives the same code hash, so it waits for that submission's ticket
# instead of sending a new one.
#
# Overrides: SIGNING_IDENTITY, NOTARY_PROFILE, UPDATER_KEY, NOTARY_HOURS
set -euo pipefail

TAG="${1:?usage: scripts/sign-release-local.sh v1.0.20-plus.N [--publish]}"
PUBLISH="${2:-}"
REPO=GustavoGomez092/astro-editor-plus
IDENTITY="${SIGNING_IDENTITY:-Developer ID Application: NEXA SERVICES INC (CJZFKX9W4R)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-jslab-notary}"
NOTARY_HOURS="${NOTARY_HOURS:-12}"
UPDATER_KEY="${UPDATER_KEY:-$HOME/.tauri/astro-editor-plus.key}"

VERSION="${TAG#v}"
APP_NAME="Astro Editor+"
TARBALL="Astro.Editor+_${VERSION}_universal.app.tar.gz"
DMG="Astro.Editor+_${VERSION}_universal.dmg"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-plus\.[0-9]+$ ]]; then
  echo "Tag '$TAG' must look like v1.0.20-plus.1" >&2
  exit 1
fi
if [ "$(gh release view "$TAG" -R "$REPO" --json isDraft -q .isDraft)" != "true" ]; then
  echo "$TAG isn't a draft release. Build it with: gh workflow run release.yml --ref main -f tag=$TAG -f draft=true" >&2
  exit 1
fi
security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\"" || {
  echo "Signing identity not in the keychain: $IDENTITY" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

# Submits a file, or waits for an earlier submission of it (its ID as the
# second argument), and fails unless Apple accepts it, printing Apple's log if not.
# It polls rather than using --wait, so a status request that drops on the
# network is retried instead of ending the run.
notarise() {
  local id="${2:-}" status="" deadline
  if [ -z "$id" ]; then
    id="$(xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --output-format json | jq -r '.id // empty')"
    [ -n "$id" ] || { echo "Apple didn't accept the upload of $(basename "$1")" >&2; exit 1; }
  fi
  echo "Waiting for submission $id"
  deadline=$((SECONDS + NOTARY_HOURS * 3600))
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(xcrun notarytool info "$id" --keychain-profile "$NOTARY_PROFILE" --output-format json 2>/dev/null | jq -r '.status // empty' || true)"
    case "$status" in
      Accepted)
        echo "Notarisation of $(basename "$1"): Accepted ($id)"
        return
        ;;
      Invalid | Rejected)
        echo "Notarisation of $(basename "$1"): $status ($id)" >&2
        xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2 || true
        exit 1
        ;;
    esac
    sleep 60
  done
  echo "Apple hasn't finished after ${NOTARY_HOURS}h. Run again with APP_SUBMISSION=$id (or DMG_SUBMISSION=$id for the DMG) to keep waiting for it." >&2
  exit 1
}

echo "==> Downloading $TAG"
gh release download "$TAG" -R "$REPO" -p "$TARBALL" -p latest.json
mkdir app
tar -xzf "$TARBALL" -C app
app="app/$APP_NAME.app"
main="$app/Contents/MacOS/$(defaults read "$PWD/$app/Contents/Info" CFBundleExecutable)"

echo "==> Signing as $IDENTITY"
# Inside-out: nested code first, deepest first, then the bundle (which signs
# the main executable). Hardened runtime and a secure timestamp are required
# for notarisation; the app needs no entitlements.
find "$app/Contents" -type f \( -perm +111 -o -name '*.dylib' \) ! -path "$main" |
  awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2- |
  while IFS= read -r nested; do
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$nested"
  done
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

echo "==> Notarising the app"
ditto -c -k --keepParent "$app" app.zip
notarise app.zip "${APP_SUBMISSION:-}"
xcrun stapler staple "$app"

echo "==> Updater tarball"
rm "$TARBALL"
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C app "$APP_NAME.app"
(cd "$REPO_DIR" && TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun tauri signer sign \
  -f "$UPDATER_KEY" --app-version "$VERSION" "$work/$TARBALL" >/dev/null)

echo "==> DMG"
mkdir dmg
ditto "$app" "dmg/$APP_NAME.app"
ln -s /Applications dmg/Applications
hdiutil create -volname "$APP_NAME" -srcfolder dmg -ov -format UDZO "$DMG" >/dev/null
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
notarise "$DMG" "${DMG_SUBMISSION:-}"
xcrun stapler staple "$DMG"

echo "==> Gatekeeper"
spctl --assess --type execute --verbose=4 "$app"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
xcrun stapler validate "$DMG"

echo "==> Uploading"
gh release upload "$TAG" -R "$REPO" --clobber "$TARBALL" "$TARBALL.sig" "$DMG"
# Re-uploading gives the tarball a new asset ID, and latest.json links to it by ID
asset_url="$(gh release view "$TAG" -R "$REPO" --json assets -q ".assets[] | select(.name == \"$TARBALL\") | .apiUrl")"
jq --arg sig "$(cat "$TARBALL.sig")" --arg url "$asset_url" \
  '.platforms |= map_values(.signature = $sig | .url = $url)' latest.json >latest.new.json
mv latest.new.json latest.json
gh release upload "$TAG" -R "$REPO" --clobber latest.json
echo "Signed and uploaded $TAG ($asset_url)"

if [ "$PUBLISH" = "--publish" ]; then
  gh release edit "$TAG" -R "$REPO" --draft=false --latest
  echo "Published $TAG"
else
  echo "Still a draft. Publish with: gh release edit $TAG -R $REPO --draft=false --latest"
fi
