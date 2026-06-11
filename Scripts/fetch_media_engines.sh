#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/Sources/Firelink"

YTDLP_VERSION="2026.06.09"
YTDLP_MACOS_ZIP_SHA256="62a3108d7c37090107f0bb9a2369b953b35e43f4bc76ab0ea87e4ab593c23ec7"

DENO_VERSION="2.8.2"
DENO_ARM64_ZIP_SHA256="02e5eb795c9f763772dfd081429cead9029e0a4a6aaff6d4e5f3ed6d2e94d361"
DENO_X86_64_ZIP_SHA256="77cf27f835f1921e49434449675c57432c6314d54edc725e2474cc825546e206"

FFMPEG_VERSION="8.1.1"
FFMPEG_ARM64_URL="https://ffmpeg.martin-riedl.de/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip"
FFMPEG_ARM64_ZIP_SHA256="a05b1a47bb3ac89a95a55eec713f8bbb347051bb07015f3b7d08fb62ed81a21e"

ARIA2_VERSION="1.37.0"
ARIA2_BOTTLE_REVISION="2"
ARIA2_RUNTIME_ID="$ARIA2_VERSION-$ARIA2_BOTTLE_REVISION-arm64-sonoma"
ARIA2_BOTTLE_SHA256="8815b6b79395235863349628dc0d753bbee9069e99d94257b7646ffd85615623"
CARES_VERSION="1.34.6"
CARES_BOTTLE_SHA256="17f44048d8003b88231d69bac0408cf22be2f712ef8588d4933ff0811b92342c"
LIBSSH2_VERSION="1.11.1_1"
LIBSSH2_BOTTLE_SHA256="34927ad08cd265d32f1390a92d84451f85ab5b2f28101ca951da3d3e9df12047"
OPENSSL_VERSION="3.6.2"
OPENSSL_BOTTLE_SHA256="aaa5f4f3d87868ecd5f5fd6967da0c305eb335a58171faba193e9c7e39fbf35c"
SQLITE_VERSION="3.53.0"
SQLITE_BOTTLE_SHA256="36080e3273614fe3d606ff0bd5bb090ad33c19f186ba44c35807b8f97afa15be"
GETTEXT_VERSION="1.0"
GETTEXT_BOTTLE_SHA256="f9ea4eed738746ea4150a4f83e8dd11ca21ca3de5bb113995c25eec409bb5749"

ARIA2_RUNTIME_SHA256="111b2f5ed760f1e1a2ec06117c4e8094fcde336ba16122dda1c5e7209bf1862d"
CARES_RUNTIME_SHA256="86ceec6264753bfffb1562df22e81cbbed72d370105936ee083f3152c9dc1673"
LIBCRYPTO_RUNTIME_SHA256="a13e280563c6eb85058f590f6f558fb20f54e171024f3b9b3637df140add1714"
LIBINTL_RUNTIME_SHA256="7e6628118b26b58b57346f3f088b1f87b263c677736ade678f0aced5579ea357"
LIBSQLITE_RUNTIME_SHA256="27da39c4cc96e7f43c8ed0134d2de6dd2fd36008dcb044c03aeee3eec9edc545"
LIBSSH2_RUNTIME_SHA256="67cbce90dca26590a8a7627af8f4abccfd94f41cae48f7fa67a5f0cb98efc85b"
LIBSSL_RUNTIME_SHA256="f5676ffe68757ea2629898c29bcee5f15982e06fe878bec4f70d159dd1b70452"

mkdir -p "$SOURCE_DIR"

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_sha256() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(sha256 "$path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $path" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    exit 1
  fi
}

version_matches() {
  local marker_path="$1"
  local expected="$2"
  [[ -f "$marker_path" ]] && [[ "$(tr -d '[:space:]' < "$marker_path")" == "$expected" ]]
}

