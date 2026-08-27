#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const executableArg = argValue('--executable');
if (!executableArg) {
  console.error('Pass --executable <path>.');
  process.exit(1);
}

const executable = path.resolve(executableArg);
const assertNoVisibleChildWindows = process.argv.includes('--assert-no-visible-child-windows');
const assertPortableData = process.argv.includes('--assert-portable-data');
const MAX_STABILITY_MS = 60_000;
const MAX_CONSECUTIVE_STABILITY_FAILURES = 3;
const stabilityMsValue = Number.parseInt(argValue('--stability-ms') || '5000', 10);
const stabilityMs = Number.isFinite(stabilityMsValue) && stabilityMsValue >= 0
  ? Math.min(stabilityMsValue, MAX_STABILITY_MS)
  : 5000;
const READY_PORT_TIMEOUT_MS = 500;
const child = spawn(executable, [], {
  cwd: process.env.RUNNER_TEMP || process.env.TMPDIR || process.cwd(),
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    FIRELINK_SMOKE_TEST: '1',
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
    GDK_BACKEND: 'x11',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
let spawnError = null;
let readyPort = null;
let childExit = null;

child.on('error', error => {
  spawnError = error;
});

child.on('exit', (code, signal) => {
  childExit = { code, signal };
  if (readyPort === null) {
    console.error(`Child exited prematurely with code ${code} signal ${signal}`);
  }
});

child.stderr.on('data', data => {
  stderr += data.toString();
});
child.stdout.on('data', () => {});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findReadyPort() {
  for (let attempt = 0; attempt < 200 && readyPort === null; attempt += 1) {
    if (spawnError || childExit) {
      break;
    }

    const ports = Array.from({ length: 11 }, (_, index) => 6412 + index);
    const matches = await Promise.all(ports.map(async port => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ping`, {
          signal: AbortSignal.timeout(READY_PORT_TIMEOUT_MS),
        });
        const matchesChild = response.headers.get('x-firelink-server') === '1'
          && response.headers.get('x-firelink-smoke-process-id') === String(child.pid);
        await response.body?.cancel();
        return matchesChild ? port : null;
      } catch {
        return null;
      }
    }));
    readyPort = matches.find(port => port !== null) ?? null;

    if (readyPort === null) {
      await sleep(250);
    }
  }
}

async function checkReadyPort() {
  if (readyPort === null) return false;

  try {
    const response = await fetch(`http://127.0.0.1:${readyPort}/ping`, {
      signal: AbortSignal.timeout(READY_PORT_TIMEOUT_MS),
    });
    const matchesChild = response.headers.get('x-firelink-server') === '1'
      && response.headers.get('x-firelink-smoke-process-id') === String(child.pid);
    await response.body?.cancel();
    return matchesChild;
  } catch {
    return false;
  }
}

async function assertStableReady() {
  const deadline = Date.now() + stabilityMs;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`Packaged Firelink failed during stability check: ${spawnError.message}`);
    }
    if (childExit) {
      throw new Error(
        `Packaged Firelink exited during stability check with code ${childExit.code} signal ${childExit.signal}.`,
      );
    }
    if (await checkReadyPort()) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_STABILITY_FAILURES) {
        throw new Error('Packaged Firelink stopped exposing its extension ping endpoint during stability check.');
      }
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }

  if (childExit) {
    throw new Error(
      `Packaged Firelink exited during stability check with code ${childExit.code} signal ${childExit.signal}.`,
    );
  }
  if (!await checkReadyPort() && !await checkReadyPort()) {
    throw new Error('Packaged Firelink was not healthy at the end of its stability check.');
  }
}

function assertNoVisibleWindows(rootPid) {
  if (process.platform !== 'win32') {
    return;
  }

  const script = `
$root = ${rootPid}
$all = Get-CimInstance Win32_Process
$pending = @($root)
$descendants = @()
while ($pending.Count -gt 0) {
  $parent = $pending[0]
  if ($pending.Count -eq 1) {
    $pending = @()
  } else {
    $pending = $pending[1..($pending.Count - 1)]
  }

  $children = @($all | Where-Object { $_.ParentProcessId -eq $parent })
  foreach ($child in $children) {
    $descendants += $child.ProcessId
    $pending += $child.ProcessId
  }
}

$visible = foreach ($childPid in $descendants) {
  $process = Get-Process -Id $childPid -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    "$($process.ProcessName)($childPid)"
  }
}

if ($visible.Count -gt 0) {
  Write-Error "Visible child process windows detected: $($visible -join ', ')"
  exit 1
}
`;

  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    const detail = [error.stdout?.toString(), error.stderr?.toString()].filter(Boolean).join('\n').trim();
    throw new Error(detail || 'Visible child process window check failed.');
  }
}

