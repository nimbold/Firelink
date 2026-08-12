import fs from 'node:fs';
import path from 'node:path';

const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function pathExists(value) {
  try {
    fs.lstatSync(value);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function previousPayloadPrefix(destination) {
  return `.${path.basename(destination)}.previous-`;
}

function previousPayloads(destination) {
  const parent = path.dirname(destination);
  const prefix = previousPayloadPrefix(destination);
  return fs.readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.name.startsWith(prefix))
    .map(entry => path.join(parent, entry.name));
}

function previousPayloadOwner(destination, candidate) {
  const suffix = path.basename(candidate).slice(previousPayloadPrefix(destination).length);
  const separator = suffix.indexOf('-');
  const pid = separator >= 0 ? suffix.slice(0, separator) : suffix;
  return /^\d+$/.test(pid) ? Number(pid) : null;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function removeOrphanedPreviousPayloads(destination) {
  for (const candidate of previousPayloads(destination)) {
    const owner = previousPayloadOwner(destination, candidate);
    if (owner === null || isProcessAlive(owner)) continue;
    await removePathWithRetry(candidate);
  }
}

/**
 * Restores the only previous payload left by a process that died after moving
 * the destination aside but before publishing its replacement. Multiple
 * candidates are ambiguous and remain untouched for manual recovery.
 */
export function recoverInterruptedPromotion(destination) {
  if (pathExists(destination)) return;

  const candidates = previousPayloads(destination);
  if (candidates.length === 0) return;
  if (candidates.length > 1) {
    throw new Error(
      `Cannot recover engine payload at ${destination}: found ${candidates.length} previous payloads`
    );
  }

  const candidate = candidates[0];
  if (!fs.lstatSync(candidate).isDirectory()) {
    throw new Error(`Cannot recover engine payload from non-directory backup: ${candidate}`);
  }
  fs.renameSync(candidate, destination);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function removePathWithRetry(value) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(value, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = process.platform === 'win32'
        && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Publishes a fully verified payload without exposing a partially written
 * directory. The staging directory must share a filesystem with destination.
 */
export async function promoteDirectory(staging, destination) {
  recoverInterruptedPromotion(destination);
  const stagingStats = fs.lstatSync(staging);
  if (!stagingStats.isDirectory()) {
    throw new Error(`Engine payload staging path is not a directory: ${staging}`);
  }

  const parent = path.dirname(destination);
  const backup = path.join(
    parent,
    `.${path.basename(destination)}.previous-${process.pid}-${process.hrtime.bigint()}`
  );
  let movedExisting = false;

  try {
    if (pathExists(destination)) {
      fs.renameSync(destination, backup);
      movedExisting = true;
    }
    fs.renameSync(staging, destination);
  } catch (error) {
    if (movedExisting && !pathExists(destination) && pathExists(backup)) {
      try {
        fs.renameSync(backup, destination);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Failed to publish engine payload and restore the previous payload at ${destination}`
        );
      }
    } else if (movedExisting && pathExists(destination) && pathExists(backup)) {
      // Another provisioner won the promotion race; discard only our backup.
      await removePathWithRetry(backup);
    }
    throw error;
  }

  if (movedExisting) await removePathWithRetry(backup);
  await removeOrphanedPreviousPayloads(destination);
}
