#!/usr/bin/env node

import fs from 'node:fs';

const sourceArgument = process.argv.indexOf('--source');
const sourceLocation = sourceArgument >= 0
  ? process.argv[sourceArgument + 1]
  : 'https://raw.githubusercontent.com/aria2/aria2/release-1.37.0/doc/manual-src/en/aria2c.rst';

if (!sourceLocation) throw new Error('--source requires a path or URL');

const source = /^https:\/\//.test(sourceLocation)
  ? await fetch(sourceLocation, { signal: AbortSignal.timeout(15000) }).then(response => {
      if (!response.ok) throw new Error(`Aria2 manual fetch failed with HTTP ${response.status}`);
      return response.text();
    })
  : fs.readFileSync(sourceLocation, 'utf8');

function section(start, end) {
  const startIndex = source.indexOf(`${start}\n`);
  const endIndex = source.indexOf(`${end}\n`, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Could not find manual section ${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
}

function options(text) {
  const names = [...text.matchAll(/^\.\. option:: .*?(--[a-z0-9-]+)/gm)]
    .map(match => match[1].slice(2));
  return [...new Set(names)].sort();
}

const normal = options(section('HTTP/FTP/SFTP Options', 'BitTorrent/Metalink Options'));
const torrent = options(
  `${section('BitTorrent/Metalink Options', 'BitTorrent Specific Options')}\n${section('BitTorrent Specific Options', 'Metalink Specific Options')}`,
);

if (torrent.length !== 46) {
  throw new Error(`Expected 46 unique Aria2 1.37.0 Torrent options, found ${torrent.length}`);
}

console.log(JSON.stringify({
  source: sourceLocation,
  aria2Version: '1.37.0',
  normal: { count: normal.length, options: normal },
  torrent: { count: torrent.length, options: torrent },
}, null, 2));