function waitForChildExit(timeoutMs) {
  if (childExit) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function isProcessGroupAlive(rootPid) {
  if (process.platform === 'win32') {
    return false;
  }

  try {
    process.kill(-rootPid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(rootPid, timeoutMs) {
  if (process.platform === 'win32') {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(rootPid)) {
      return true;
    }
    await sleep(100);
  }

  return !isProcessGroupAlive(rootPid);
}

function windowsBundleRoot() {
  return path.dirname(executable).replaceAll("'", "''");
}

function windowsBundleProcessIds() {
  const root = windowsBundleRoot();
  const script = `
$root = '${root}'
$rootPrefix = $root.TrimEnd('\\') + '\\'
Get-CimInstance Win32_Process |
  Where-Object {
    $commandLine = $_.CommandLine
    $commandLine -and $commandLine.TrimStart([char]34).StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object -ExpandProperty ProcessId
`;
  try {
    const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map(value => Number.parseInt(value.trim(), 10))
      .filter(Number.isInteger);
  } catch {
    return null;
  }
}

function terminateWindowsBundleProcesses() {
  const root = windowsBundleRoot();
  const script = `
$root = '${root}'
$rootPrefix = $root.TrimEnd('\\') + '\\'
Get-CimInstance Win32_Process |
  Where-Object {
    $commandLine = $_.CommandLine
    $commandLine -and $commandLine.TrimStart([char]34).StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {}
}

async function waitForWindowsBundleExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processIds = windowsBundleProcessIds();
    if (processIds?.length === 0) {
      return true;
    }
    await sleep(100);
  }
  return windowsBundleProcessIds()?.length === 0;
}

async function terminateChild() {
  if (!child.pid) {
    return true;
  }

  const childWasRunning = !childExit;
  if (process.platform === 'win32') {
    if (childWasRunning) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {}
    }
    const childExited = await waitForChildExit(10000);
    const bundleExited = await waitForWindowsBundleExit(5000);
    if (childExited && bundleExited) {
      return true;
    }
    terminateWindowsBundleProcesses();
    return await waitForChildExit(5000) && await waitForWindowsBundleExit(5000);
  }

  if (childWasRunning && !childExit) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      if (!childExit) {
        child.kill('SIGTERM');
      }
    }
  }
  if (await waitForChildExit(5000) && await waitForProcessGroupExit(child.pid, 5000)) {
    return true;
  }

  if (!childWasRunning || childExit) {
    return false;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    if (!childExit) {
      child.kill('SIGKILL');
    }
  }
  return await waitForChildExit(5000) && await waitForProcessGroupExit(child.pid, 5000);
}

async function assertPortableStorage() {
  const portableRoot = path.dirname(executable);
  const marker = path.join(portableRoot, 'portable.flag');
  const database = path.join(portableRoot, 'data', 'firelink.sqlite');
  const webviewData = path.join(portableRoot, 'data', 'webview');

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const markerReady = fs.statSync(marker, { throwIfNoEntry: false })?.isFile();
    const databaseReady = fs.statSync(database, { throwIfNoEntry: false })?.isFile();
    const webviewReady = fs.statSync(webviewData, { throwIfNoEntry: false })?.isDirectory();
    if (markerReady && databaseReady && webviewReady) {
      return;
    }
    await sleep(250);
  }

  throw new Error(
    `Portable storage was not ready: marker=${marker}, database=${database}, webview=${webviewData}`,
  );
}

try {
  await findReadyPort();

  if (readyPort === null) {
    if (spawnError) {
      throw new Error(`Packaged Firelink failed to start: ${spawnError.message}`);
    } else if (childExit) {
      throw new Error(
        `Packaged Firelink exited before exposing extension ping endpoint with code ${childExit.code} signal ${childExit.signal}.`,
      );
    } else {
      throw new Error(`Packaged Firelink did not expose extension ping endpoint. Stderr:\n${stderr.slice(-1000)}`);
    }
  }

  if (assertNoVisibleChildWindows) {
    assertNoVisibleWindows(child.pid);
  }
  if (assertPortableData) {
    await assertPortableStorage();
  }

  await assertStableReady();

  console.log(`Packaged Firelink smoke passed on 127.0.0.1:${readyPort} with ${stabilityMs}ms stability`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!await terminateChild()) {
    console.error('Packaged Firelink could not be terminated cleanly; refusing to report smoke success.');
    process.exitCode = 1;
  }
}
