#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/smoke-torrent.js [--binary PATH] [--failure-paths] [--keep-temp]');
  process.exit(0);
}

const keepTemp = process.argv.includes('--keep-temp');
const runFailurePaths = process.argv.includes('--failure-paths');
const arch = { x64: 'x86_64', arm64: 'aarch64' }[os.arch()];
const platform = {
  darwin: 'apple-darwin',
  linux: 'unknown-linux-gnu',
  win32: 'pc-windows-msvc',
}[os.platform()];
if (!arch || !platform) {
  throw new Error(`Unsupported host: ${os.arch()} / ${os.platform()}`);
}
const targetTriple = `${arch}-${platform}`;
const executableName = `aria2c-${targetTriple}${os.platform() === 'win32' ? '.exe' : ''}`;
const binaryPath = path.resolve(
  argumentValue('--binary') || path.join(repoRoot, 'src-tauri', 'binaries', executableName),
);

const runtimeAbortController = new AbortController();
const sleep = (milliseconds, signal = runtimeAbortController.signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error('Torrent runtime smoke was interrupted'));
    return;
  }
  let timer;
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(new Error('Torrent runtime smoke was interrupted'));
  };
  timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener('abort', onAbort, { once: true });
});
const activeDaemons = new Set();
let runtimeTempRoot;
let runtimeTracker;
let cleanupPromise;
let signalTerminationRequested = false;

class DaemonExitedError extends Error {}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : null;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('Could not reserve a local port');
  return port;
}

function bencode(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  }
  if (value instanceof Map || (value && typeof value === 'object')) {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    entries.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return Buffer.concat([
      Buffer.from('d'),
      ...entries.flatMap(([key, child]) => [bencode(String(key)), bencode(child)]),
      Buffer.from('e'),
    ]);
  }
  throw new Error(`Unsupported bencode value: ${typeof value}`);
}

function decodeBencode(bytes) {
  let position = 0;
  const parse = () => {
    const marker = bytes[position];
    if (marker === 0x69) {
      position += 1;
      const end = bytes.indexOf(0x65, position);
      if (end < 0) throw new Error('Malformed integer in saved torrent');
      const value = Number(bytes.subarray(position, end).toString('ascii'));
      position = end + 1;
      return value;
    }
    if (marker === 0x6c) {
      position += 1;
      const values = [];
      while (bytes[position] !== 0x65) values.push(parse());
      position += 1;
      return values;
    }
    if (marker === 0x64) {
      position += 1;
      const values = new Map();
      while (bytes[position] !== 0x65) {
        const key = parse();
        if (!Buffer.isBuffer(key)) throw new Error('Malformed dictionary key in saved torrent');
        values.set(key.toString('utf8'), parse());
      }
      position += 1;
      return values;
    }
    if (marker >= 0x30 && marker <= 0x39) {
      const separator = bytes.indexOf(0x3a, position);
      if (separator < 0) throw new Error('Malformed byte string in saved torrent');
      const length = Number(bytes.subarray(position, separator).toString('ascii'));
      position = separator + 1;
      const value = bytes.subarray(position, position + length);
      if (value.length !== length) throw new Error('Truncated byte string in saved torrent');
      position += length;
      return value;
    }
    throw new Error(`Unexpected bencode marker ${String.fromCharCode(marker || 0)}`);
  };
  const value = parse();
  if (position !== bytes.length) throw new Error('Saved torrent contains trailing data');
  return value;
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest();
}

function createRuntimeTorrent(trackerUrl) {
  const name = 'firelink-torrent-runtime';
  const pieceLength = 16 * 1024;
  const files = [
    {
      path: 'selected.bin',
      data: Buffer.alloc(256 * 1024, 0x53),
    },
    {
      path: 'skipped.bin',
      data: Buffer.from('this file must not be selected\n'),
    },
  ];
  const piecesSource = Buffer.concat(files.map(file => file.data));
  const pieces = [];
  for (let offset = 0; offset < piecesSource.length; offset += pieceLength) {
    pieces.push(sha1(piecesSource.subarray(offset, offset + pieceLength)));
  }
  const info = new Map([
    ['files', files.map(file => new Map([
      ['length', file.data.length],
      ['path', [file.path]],
    ]))],
    ['name', name],
    ['piece length', pieceLength],
    ['pieces', Buffer.concat(pieces)],
  ]);
  const torrent = new Map([
    ['announce', trackerUrl],
    ['info', info],
  ]);
  const bytes = bencode(torrent);
  const infoHash = sha1(bencode(info)).toString('hex');
  return { bytes, infoHash, name, files };
}

