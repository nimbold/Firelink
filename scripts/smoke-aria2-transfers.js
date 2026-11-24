#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ARIA2_LOCAL_FIXTURE_OPTIONS,
  ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS,
  assertAria2Baseline,
  hasAria2RouteCapabilities,
} from './aria2-route-contract.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = { x64: 'x86_64', arm64: 'aarch64' }[os.arch()];
const platform = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
if (!arch || !platform) throw new Error(`Unsupported host: ${os.arch()} / ${process.platform}`);
const targetTriple = `${arch}-${platform}`;
const argumentIndex = process.argv.indexOf('--binary');
const binaryPath = path.resolve(argumentIndex >= 0
  ? process.argv[argumentIndex + 1]
  : process.env.FIRELINK_ENGINE_OUTPUT_ROOT
    ? path.join(
        process.env.FIRELINK_ENGINE_OUTPUT_ROOT,
        targetTriple,
        `aria2c-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`,
      )
    : path.join(repoRoot, 'src-tauri', 'binaries', `aria2c-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`));
if (!fs.existsSync(binaryPath)) throw new Error(`Aria2 binary does not exist: ${binaryPath}`);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate local fixture port');
  return address.port;
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function rpc(port, secret, method, params = [], { timeoutMs = 15000 } = {}) {
  let body;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params: [`token:${secret}`, ...params],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.json();
  } catch (error) {
    throw new Error(`Aria2 RPC ${method} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (!Object.hasOwn(body, 'result')) throw new Error(`${method}: response has no result`);
  return body.result;
}

const TRANSIENT_RPC_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isTransientRpcError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const name = typeof current === 'object' ? current.name || '' : '';
    const code = typeof current === 'object' ? current.code || '' : '';
    const message = current instanceof Error ? current.message : String(current);
    if (name === 'TimeoutError'
      || name === 'AbortError'
      || TRANSIENT_RPC_ERROR_CODES.has(code)
      || /aborted due to timeout|timed out/i.test(message)) {
      return true;
    }
    current = typeof current === 'object' ? current.cause : null;
  }
  return false;
}

async function waitForRpc(port, secret) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await rpc(port, secret, 'aria2.getVersion', [], { timeoutMs: 5000 });
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error(`Aria2 RPC did not become ready: ${lastError?.message || 'unknown error'}`, { cause: lastError });
}

async function waitForTerminal(port, secret, gid, timeoutMs = 20000, observeStatus) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  let lastPollError;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    try {
      latest = await rpc(port, secret, 'aria2.tellStatus', [gid, [
        'status', 'errorCode', 'errorMessage', 'completedLength', 'totalLength', 'connections',
      ]], { timeoutMs: Math.min(15000, remainingMs) });
      lastPollError = undefined;
      observeStatus?.(latest);
      if (['complete', 'error', 'removed'].includes(latest.status)) return latest;
    } catch (error) {
      if (!isTransientRpcError(error)) throw error;
      lastPollError = error;
      if (Date.now() >= deadline) break;
    }
    await wait(100);
  }
  throw new Error(
    `Aria2 gid ${gid} did not become terminal: ${JSON.stringify(latest)}${lastPollError ? ` (last poll error: ${lastPollError.message})` : ''}`,
    { cause: lastPollError },
  );
}

async function waitForProgress(port, secret, gid, minimumBytes = 1) {
  const deadline = Date.now() + 15000;
  let latest;
  let lastPollError;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    try {
      latest = await rpc(port, secret, 'aria2.tellStatus', [gid, ['status', 'completedLength']], {
        timeoutMs: Math.min(10000, remainingMs),
      });
      lastPollError = undefined;
      if (latest.status === 'active' && Number(latest.completedLength) >= minimumBytes) return latest;
    } catch (error) {
      if (!isTransientRpcError(error)) throw error;
      lastPollError = error;
      if (Date.now() >= deadline) break;
    }
    await wait(25);
  }
  throw new Error(
    `Aria2 gid ${gid} made no observable progress: ${JSON.stringify(latest)}${lastPollError ? ` (last poll error: ${lastPollError.message})` : ''}`,
    { cause: lastPollError },
  );
}

function serveBuffer(request, response, buffer) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
  if (!match) {
    response.writeHead(200, { 'content-length': String(buffer.length), 'accept-ranges': 'bytes' });
    response.end(buffer);
    return;
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : buffer.length - 1;
  const end = Math.min(requestedEnd, buffer.length - 1);
  if (!Number.isSafeInteger(start) || start < 0 || start > end) {
    response.writeHead(416, { 'content-range': `bytes */${buffer.length}` });
    response.end();
    return;
  }
  const body = buffer.subarray(start, end + 1);
  response.writeHead(206, {
    'content-length': String(body.length),
    'content-range': `bytes ${start}-${end}/${buffer.length}`,
    'accept-ranges': 'bytes',
  });
  response.end(body);
}

function serveThrottledBuffer(
  request,
  response,
  buffer,
  { honorRange = true, advertiseRange = true } = {},
) {
  const match = honorRange ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '') : null;
  const start = match ? Number(match[1]) : 0;
  const requestedEnd = match && match[2] ? Number(match[2]) : buffer.length - 1;
  const end = Math.min(requestedEnd, buffer.length - 1);
  if (!Number.isSafeInteger(start) || start < 0 || start > end) {
    response.writeHead(416, { 'content-range': `bytes */${buffer.length}` });
    response.end();
    return;
  }
  const body = buffer.subarray(start, end + 1);
  response.writeHead(match ? 206 : 200, {
    'content-length': String(body.length),
    ...(match ? { 'content-range': `bytes ${start}-${end}/${buffer.length}` } : {}),
    ...(advertiseRange ? { 'accept-ranges': 'bytes' } : {}),
  });
  let offset = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || response.destroyed || offset >= body.length) {
      clearInterval(timer);
      if (!stopped && !response.destroyed) response.end();
      return;
    }
    const next = Math.min(offset + 32 * 1024, body.length);
    const chunk = body.subarray(offset, next);
    offset = next;
    if (next >= body.length) {
      clearInterval(timer);
      response.end(chunk);
      return;
    }
    response.write(chunk);
  }, 20);
  const stopWriting = () => {
    stopped = true;
    clearInterval(timer);
  };
  response.once('close', stopWriting);
  request.once('aborted', stopWriting);
  request.socket?.once('close', stopWriting);
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs = 8000) {
  if (childExited(child)) return true;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(result);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (childExited(child)) finish(true);
  });
}

async function stop(child, port, secret) {
  if (!child || childExited(child)) return;
  try {
    await rpc(port, secret, 'aria2.shutdown');
  } catch {
    // It may already be stopping.
  }
  let exited = await waitForChildExit(child);
  if (!exited) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', timeout: 3000 });
      } catch {
        // It may have exited between the timeout and taskkill.
      }
    } else {
      child.kill('SIGTERM');
    }
    exited = await waitForChildExit(child);
  }
  if (!exited && process.platform !== 'win32') {
    child.kill('SIGKILL');
    exited = await waitForChildExit(child);
  }
  if (!exited) throw new Error(`Aria2 process ${child.pid} did not exit after cleanup`);
}

async function removeTempRoot(tempRoot) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await wait(100 * attempt);
    }
  }
  throw lastError;
}

const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
const parallelPayload = Buffer.alloc(32 * 1024 * 1024, 0x4d);
const smallPayload = Buffer.alloc(1536 * 1024, 0x2a);
const checksum = crypto.createHash('sha256').update(payload).digest('hex');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-aria2-transfers-'));
const serverStatPath = path.join(tempRoot, 'server-stat.txt');
fs.writeFileSync(serverStatPath, '', { mode: 0o600 });
let finalRequests = 0;
let finalCredentials = [];
let checkingRestart = false;
let resumedFromOffset = false;
let redirectSourceCredentials;
const activeMirrorRequests = new Map();
let simultaneousMirrorRequests = false;
const connectionStats = {
  parallelRange: {
    requests: 0,
    active: 0,
    peak: 0,
    rangedGets: 0,
    activeRangedGets: 0,
    peakRangedGets: 0,
    rangeHeaders: [],
  },
  noRange: { requests: 0, active: 0, peak: 0, rangedGets: 0, activeRangedGets: 0, peakRangedGets: 0, rangeHeaders: [] },
  smallRange: {
    requests: 0,
    active: 0,
    peak: 0,
    rangedGets: 0,
    activeRangedGets: 0,
    peakRangedGets: 0,
    rangeHeaders: [],
  },
};
const activeConnectionHandles = {
  parallelRange: new Set(),
  noRange: new Set(),
  smallRange: new Set(),
};
let smokePassed = false;
let smokeFailure;
let currentStep = 'startup';

function pruneInactiveConnections(name) {
  const handles = activeConnectionHandles[name];
  for (const handle of handles) {
    if (handle.response.writableEnded || handle.response.destroyed || handle.request.destroyed || handle.request.socket?.destroyed) {
      handle.release();
    }
  }
}

function observeConnection(name, request, response) {
  const stats = connectionStats[name];
  const handles = activeConnectionHandles[name];
  pruneInactiveConnections(name);
  const isRangedGet = request.method === 'GET' && typeof request.headers.range === 'string';
  stats.requests += 1;
  stats.rangeHeaders.push({ method: request.method, range: request.headers.range || null });
  stats.active += 1;
  stats.peak = Math.max(stats.peak, stats.active);
  if (isRangedGet) {
    stats.rangedGets += 1;
    stats.activeRangedGets += 1;
    stats.peakRangedGets = Math.max(stats.peakRangedGets, stats.activeRangedGets);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    handles.delete(handle);
    stats.active = Math.max(0, stats.active - 1);
    if (isRangedGet) stats.activeRangedGets = Math.max(0, stats.activeRangedGets - 1);
  };
  const handle = { request, response, release };
  handles.add(handle);
  response.once('finish', release);
  response.once('close', release);
  request.once('aborted', release);
  request.socket?.once('close', release);
}

const targetServer = http.createServer((request, response) => {
  finalRequests += 1;
  finalCredentials.push({
    authorization: request.headers.authorization,
    cookie: request.headers.cookie,
    custom: request.headers['x-firelink-secret'],
  });
  serveBuffer(request, response, payload);
});
const targetPort = await listen(targetServer);
const fixtureServer = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
  switch (pathname) {
    case '/range':
      serveBuffer(request, response, payload);
      break;
    case '/no-range':
      observeConnection('noRange', request, response);
      serveThrottledBuffer(request, response, payload, { honorRange: false, advertiseRange: false });
      break;
    case '/parallel-range':
      observeConnection('parallelRange', request, response);
      serveThrottledBuffer(request, response, parallelPayload);
      break;
    case '/restart':
      if (checkingRestart) {
        resumedFromOffset ||= /^bytes=[1-9]\d*-/.test(request.headers.range || '');
        serveBuffer(request, response, parallelPayload);
      } else {
        serveThrottledBuffer(request, response, parallelPayload);
      }
      break;
    case '/mirror-a':
    case '/mirror-b': {
      activeMirrorRequests.set(pathname, (activeMirrorRequests.get(pathname) ?? 0) + 1);
      simultaneousMirrorRequests ||= activeMirrorRequests.size > 1;
      response.once('close', () => {
        const remaining = activeMirrorRequests.get(pathname) - 1;
        if (remaining > 0) activeMirrorRequests.set(pathname, remaining);
        else activeMirrorRequests.delete(pathname);
      });
      serveThrottledBuffer(request, response, payload);
      break;
    }
    case '/small-range':
      observeConnection('smallRange', request, response);
      serveBuffer(request, response, smallPayload);
      break;
    case '/throttled':
      serveThrottledBuffer(request, response, payload);
      break;
    case '/authenticated': {
      const expectedAuthorization = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
      if (request.headers.authorization !== expectedAuthorization
        || request.headers.cookie !== 'fixture-cookie=present'
        || request.headers['x-firelink-auth'] !== 'present') {
        response.writeHead(401, { 'content-length': '0' });
        response.end();
        break;
      }
      serveBuffer(request, response, payload);
      break;
    }
    case '/redirect':
      redirectSourceCredentials = {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        custom: request.headers['x-firelink-secret'],
      };
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/final` });
      response.end();
      break;
    case '/missing':
      response.writeHead(404, { 'content-length': '0' });
      response.end();
      break;
    case '/malformed':
      response.writeHead(200, { 'content-length': String(payload.length * 2) });
      response.write(payload.subarray(0, 1024));
      response.destroy();
      break;
    case '/slow': {
      const slowLength = 64 * 1024;
      let written = 0;
      response.writeHead(200, { 'content-length': String(slowLength) });
      const timer = setInterval(() => {
        if (response.destroyed || written >= slowLength) {
          clearInterval(timer);
          if (!response.destroyed) response.end();
          return;
        }
        response.write(Buffer.alloc(1024, 0x73));
        written += 1024;
      }, 500);
      response.once('close', () => clearInterval(timer));
      break;
    }
    default:
      response.writeHead(404, { 'content-length': '0' });
      response.end();
  }
});
const fixturePort = await listen(fixtureServer);
const rpcPort = await availablePort();
const unavailableProxyPort = await availablePort();
const secret = `firelink-transfers-${crypto.randomUUID()}`;
const configPath = path.join(tempRoot, 'aria2.conf');
fs.writeFileSync(configPath, `rpc-secret=${secret}\n`, { mode: 0o600 });
const libraryPath = path.join(path.dirname(binaryPath), 'aria2-libs');
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
const environment = fs.existsSync(libraryPath)
  ? {
      ...process.env,
      OPENSSL_MODULES: libraryPath,
      ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: libraryPath } : {}),
      ...(process.platform === 'win32'
        ? { [pathKey]: `${libraryPath}${path.delimiter}${process.env[pathKey] || ''}` }
        : {}),
    }
  : process.env;
