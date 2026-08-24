import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkRows, fetchJson, fetchText, npmExecutable, providerAssetHashes } from './check-updates.js';

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
