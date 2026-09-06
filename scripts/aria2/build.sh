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
