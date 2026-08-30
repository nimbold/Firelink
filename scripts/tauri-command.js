#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireExclusiveFileLock,
  readExclusiveFileLockOwner,
} from './engine-staging-lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tauriCli = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const stagingLockPath = path.join(repoRoot, 'src-tauri', 'engine-dist.lock');
const ENGINE_TREE_COMMANDS = new Set(['dev', 'build', 'bundle']);

export function commandUsesEngineTree(args) {
  return args.some(argument => ENGINE_TREE_COMMANDS.has(argument));
}

function signalExitCode(signal) {
  return {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  }[signal] ?? 1;
}

const args = process.argv.slice(2);
const holdsEngineLock = commandUsesEngineTree(args);
let releaseEngineLock;
let child;

function handleSignal(signal) {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        console.error(`[WARN] Could not terminate Tauri: ${error.message}`);
      }
    }
    return;
  }

  // No child has started yet, so there is no packaging work to preserve. If
  // lock acquisition was interrupted after ownership was granted, release it
  // before exiting; otherwise exit promptly instead of waiting out the lock.
  try {
    releaseEngineLock?.();
  } catch (error) {
    console.error(`[WARN] Could not release the engine staging lock: ${error.message}`);
  }
  process.exit(signalExitCode(signal));
}

async function run() {
  const handlers = new Map(['SIGHUP', 'SIGINT', 'SIGTERM'].map(signal => [
    signal,
    () => handleSignal(signal),
  ]));
  for (const [signal, handler] of handlers) process.once(signal, handler);

  try {
    const env = { ...process.env };
    if (holdsEngineLock) {
      releaseEngineLock = await acquireExclusiveFileLock(stagingLockPath);
      const owner = readExclusiveFileLockOwner(stagingLockPath);
      // beforeBuildCommand and beforeDevCommand run as child processes. The
      // wrapper keeps the lock until Tauri has finished consuming resources;
      // nested staging/verifying must therefore use this held lease instead
      // of trying to acquire the same path again.
      env.FIRELINK_ENGINE_STAGING_LOCK_PID = String(owner.pid);
      env.FIRELINK_ENGINE_STAGING_LOCK_TOKEN = owner.token;
    }

    child = spawn(process.execPath, [tauriCli, ...args], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    if (result.signal) {
      process.exitCode = signalExitCode(result.signal);
    } else {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    releaseEngineLock?.();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run().catch(error => {
    console.error(`[FAIL] Tauri command failed: ${error.message}`);
    process.exitCode = 1;
  });
}
