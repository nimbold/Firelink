#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Firelink"
CONFIGURATION="${CONFIGURATION:-release}"
MARKETING_VERSION="${MARKETING_VERSION:-0.1.0}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
APP_DIR="$ROOT_DIR/build/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICON_NAME="AppIcon"

cd "$ROOT_DIR"
swift build -c "$CONFIGURATION"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp ".build/$CONFIGURATION/$APP_NAME" "$MACOS_DIR/$APP_NAME"
cp "$ROOT_DIR/Resources/$ICON_NAME.icns" "$RESOURCES_DIR/$ICON_NAME.icns"

ARIA2C_PATH=$(which aria2c || true)
if [[ -n "$ARIA2C_PATH" && -x "$ARIA2C_PATH" ]]; then
  echo "Bundling aria2c from $ARIA2C_PATH..."
  cp "$ARIA2C_PATH" "$RESOURCES_DIR/aria2c"
  
  if ! command -v dylibbundler &> /dev/null; then
    echo "Installing dylibbundler..."
    brew install dylibbundler
  fi
  
  FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
  dylibbundler -od -b -x "$RESOURCES_DIR/aria2c" -d "$FRAMEWORKS_DIR" -p "@executable_path/../Frameworks/"
else
  echo "WARNING: aria2c not found! It will not be bundled. Please install it first."
fi

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>local.firelink.swiftui</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleIconFile</key>
  <string>$ICON_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$MARKETING_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Firelink needs permission to control Finder so it can sleep, restart, or shut down your Mac after scheduled downloads finish.</string>
</dict>
</plist>
PLIST

if command -v codesign &> /dev/null; then
  codesign --force --deep --sign - "$APP_DIR"
fi

echo "Created $APP_DIR"