fetch_homebrew_bottle() {
  local repository="$1"
  local digest="$2"
  local output_path="$3"
  local token

  token="$(
    curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:homebrew/core/$repository:pull" |
      python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])'
  )"
  curl -fsSL \
    -H "Authorization: Bearer $token" \
    "https://ghcr.io/v2/homebrew/core/$repository/blobs/sha256:$digest" \
    -o "$output_path"
  verify_sha256 "$output_path" "$digest"
}

fetch_ytdlp() {
  local executable="$SOURCE_DIR/yt-dlp"
  local runtime="$SOURCE_DIR/_internal"
  local marker="$SOURCE_DIR/yt-dlp-version.txt"

  if [[ -x "$executable" ]] && [[ -d "$runtime" ]] && version_matches "$marker" "$YTDLP_VERSION"; then
    return
  fi

  echo "Fetching yt-dlp $YTDLP_VERSION one-folder runtime..."
  local temp_dir
  temp_dir="$(mktemp -d)"
  curl -fsSL \
    "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp_macos.zip" \
    -o "$temp_dir/yt-dlp.zip"
  verify_sha256 "$temp_dir/yt-dlp.zip" "$YTDLP_MACOS_ZIP_SHA256"
  unzip -q -o "$temp_dir/yt-dlp.zip" -d "$temp_dir/runtime"

  rm -rf "$runtime"
  cp "$temp_dir/runtime/yt-dlp_macos" "$executable"
  cp -R "$temp_dir/runtime/_internal" "$runtime"
  touch "$runtime/.gitkeep"
  chmod +x "$executable"
  printf '%s\n' "$YTDLP_VERSION" > "$marker"
  rm -rf "$temp_dir"
}

fetch_deno() {
  local machine_arch
  machine_arch="$(uname -m)"

  local asset_arch
  local expected_sha
  case "$machine_arch" in
    arm64)
      asset_arch="aarch64"
      expected_sha="$DENO_ARM64_ZIP_SHA256"
      ;;
    x86_64)
      asset_arch="x86_64"
      expected_sha="$DENO_X86_64_ZIP_SHA256"
      ;;
    *)
      echo "Unsupported architecture for bundled Deno: $machine_arch" >&2
      exit 1
      ;;
  esac

  local executable="$SOURCE_DIR/deno"
  local marker="$SOURCE_DIR/deno-version.txt"
  if [[ -x "$executable" ]] && version_matches "$marker" "$DENO_VERSION-$machine_arch"; then
    return
  fi

  echo "Fetching Deno $DENO_VERSION for $machine_arch..."
  local temp_dir
  temp_dir="$(mktemp -d)"
  curl -fsSL \
    "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/deno-$asset_arch-apple-darwin.zip" \
    -o "$temp_dir/deno.zip"
  verify_sha256 "$temp_dir/deno.zip" "$expected_sha"
  unzip -q -o "$temp_dir/deno.zip" -d "$temp_dir/runtime"
  cp "$temp_dir/runtime/deno" "$executable"
  chmod +x "$executable"
  printf '%s\n' "$DENO_VERSION-$machine_arch" > "$marker"
  rm -rf "$temp_dir"
}

fetch_ffmpeg() {
  local executable="$SOURCE_DIR/ffmpeg"
  local marker="$SOURCE_DIR/ffmpeg-version.txt"

  if [[ "$(uname -m)" != "arm64" ]]; then
    if [[ ! -x "$executable" ]]; then
      echo "A local ffmpeg executable is required on non-ARM64 development hosts." >&2
      exit 1
    fi
    return
  fi

  if [[ -x "$executable" ]] && version_matches "$marker" "$FFMPEG_VERSION-arm64"; then
    return
  fi

  echo "Fetching FFmpeg $FFMPEG_VERSION for arm64..."
  local temp_dir
  temp_dir="$(mktemp -d)"
  curl -fsSL "$FFMPEG_ARM64_URL" -o "$temp_dir/ffmpeg.zip"
  verify_sha256 "$temp_dir/ffmpeg.zip" "$FFMPEG_ARM64_ZIP_SHA256"
  unzip -q -o "$temp_dir/ffmpeg.zip" -d "$temp_dir/runtime"
  cp "$temp_dir/runtime/ffmpeg" "$executable"
  chmod +x "$executable"
  printf '%s\n' "$FFMPEG_VERSION-arm64" > "$marker"
  rm -rf "$temp_dir"
}