function startTracker(seederPort) {
  let activeSeederPort = seederPort;
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = request.url ? new URL(request.url, 'http://127.0.0.1').pathname : undefined;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname !== '/announce') {
      response.writeHead(404).end();
      return;
    }
    const peer = Buffer.alloc(6);
    peer[0] = 127;
    peer[1] = 0;
    peer[2] = 0;
    peer[3] = 1;
    peer.writeUInt16BE(activeSeederPort, 4);
    const body = bencode(new Map([
      ['complete', 1],
      ['incomplete', 0],
      ['interval', 2],
      ['min interval', 1],
      ['peers', peer],
    ]));
    response.writeHead(200, {
      'Content-Length': body.length,
      'Content-Type': 'text/plain',
    });
    response.end(body);
  });
  return {
    server,
    setSeederPort(port) {
      activeSeederPort = port;
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine local server port');
  return address.port;
}

function daemonEnvironment() {
  const libraries = path.join(path.dirname(binaryPath), 'aria2-libs');
  return fs.existsSync(libraries)
    ? { ...process.env, OPENSSL_MODULES: libraries }
    : process.env;
}

async function rpc(port, secret, method, params = [], { signal = runtimeAbortController.signal } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `firelink-torrent-${Date.now()}`,
      method,
      params: [`token:${secret}`, ...params],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (!Object.hasOwn(body, 'result')) throw new Error(`${method}: response has no result`);
  return body.result;
}

async function waitFor(description, check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (runtimeAbortController.signal.aborted) throw new Error('Torrent runtime smoke was interrupted');
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
      if (runtimeAbortController.signal.aborted || error instanceof DaemonExitedError) throw error;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function startDaemon({ name, rpcPort, listenPort, directory, extraArgs = [] }) {
  const maxAttempts = 3;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selectedRpcPort = attempt === 0 ? rpcPort : await findAvailablePort();
    const selectedListenPort = listenPort === undefined
      ? undefined
      : attempt === 0 ? listenPort : await findAvailablePort();
    const secret = `firelink-${name}-${crypto.randomUUID()}`;
    const stderr = [];
    const child = spawn(binaryPath, [
      '--enable-rpc=true',
      `--rpc-listen-port=${selectedRpcPort}`,
      '--rpc-listen-all=false',
      `--rpc-secret=${secret}`,
      `--dir=${directory}`,
      '--file-allocation=none',
      '--enable-dht=false',
      '--enable-peer-exchange=false',
      '--bt-enable-lpd=false',
      '--console-log-level=error',
      '--quiet=true',
      ...(selectedListenPort ? [`--listen-port=${selectedListenPort}`] : []),
      ...extraArgs,
    ], {
      env: daemonEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => stderr.push(chunk.toString()));
    let exit;
    child.once('exit', (code, signal) => { exit = { code, signal }; });
    child.once('error', error => { exit = { error }; });
    const daemon = {
      child,
      secret,
      stderr,
      rpcPort: selectedRpcPort,
      listenPort: selectedListenPort,
    };
    activeDaemons.add(daemon);
    try {
      await waitFor(`${name} Aria2 RPC`, async () => {
        if (exit) throw new DaemonExitedError(`${name} exited: ${exit.error?.message || `${exit.code}/${exit.signal}`}`);
        try {
          await rpc(selectedRpcPort, secret, 'aria2.getVersion');
          return true;
        } catch {
          return false;
        }
      }, 10000);
      return daemon;
    } catch (error) {
      lastError = error;
      const detail = `${error.message}\n${stderr.join('')}`;
      await stopDaemon(daemon);
      if (!/address already in use|failed to bind|could not bind|listen failed/i.test(detail)) {
        throw error;
      }
    }
  }
  throw lastError || new Error(`Could not start ${name} Aria2 daemon`);
}

async function stopDaemon(daemon) {
  const child = daemon?.child;
  if (!child) return;
  try {
    if (!childExited(child)) {
      try {
        await rpc(daemon.rpcPort, daemon.secret, 'aria2.shutdown', [], { signal: null });
      } catch {
        // The process may already have exited during cleanup.
      }
    }
    let exited = await waitForChildExit(child, 3000);
    if (!exited) {
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            timeout: 3000,
          });
        } catch {
          // The process may have exited between the wait and taskkill.
        }
      } else {
        child.kill('SIGTERM');
      }
      exited = await waitForChildExit(child, 3000);
    }
    if (!exited) {
      if (process.platform !== 'win32') {
        child.kill('SIGKILL');
        exited = await waitForChildExit(child, 3000);
      }
    }
    if (!exited) {
      throw new Error(`Aria2 daemon process ${child.pid} did not exit after forced cleanup`);
    }
  } finally {
    activeDaemons.delete(daemon);
  }
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise(resolve => server.close(() => resolve()));
}

