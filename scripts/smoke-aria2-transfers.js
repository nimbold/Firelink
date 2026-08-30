#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

async function rpc(port, secret, method, params = []) {
  const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params: [`token:${secret}`, ...params],
    }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (!Object.hasOwn(body, 'result')) throw new Error(`${method}: response has no result`);
  return body.result;
}

async function waitForRpc(port, secret) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await rpc(port, secret, 'aria2.getVersion');
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error(`Aria2 RPC did not become ready: ${lastError?.message || 'unknown error'}`);
}

async function waitForTerminal(port, secret, gid, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await rpc(port, secret, 'aria2.tellStatus', [gid, [
      'status', 'errorCode', 'errorMessage', 'completedLength', 'totalLength',
    ]]);
    if (['complete', 'error', 'removed'].includes(latest.status)) return latest;
    await wait(100);
  }
  throw new Error(`Aria2 gid ${gid} did not become terminal: ${JSON.stringify(latest)}`);
}

async function waitForProgress(port, secret, gid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await rpc(port, secret, 'aria2.tellStatus', [gid, ['status', 'completedLength']]);
    if (latest.status === 'active' && Number(latest.completedLength) > 0) return latest;
    await wait(25);
  }
  throw new Error(`Aria2 gid ${gid} made no observable progress: ${JSON.stringify(latest)}`);
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

function serveThrottledBuffer(request, response, buffer) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
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
    'accept-ranges': 'bytes',
  });
  let offset = 0;
  const timer = setInterval(() => {
    if (response.destroyed || offset >= body.length) {
      clearInterval(timer);
      if (!response.destroyed) response.end();
      return;
    }
    const next = Math.min(offset + 32 * 1024, body.length);
    response.write(body.subarray(offset, next));
    offset = next;
  }, 20);
  response.once('close', () => clearInterval(timer));
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
const checksum = crypto.createHash('sha256').update(payload).digest('hex');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-aria2-transfers-'));
const serverStatPath = path.join(tempRoot, 'server-stat.txt');
fs.writeFileSync(serverStatPath, '', { mode: 0o600 });
let finalRequests = 0;
let finalCredentials = [];
let redirectSourceCredentials;
let smokePassed = false;
let smokeFailure;

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
  switch (new URL(request.url, 'http://fixture.invalid').pathname) {
    case '/range':
      serveBuffer(request, response, payload);
      break;
    case '/no-range':
      response.writeHead(200, { 'content-length': String(payload.length) });
      response.end(payload);
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
const environment = fs.existsSync(libraryPath)
  ? {
      ...process.env,
      OPENSSL_MODULES: libraryPath,
      ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: libraryPath } : {}),
    }
  : process.env;