aria2_runtime_is_ready() {
  local required_paths=(
    "$SOURCE_DIR/aria2c"
    "$SOURCE_DIR/aria2-cacert.pem"
    "$SOURCE_DIR/aria2-libs/libcares.2.dylib"
    "$SOURCE_DIR/aria2-libs/libcrypto.3.dylib"
    "$SOURCE_DIR/aria2-libs/libintl.8.dylib"
    "$SOURCE_DIR/aria2-libs/libsqlite3.dylib"
    "$SOURCE_DIR/aria2-libs/libssh2.1.dylib"
    "$SOURCE_DIR/aria2-libs/libssl.3.dylib"
  )

  version_matches "$SOURCE_DIR/aria2-version.txt" "$ARIA2_RUNTIME_ID" || return 1
  [[ -x "$SOURCE_DIR/aria2c" ]] || return 1
  [[ -d "$SOURCE_DIR/aria2-licenses" ]] || return 1

  local path
  for path in "${required_paths[@]}"; do
    [[ -e "$path" ]] || return 1
  done

  [[ "$(sha256 "$SOURCE_DIR/aria2c")" == "$ARIA2_RUNTIME_SHA256" ]] || return 1
  [[ "$(sha256 "$SOURCE_DIR/aria2-libs/libcares.2.dylib")" == "$CARES_RUNTIME_SHA256" ]] || return 1
  [[ "$(sha256 "$SOURCE_DIR/aria2-libs/libcrypto.3.dylib")" == "$LIBCRYPTO_RUNTIME_SHA256" ]] || return 1
  [[ "$(sha256 "$SOURCE_DIR/aria2-libs/libintl.8.dylib")" == "$LIBINTL_RUNTIME_SHA256" ]] || return 1
  [[ "$(sha256 "$SOURCE_DIR/aria2-libs/libsqlite3.dylib")" == "$LIBSQLITE_RUNTIME_SHA256" ]] || return 1
  [[ "$(sha256 "$SOURCE_DIR/aria2-libs/libssh2.1.dylib")" == "$LIBSSH2_RUNTIME_SHA256" ]] || return 1
  [[ "$(sha256 "$SOURCE_DIR/aria2-libs/libssl.3.dylib")" == "$LIBSSL_RUNTIME_SHA256" ]] || return 1
}

