#!/bin/sh
# Builds dot(.)music and publishes a GitHub release that installed apps update to automatically.
#
#   scripts/release.sh <notes.md>
#   DRY_RUN=1 scripts/release.sh <notes.md>   # build and write latest.json, publish nothing
#
# Bump "version" in src-tauri/tauri.conf.json and src-tauri/Cargo.toml first and commit it.
# Needs the updater signing key at ~/.tauri/dot-music.key (or TAURI_SIGNING_PRIVATE_KEY) and an
# authenticated `gh`. Uploads the .dmg (first installs), the signed .app.tar.gz (updates) and
# latest.json, which the app checks at releases/latest/download/latest.json.
set -eu

NOTES="${1:?usage: scripts/release.sh <notes.md>}"
REPO="ansh-logics/Dot-Play"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v$VERSION"
BUNDLE="src-tauri/target/release/bundle"
ARCH=aarch64

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "$TAG already exists; bump the version first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain -- src src-tauri)" ]; then
  echo "Commit the app changes before releasing." >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/dot-music.key}"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
npm run tauri build

DMG="$BUNDLE/dmg/dot-music_${VERSION}_${ARCH}.dmg"
UPDATE="$BUNDLE/macos/dot-music_${VERSION}_${ARCH}.app.tar.gz"
cp "$BUNDLE/macos/dot-music.app.tar.gz" "$UPDATE"
cp "$BUNDLE/macos/dot-music.app.tar.gz.sig" "$UPDATE.sig"

LATEST="$BUNDLE/latest.json"
node -e '
  const fs = require("fs");
  const [version, notes, sig, url, out] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({
    version,
    notes: fs.readFileSync(notes, "utf8"),
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": { signature: fs.readFileSync(sig, "utf8").trim(), url } },
  }, null, 2) + "\n");
' "$VERSION" "$NOTES" "$UPDATE.sig" \
  "https://github.com/$REPO/releases/download/$TAG/$(basename "$UPDATE")" "$LATEST"

if [ -n "${DRY_RUN:-}" ]; then
  echo "Dry run: built $DMG, $UPDATE and $LATEST; nothing published."
  exit 0
fi

git push origin HEAD
gh release create "$TAG" "$DMG" "$UPDATE" "$UPDATE.sig" "$LATEST" \
  --repo "$REPO" --target "$(git rev-parse HEAD)" --title "dot(.)music $TAG" --notes-file "$NOTES" --latest
