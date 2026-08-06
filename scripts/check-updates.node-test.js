import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkRows, fetchJson, fetchText } from './check-updates.js';

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
