#!/bin/sh
# Installs dot(.)music on a Mac:
#
#   curl -fsSL https://dot-music.anshbhatt.space/install.sh | sh
#
# It reads the same update file the app's own updater uses (the latest GitHub release),
# downloads the app, checks its signature is intact, puts it in Applications (replacing an
# older copy) and opens it. Apps downloaded this way aren't flagged by macOS as "from the
# internet", so there's no "can't be opened" prompt. Nothing else on your Mac is touched.
#
# Options (environment variables):
#   DOT_INSTALL_DIR=~/Applications   install somewhere else
#   DOT_INSTALL_DRY_RUN=1            download and check only; install nothing
#
# Source: https://github.com/ansh-logics/Dot-Play/blob/main/site/public/install.sh

# Everything runs from main() at the very end, so a download cut off halfway through runs nothing.
set -eu

REPO="ansh-logics/Dot-Play"
LATEST_URL="https://github.com/$REPO/releases/latest/download/latest.json"
APP_NAME="dot-music.app"

say() { printf '%s\n' "$*"; }
step() { printf '\033[1;31m●\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

check_mac() {
  [ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows, download the installer from https://dot-music.anshbhatt.space"
  # Apple silicon only for now; under Rosetta, uname reports x86_64, so ask the hardware.
  if [ "$(uname -m)" != "arm64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != "1" ]; then
    fail "dot(.)music needs a Mac with Apple silicon (M1 or later) for now."
  fi
  major=$(sw_vers -productVersion | cut -d. -f1)
  [ "$major" -ge 13 ] 2>/dev/null || fail "dot(.)music needs macOS 13 Ventura or newer (this Mac has $(sw_vers -productVersion))."
}

install_dir() {
  if [ -n "${DOT_INSTALL_DIR:-}" ]; then
    printf '%s' "$DOT_INSTALL_DIR"
  elif [ -w /Applications ]; then
    printf '%s' /Applications
  else
    # A standard Mac account without admin rights: the per-user Applications folder.
    printf '%s' "$HOME/Applications"
  fi
}

main() {
  check_mac

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/dot-music-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  trap 'rm -rf "$tmp"; exit 130' INT TERM

  step "Finding the latest version"
  curl -fsSL --retry 3 "$LATEST_URL" -o "$tmp/latest.json" || fail "Couldn't reach GitHub. Check your internet connection."
  version=$(plutil -extract version raw -o - "$tmp/latest.json" 2>/dev/null) || fail "The release information couldn't be read."
  url=$(plutil -extract platforms.darwin-aarch64.url raw -o - "$tmp/latest.json" 2>/dev/null) || fail "No Mac download in the latest release."
  case "$url" in
    # curl would resolve "../" segments, which could step out of this repo's releases.
    *..*) fail "Unexpected download address: $url" ;;
    "https://github.com/$REPO/releases/download/"*) ;;
    *) fail "Unexpected download address: $url" ;;
  esac

  step "Downloading dot(.)music $version"
  curl -fL --retry 3 --progress-bar "$url" -o "$tmp/app.tar.gz" || fail "The download didn't finish. Please try again."
  tar -xzf "$tmp/app.tar.gz" -C "$tmp" || fail "The download looks damaged. Please try again."
  [ -d "$tmp/$APP_NAME" ] || fail "The download didn't contain $APP_NAME."

  # Every file in the app is covered by its code signature: a damaged or altered download fails here.
  step "Checking the app"
  codesign --verify --deep --strict "$tmp/$APP_NAME" 2>/dev/null || fail "The app's signature check failed, so it wasn't installed."

  dir=$(install_dir)
  if [ -n "${DOT_INSTALL_DRY_RUN:-}" ]; then
    say "Dry run: dot(.)music $version downloaded and checked; it would go in $dir. Nothing was installed."
    return 0
  fi

  mkdir -p "$dir" || fail "Couldn't create $dir."
  target="$dir/$APP_NAME"

  # Quit a running copy first, so it isn't replaced while it's open.
  if pgrep -x dot-music >/dev/null 2>&1; then
    step "Quitting the running copy"
    osascript -e 'quit app "dot-music"' >/dev/null 2>&1 || true
    sleep 2
  fi

  step "Installing in $dir"
  # Copy next to the old app first and swap at the end, so a failed copy (full disk) never leaves
  # the Mac without a working app.
  staged="$dir/.$APP_NAME.installing"
  rm -rf "$staged"
  ditto "$tmp/$APP_NAME" "$staged" || { rm -rf "$staged"; fail "Couldn't copy the app to $dir."; }
  if [ -e "$target" ]; then
    rm -rf "$target" || { rm -rf "$staged"; fail "Couldn't replace the old copy in $dir. Quit dot(.)music and try again."; }
  fi
  mv "$staged" "$target" || fail "Couldn't move the app into place in $dir."
  # In case the app was downloaded some other way before: no "from the internet" flag.
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

  step "Opening dot(.)music"
  open "$target" || say "Installed. Open dot(.)music from $dir."

  say ""
  say "dot(.)music $version is installed. Updates install themselves from now on."
}

main "$@"
