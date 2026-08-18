import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256 } from './engine-payload-integrity.js';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000];
const FILE_RESET_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value || '');
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return undefined;
  }
  if (total !== undefined && (!Number.isSafeInteger(total) || end >= total)) {
    return undefined;
  }
  return { start, end, total };
}

function responseLength(response) {
  const value = response.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

function createDownloadTimeout(idleTimeoutMs) {
  const controller = new AbortController();
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new Error(`Download idle for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  };
  const dispose = () => clearTimeout(timer);
  refresh();
  return { signal: controller.signal, refresh, dispose };
}

function archiveSize(archive) {
  try {
    return fs.statSync(archive).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function checksumMismatchError(name, expected, actual) {
  const error = new Error(`Archive checksum mismatch for ${name}. Expected ${expected}, got ${actual}`);
  error.code = 'ARCHIVE_CHECKSUM_MISMATCH';
  return error;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function resetArchive(archive) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(archive, { force: true });
      return;
    } catch (error) {
      const retryable = process.platform === 'win32'
        && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!retryable || attempt >= FILE_RESET_RETRY_DELAYS_MS.length) throw error;
      await sleep(FILE_RESET_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Download and checksum an engine archive, resuming an interrupted response
 * when the provider honors HTTP range requests. A provider that ignores the
 * range is handled safely by replacing the partial file instead of appending
 * a second full archive to it.
 */
export async function downloadEngineArchive({
  name,
  url,
  archive,
  expectedSha256,
  attempts = DEFAULT_ATTEMPTS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const partialSize = archiveSize(archive);
    if (partialSize > 0 && sha256(archive) === expectedSha256) return archive;
    const downloadTimeout = createDownloadTimeout(idleTimeoutMs);
    let resetForRetry = false;

    try {
      const response = await fetch(url, {
        headers: partialSize > 0 ? { Range: `bytes=${partialSize}-` } : undefined,
        redirect: 'follow',
        signal: downloadTimeout.signal,
      });

      if (response.status === 416 && partialSize > 0) {
        await response.body?.cancel();
        resetForRetry = true;
        throw new Error(`Retained partial archive range is not satisfiable for ${name}`);
      }

      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
      }

      const contentRange = response.status === 206
        ? parseContentRange(response.headers.get('content-range'))
        : undefined;
      if (response.status === 206 && (!contentRange || contentRange.start !== partialSize)) {
        await response.body.cancel();
        throw new Error(`Invalid Content-Range while downloading ${name}`);
      }

      const append = response.status === 206 && partialSize > 0;
      const expectedResponseLength = responseLength(response);
      if (!append && partialSize > 0) {
        // The provider ignored Range and returned the complete archive.
        await resetArchive(archive);
      }

      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, encoding, callback) {
            downloadTimeout.refresh();
            callback(null, chunk, encoding);
          },
        }),
        fs.createWriteStream(archive, { flags: append ? 'a' : 'w' }),
        { signal: downloadTimeout.signal },
      );

      const finalSize = archiveSize(archive);
      const expectedFinalSize = contentRange?.total
        ?? (expectedResponseLength === undefined
          ? undefined
          : (append ? partialSize + expectedResponseLength : expectedResponseLength));
      if (expectedFinalSize !== undefined && finalSize !== expectedFinalSize) {
        throw new Error(
          `Incomplete archive for ${name}: expected ${expectedFinalSize} bytes, got ${finalSize}`,
        );
      }

      const actual = sha256(archive);
      if (actual === expectedSha256) return archive;

      resetForRetry = true;
      throw checksumMismatchError(name, expectedSha256, actual);
    } catch (error) {
      lastError = error;
      if (resetForRetry || error?.code === 'ARCHIVE_CHECKSUM_MISMATCH') {
        await resetArchive(archive);
      }
      if (attempt === attempts) {
        throw new Error(
          `Failed to download ${name} after ${attempts} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt - 1] ?? 0));
    } finally {
      downloadTimeout.dispose();
    }
  }

  throw lastError;
}