async function cleanupRuntime() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let cleanupError;
    for (const daemon of [...activeDaemons].reverse()) {
      try {
        await stopDaemon(daemon);
      } catch (error) {
        cleanupError ??= error;
        console.error(`[FAIL] failed to stop Aria2 daemon: ${error.message}`);
      }
    }
    if (runtimeTracker) {
      const tracker = runtimeTracker;
      runtimeTracker = undefined;
      await closeServer(tracker.server);
    }
    if (runtimeTempRoot) {
      const tempRoot = runtimeTempRoot;
      runtimeTempRoot = undefined;
      if (keepTemp || cleanupError) {
        console.log(`[INFO] retained smoke-test directory: ${tempRoot}`);
      } else {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch (error) {
          cleanupError ??= error;
          console.error(`[FAIL] failed to remove smoke-test directory: ${error.message}`);
          console.log(`[INFO] retained smoke-test directory: ${tempRoot}`);
        }
      }
    }
    if (cleanupError) throw cleanupError;
  })();
  return cleanupPromise;
}

async function tellStatus(daemon, gid) {
  return rpc(daemon.rpcPort, daemon.secret, 'aria2.tellStatus', [gid, [
    'status',
    'errorCode',
    'errorMessage',
    'completedLength',
    'totalLength',
    'files',
  ]]);
}

function assertDaemonRunning(daemon) {
  if (childExited(daemon.child)) {
    throw new DaemonExitedError(
      `Aria2 daemon exited: ${daemon.child.exitCode ?? 'null'}/${daemon.child.signalCode ?? 'null'}`,
    );
  }
}

async function waitForTerminal(daemon, gid, timeoutMs = 30000) {
  let lastStatus;
  try {
    return await waitFor(`Aria2 transfer ${gid} to complete`, async () => {
      assertDaemonRunning(daemon);
      lastStatus = await tellStatus(daemon, gid);
      if (lastStatus.status === 'complete') return lastStatus;
      if (lastStatus.status === 'error' || lastStatus.status === 'removed') {
        throw new Error(`transfer ended ${lastStatus.status}: ${lastStatus.errorCode || ''} ${lastStatus.errorMessage || ''}`);
      }
      return false;
    }, timeoutMs);
  } catch (error) {
    const stderr = daemon.stderr?.join('').trim();
    throw new Error(`${error.message}; last status ${JSON.stringify(lastStatus)}${stderr ? `; stderr ${stderr}` : ''}`);
  }
}

async function waitForStatus(daemon, gid, expected, timeoutMs = 10000) {
  return waitFor(`Aria2 transfer ${gid} to become ${expected}`, async () => {
    assertDaemonRunning(daemon);
    const status = await tellStatus(daemon, gid);
    if (status.status === expected) return status;
    if (status.status === 'error' || status.status === 'removed') {
      throw new Error(`transfer ended ${status.status}: ${status.errorCode || ''} ${status.errorMessage || ''}`);
    }
    return false;
  }, timeoutMs);
}

async function waitForDataComplete(daemon, gid, timeoutMs = 30000) {
  let lastStatus;
  try {
    return await waitFor(`Aria2 transfer ${gid} data to complete`, async () => {
      assertDaemonRunning(daemon);
      lastStatus = await tellStatus(daemon, gid);
      if (lastStatus.status === 'error' || lastStatus.status === 'removed') {
        throw new Error(`transfer ended ${lastStatus.status}: ${lastStatus.errorCode || ''} ${lastStatus.errorMessage || ''}`);
      }
      return Number(lastStatus.completedLength) === Number(lastStatus.totalLength) ? lastStatus : false;
    }, timeoutMs);
  } catch (error) {
    const stderr = daemon.stderr?.join('').trim();
    throw new Error(`${error.message}; last status ${JSON.stringify(lastStatus)}${stderr ? `; stderr ${stderr}` : ''}`);
  }
}