const child = spawn(binaryPath, [
  '--enable-rpc=true',
  `--conf-path=${configPath}`,
  `--rpc-listen-port=${rpcPort}`,
  '--rpc-listen-all=false',
  `--dir=${tempRoot}`,
  '--file-allocation=none',
  '--enable-dht=false',
  '--console-log-level=error',
  '--quiet=true',
  `--server-stat-if=${serverStatPath}`,
  `--server-stat-of=${serverStatPath}`,
], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

try {
  const version = await waitForRpc(rpcPort, secret);
  console.log(`[INFO] aria2 ${version.version || 'unknown'} normal-transfer smoke`);

  const rangeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    out: 'range.bin', split: '4', 'max-connection-per-server': '4', 'min-split-size': '1M',
  }]);
  const rangeStatus = await waitForTerminal(rpcPort, secret, rangeGid);
  if (rangeStatus.status !== 'complete' || !fs.readFileSync(path.join(tempRoot, 'range.bin')).equals(payload)) {
    throw new Error(`bounded-range transfer failed: ${JSON.stringify(rangeStatus)}`);
  }

  const noRangeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/no-range`], {
    out: 'no-range.bin', split: '1', 'max-connection-per-server': '1',
  }]);
  if ((await waitForTerminal(rpcPort, secret, noRangeGid)).status !== 'complete') {
    throw new Error('single-connection no-range transfer did not complete');
  }

  const authenticatedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/authenticated`], {
    out: 'authenticated.bin', 'http-user': 'fixture-user', 'http-passwd': 'fixture-password',
    header: ['Cookie: fixture-cookie=present', 'X-Firelink-Auth: present'],
  }]);
  if ((await waitForTerminal(rpcPort, secret, authenticatedGid)).status !== 'complete') {
    throw new Error('authenticated cookie/header transfer did not complete');
  }

  const resumeGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/throttled`], {
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

  const cancelGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/throttled`], {
    out: 'cancel.bin', split: '1',
  }]);
  await waitForProgress(rpcPort, secret, cancelGid);
  await rpc(rpcPort, secret, 'aria2.remove', [cancelGid]);
  const cancelStatus = await waitForTerminal(rpcPort, secret, cancelGid);
  if (cancelStatus.status !== 'removed') {
    throw new Error(`normal transfer cancellation did not reach removed: ${JSON.stringify(cancelStatus)}`);
  }

  const mirrorGid = await rpc(rpcPort, secret, 'aria2.addUri', [[
    `http://127.0.0.1:${fixturePort}/missing`,
    `http://127.0.0.1:${fixturePort}/range`,
  ], { out: 'mirror.bin', split: '1', 'max-tries': '1', 'uri-selector': 'adaptive' }]);
  const mirrorStatus = await waitForTerminal(rpcPort, secret, mirrorGid);
  if (mirrorStatus.status !== 'complete') throw new Error(`adaptive mirror failover failed: ${JSON.stringify(mirrorStatus)}`);

  const checksumGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    out: 'checksum.bin', checksum: `sha-256=${checksum}`, 'check-integrity': 'true',
  }]);
  if ((await waitForTerminal(rpcPort, secret, checksumGid)).status !== 'complete') {
    throw new Error('valid checksum transfer did not complete');
  }
  const mismatchGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    out: 'checksum-mismatch.bin', checksum: `sha-256=${'0'.repeat(64)}`, 'check-integrity': 'true',
  }]);
  const mismatchStatus = await waitForTerminal(rpcPort, secret, mismatchGid);
  if (mismatchStatus.status !== 'error') throw new Error(`checksum mismatch was not rejected: ${JSON.stringify(mismatchStatus)}`);

  // Model Firelink's manual preflight: credentials reach the original origin,
  // the redirect is not followed by the HTTP client, and Aria2 receives only
  // the resolved cross-origin URL without credential options.
  const redirectProbe = await fetch(`http://127.0.0.1:${fixturePort}/redirect`, {
    headers: {
      Range: 'bytes=0-0',
      Authorization: 'Bearer fixture-secret',
      Cookie: 'fixture=secret',
      'X-Firelink-Secret': 'fixture',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (redirectProbe.status !== 302) throw new Error(`redirect preflight returned HTTP ${redirectProbe.status}`);
  if (!redirectSourceCredentials || Object.values(redirectSourceCredentials).some(value => !value)) {
    throw new Error(`redirect source did not receive its scoped credentials: ${JSON.stringify(redirectSourceCredentials)}`);
  }
  const redirectLocation = redirectProbe.headers.get('location');
  if (!redirectLocation) throw new Error('redirect preflight returned no Location header');
  const resolvedRedirect = new URL(redirectLocation, redirectProbe.url);
  const redirectGid = await rpc(rpcPort, secret, 'aria2.addUri', [[resolvedRedirect.toString()], {
    out: 'redirect.bin',
  }]);
  const redirectStatus = await waitForTerminal(rpcPort, secret, redirectGid);
  if (redirectStatus.status !== 'complete' || finalRequests === 0 || finalCredentials.some(headers => Object.values(headers).some(Boolean))) {
    throw new Error(`redirect credential boundary failed: ${JSON.stringify({ redirectStatus, finalRequests, finalCredentials })}`);
  }

  const missingGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/missing`], {
    out: 'missing.bin', 'max-tries': '1',
  }]);
  const missingStatus = await waitForTerminal(rpcPort, secret, missingGid);
  if (missingStatus.status !== 'error' || !['3', '4'].includes(missingStatus.errorCode)) {
    throw new Error(`not-found error classification changed: ${JSON.stringify(missingStatus)}`);
  }

  const lowSpeedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/slow`], {
    out: 'low-speed.bin', 'max-tries': '1', 'lowest-speed-limit': '1M', timeout: '20',
  }]);
  const lowSpeedStatus = await waitForTerminal(rpcPort, secret, lowSpeedGid, 25000);
  if (lowSpeedStatus.status !== 'error' || lowSpeedStatus.errorCode !== '5') {
    throw new Error(`low-speed error classification changed: ${JSON.stringify(lowSpeedStatus)}`);
  }

  const malformedGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/malformed`], {
    out: 'malformed.bin', 'max-tries': '1',
  }]);
  if ((await waitForTerminal(rpcPort, secret, malformedGid)).status !== 'error') {
    throw new Error('malformed response unexpectedly completed');
  }

  const proxyGid = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${fixturePort}/range`], {
    out: 'proxy.bin', 'all-proxy': `http://127.0.0.1:${unavailableProxyPort}`, 'max-tries': '1',
  }]);
  if ((await waitForTerminal(rpcPort, secret, proxyGid)).status !== 'error') {
    throw new Error('unavailable proxy unexpectedly completed');
  }

  smokePassed = true;
} catch (error) {
  const detail = stderr.trim();
  smokeFailure = new Error(`${error.message}${detail ? `\n${detail}` : ''}`);
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
console.log('[PASS] Aria2 normal transfers, auth/cookies, resume/cancel, mirrors, integrity, redirects, low-speed/not-found classification, malformed responses, proxy failures, and server statistics');
