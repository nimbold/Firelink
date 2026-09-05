import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { downloadEngineArchive } from './engine-download.js';

async function withMockFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function makeBody(chunks, failure) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      if (failure) controller.error(failure);
      else controller.close();
    },
  });
}

function makeArchivePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-engine-download-'));
  return {
    directory,
    archive: path.join(directory, 'engine.zip'),
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('resumes an interrupted archive response from the retained partial file', async () => {
  const { directory, archive } = makeArchivePath();
  const full = Buffer.from('complete archive payload');
  const prefix = full.subarray(0, 8);
  const middle = full.subarray(8, 15);
  const suffix = full.subarray(15);
  fs.writeFileSync(archive, Buffer.concat([prefix, middle]));
  const ranges = [];
  let calls = 0;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      ranges.push(options.headers?.Range);
      if (calls === 1) {
        return new Response(makeBody([], new Error('connection reset')), {
          status: 206,
          headers: {
            'Content-Length': String(suffix.length),
            'Content-Range': `bytes ${prefix.length + middle.length}-${full.length - 1}/${full.length}`,
          },
        });
      }
      return new Response(makeBody([suffix]), {
        status: 206,
        headers: {
          'Content-Length': String(suffix.length),
          'Content-Range': `bytes ${prefix.length + middle.length}-${full.length - 1}/${full.length}`,
        },
      });
    }, async () => {
      await downloadEngineArchive({
        name: 'test',
        url: 'https://example.test/engine.zip',
        archive,
        expectedSha256: digest(full),
        attempts: 2,
        retryDelaysMs: [0],
      });
    });

    assert.deepEqual(
      ranges,
      [`bytes=${prefix.length + middle.length}-`, `bytes=${prefix.length + middle.length}-`],
    );
    assert.deepEqual(fs.readFileSync(archive), full);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('replaces a partial archive when the provider ignores the Range request', async () => {
  const { directory, archive } = makeArchivePath();
  const full = Buffer.from('complete archive after range fallback');
  fs.writeFileSync(archive, Buffer.from('stale partial bytes'));
  let requestedRange;

  try {
    await withMockFetch(async (_url, options) => {
      requestedRange = options.headers?.Range;
      return new Response(full, {
        status: 200,
        headers: { 'Content-Length': String(full.length) },
      });
    }, async () => {
      await downloadEngineArchive({
        name: 'test',
        url: 'https://example.test/engine.zip',
        archive,
        expectedSha256: digest(full),
        attempts: 1,
      });
    });

    assert.equal(requestedRange, 'bytes=19-');
    assert.deepEqual(fs.readFileSync(archive), full);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts a complete retained archive without issuing an unsatisfiable range', async () => {
  const { directory, archive } = makeArchivePath();
  const full = Buffer.from('complete archive retained after a late connection reset');
  fs.writeFileSync(archive, full);
  let calls = 0;

  try {
    await withMockFetch(async () => {
      calls += 1;
      throw new Error('fetch should not be called for a complete retained archive');
    }, async () => {
      await downloadEngineArchive({
        name: 'test',
        url: 'https://example.test/engine.zip',
        archive,
        expectedSha256: digest(full),
        attempts: 1,
      });
    });

    assert.equal(calls, 0);
    assert.deepEqual(fs.readFileSync(archive), full);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restarts from zero after an unsatisfiable retained range', async () => {
  const { directory, archive } = makeArchivePath();
  const full = Buffer.from('complete archive after a stale range response');
  fs.writeFileSync(archive, Buffer.from('stale partial bytes'));
  const ranges = [];
  let calls = 0;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      ranges.push(options.headers?.Range);
      if (calls === 1) return new Response(null, { status: 416 });
      return new Response(full, {
        status: 200,
        headers: { 'Content-Length': String(full.length) },
      });
    }, async () => {
      await downloadEngineArchive({
        name: 'test',
        url: 'https://example.test/engine.zip',
        archive,
        expectedSha256: digest(full),
        attempts: 2,
        retryDelaysMs: [0],
      });
    });

    assert.deepEqual(ranges, ['bytes=19-', undefined]);
    assert.deepEqual(fs.readFileSync(archive), full);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('propagates external cancellation without retrying an in-flight archive', async () => {
  const { directory, archive } = makeArchivePath();
  const abortController = new AbortController();
  let calls = 0;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      assert.equal(options.signal.aborted, false);
      setTimeout(() => {
        abortController.abort(new Error('provisioning interrupted'));
      }, 10);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('partial archive bytes'));
        },
      }), {
        status: 200,
        headers: { 'Content-Length': '100' },
      });
    }, async () => {
      await assert.rejects(
        downloadEngineArchive({
          name: 'test',
          url: 'https://example.test/engine.zip',
          archive,
          expectedSha256: digest(Buffer.from('never completed')),
          attempts: 3,
          retryDelaysMs: [500, 500],
          signal: abortController.signal,
        }),
        error => {
          assert.match(error.message, /provisioning interrupted/);
          return true;
        },
      );
    });

    assert.equal(calls, 1);
    assert.ok(fs.statSync(archive).size > 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects and removes an archive with a mismatched checksum', async () => {
  const { directory, archive } = makeArchivePath();
  const corrupt = Buffer.from('corrupt engine archive');

  try {
    await withMockFetch(
      async () => new Response(corrupt, {
        status: 200,
        headers: { 'Content-Length': String(corrupt.length) },
      }),
      async () => {
        await assert.rejects(
          downloadEngineArchive({
            name: 'ffmpeg',
            url: 'https://example.test/ffmpeg.zip',
            archive,
            expectedSha256: digest(Buffer.from('trusted engine archive')),
            attempts: 1,
          }),
          /Archive checksum mismatch for ffmpeg/,
        );
      },
    );
    assert.equal(fs.existsSync(archive), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