fetch_aria2() {
  if [[ "$(uname -m)" != "arm64" ]]; then
    echo "The pinned aria2 runtime is currently available only for ARM64 macOS." >&2
    exit 1
  fi

  if aria2_runtime_is_ready; then
    return
  fi

  echo "Fetching aria2 $ARIA2_VERSION Homebrew ARM64 Sonoma runtime..."
  local temp_dir
  temp_dir="$(mktemp -d)"
  local bottles_dir="$temp_dir/bottles"
  local extracted_dir="$temp_dir/extracted"
  local runtime_dir="$temp_dir/runtime"
  local libraries_dir="$runtime_dir/aria2-libs"
  local licenses_dir="$runtime_dir/aria2-licenses"
  mkdir -p "$bottles_dir" "$extracted_dir" "$libraries_dir" "$licenses_dir"

  fetch_homebrew_bottle "aria2" "$ARIA2_BOTTLE_SHA256" "$bottles_dir/aria2.tar.gz"
  fetch_homebrew_bottle "c-ares" "$CARES_BOTTLE_SHA256" "$bottles_dir/c-ares.tar.gz"
  fetch_homebrew_bottle "libssh2" "$LIBSSH2_BOTTLE_SHA256" "$bottles_dir/libssh2.tar.gz"
  fetch_homebrew_bottle "openssl/3" "$OPENSSL_BOTTLE_SHA256" "$bottles_dir/openssl.tar.gz"
  fetch_homebrew_bottle "sqlite" "$SQLITE_BOTTLE_SHA256" "$bottles_dir/sqlite.tar.gz"
  fetch_homebrew_bottle "gettext" "$GETTEXT_BOTTLE_SHA256" "$bottles_dir/gettext.tar.gz"

  local bottle
  for bottle in "$bottles_dir"/*.tar.gz; do
    tar -xzf "$bottle" -C "$extracted_dir"
  done

  cp "$extracted_dir/aria2/$ARIA2_VERSION"_"$ARIA2_BOTTLE_REVISION/bin/aria2c" "$runtime_dir/aria2c"
  cp "$extracted_dir/c-ares/$CARES_VERSION/lib/libcares.2.19.5.dylib" "$libraries_dir/libcares.2.dylib"
  cp "$extracted_dir/libssh2/$LIBSSH2_VERSION/lib/libssh2.1.dylib" "$libraries_dir/libssh2.1.dylib"
  cp "$extracted_dir/openssl@3/$OPENSSL_VERSION/lib/libssl.3.dylib" "$libraries_dir/libssl.3.dylib"
  cp "$extracted_dir/openssl@3/$OPENSSL_VERSION/lib/libcrypto.3.dylib" "$libraries_dir/libcrypto.3.dylib"
  cp "$extracted_dir/sqlite/$SQLITE_VERSION/lib/libsqlite3.3.53.0.dylib" "$libraries_dir/libsqlite3.dylib"
  cp "$extracted_dir/gettext/$GETTEXT_VERSION/lib/libintl.8.dylib" "$libraries_dir/libintl.8.dylib"
  cp "$SOURCE_DIR/_internal/certifi/cacert.pem" "$runtime_dir/aria2-cacert.pem"

  cp "$extracted_dir/aria2/$ARIA2_VERSION"_"$ARIA2_BOTTLE_REVISION/COPYING" "$licenses_dir/aria2-COPYING"
  cp "$extracted_dir/c-ares/$CARES_VERSION/LICENSE.md" "$licenses_dir/c-ares-LICENSE.md"
  cp "$extracted_dir/libssh2/$LIBSSH2_VERSION/COPYING" "$licenses_dir/libssh2-COPYING"
  cp "$extracted_dir/openssl@3/$OPENSSL_VERSION/LICENSE.txt" "$licenses_dir/openssl-LICENSE.txt"
  cp "$extracted_dir/gettext/$GETTEXT_VERSION/COPYING" "$licenses_dir/gettext-COPYING"
  cp "$extracted_dir/sqlite/$SQLITE_VERSION/sbom.spdx.json" "$licenses_dir/sqlite-sbom.spdx.json"

  install_name_tool \
    -change "@@HOMEBREW_PREFIX@@/opt/sqlite/lib/libsqlite3.dylib" "@loader_path/aria2-libs/libsqlite3.dylib" \
    -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libssl.3.dylib" "@loader_path/aria2-libs/libssl.3.dylib" \
    -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libcrypto.3.dylib" "@loader_path/aria2-libs/libcrypto.3.dylib" \
    -change "@@HOMEBREW_PREFIX@@/opt/libssh2/lib/libssh2.1.dylib" "@loader_path/aria2-libs/libssh2.1.dylib" \
    -change "@@HOMEBREW_PREFIX@@/opt/c-ares/lib/libcares.2.dylib" "@loader_path/aria2-libs/libcares.2.dylib" \
    -change "@@HOMEBREW_PREFIX@@/opt/gettext/lib/libintl.8.dylib" "@loader_path/aria2-libs/libintl.8.dylib" \
    "$runtime_dir/aria2c"

  local library
  for library in "$libraries_dir"/*.dylib; do
    install_name_tool -id "@loader_path/$(basename "$library")" "$library"
  done

  install_name_tool \
    -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libssl.3.dylib" "@loader_path/libssl.3.dylib" \
    -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libcrypto.3.dylib" "@loader_path/libcrypto.3.dylib" \
    "$libraries_dir/libssh2.1.dylib"
  install_name_tool \
    -change "@@HOMEBREW_CELLAR@@/openssl@3/$OPENSSL_VERSION/lib/libcrypto.3.dylib" "@loader_path/libcrypto.3.dylib" \
    "$libraries_dir/libssl.3.dylib"

  chmod +x "$runtime_dir/aria2c"
  for library in "$libraries_dir"/*.dylib; do
    codesign --force --sign - "$library"
  done
  codesign --force --sign - "$runtime_dir/aria2c"

  verify_sha256 "$runtime_dir/aria2c" "$ARIA2_RUNTIME_SHA256"
  verify_sha256 "$libraries_dir/libcares.2.dylib" "$CARES_RUNTIME_SHA256"
  verify_sha256 "$libraries_dir/libcrypto.3.dylib" "$LIBCRYPTO_RUNTIME_SHA256"
  verify_sha256 "$libraries_dir/libintl.8.dylib" "$LIBINTL_RUNTIME_SHA256"
  verify_sha256 "$libraries_dir/libsqlite3.dylib" "$LIBSQLITE_RUNTIME_SHA256"
  verify_sha256 "$libraries_dir/libssh2.1.dylib" "$LIBSSH2_RUNTIME_SHA256"
  verify_sha256 "$libraries_dir/libssl.3.dylib" "$LIBSSL_RUNTIME_SHA256"

  if otool -L "$runtime_dir/aria2c" "$libraries_dir"/*.dylib | grep -Eq '(@@HOMEBREW|/opt/homebrew|/usr/local)'; then
    echo "The prepared aria2 runtime still contains a Homebrew path." >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  if ! vtool -show-build "$runtime_dir/aria2c" | grep -q 'minos 14.0'; then
    echo "The pinned aria2 runtime no longer supports the app's macOS 14 deployment target." >&2
    rm -rf "$temp_dir"
    exit 1
  fi
  if [[ "$("$runtime_dir/aria2c" --version | head -n 1)" != "aria2 version $ARIA2_VERSION" ]]; then
    echo "The prepared aria2 runtime failed its version check." >&2
    rm -rf "$temp_dir"
    exit 1
  fi

  rm -rf "$SOURCE_DIR/aria2-libs" "$SOURCE_DIR/aria2-licenses"
  cp "$runtime_dir/aria2c" "$SOURCE_DIR/aria2c"
  cp "$runtime_dir/aria2-cacert.pem" "$SOURCE_DIR/aria2-cacert.pem"
  cp -R "$libraries_dir" "$SOURCE_DIR/aria2-libs"
  cp -R "$licenses_dir" "$SOURCE_DIR/aria2-licenses"
  printf '%s\n' "$ARIA2_RUNTIME_ID" > "$SOURCE_DIR/aria2-version.txt"
  rm -rf "$temp_dir"
}

fetch_ytdlp
fetch_deno
fetch_ffmpeg
fetch_aria2

if command -v xattr >/dev/null; then
  xattr -cr \
    "$SOURCE_DIR/yt-dlp" \
    "$SOURCE_DIR/_internal" \
    "$SOURCE_DIR/deno" \
    "$SOURCE_DIR/ffmpeg" \
    "$SOURCE_DIR/aria2c" \
    "$SOURCE_DIR/aria2-libs" 2>/dev/null || true
fi

echo "Media engines are ready:"
echo "  yt-dlp $YTDLP_VERSION"
echo "  Deno $DENO_VERSION"
echo "  FFmpeg $FFMPEG_VERSION"
echo "  aria2 $ARIA2_VERSION (Homebrew bottle revision $ARIA2_BOTTLE_REVISION)"
