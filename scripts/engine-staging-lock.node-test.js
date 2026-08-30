import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  acquireExclusiveFileLock,
  assertExclusiveFileLockHeld,
  readExclusiveFileLockOwner,
} from './engine-staging-lock.js';

const childOutputStates = new WeakMap();

function temporaryLockPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-stage-lock-'));
  return path.join(directory, 'engine-dist.lock');
}

function waitForOutput(child, expected) {
  const state = childOutputStates.get(child);
  assert.ok(state, 'child output tracking must be installed before waiting');
  if (state.output.includes(expected)) return Promise.resolve(state.output);
  if (state.error) return Promise.reject(state.error);
  if (state.exit) {
    return Promise.reject(new Error(
      `lock child exited before '${expected}' (code=${state.exit.code}, signal=${state.exit.signal})`,
    ));
  }

  return new Promise((resolve, reject) => {
    state.waiters.push({ expected, resolve, reject });
  });
}

function trackChildOutput(child) {
  const state = { error: null, exit: null, output: '', waiters: [] };
  childOutputStates.set(child, state);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    state.output += chunk;
    for (const waiter of state.waiters.splice(0)) {
      if (state.output.includes(waiter.expected)) {
        waiter.resolve(state.output);
      } else {
        state.waiters.push(waiter);
      }
    }
  });
  child.once('error', error => {
    state.error = error;
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  });
  child.once('exit', (code, signal) => {
    state.exit = { code, signal };
    const error = new Error(`lock child exited before a requested output (code=${code}, signal=${signal})`);
    for (const waiter of state.waiters.splice(0)) waiter.reject(error);
  });
}

function spawnLockChild(lockPath) {
  const moduleUrl = pathToFileURL(path.resolve('scripts/engine-staging-lock.js')).href;
  const source = `
import { acquireExclusiveFileLock } from ${JSON.stringify(moduleUrl)};
process.stdout.write('started\\n');
const release = await acquireExclusiveFileLock(process.argv[1], { timeoutMs: 5_000 });
process.stdout.write('acquired\\n');
process.stdin.once('data', () => {
  release();
  process.exit(0);
});
process.stdin.resume();
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, lockPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  trackChildOutput(child);
  return child;
}

test('exclusive staging lock waits for a live owner and releases idempotently', async () => {
  const lockPath = temporaryLockPath();
  const releaseFirst = await acquireExclusiveFileLock(lockPath, { timeoutMs: 1_000 });
  const secondAcquisition = acquireExclusiveFileLock(lockPath, {
    timeoutMs: 1_000,
  });

  assert.equal(fs.existsSync(lockPath), true);
  releaseFirst();
  releaseFirst();

  const releaseSecond = await secondAcquisition;
  assert.equal(fs.existsSync(lockPath), true);
  releaseSecond();
  assert.equal(fs.existsSync(lockPath), false);
});

test('exclusive staging lock recovers empty and malformed legacy records', async () => {
  for (const contents of ['', '{not-json']) {
    const lockPath = temporaryLockPath();
    fs.writeFileSync(lockPath, contents);

    const release = await acquireExclusiveFileLock(lockPath, { timeoutMs: 1_000 });
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(owner.pid, process.pid);
    release();
    assert.equal(fs.existsSync(lockPath), false);
  }
});

test('exclusive staging lock serializes separate processes', async () => {
  const lockPath = temporaryLockPath();
  const first = spawnLockChild(lockPath);
  let second;
  try {
    await waitForOutput(first, 'acquired\n');
    second = spawnLockChild(lockPath);
    await waitForOutput(second, 'started\n');

    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(owner.pid, first.pid);
    first.stdin.write('\n');
    await once(first, 'exit');
    await waitForOutput(second, 'acquired\n');
    second.stdin.write('\n');
    await once(second, 'exit');
  } finally {
    for (const child of [first, second]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }
});

test('exclusive staging lock recovers after an owner is force-killed', async () => {
  const lockPath = temporaryLockPath();
  const owner = spawnLockChild(lockPath);
  try {
    await waitForOutput(owner, 'acquired\n');
    assert.equal(owner.kill('SIGKILL'), true);
    await once(owner, 'exit');

    const release = await acquireExclusiveFileLock(lockPath, { timeoutMs: 1_000 });
    const replacement = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(replacement.pid, process.pid);
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
  }
});

test('exclusive staging lock recovers a lock owned by a dead process', async () => {
  const lockPath = temporaryLockPath();
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999_999_999,
    token: 'dead-owner',
  }));

  const release = await acquireExclusiveFileLock(lockPath, { timeoutMs: 1_000 });
  const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, 'dead-owner');
  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('staging lock release fails closed when ownership changes', async () => {
  const lockPath = temporaryLockPath();
  const release = await acquireExclusiveFileLock(lockPath, { timeoutMs: 1_000 });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'other-owner' }));

  assert.throws(() => release(), /ownership changed/);
  fs.unlinkSync(lockPath);
});

test('inherited staging lock validation rejects a released lease', async () => {
  const lockPath = temporaryLockPath();
  const release = await acquireExclusiveFileLock(lockPath, { timeoutMs: 1_000 });
  const owner = readExclusiveFileLockOwner(lockPath);
  assert.doesNotThrow(() => assertExclusiveFileLockHeld(lockPath, owner));
  release();

  assert.throws(() => assertExclusiveFileLockHeld(lockPath, owner), /owner record is unavailable/);
});