const daemonArgs = [
  '--enable-rpc=true',
  `--conf-path=${configPath}`,
  `--rpc-listen-port=${rpcPort}`,
  '--rpc-listen-all=false',
  `--dir=${tempRoot}`,
  '--file-allocation=none',
  '--enable-dht=false',
  '--console-log-level=error',
  '--quiet=true',
  ...ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS,
  `--server-stat-if=${serverStatPath}`,
  `--server-stat-of=${serverStatPath}`,
];
let stderr = '';
function launchDaemon() {
  const daemon = spawn(binaryPath, daemonArgs, { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', chunk => { stderr += chunk.toString(); });
  return daemon;
}
let child = launchDaemon();

try {
  currentStep = 'waitForRpc';
  const version = await waitForRpc(rpcPort, secret);
  assertAria2Baseline(version);
  if (hasAria2RouteCapabilities(version)) {
    // The fixture server is intentionally loopback. Disable only the custom
    // target policy after the optional capabilities have been attested.
    await rpc(rpcPort, secret, 'aria2.changeGlobalOption', [{ 'network-target-policy': 'none' }]);
  }
  console.log(`[INFO] aria2 ${version.version || 'unknown'} normal-transfer smoke (system resolver)`);

  currentStep = 'bounded-range';
  const rangeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'range.bin', split: '4', 'max-connection-per-server': '4', 'min-split-size': '1M',
  }]);
  const rangeStatus = await waitForTerminal(rpcPort, secret, rangeGid);
  if (rangeStatus.status !== 'complete' || !fs.readFileSync(path.join(tempRoot, 'range.bin')).equals(payload)) {
    throw new Error(`bounded-range transfer failed: ${JSON.stringify(rangeStatus)}`);
  }

  currentStep = 'parallel-range';
  const parallelGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/parallel-range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'parallel-range.bin', split: '16', 'max-connection-per-server': '16', 'min-split-size': '1M',
    'stream-piece-selector': 'inorder',
  }]);
  let midTransferConnections = 0;
  let maxAria2Connections = 0;
  const parallelStatus = await waitForTerminal(rpcPort, secret, parallelGid, 30000, status => {
    const activeConnections = Number(status.connections);
    if (Number.isFinite(activeConnections)) {
      maxAria2Connections = Math.max(maxAria2Connections, activeConnections);
    }
    const fraction = Number(status.completedLength) / parallelPayload.length;
    if (status.status === 'active' && fraction >= 0.25 && fraction <= 0.75) {
      midTransferConnections = Math.max(midTransferConnections, activeConnections);
    }
  });
  if (parallelStatus.status !== 'complete'
    || !fs.readFileSync(path.join(tempRoot, 'parallel-range.bin')).equals(parallelPayload)) {
    throw new Error(`parallel bounded-range transfer failed: ${JSON.stringify(parallelStatus)}`);
  }
  // Aria2's own active connection count must never exceed 16. On the HTTP
  // server side, allow at most a 2-socket overlap for kernel FIN/RST teardown
  // lag when Aria2 aborts an open-ended range to split it.
  if (connectionStats.parallelRange.rangedGets < 12
    || connectionStats.parallelRange.peakRangedGets < 12
    || maxAria2Connections > 16
    || connectionStats.parallelRange.peak > 18
    || midTransferConnections < 12) {
    throw new Error(`configured range pool was underused or exceeded (mid-transfer: ${midTransferConnections}, max-aria2: ${maxAria2Connections}): ${JSON.stringify(connectionStats.parallelRange)}`);
  }

  // Direct Aria2 intentionally bypasses Firelink's bounded range preflight.
  // This case checks safe recovery from an ignored Range header; the app-level
  // effective-connection fallback is covered by queue.rs unit tests.
  currentStep = 'no-range';
  const noRangeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/no-range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'no-range.bin', split: '4', 'max-connection-per-server': '4', 'min-split-size': '1M',
  }]);
  const noRangeStatus = await waitForTerminal(rpcPort, secret, noRangeGid);
  if (noRangeStatus.status !== 'complete'
    || !fs.readFileSync(path.join(tempRoot, 'no-range.bin')).equals(payload)) {
    throw new Error('unsupported-range transfer did not recover to exact output bytes');
  }
  if (connectionStats.noRange.peak > 4 || connectionStats.noRange.requests > 5) {
    throw new Error(`unsupported byte ranges exceeded the bounded initial split and probe: ${JSON.stringify(connectionStats.noRange)}`);
  }

  currentStep = 'small-range';
  const smallRangeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/small-range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'small-range.bin', split: '4', 'max-connection-per-server': '4', 'min-split-size': '1M',
  }]);
  if ((await waitForTerminal(rpcPort, secret, smallRangeGid)).status !== 'complete'
    || !fs.readFileSync(path.join(tempRoot, 'small-range.bin')).equals(smallPayload)) {
    throw new Error('small-file transfer did not complete correctly');
  }
  if (connectionStats.smallRange.rangedGets > 1 || connectionStats.smallRange.peakRangedGets > 1) {
    throw new Error(`a file below the configured split floor opened multiple byte-range connections: ${JSON.stringify(connectionStats.smallRange)}`);
  }

  currentStep = 'authenticated';
  const authenticatedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/authenticated`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'authenticated.bin', 'http-user': 'fixture-user', 'http-passwd': 'fixture-password',
    header: ['Cookie: fixture-cookie=present', 'X-Firelink-Auth: present'],
  }]);
  if ((await waitForTerminal(rpcPort, secret, authenticatedGid)).status !== 'complete') {
    throw new Error('authenticated cookie/header transfer did not complete');
  }

  currentStep = 'pause-resume';
  const resumeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/throttled`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'resume.bin', split: '1', continue: 'true',
  }]);
  await waitForProgress(rpcPort, secret, resumeGid);
  await rpc(rpcPort, secret, 'aria2.pause', [resumeGid]);
  const pausedStatus = await rpc(rpcPort, secret, 'aria2.tellStatus', [resumeGid, ['status', 'completedLength']]);
  if (pausedStatus.status !== 'paused' || Number(pausedStatus.completedLength) <= 0) {
    throw new Error(`normal transfer did not pause with resumable progress: ${JSON.stringify(pausedStatus)}`);
  }
  await rpc(rpcPort, secret, 'aria2.unpause', [resumeGid]);
  if ((await waitForTerminal(rpcPort, secret, resumeGid)).status !== 'complete') {
    throw new Error('paused normal transfer did not resume to completion');
  }

  currentStep = 'cancel';
  const cancelGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/throttled`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'cancel.bin', split: '1',
  }]);
  await waitForProgress(rpcPort, secret, cancelGid);
  await rpc(rpcPort, secret, 'aria2.remove', [cancelGid]);
  const cancelStatus = await waitForTerminal(rpcPort, secret, cancelGid);
  if (cancelStatus.status !== 'removed') {
    throw new Error(`normal transfer cancellation did not reach removed: ${JSON.stringify(cancelStatus)}`);
  }

  for (const selector of ['adaptive', 'feedback']) {
    currentStep = `mirror-${selector}`;
    const out = `mirror-${selector}.bin`;
    const mirrorGid = await rpc(rpcPort, secret, 'aria2.addUri', [[
      `http://127.0.0.1:${fixturePort}/missing`,
      `http://127.0.0.1:${fixturePort}/range`,
    ], { ...ARIA2_LOCAL_FIXTURE_OPTIONS, out, split: '1', 'max-tries': '1', 'uri-selector': selector }]);
    const mirrorStatus = await waitForTerminal(rpcPort, secret, mirrorGid);
    if (mirrorStatus.status !== 'complete' || !fs.readFileSync(path.join(tempRoot, out)).equals(payload)) {
      throw new Error(`${selector} mirror failover failed: ${JSON.stringify(mirrorStatus)}`);
    }
  }

  currentStep = 'segmented-mirror';
  const segmentedMirrorGid = await rpc(rpcPort, secret, 'aria2.addUri', [[
    `http://127.0.0.1:${fixturePort}/mirror-a`,
    `http://127.0.0.1:${fixturePort}/mirror-b`,
  ], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'segmented-mirror.bin',
    split: '4',
    'max-connection-per-server': '4',
    'min-split-size': '1M',
    'uri-selector': 'feedback',
  }]);
  const segmentedMirrorStatus = await waitForTerminal(rpcPort, secret, segmentedMirrorGid);
  if (segmentedMirrorStatus.status !== 'complete'
    || !simultaneousMirrorRequests
    || !fs.readFileSync(path.join(tempRoot, 'segmented-mirror.bin')).equals(payload)) {
    throw new Error(`segmented mirrors did not transfer concurrently to an exact output: ${JSON.stringify(segmentedMirrorStatus)}`);
  }

  currentStep = 'checksum-valid';
  const checksumGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'checksum.bin', checksum: `sha-256=${checksum}`, 'check-integrity': 'true',
  }]);
  if ((await waitForTerminal(rpcPort, secret, checksumGid)).status !== 'complete') {
    throw new Error('valid checksum transfer did not complete');
  }
  currentStep = 'checksum-mismatch';
  const mismatchGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'checksum-mismatch.bin', checksum: `sha-256=${'0'.repeat(64)}`, 'check-integrity': 'true',
  }]);
  const mismatchStatus = await waitForTerminal(rpcPort, secret, mismatchGid);
  if (mismatchStatus.status !== 'error') throw new Error(`checksum mismatch was not rejected: ${JSON.stringify(mismatchStatus)}`);

  // Model Firelink's manual preflight: credentials reach the original origin,
  // the redirect is not followed by the HTTP client, and Aria2 receives only
  // the resolved cross-origin URL without credential options.
  currentStep = 'redirect-credentials';
  const redirectProbe = await fetch(`http://127.0.0.1:${fixturePort}/redirect`, {
    headers: {
      Range: 'bytes=0-0',
      Authorization: 'Bearer fixture-secret',
      Cookie: 'fixture=secret',
      'X-Firelink-Secret': 'fixture',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  if (redirectProbe.status !== 302) throw new Error(`redirect preflight returned HTTP ${redirectProbe.status}`);
  if (!redirectSourceCredentials || Object.values(redirectSourceCredentials).some(value => !value)) {
    throw new Error(`redirect source did not receive its scoped credentials: ${JSON.stringify(redirectSourceCredentials)}`);
  }
  const redirectLocation = redirectProbe.headers.get('location');
  if (!redirectLocation) throw new Error('redirect preflight returned no Location header');
  const resolvedRedirect = new URL(redirectLocation, redirectProbe.url);
  const redirectGid = await rpc(rpcPort, secret, 'aria2.addUri', [[resolvedRedirect.toString()], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'redirect.bin',
  }]);
  const redirectStatus = await waitForTerminal(rpcPort, secret, redirectGid);
  if (redirectStatus.status !== 'complete' || finalRequests === 0 || finalCredentials.some(headers => Object.values(headers).some(Boolean))) {
    throw new Error(`redirect credential boundary failed: ${JSON.stringify({ redirectStatus, finalRequests, finalCredentials })}`);
  }

  currentStep = 'missing-404';
  const missingGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/missing`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'missing.bin', 'max-tries': '1',
  }]);
  const missingStatus = await waitForTerminal(rpcPort, secret, missingGid);
  if (missingStatus.status !== 'error' || !['3', '4'].includes(missingStatus.errorCode)) {
    throw new Error(`not-found error classification changed: ${JSON.stringify(missingStatus)}`);
  }

  currentStep = 'low-speed';
  const lowSpeedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/slow`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'low-speed.bin', 'max-tries': '1', 'lowest-speed-limit': '1M', timeout: '20',
  }]);
  const lowSpeedStatus = await waitForTerminal(rpcPort, secret, lowSpeedGid, 25000);
  if (lowSpeedStatus.status !== 'error' || lowSpeedStatus.errorCode !== '5') {
    throw new Error(`low-speed error classification changed: ${JSON.stringify(lowSpeedStatus)}`);
  }

  currentStep = 'malformed';
  const malformedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/malformed`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'malformed.bin', 'max-tries': '1',
  }]);
  if ((await waitForTerminal(rpcPort, secret, malformedGid)).status !== 'error') {
    throw new Error('malformed response unexpectedly completed');
  }

  currentStep = 'unavailable-proxy';
  const proxyGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'proxy.bin', 'all-proxy': `http://127.0.0.1:${unavailableProxyPort}`, 'max-tries': '1',
  }]);
  if ((await waitForTerminal(rpcPort, secret, proxyGid)).status !== 'error') {
    throw new Error('unavailable proxy unexpectedly completed');
  }

  currentStep = 'graceful-shutdown';
  const restartUri = `http://127.0.0.1:${fixturePort}/restart`;
  const restartOptions = {
    ...ARIA2_LOCAL_FIXTURE_OPTIONS,
    out: 'restart.bin', split: '1', continue: 'true', 'always-resume': 'true',
  };
  const interruptedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[restartUri], restartOptions]);
  await waitForProgress(rpcPort, secret, interruptedGid, 2 * 1024 * 1024);
  const shutdownStarted = Date.now();
  if (process.platform === 'win32') {
    await rpc(rpcPort, secret, 'aria2.shutdown', [], { timeoutMs: 15000 });
  } else if (!child.kill('SIGINT')) {
    throw new Error('could not send a graceful shutdown signal to Aria2');
  }
  if (!await waitForChildExit(child) || child.signalCode
    || !fs.existsSync(path.join(tempRoot, 'restart.bin.aria2'))) {
    throw new Error('graceful shutdown did not preserve the unfinished transfer control file');
  }
  console.log(`[OK] graceful Aria2 shutdown saved unfinished transfer state in ${Date.now() - shutdownStarted} ms`);

  currentStep = 'restart-resume';
  checkingRestart = true;
  child = launchDaemon();
  await waitForRpc(rpcPort, secret);
  if (hasAria2RouteCapabilities(version)) {
    await rpc(rpcPort, secret, 'aria2.changeGlobalOption', [{ 'network-target-policy': 'none' }]);
  }
  const restartedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[restartUri], restartOptions]);
  if ((await waitForTerminal(rpcPort, secret, restartedGid)).status !== 'complete'
    || !resumedFromOffset || !fs.readFileSync(path.join(tempRoot, 'restart.bin')).equals(parallelPayload)) {
    throw new Error('a fresh Aria2 daemon did not resume the durable range or changed the output');
  }

  smokePassed = true;
} catch (error) {
  const detail = stderr.trim();
  const baseMessage = error instanceof Error ? error.message : String(error);
  smokeFailure = new Error(`[step: ${currentStep}] ${baseMessage}${detail ? `\n${detail}` : ''}`, { cause: error });
} finally {
  try {
    await stop(child, rpcPort, secret);
    if (smokePassed) {
      const stat = fs.readFileSync(serverStatPath, 'utf8');
      if (!stat.includes('host=127.0.0.1')) {
        throw new Error(`Aria2 did not persist adaptive mirror statistics: ${JSON.stringify(stat)}`);
      }
    }
  } catch (error) {
    if (!smokeFailure) smokeFailure = error;
  } finally {
    try {
      await Promise.all([
        new Promise(resolve => fixtureServer.close(resolve)),
        new Promise(resolve => targetServer.close(resolve)),
      ]);
      await removeTempRoot(tempRoot);
    } catch (error) {
      if (!smokeFailure) smokeFailure = error;
    }
  }
}

if (smokeFailure) throw smokeFailure;
console.log('[PASS] Aria2 normal transfers, range/small-file concurrency, auth/cookies, resume/cancel, mirrors, integrity, redirects, low-speed/not-found classification, malformed responses, proxy failures, and server statistics');
