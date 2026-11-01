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

function waitForFilePrefix(filePath, prefix, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fs.unwatchFile(filePath, onFileChange);
      if (error) reject(error);
      else resolve();
    };

    const onFileChange = () => {
      try {
        const contents = fs.readFileSync(filePath);
        if (
          contents.length >= prefix.length
          && contents.subarray(0, prefix.length).equals(prefix)
        ) {
          finish();
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') finish(error);
      }
    };

    fs.watchFile(filePath, { interval: 10, persistent: false }, onFileChange);
    timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for ${filePath} to contain the written bytes`));
    }, timeoutMs);
    onFileChange();
  });
}

function makeTrackedResponseBody(onCancel) {
  let resolveCancelled;
  const cancelled = new Promise(resolve => {
    resolveCancelled = resolve;
  });
  const body = new ReadableStream({
    cancel(reason) {
      onCancel?.(reason);
      resolveCancelled(reason);
    },
  });
  return { body, cancelled };
}

async function waitForBodyCancellation(cancelled, timeoutMs = 1_000) {
  let timeout;
  try {
    await Promise.race([
      cancelled,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Response body was not canceled')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
  const cancellationReason = new Error('provisioning interrupted');
  const partialBytes = Buffer.from('partial archive bytes');
  let downloadPromise;
  let calls = 0;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      assert.equal(options.signal.aborted, false);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(partialBytes);
        },
      }), {
        status: 200,
        headers: { 'Content-Length': '100' },
      });
    }, async () => {
      downloadPromise = downloadEngineArchive({
        name: 'test',
        url: 'https://example.test/engine.zip',
        archive,
        expectedSha256: digest(Buffer.from('never completed')),
        attempts: 3,
        idleTimeoutMs: 10_000,
        retryDelaysMs: [0, 0],
        signal: abortController.signal,
      });
      void downloadPromise.catch(() => {});

      try {
        await waitForFilePrefix(archive, partialBytes);
      } catch (error) {
        abortController.abort(error);
        await downloadPromise.catch(() => {});
        throw error;
      }

      abortController.abort(cancellationReason);
      await assert.rejects(downloadPromise, error => {
        assert.equal(error, cancellationReason);
        return true;
      });
    });

    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(archive), partialBytes);
  } finally {
    if (downloadPromise && !abortController.signal.aborted) {
      abortController.abort(new Error('test cleanup'));
    }
    await downloadPromise?.catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves a retained partial archive when cancellation wins before an ignored-range response', async () => {
  const { directory, archive } = makeArchivePath();
  const retainedBytes = Buffer.from('retained partial archive');
  fs.writeFileSync(archive, retainedBytes);
  const abortController = new AbortController();
  const cancellationReason = new Error('provisioning interrupted before response');
  const trackedBody = makeTrackedResponseBody();
  let calls = 0;
  let requestedRange;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      requestedRange = options.headers?.Range;
      assert.equal(options.signal.aborted, false);
      abortController.abort(cancellationReason);
      return new Response(trackedBody.body, {
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
          retryDelaysMs: [0, 0],
          signal: abortController.signal,
        }),
        error => {
          assert.equal(error, cancellationReason);
          return true;
        },
      );
      await waitForBodyCancellation(trackedBody.cancelled);
    });

    assert.equal(requestedRange, `bytes=${retainedBytes.length}-`);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(archive), retainedBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves a retained partial archive when the idle timeout wins before an ignored-range response', async () => {
  const { directory, archive } = makeArchivePath();
  const retainedBytes = Buffer.from('retained partial archive');
  fs.writeFileSync(archive, retainedBytes);
  const trackedBody = makeTrackedResponseBody();
  let calls = 0;
  let requestedRange;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      requestedRange = options.headers?.Range;
      return new Promise(resolve => {
        const respondAfterTimeout = () => resolve(new Response(trackedBody.body, {
          status: 200,
          headers: { 'Content-Length': '100' },
        }));
        options.signal.addEventListener('abort', respondAfterTimeout, { once: true });
        if (options.signal.aborted) respondAfterTimeout();
      });
    }, async () => {
      await assert.rejects(
        downloadEngineArchive({
          name: 'test',
          url: 'https://example.test/engine.zip',
          archive,
          expectedSha256: digest(Buffer.from('never completed')),
          attempts: 1,
          idleTimeoutMs: 25,
          retryDelaysMs: [],
        }),
        error => {
          assert.match(error.message, /Download idle for 25ms/);
          return true;
        },
      );
      await waitForBodyCancellation(trackedBody.cancelled);
    });

    assert.equal(requestedRange, `bytes=${retainedBytes.length}-`);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(archive), retainedBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves a retained partial archive when cancellation occurs while discarding an unsatisfiable range response', async () => {
  const { directory, archive } = makeArchivePath();
  const retainedBytes = Buffer.from('retained partial archive');
  fs.writeFileSync(archive, retainedBytes);
  const abortController = new AbortController();
  const cancellationReason = new Error('provisioning interrupted while discarding response');
  let calls = 0;
  let requestedRange;
  let bodyCanceled = false;

  try {
    await withMockFetch(async (_url, options) => {
      calls += 1;
      requestedRange = options.headers?.Range;
      return new Response(new ReadableStream({
        cancel() {
          bodyCanceled = true;
          abortController.abort(cancellationReason);
        },
      }), { status: 416 });
    }, async () => {
      await assert.rejects(
        downloadEngineArchive({
          name: 'test',
          url: 'https://example.test/engine.zip',
          archive,
          expectedSha256: digest(Buffer.from('never completed')),
          attempts: 3,
          retryDelaysMs: [0, 0],
          signal: abortController.signal,
        }),
        error => {
          assert.equal(error, cancellationReason);
          return true;
        },
      );
    });

    assert.equal(requestedRange, `bytes=${retainedBytes.length}-`);
    assert.equal(bodyCanceled, true);
    assert.equal(calls, 1);
    assert.deepEqual(fs.readFileSync(archive), retainedBytes);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('cancels Windows archive reset backoff without retrying or changing the partial file', async () => {
  const { directory, archive } = makeArchivePath();
  const retainedBytes = Buffer.from('retained partial archive during Windows reset');
  fs.writeFileSync(archive, retainedBytes);

  const abortController = new AbortController();
  const cancellationReason = new Error('provisioning interrupted during file reset');
  const trackedBody = makeTrackedResponseBody();
  const originalRmSync = fs.rmSync;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let calls = 0;
  let requestedRange;
  let removalAttempts = 0;

  try {
    // Drive the platform-specific retry branch in this isolated test process.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    fs.rmSync = function mockRmSync(target, ...args) {
      if (path.resolve(target) === archive) {
        removalAttempts += 1;
        const error = new Error('simulated Windows sharing violation');
        error.code = 'EBUSY';

        // This timer fires after resetArchive has entered its 100ms backoff.
        setTimeout(() => abortController.abort(cancellationReason), 0);
        throw error;
      }
      return originalRmSync.call(this, target, ...args);
    };

    await withMockFetch(async (_url, options) => {
      calls += 1;
      requestedRange = options.headers?.Range;
      return new Response(trackedBody.body, {
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
          retryDelaysMs: [0, 0],
          signal: abortController.signal,
        }),
        error => {
          assert.equal(error, cancellationReason);
          return true;
        },
      );
      await waitForBodyCancellation(trackedBody.cancelled);
    });

    assert.equal(requestedRange, `bytes=${retainedBytes.length}-`);
    assert.equal(calls, 1);
    assert.equal(removalAttempts, 1);
    assert.deepEqual(fs.readFileSync(archive), retainedBytes);
  } finally {
    fs.rmSync = originalRmSync;
    Object.defineProperty(process, 'platform', originalPlatform);
    originalRmSync(directory, { recursive: true, force: true });
  }
});

test('cancels the response body and preserves a partial archive when reset fails with EIO', async () => {
  const { directory, archive } = makeArchivePath();
  const retainedBytes = Buffer.from('retained partial archive after reset failure');
  fs.writeFileSync(archive, retainedBytes);

  const trackedBody = makeTrackedResponseBody();
  const originalRmSync = fs.rmSync;
  let calls = 0;
  let requestedRange;
  let removalAttempts = 0;

  try {
    fs.rmSync = function mockRmSync(target, ...args) {
      if (path.resolve(target) === archive) {
        removalAttempts += 1;
        const error = new Error('simulated archive reset I/O failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRmSync.call(this, target, ...args);
    };

    await withMockFetch(async (_url, options) => {
      calls += 1;
      requestedRange = options.headers?.Range;
      return new Response(trackedBody.body, {
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
          attempts: 1,
          retryDelaysMs: [],
        }),
        error => {
          assert.match(error.message, /Failed to download test after 1 attempts/);
          assert.match(error.message, /simulated archive reset I\/O failure/);
          assert.equal(error.cause?.code, 'EIO');
          return true;
        },
      );
      await waitForBodyCancellation(trackedBody.cancelled);
    });

    assert.equal(requestedRange, `bytes=${retainedBytes.length}-`);
    assert.equal(calls, 1);
    assert.equal(removalAttempts, 1);
    assert.deepEqual(fs.readFileSync(archive), retainedBytes);
  } finally {
    fs.rmSync = originalRmSync;
    originalRmSync(directory, { recursive: true, force: true });
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
