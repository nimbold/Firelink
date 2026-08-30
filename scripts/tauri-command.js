#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createEngineWorkspace,
  engineResourceConfig,
  removeEngineWorkspace,
  resolveTargetTriple,
} from './engine-workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tauriCli = path.join(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const ENGINE_TREE_COMMANDS = new Set(['dev', 'build', 'bundle']);

export function commandUsesEngineTree(args) {
  return args.some(argument => ENGINE_TREE_COMMANDS.has(argument));
}

export function commandIsStandaloneBundle(args) {
  return args.includes('bundle');
}

function signalExitCode(signal) {
  return {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  }[signal] ?? 1;
}

const args = process.argv.slice(2);
const usesEngineWorkspace = commandUsesEngineTree(args);
let engineWorkspace;
let child;
let receivedSignal;
let escalationTimer;
let interruptedProcessPid;

function windowsTaskkillPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
}

function forceTerminateProcessTree(pid) {
  if (!pid) return Promise.resolve();

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        console.error(`[WARN] Could not force-terminate the Tauri process group: ${error.message}`);
      }
    }
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let killer;
    try {
      killer = spawn(
        windowsTaskkillPath(),
        ['/PID', String(pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch {
      finish();
      return;
    }
    killer.once('error', finish);
    killer.once('close', finish);
  });
}

function handleSignal(signal) {
  receivedSignal ??= signal;
  if (child && child.exitCode === null && child.signalCode === null) {
    const pid = child.pid;
    interruptedProcessPid ??= pid;
    if (process.platform === 'win32') {
      // Node's Windows child.kill() does not reliably terminate descendants.
      // taskkill's process-tree mode is the OS-supported equivalent of the
      // POSIX process-group kill used below.
      void forceTerminateProcessTree(pid);
      return;
    }
    try {
      if (!pid) {
        child.kill(signal);
      } else {
        process.kill(-pid, signal);
      }
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        console.error(`[WARN] Could not terminate the Tauri process group: ${error.message}`);
      }
    }
    if (!escalationTimer) {
      escalationTimer = setTimeout(() => {
        void forceTerminateProcessTree(pid);
      }, 2_000);
      escalationTimer.unref();
    }
    return;
  }

  process.exitCode = signalExitCode(signal);
}

function runChild(command, commandArgs, env) {
  const spawned = spawn(command, commandArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  child = spawned;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = callback => value => {
      if (settled) return;
      settled = true;
      if (child === spawned) child = undefined;
      callback(value);
    };
    spawned.once('error', settle(reject));
    spawned.once('close', (code, signal) => settle(resolve)({ code, signal }));
  });
}

async function run() {
  const handlers = new Map(['SIGHUP', 'SIGINT', 'SIGTERM'].map(signal => [
    signal,
    () => handleSignal(signal),
  ]));
  for (const [signal, handler] of handlers) process.once(signal, handler);

  try {
    const env = { ...process.env };
    let commandArgs = args;
    if (usesEngineWorkspace) {
      const target = resolveTargetTriple(args, env);
      engineWorkspace = createEngineWorkspace(target);
      env.FIRELINK_ENGINE_WORKSPACE = engineWorkspace.workspace;
      env.FIRELINK_ENGINE_OUTPUT_ROOT = engineWorkspace.outputRoot;
      env.FIRELINK_ENGINE_RUNTIME_ROOT = engineWorkspace.runtimeRoot;
      env.FIRELINK_TARGET_TRIPLE = target;

      if (
        (args.includes('build') || args.includes('bundle'))
        && env.FIRELINK_SKIP_ENGINE_RESOURCE !== '1'
      ) {
        commandArgs = [...args, '--config', engineResourceConfig(engineWorkspace.outputRoot)];
      }
    }

    if (receivedSignal) return;

    if (usesEngineWorkspace && commandIsStandaloneBundle(args) && env.FIRELINK_SKIP_ENGINE_RESOURCE !== '1') {
      let preparation;
      try {
        preparation = await runChild(
          process.execPath,
          [path.join(repoRoot, 'scripts', 'prepare-tauri-engines.js')],
          env,
        );
      } catch (error) {
        throw new Error(`Engine preparation failed: ${error.message}`, { cause: error });
      }
      if (receivedSignal) return;
      if (preparation.signal) {
        process.exitCode = signalExitCode(preparation.signal);
        return;
      }
      if (preparation.code !== 0) {
        process.exitCode = preparation.code ?? 1;
        return;
      }
      env.FIRELINK_ENGINE_BUNDLE_PREPARED = '1';
    }

    if (receivedSignal) return;

    const result = await runChild(process.execPath, [tauriCli, ...commandArgs], env);

    if (receivedSignal) {
      process.exitCode = signalExitCode(receivedSignal);
    } else if (result.signal) {
      process.exitCode = signalExitCode(result.signal);
    } else {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (escalationTimer) clearTimeout(escalationTimer);
    if (interruptedProcessPid) await forceTerminateProcessTree(interruptedProcessPid);
    if (engineWorkspace) {
      try {
        await removeEngineWorkspace(engineWorkspace.workspace);
      } catch (error) {
        console.error(`[WARN] Could not remove the temporary engine workspace: ${error.message}`);
      }
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run().catch(error => {
    console.error(`[FAIL] Tauri command failed: ${error.message}`);
    process.exitCode = 1;
  });
}
