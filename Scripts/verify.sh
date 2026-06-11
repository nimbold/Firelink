#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/Scripts/fetch_media_engines.sh"

ARIA2C="$ROOT_DIR/Sources/Firelink/aria2c"
ARIA2_LIBS="$ROOT_DIR/Sources/Firelink/aria2-libs"
test -x "$ARIA2C"
test -f "$ROOT_DIR/Sources/Firelink/aria2-cacert.pem"
test -d "$ARIA2_LIBS"
"$ARIA2C" --version | grep -q '^aria2 version 1.37.0$'
test "$(tr -d '[:space:]' < "$ROOT_DIR/Sources/Firelink/aria2-version.txt")" = "1.37.0-2-arm64-sonoma"
lipo -archs "$ARIA2C" | grep -qx arm64
vtool -show-build "$ARIA2C" | grep -q 'minos 14.0'
for library in "$ARIA2_LIBS"/*.dylib; do
  lipo -archs "$library" | grep -qx arm64
done
if otool -L "$ARIA2C" "$ARIA2_LIBS"/*.dylib | grep -Eq '(@@HOMEBREW|/opt/homebrew|/usr/local)'; then
  echo "Bundled aria2 runtime contains a non-portable dependency path." >&2
  exit 1
fi

swift build
git diff --check
python3 -m json.tool Extensions/Firefox/manifest.json >/dev/null
