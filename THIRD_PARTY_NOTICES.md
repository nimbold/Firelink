# Third-Party Notices

Firelink distributes separate executable tools. Firelink's MIT license does not replace their licenses.

Exact versions, target hashes, sources, and build descriptions are pinned in `engines.lock.json`.

## Bundled fonts

Firelink bundles variable WOFF2 web fonts through Fontsource. Each font is
licensed under the SIL Open Font License, Version 1.1. The corresponding
license and author information are available from the linked project sources.

- Inter: <https://github.com/rsms/inter>
- Outfit: <https://github.com/Outfitio/Outfit-Fonts>
- Roboto: <https://github.com/googlefonts/roboto-classic>
- Vazirmatn: <https://github.com/rastikerdar/vazirmatn>
- Noto Sans Hebrew: <https://github.com/notofonts/hebrew>
- Noto Sans SC: <https://github.com/notofonts/noto-cjk>

Fontsource distribution: <https://github.com/fontsource/font-files>

## aria2

- Project: <https://aria2.github.io/>
- Source: <https://github.com/aria2/aria2>
- License: GNU General Public License version 2 or later

Corresponding source for the distributed version is available from the source link and release tag listed in `engines.lock.json`. Firelink release notes must retain that source reference.

Linux x64 uses a checksum-pinned musl static build produced from upstream aria2 by <https://github.com/abcfy2/aria2-static-build>. Builder source and upstream tag are recorded in `engine-sources.lock.json`.

## FFmpeg

- Project and source: <https://ffmpeg.org/>
- License information: <https://ffmpeg.org/legal.html>

Current macOS binary reports `--enable-gpl --enable-version3`; distribution therefore follows GNU GPL version 3 requirements. Exact build identity is recorded in `engines.lock.json`.

Windows and Linux archives come from checksum-pinned BtbN FFmpeg GPL builds. Build project: <https://github.com/BtbN/FFmpeg-Builds>.

## yt-dlp

- Project and source: <https://github.com/yt-dlp/yt-dlp>
- License: The Unlicense

Firelink uses a self-contained PyInstaller onedir distribution. Embedded Python packages keep their own license files inside `_internal` where supplied.

## Deno

- Project and source: <https://github.com/denoland/deno>
- License: MIT

## OpenSSL and bundled native libraries

Engine payloads may contain OpenSSL, SQLite, c-ares, libssh2, gettext/libintl, zstd, and other runtime libraries. Their copyright and license notices remain part of their source distributions and embedded package metadata.

Release engineering must review each newly added target payload before adding its hashes to `engines.lock.json`. Missing provenance or license data blocks release.
