#!/bin/sh
# Makes the WebP screenshots the site serves from the JPEGs `npm run capture` writes:
# one at full size, plus a 1000px copy of anything wider than 1200px. Needs cwebp
# (brew install webp).
set -eu
cd "$(dirname "$0")/../public/shots"
for jpg in *.jpg; do
  name=${jpg%.jpg}
  width=$(sips -g pixelWidth "$jpg" | awk '/pixelWidth/ { print $2 }')
  cwebp -quiet -q 80 -m 6 "$jpg" -o "$name.webp"
  if [ "$width" -gt 1200 ]; then
    cwebp -quiet -q 80 -m 6 -resize 1000 0 "$jpg" -o "$name-1000.webp"
  fi
done
