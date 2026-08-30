import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [25, 50, 100, 250, 500];
const RETRYABLE_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

function readLock(lockPath) {
  let contents;
  try {
    contents = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const owner = JSON.parse(contents);
    if (
      !Number.isSafeInteger(owner?.pid)
      || owner.pid <= 0
      || typeof owner.token !== 'string'
      || owner.token.length === 0
    ) {
      return { malformed: true };
    }
    return { owner };
  } catch {
    return { malformed: true };
  }
}

async function removeStaleLock(lockPath) {
  const quarantinePath = `${lockPath}.stale-${process.pid}-${process.hrtime.bigint()}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Rename is the compare-and-remove operation: another waiter cannot
      // delete a newly acquired lock after this path has changed owners.
      fs.renameSync(lockPath, quarantinePath);
      break;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return false;
      if (!RETRYABLE_RENAME_ERRORS.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) {
        return false;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  try {
    fs.unlinkSync(quarantinePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

function releaseLock(lockPath, token) {
  const currentLock = readLock(lockPath);
  if (!currentLock) return;
  if (currentLock.malformed) {
    throw new Error(`Cannot release staging lock with an invalid owner record: ${lockPath}`);
  }
  const owner = currentLock.owner;
  if (owner.token !== token || owner.pid !== process.pid) {
    throw new Error(`Staging lock ownership changed before release: ${lockPath}`);
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function createLock(lockPath, owner) {
  const temporaryPath = `${lockPath}.owner-${owner.token}`;
  let temporaryCreated = false;
  try {
    // Write the complete record away from the contested path, then publish it
    // with a hard link. Unlike rename, link never replaces an existing lock.
    fs.writeFileSync(temporaryPath, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    temporaryCreated = true;
    fs.linkSync(temporaryPath, lockPath);
  } finally {
    if (temporaryCreated) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

export function readExclusiveFileLockOwner(lockPath) {
  const currentLock = readLock(path.resolve(lockPath));
  if (!currentLock?.owner) {
    throw new Error(`Staging lock owner record is unavailable: ${path.resolve(lockPath)}`);
  }
  return currentLock.owner;
}

export function assertExclusiveFileLockHeld(lockPath, expectedOwner) {
  if (
    !Number.isSafeInteger(expectedOwner?.pid)
    || expectedOwner.pid <= 0
    || typeof expectedOwner.token !== 'string'
    || expectedOwner.token.length === 0
  ) {
    throw new Error(`Invalid inherited staging lock owner: ${path.resolve(lockPath)}`);
  }

  const owner = readExclusiveFileLockOwner(lockPath);
  if (
    owner.pid !== expectedOwner.pid
    || owner.token !== expectedOwner.token
    || !isProcessAlive(owner.pid)
  ) {
    throw new Error(`Inherited staging lock is no longer held: ${path.resolve(lockPath)}`);
  }
}

/**
 * Serializes operations that replace the shared engine-dist directory.
 * Returns an idempotent release function after the caller owns the lock.
 */
export async function acquireExclusiveFileLock(lockPath, options = {}) {
  const resolvedPath = path.resolve(lockPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const token = `${process.pid}-${process.hrtime.bigint()}`;
  const owner = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      createLock(resolvedPath, owner);

      let released = false;
      return () => {
        if (released) return;
        releaseLock(resolvedPath, token);
        released = true;
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      const currentLock = readLock(resolvedPath);
      if (currentLock?.malformed) {
        if (await removeStaleLock(resolvedPath)) continue;
      } else if (currentLock?.owner && !isProcessAlive(currentLock.owner.pid)) {
        if (await removeStaleLock(resolvedPath)) continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const ownerDescription = currentLock?.owner?.pid
          ? ` owned by PID ${currentLock.owner.pid}`
          : ' with an unreadable owner record';
        throw new Error(`Timed out waiting for staging lock ${resolvedPath}${ownerDescription}`);
      }

      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      await sleep(delay);
    }
  }
}
