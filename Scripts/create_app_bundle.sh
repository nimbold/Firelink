#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Firelink"
CONFIGURATION="${CONFIGURATION:-release}"
DEFAULT_MARKETING_VERSION="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
DEFAULT_BUILD_NUMBER="$(git rev-list --count HEAD 2>/dev/null || true)"
MARKETING_VERSION="${MARKETING_VERSION:-${DEFAULT_MARKETING_VERSION:-0.1.0}}"
BUILD_NUMBER="${BUILD_NUMBER:-${DEFAULT_BUILD_NUMBER:-1}}"
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
cp "$ROOT_DIR/Sources/Firelink/Assets.xcassets/MenuBarIcon.imageset/MenuBarIconTemplate.png" "$RESOURCES_DIR/MenuBarIconTemplate.png"
cp "$ROOT_DIR/Resources/GitHubTemplate.png" "$RESOURCES_DIR/GitHubTemplate.png"

echo "Packaging Firefox extension..."
mkdir -p "$RESOURCES_DIR/FirefoxExtension"
cp "$ROOT_DIR/Extensions/Firefox/background.js" "$RESOURCES_DIR/FirefoxExtension/background.js"
cp "$ROOT_DIR/Extensions/Firefox/content.js" "$RESOURCES_DIR/FirefoxExtension/content.js"
cp "$ROOT_DIR/Extensions/Firefox/manifest.json" "$RESOURCES_DIR/FirefoxExtension/manifest.json"
cp -R "$ROOT_DIR/Extensions/Firefox/icons" "$RESOURCES_DIR/FirefoxExtension/icons"
cp -R "$ROOT_DIR/Extensions/Firefox/popup" "$RESOURCES_DIR/FirefoxExtension/popup"


ARIA2C_PATH=$(which aria2c || true)
if [[ -n "$ARIA2C_PATH" && -x "$ARIA2C_PATH" ]]; then
  echo "Bundling aria2c from $ARIA2C_PATH..."
  cp "$ARIA2C_PATH" "$RESOURCES_DIR/aria2c"

  if ! command -v dylibbundler &> /dev/null; then
    echo "Installing dylibbundler..."
    brew install dylibbundler
  fi

  FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
  mkdir -p "$FRAMEWORKS_DIR"
  dylibbundler -od -b -x "$RESOURCES_DIR/aria2c" -d "$FRAMEWORKS_DIR" -p "@executable_path/../Frameworks/"
else
  echo "WARNING: aria2c not found! It will not be bundled. Please install it first."
fi

FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
mkdir -p "$FRAMEWORKS_DIR"
if [ -d ".build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework" ]; then
  cp -R ".build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework" "$FRAMEWORKS_DIR/Sparkle.framework"
fi
if [ -d ".build/artifacts/sparkle/Sparkle/SparkleCore.xcframework/macos-arm64_x86_64/SparkleCore.framework" ]; then
  cp -R ".build/artifacts/sparkle/Sparkle/SparkleCore.xcframework/macos-arm64_x86_64/SparkleCore.framework" "$FRAMEWORKS_DIR/SparkleCore.framework"
fi

install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/$APP_NAME" || true


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
  <key>SUPublicEDKey</key>
  <string>TnontDdbFQHbKkjpWVlHaMEbMahiCugSHOcUF1MwKE0=</string>
  <key>SUFeedURL</key>
  <string>https://raw.githubusercontent.com/nimbold/Firelink/main/appcast.xml</string>
  <key>SUEnableAutomaticChecks</key>
  <true/>
</dict>
</plist>
PLIST

if command -v codesign &> /dev/null; then
  codesign --force --deep --sign - "$APP_DIR"
fi

echo "Created $APP_DIR"
