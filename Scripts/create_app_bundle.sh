#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Firelink"
CONFIGURATION="${CONFIGURATION:-release}"
DEFAULT_MARKETING_VERSION="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
DEFAULT_BUILD_NUMBER="$(git rev-list --count HEAD 2>/dev/null || true)"
MARKETING_VERSION="${MARKETING_VERSION:-${DEFAULT_MARKETING_VERSION:-0.1.0}}"
BUILD_NUMBER="${BUILD_NUMBER:-${DEFAULT_BUILD_NUMBER:-1}}"
SIGNING_IDENTITY="${CODE_SIGN_IDENTITY:-${SIGNING_IDENTITY:-}}"
APP_DIR="$ROOT_DIR/build/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICON_NAME="AppIcon"

cd "$ROOT_DIR"

"$ROOT_DIR/Scripts/fetch_media_engines.sh"

swift build -c "$CONFIGURATION"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp ".build/$CONFIGURATION/$APP_NAME" "$MACOS_DIR/$APP_NAME"
cp "$ROOT_DIR/Resources/$ICON_NAME.icns" "$RESOURCES_DIR/$ICON_NAME.icns"
cp "$ROOT_DIR/Sources/Firelink/Assets.xcassets/MenuBarIcon.imageset/MenuBarIconTemplate.png" "$RESOURCES_DIR/MenuBarIconTemplate.png"
cp "$ROOT_DIR/Resources/GitHubTemplate.png" "$RESOURCES_DIR/GitHubTemplate.png"

for media_engine in yt-dlp deno ffmpeg aria2c; do
  media_engine_path="$ROOT_DIR/Sources/Firelink/$media_engine"
  if [[ -x "$media_engine_path" ]]; then
    cp "$media_engine_path" "$RESOURCES_DIR/$media_engine"
    chmod +x "$RESOURCES_DIR/$media_engine"
  else
    echo "WARNING: $media_engine not found or not executable at $media_engine_path"
  fi
done

for resource_directory in _internal aria2-libs aria2-licenses; do
  source_path="$ROOT_DIR/Sources/Firelink/$resource_directory"
  if [[ ! -d "$source_path" ]]; then
    echo "Required runtime directory is missing: $source_path" >&2
    exit 1
  fi
  cp -R "$source_path" "$RESOURCES_DIR/$resource_directory"
done

for resource_file in yt-dlp-version.txt aria2-version.txt aria2-cacert.pem; do
  source_path="$ROOT_DIR/Sources/Firelink/$resource_file"
  if [[ ! -f "$source_path" ]]; then
    echo "Required runtime file is missing: $source_path" >&2
    exit 1
  fi
  cp "$source_path" "$RESOURCES_DIR/$resource_file"
done

echo "Packaging Firefox extension..."
mkdir -p "$RESOURCES_DIR/FirefoxExtension"
cp "$ROOT_DIR/Extensions/Firefox/background.js" "$RESOURCES_DIR/FirefoxExtension/background.js"
cp "$ROOT_DIR/Extensions/Firefox/content.js" "$RESOURCES_DIR/FirefoxExtension/content.js"
cp "$ROOT_DIR/Extensions/Firefox/manifest.json" "$RESOURCES_DIR/FirefoxExtension/manifest.json"
cp -R "$ROOT_DIR/Extensions/Firefox/icons" "$RESOURCES_DIR/FirefoxExtension/icons"
cp -R "$ROOT_DIR/Extensions/Firefox/popup" "$RESOURCES_DIR/FirefoxExtension/popup"


FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
mkdir -p "$FRAMEWORKS_DIR"

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
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>local.firelink.swiftui</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>firelink</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

if command -v codesign &> /dev/null; then
  if [[ -n "$SIGNING_IDENTITY" ]]; then
    CODESIGN_ARGS=(--force --timestamp --options runtime --sign "$SIGNING_IDENTITY")
    echo "Signing app bundle with identity: $SIGNING_IDENTITY"
  else
    CODESIGN_ARGS=(--force --sign -)
    echo "Ad-hoc signing app bundle for local use."
  fi

  sign_path() {
    local path="$1"
    codesign "${CODESIGN_ARGS[@]}" "$path"
  }

  sign_mach_o_file() {
    local path="$1"
    case "$path" in
      */Python.framework/Python|*/Python.framework/Versions/Current/*)
        return
        ;;
    esac

    if file "$path" | grep -q 'Mach-O'; then
      if ! sign_path "$path"; then
        echo "WARNING: Could not sign Mach-O executable for local build: $path" >&2
      fi
    fi
  }

  if [[ -d "$FRAMEWORKS_DIR" ]]; then
    while IFS= read -r -d '' executable_path; do
      sign_mach_o_file "$executable_path"
    done < <(find "$FRAMEWORKS_DIR" -type f -print0)

    while IFS= read -r -d '' bundle_path; do
      sign_path "$bundle_path"
    done < <(find "$FRAMEWORKS_DIR" \( -name "*.xpc" -o -name "*.framework" \) -type d -depth -print0)
  fi

  while IFS= read -r -d '' executable_path; do
    sign_mach_o_file "$executable_path"
  done < <(find "$RESOURCES_DIR" -type f -print0)

  sign_path "$MACOS_DIR/$APP_NAME"
  sign_path "$APP_DIR"
  codesign --verify --deep --strict --verbose=2 "$APP_DIR"
fi

echo "Created $APP_DIR"
