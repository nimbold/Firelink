import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRows,
  diffCargoMetadata,
  fetchJson,
  fetchText,
  latestBtbnFfmpegStableBuild,
  latestMartinRiedlMacArm64Release,
  npmExecutable,
  providerAssetHashes,
} from './check-updates.js';

async function withMockFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('fetchJson retries transient HTTP responses before succeeding', async () => {
  let attempts = 0;
  const result = await withMockFetch(async () => {
    attempts += 1;
    if (attempts < 3) return new Response('temporarily unavailable', { status: 503 });
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }, () => fetchJson('https://example.test/releases'));

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(attempts, 3);
});

test('fetchText does not retry terminal HTTP responses', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withMockFetch(async () => {
        attempts += 1;
        return new Response('not found', { status: 404 });
      }, () => fetchText('https://example.test/missing')),
    /404: https:\/\/example\.test\/missing/
  );
  assert.equal(attempts, 1);
});

test('checkRows fails closed when a latest version is unavailable', () => {
  assert.throws(
    () =>
      checkRows(
        [{ target: 'test-target', engine: 'test-engine', version: '1.0.0', url: 'https://example.test/engine' }],
        {}
      ),
    /Latest version is unavailable for test-target test-engine/
  );
});

test('checkRows does not fall back to the generic release for target-specific engines', () => {
  assert.throws(
    () =>
      checkRows(
        [{ target: 'test-target', engine: 'ffmpeg', version: '8.1.2', url: 'https://example.test/engine' }],
        { ffmpeg: '9.0.1' },
        {},
        {},
        new Set(['ffmpeg'])
      ),
    /Latest provider version is unavailable for test-target ffmpeg/
  );
});

test('checkRows detects a provider hash change when version and URL are current', () => {
  const outdated = checkRows(
    [{
      target: 'test-target',
      engine: 'test-engine',
      version: '1.0.0',
      url: 'https://example.test/engine',
      sha256: 'a'.repeat(64),
    }],
    { 'test-engine': '1.0.0' },
    {},
    {},
    new Set(),
    {},
    { 'https://example.test/engine': 'b'.repeat(64) },
  );

  assert.equal(outdated, 1);
});

test('checkRows detects an aria2 asset digest change when the provider supplies it', () => {
  const url = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
  const digest = 'b'.repeat(64);
  const hashes = providerAssetHashes({
    aria2: { assets: [{ browser_download_url: url, digest: `sha256:${digest}` }] },
  });

  const outdated = checkRows(
    [{
      target: 'x86_64-pc-windows-msvc',
      engine: 'aria2c',
      version: '1.37.0',
      url,
      sha256: 'a'.repeat(64),
    }],
    { aria2c: '1.37.0' },
    {},
    {},
    new Set(),
    {},
    hashes,
  );

  assert.equal(outdated, 1);
});

test('npm executable selection uses the Windows command shim when needed', () => {
  assert.equal(npmExecutable('win32'), 'npm.cmd');
  assert.equal(npmExecutable('darwin'), 'npm');
  assert.equal(npmExecutable('linux'), 'npm');
});

test('selects a complete BtbN build for the current stable series', async () => {
  const digest = value => `sha256:${value.repeat(64)}`;
  const release = {
    tag_name: 'autobuild-test',
    assets: [
      {
        name: 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip',
        browser_download_url: 'https://example.test/windows.zip',
        digest: digest('a'),
      },
      {
        name: 'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz',
        browser_download_url: 'https://example.test/linux.tar.xz',
        digest: digest('b'),
      },
      {
        name: 'ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip',
        browser_download_url: 'https://example.test/old.zip',
        digest: digest('c'),
      },
    ],
  };
  const result = await withMockFetch(
    async () => new Response(JSON.stringify([release]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );

  assert.equal(result.version, '9.0.1-11-ge47273f4d9');
  assert.equal(result.urls.windows, 'https://example.test/windows.zip');
  assert.equal(result.hashes.linux, 'b'.repeat(64));
});

test('rejects an incomplete BtbN stable target tuple', async () => {
  const release = {
    tag_name: 'autobuild-test',
    assets: [{
      name: 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip',
      browser_download_url: 'https://example.test/windows.zip',
      digest: `sha256:${'a'.repeat(64)}`,
    }],
  };
  const result = await withMockFetch(
    async () => new Response(JSON.stringify([release]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );
  assert.equal(result, undefined);
});

test('requires a complete Martin Riedl stable artifact and digest', async () => {
  const html = `
    <h2>Download Release Build</h2>
    <div><h3>macOS (Apple Silicon/arm64)</h3>
    <p><b>Release: </b>9.0.1</p>
    <a href="/download/macos/arm64/build/ffmpeg.zip">FFmpeg (ZIP)</a></div>`;
  const result = await withMockFetch(
    async url => new Response(
      String(url).endsWith('.sha256') ? `${'d'.repeat(64)}  ffmpeg.zip\n` : html,
      { status: 200 },
    ),
    () => latestMartinRiedlMacArm64Release(),
  );
  assert.deepEqual(result, {
    version: '9.0.1',
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/build/ffmpeg.zip',
    sha256: 'd'.repeat(64),
  });
});

test('reports compatible Cargo resolution drift from structured metadata', () => {
  const metadata = versions => ({
    packages: Object.entries(versions).map(([name, version]) => ({
      name,
      version,
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    })),
  });
  assert.deepEqual(
    diffCargoMetadata(metadata({ indexmap: '2.14.1', serde: '1.0.229' }), metadata({
      indexmap: '2.14.2',
      serde: '1.0.229',
    })),
    [{
      name: 'indexmap',
      version: '2.14.1',
      latest: '2.14.2',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    }],
  );
});
