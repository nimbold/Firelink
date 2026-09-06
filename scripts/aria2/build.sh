#!/usr/bin/env bash
set -euo pipefail
# Build from the checksum-pinned upstream archive plus the reviewed patch.
source_root="$1"
patch_file="$2"
if command -v cygpath >/dev/null 2>&1; then
  source_root="$(cygpath -u "$source_root")"
  patch_file="$(cygpath -u "$patch_file")"
  export PATH="/mingw64/bin:/usr/bin:$PATH"
  export ACLOCAL_PATH="/mingw64/share/aclocal:/usr/share/aclocal${ACLOCAL_PATH:+:$ACLOCAL_PATH}"
  export PKG_CONFIG_PATH=/mingw64/lib/pkgconfig
fi

copy_mingw_runtime_dependencies() {
  local binary="$1"
  local runtime_dir="$2"
  local dependency
  local source
  local destination

  while IFS= read -r dependency; do
    [[ -z "$dependency" ]] && continue
    source="/mingw64/bin/$dependency"
    if [[ ! -f "$source" ]]; then
      continue
    fi
    destination="$runtime_dir/$dependency"
    if [[ -e "$destination" ]]; then
      continue
    fi
    cp "$source" "$destination"
    copy_mingw_runtime_dependencies "$destination" "$runtime_dir"
  done < <(objdump -p "$binary" | awk '/DLL Name:/{print $3}')
}

cd "$source_root"
patch --batch -p1 < "$patch_file"
autoreconf -fi
mkdir firelink-build
cd firelink-build
# Linux and Windows payloads are self-contained; do not inherit host dylibs.
export LDFLAGS="-static ${LDFLAGS:-}"
export PKG_CONFIG="pkg-config --static"
../configure --enable-static --disable-shared --disable-nls \
  --without-gnutls --with-openssl --without-libxml2 --with-libexpat \
  --without-libgmp --without-libnettle --without-libgcrypt \
  --with-libssh2 --with-libcares
make -j2

if command -v cygpath >/dev/null 2>&1; then
  command -v objdump >/dev/null 2>&1 || {
    echo "MinGW objdump is required to collect Aria2 runtime dependencies." >&2
    exit 1
  }
  runtime_dir="$source_root/aria2-libs"
  mkdir -p "$runtime_dir"
  copy_mingw_runtime_dependencies "$source_root/firelink-build/src/aria2c.exe" "$runtime_dir"
  if [[ -d /mingw64/lib/ossl-modules ]]; then
    find /mingw64/lib/ossl-modules -maxdepth 1 -type f -iname '*.dll' -exec cp {} "$runtime_dir/" \;
  fi
fi
