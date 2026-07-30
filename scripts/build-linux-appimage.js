#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
let activeChild;
let receivedSignal;

export const APPIMAGE_CONFIG = JSON.stringify({
  bundle: {
    resources: {
      // Tauri merges --config values using JSON Merge Patch. An omitted key
      // would leave the base engine resource enabled; null explicitly removes
      // it for this first packaging pass. The verified payload is added back
      // by repack-linux-appimage-engines.js after linuxdeploy finishes.
      'engine-dist/': null,
    },
  },
});

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function signalExitCode(signal) {
  return {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  }[signal] ?? 1;
}

function npmInvocation(args) {
  if (process.env.npm_execpath) {
    return [process.execPath, [process.env.npm_execpath, ...args]];
  }

  if (process.platform === 'win32') {
    return ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]];
  }

  return ['npm', args];
}

export function appImageBundleArguments(target) {
  return [
    'run',
    'tauri',
    '--',
    'bundle',
    '-vv',
    '--target',
    target,
    '--bundles',
    'appimage',
    '--config',
    APPIMAGE_CONFIG,
  ];
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  activeChild = child;

  return new Promise((resolve, reject) => {
    let settled = false;

    child.once('error', error => {
      if (activeChild === child) activeChild = undefined;
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
  });
}

async function runChecked(command, args, label = command) {
  let result;
  try {
    result = await run(command, args);
  } catch (error) {
    throw new Error(`Failed to run ${label}: ${error.message}`, { cause: error });
  }

  if (result.signal) {
    const error = new Error(`${label} was terminated by ${result.signal}.`);
    error.exitCode = signalExitCode(result.signal);
    throw error;
  }

  if (result.code !== 0) {
    const error = new Error(`${label} exited with status ${result.code}.`);
    error.exitCode = result.code ?? 1;
    throw error;
  }

  return result;
}

function assertSafeTarget(target) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target)) {
    throw new Error(`Invalid target triple: ${target}`);
  }
}

async function main() {
  const target = argValue('--target') || process.env.FIRELINK_TARGET_TRIPLE;
  if (!target) {
    throw new Error('Pass --target <triple>.');
  }
  assertSafeTarget(target);

  // The native-package build has already staged and verified the engines.
  // Verify once more before creating the AppImage so a failed preparation
  // cannot produce an artifact that later appears valid only because its
  // payload is absent.
  await runChecked(
    process.execPath,
    ['scripts/verify-binaries.js', '--staged', '--target', target],
    'staged engine verification'
  );

  if (receivedSignal) {
    const error = new Error(`Build interrupted by ${receivedSignal}.`);
    error.exitCode = signalExitCode(receivedSignal);
    throw error;
  }

  const [npmCommand, npmArgs] = npmInvocation(appImageBundleArguments(target));
  await runChecked(npmCommand, npmArgs, 'Tauri AppImage bundling');

  if (receivedSignal) {
    const error = new Error(`Build interrupted by ${receivedSignal}.`);
    error.exitCode = signalExitCode(receivedSignal);
    throw error;
  }

  console.log(`Built the Linux AppImage from the existing ${target} release binary.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const handleSignal = signal => {
    receivedSignal ??= signal;

    // npm and Tauri can have Rust/packaging descendants. On POSIX, the child
    // is a detached process-group leader, so signal the whole group instead of
    // leaving descendants running after the wrapper exits.
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      try {
        if (process.platform === 'win32' || !activeChild.pid) {
          activeChild.kill(signal);
        } else {
          process.kill(-activeChild.pid, signal);
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          console.error(`[WARN] Could not terminate the AppImage build process group: ${error.message}`);
        }
      }
    } else {
      process.exitCode = signalExitCode(signal);
    }
  };

  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.once(signal, () => handleSignal(signal));
  }

  main()
    .catch(error => {
      console.error(`[FAIL] ${error.message}`);
      process.exitCode = error.exitCode ?? 1;
    })
    .finally(() => {
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
        process.removeAllListeners(signal);
      }
    });
}