async function waitForRemoved(daemon, gid) {
  let lastStatus;
  try {
    return await waitFor(`Aria2 transfer ${gid} to be removed`, async () => {
      assertDaemonRunning(daemon);
      try {
        lastStatus = await tellStatus(daemon, gid);
        return lastStatus.status === 'removed' ? lastStatus : false;
      } catch (error) {
        return /not found|no such download/i.test(error.message) ? true : false;
      }
    }, 10000);
  } catch (error) {
    throw new Error(`${error.message}; last status ${JSON.stringify(lastStatus)}`);
  }
}

async function forceRemoveIfPresent(daemon, gid) {
  try {
    await rpc(daemon.rpcPort, daemon.secret, 'aria2.forceRemove', [gid]);
    return true;
  } catch (error) {
    if (/not found|no such download|active download not found/i.test(error.message)) return false;
    throw error;
  }
}

async function waitForChildExit(child, timeoutMs = 5000) {
  if (childExited(child)) return true;
  return new Promise(resolve => {
    let settled = false;
    let timer;
    let onExit;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(result);
    };
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    onExit = () => finish(true);
    child.once('exit', onExit);
    if (childExited(child)) finish(true);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runFailurePathChecks({ client, tempRoot }) {
  const failureDir = path.join(tempRoot, 'failure');
  fs.mkdirSync(failureDir, { recursive: true });
  const unavailablePort = await findAvailablePort();
  const unavailableInfoHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const unavailableMagnet = `magnet:?xt=urn:btih:${unavailableInfoHash}&dn=unavailable-firelink-fixture&tr=${encodeURIComponent(`http://127.0.0.1:${unavailablePort}/announce`)}`;
  const failureGid = await rpc(client.rpcPort, client.secret, 'aria2.addUri', [[unavailableMagnet], {
    dir: failureDir,
    'bt-metadata-only': 'true',
    'bt-save-metadata': 'true',
    'max-tries': '1',
    'retry-wait': '1',
    'connect-timeout': '1',
    'bt-tracker-connect-timeout': '1',
    timeout: '2',
    'auto-file-renaming': 'false',
  }]);
  let lastStatus;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      lastStatus = await tellStatus(client, failureGid);
      if (lastStatus.status === 'error' || lastStatus.status === 'complete') break;
    } catch {
      break;
    }
    await sleep(100);
  }
  const failureRemoved = await forceRemoveIfPresent(client, failureGid);
  if (failureRemoved) await waitForRemoved(client, failureGid);
  const savedFailureMetadata = fs.readdirSync(failureDir)
    .filter(file => file.toLowerCase().endsWith('.torrent'));
  assert(savedFailureMetadata.length === 0, 'unavailable tracker produced metadata unexpectedly');
  assert(lastStatus?.status !== 'complete', 'unavailable tracker completed a metadata probe unexpectedly');
  console.log(`[OK] unavailable tracker was cleaned up without metadata (${lastStatus?.status || 'gone'})`);

  const exitDir = path.join(tempRoot, 'daemon-exit');
  fs.mkdirSync(exitDir, { recursive: true });
  const exitRpcPort = await findAvailablePort();
  const exitDaemon = await startDaemon({
    name: 'exit',
    rpcPort: exitRpcPort,
    listenPort: await findAvailablePort(),
    directory: exitDir,
    extraArgs: ['--seed-time=0'],
  });
  const exitGid = await rpc(exitDaemon.rpcPort, exitDaemon.secret, 'aria2.addUri', [[unavailableMagnet], {
    dir: exitDir,
    'bt-metadata-only': 'true',
    'bt-save-metadata': 'true',
    'max-tries': '1',
    'connect-timeout': '1',
    'bt-tracker-connect-timeout': '1',
    timeout: '15',
  }]);
  assert(exitGid, 'daemon-exit probe did not return a GID');
  exitDaemon.child.kill('SIGTERM');
  assert(await waitForChildExit(exitDaemon.child), 'Aria2 daemon did not exit after termination');
  assert(
    !fs.readdirSync(exitDir).some(file => file.toLowerCase().endsWith('.torrent')),
    'daemon exit left saved metadata in the probe directory',
  );
  console.log('[OK] daemon termination left no saved probe metadata');
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`aria2c binary not found: ${binaryPath}`);
  }

  runtimeTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-torrent-smoke-'));
  try {
    const tempRoot = runtimeTempRoot;
    const seedParent = path.join(tempRoot, 'seed');
    const seedRoot = path.join(seedParent, 'firelink-torrent-runtime');
    const probeDir = path.join(tempRoot, 'probe');
    const finalDir = path.join(tempRoot, 'final');
    const integrityDir = path.join(tempRoot, 'integrity');
    const cancelDir = path.join(tempRoot, 'cancel');
    for (const directory of [seedRoot, probeDir, finalDir, integrityDir, cancelDir]) fs.mkdirSync(directory, { recursive: true });

    const seederListenPort = await findAvailablePort();
    const clientListenPort = await findAvailablePort();
    runtimeTracker = startTracker(seederListenPort);
    const trackerPort = await listen(runtimeTracker.server);
    const torrent = createRuntimeTorrent(`http://127.0.0.1:${trackerPort}/announce`);
    for (const file of torrent.files) fs.writeFileSync(path.join(seedRoot, file.path), file.data);
    const magnet = `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(torrent.name)}&tr=${encodeURIComponent(`http://127.0.0.1:${trackerPort}/announce`)}`;
    const indexOut = [
      `1=${torrent.name}/selected.bin`,
      `2=${torrent.name}/skipped.bin`,
    ];
    const seederRpcPort = await findAvailablePort();
    const seeder = await startDaemon({
      name: 'seeder',
      rpcPort: seederRpcPort,
      listenPort: seederListenPort,
      directory: seedParent,
      extraArgs: ['--seed-time=60', '--seed-ratio=0'],
    });
    runtimeTracker.setSeederPort(seeder.listenPort);
    const seedGid = await rpc(seeder.rpcPort, seeder.secret, 'aria2.addTorrent', [
      torrent.bytes.toString('base64'),
      [],
      {
        dir: seedParent,
        'seed-time': '60',
        'seed-ratio': '0',
        'allow-overwrite': 'true',
        'check-integrity': 'true',
      },
    ]);
    await waitForDataComplete(seeder, seedGid);
    console.log(`[OK] local seeder completed ${seedGid}`);

    const clientRpcPort = await findAvailablePort();
    const client = await startDaemon({
      name: 'client',
      rpcPort: clientRpcPort,
      listenPort: clientListenPort,
      directory: probeDir,
      extraArgs: ['--seed-time=0'],
    });
    const probeGid = await rpc(client.rpcPort, client.secret, 'aria2.addUri', [[magnet], {
      dir: probeDir,
      'bt-metadata-only': 'true',
      'bt-save-metadata': 'true',
      'max-tries': '3',
      'retry-wait': '1',
      'connect-timeout': '5',
      timeout: '15',
      'auto-file-renaming': 'false',
    }]);
    const probeStatus = await waitForTerminal(client, probeGid, 30000);
    assert(probeStatus.status === 'complete', 'magnet metadata probe did not complete');
    const savedTorrentPaths = fs.readdirSync(probeDir)
      .filter(file => file.toLowerCase().endsWith('.torrent'))
      .map(file => path.join(probeDir, file));
    assert(savedTorrentPaths.length === 1, `expected one saved metadata file, found ${savedTorrentPaths.length}`);
    const expectedMetadataPath = path.join(probeDir, `${torrent.infoHash}.torrent`);
    assert(savedTorrentPaths[0] === expectedMetadataPath, `Aria2 saved metadata at an unexpected path: ${savedTorrentPaths[0]}`);
    const savedTorrentBytes = fs.readFileSync(savedTorrentPaths[0]);
    const savedTorrent = decodeBencode(savedTorrentBytes);
    const savedInfo = savedTorrent instanceof Map ? savedTorrent.get('info') : undefined;
    assert(savedInfo instanceof Map, 'saved metadata has no info dictionary');
    assert(sha1(bencode(savedInfo)).toString('hex') === torrent.infoHash, 'saved metadata hash differs from magnet');
    console.log(`[OK] magnet metadata resolved and hash matched ${torrent.infoHash}`);
    const probeRemoved = await forceRemoveIfPresent(client, probeGid);
    if (probeRemoved) await waitForRemoved(client, probeGid);
    fs.rmSync(probeDir, { recursive: true, force: true });
    fs.mkdirSync(probeDir, { recursive: true });
    console.log('[OK] metadata probe was removed after resolution');

    const finalGid = await rpc(client.rpcPort, client.secret, 'aria2.addTorrent', [
      savedTorrentBytes.toString('base64'),
      [],
      {
        dir: finalDir,
        'select-file': '1',
        'index-out': indexOut,
        'max-download-limit': '32K',
        'seed-time': '0',
        'auto-file-renaming': 'false',
      },
    ]);
    await waitForStatus(client, finalGid, 'active', 10000);
    await rpc(client.rpcPort, client.secret, 'aria2.forcePause', [finalGid]);
    await waitForStatus(client, finalGid, 'paused', 10000);
    await rpc(client.rpcPort, client.secret, 'aria2.unpause', [finalGid]);
    const finalStatus = await waitForTerminal(client, finalGid, 30000);
    const selectedPath = path.join(finalDir, torrent.name, 'selected.bin');
    const skippedPath = path.join(finalDir, torrent.name, 'skipped.bin');
    assert(fs.existsSync(selectedPath), `selected torrent output is missing: ${selectedPath}`);
    assert(fs.readFileSync(selectedPath).equals(torrent.files[0].data), 'selected torrent output content differs');
    assert(!fs.existsSync(skippedPath), 'unselected torrent output was written');
    const reportedFiles = await rpc(client.rpcPort, client.secret, 'aria2.getFiles', [finalGid]);
    const reportedSelected = reportedFiles.find(file => file.path === selectedPath || file.path.endsWith('/selected.bin'));
    assert(reportedSelected, `Aria2 ownership list did not report ${selectedPath}`);
    assert(finalStatus.files?.some(file => file.path === selectedPath || file.path.endsWith('/selected.bin')), 'terminal status omitted selected output');
    console.log('[OK] selected addTorrent output, pause/resume, and Aria2 file ownership passed');

    const integrityPath = path.join(integrityDir, torrent.name, 'selected.bin');
    fs.mkdirSync(path.dirname(integrityPath), { recursive: true });
    fs.writeFileSync(integrityPath, Buffer.alloc(torrent.files[0].data.length, 0x00));
    const integrityGid = await rpc(client.rpcPort, client.secret, 'aria2.addTorrent', [
      savedTorrentBytes.toString('base64'),
      [],
      {
        dir: integrityDir,
        'select-file': '1',
        'index-out': indexOut,
        'check-integrity': 'true',
        'bt-hash-check-seed': 'false',
        'seed-time': '0',
        'auto-file-renaming': 'false',
      },
    ]);
    const integrityStatus = await waitForTerminal(client, integrityGid, 30000);
    assert(integrityStatus.status === 'complete', 'integrity-check torrent did not complete');
    assert(fs.readFileSync(integrityPath).equals(torrent.files[0].data), 'integrity check did not replace corrupted torrent data');
    console.log('[OK] check-integrity detected and repaired corrupted Torrent data');

    const cancelGid = await rpc(client.rpcPort, client.secret, 'aria2.addTorrent', [
      savedTorrentBytes.toString('base64'),
      [],
      {
        dir: cancelDir,
        'select-file': '1',
        'index-out': indexOut,
        'max-download-limit': '8K',
        'seed-time': '0',
        'auto-file-renaming': 'false',
      },
    ]);
    await waitForStatus(client, cancelGid, 'active', 10000);
    assert(await forceRemoveIfPresent(client, cancelGid), 'cancel/remove raced to a terminal state before forceRemove');
    await waitForRemoved(client, cancelGid);
    const canceledPath = path.join(cancelDir, torrent.name, 'selected.bin');
    assert(
      !fs.existsSync(canceledPath) || fs.statSync(canceledPath).size < torrent.files[0].data.length,
      'canceled torrent produced a complete output',
    );
    console.log('[OK] cancel/remove stopped the second torrent before completion');

    if (runFailurePaths) {
      await runFailurePathChecks({ client, tempRoot });
    }
  } finally {
    await cleanupRuntime();
  }
}

function handleTerminationSignal(signal) {
  if (signalTerminationRequested) return;
  signalTerminationRequested = true;
  runtimeAbortController.abort();
  void cleanupRuntime().then(() => {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }, error => {
    console.error(`[FAIL] Torrent runtime smoke cleanup: ${error.message}`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

const onSigint = () => handleTerminationSignal('SIGINT');
const onSigterm = () => handleTerminationSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

main().catch(error => {
  console.error(`[FAIL] Torrent runtime smoke test: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
});
