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
  ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS,
  ARIA2_SYSTEM_RESOLVER_OPTIONS,
  ARIA2_ROUTE_OPTIONS,
  assertAria2Baseline,
  assertAria2RouteOptions,
  assertAria2SystemResolverOptions,
  hasAria2RouteCapabilities,
} from './aria2-route-contract.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = { x64: 'x86_64', arm64: 'aarch64' }[os.arch()];
const platform = {
  darwin: 'apple-darwin',
  linux: 'unknown-linux-gnu',
  win32: 'pc-windows-msvc',
}[process.platform];
if (!arch || !platform) {
  throw new Error(`Unsupported host: ${os.arch()} / ${process.platform}`);
}
const targetTriple = `${arch}-${platform}`;
const argumentIndex = process.argv.indexOf('--binary');
const binaryPath = path.resolve(
  argumentIndex >= 0
    ? process.argv[argumentIndex + 1]
    : process.env.FIRELINK_ENGINE_OUTPUT_ROOT
      ? path.join(
          process.env.FIRELINK_ENGINE_OUTPUT_ROOT,
          targetTriple,
          `aria2c-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`,
        )
      : path.join(
          repoRoot,
          'src-tauri',
          'binaries',
          `aria2c-${targetTriple}${process.platform === 'win32' ? '.exe' : ''}`,
        ),
);

if (!fs.existsSync(binaryPath)) {
  throw new Error(`Aria2 binary does not exist: ${binaryPath}`);
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : undefined;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('Could not reserve a local port');
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
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  if (!Object.hasOwn(body, 'result')) throw new Error(`${method}: response has no result`);
  return body.result;
}

async function forceRemoveIfPresent(port, secret, gid) {
  try {
    await rpc(port, secret, 'aria2.forceRemove', [gid]);
  } catch (error) {
    if (!/not found|no such download|active download not found/i.test(error.message)) throw error;
  }
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs = 3000) {
  if (childExited(child)) return true;
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(result);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (childExited(child)) finish(true);
  });
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

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return Buffer.concat([
      Buffer.from('d'),
      ...entries.flatMap(([key, child]) => [bencode(key), bencode(child)]),
      Buffer.from('e'),
    ]);
  }
  throw new Error(`Unsupported bencode value: ${typeof value}`);
}

async function stop(child, port, secret) {
  if (!child || childExited(child)) return;
  try {
    await rpc(port, secret, 'aria2.shutdown');
  } catch {
    // The process may already have exited.
  }
  let exited = await waitForChildExit(child);
  if (!exited) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          timeout: 3000,
        });
      } catch {
        // The process may have exited between the timeout and taskkill.
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
  if (!exited) {
    throw new Error(`Aria2 process ${child.pid} did not exit after forced cleanup`);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-aria2-resolver-'));
const secret = `firelink-resolver-${crypto.randomUUID()}`;
const rpcPort = await availablePort();
const contentServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-length': '1' });
  response.end('x');
});
await new Promise((resolve, reject) => {
  contentServer.once('error', reject);
  contentServer.listen({ host: '127.0.0.1', port: 0 }, resolve);
});
const contentPort = contentServer.address().port;
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
const child = spawn(binaryPath, [
  '--enable-rpc=true',
  `--rpc-listen-port=${rpcPort}`,
  '--rpc-listen-all=false',
  `--rpc-secret=${secret}`,
  `--dir=${tempRoot}`,
  '--file-allocation=none',
  '--enable-dht=false',
  ...ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS,
  '--console-log-level=error',
  '--quiet=true',
], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

try {
  const version = await waitForRpc(rpcPort, secret);
  assertAria2Baseline(version);
  const routeCapabilitiesAvailable = hasAria2RouteCapabilities(version);
  if (routeCapabilitiesAvailable) {
    // The fixture server is intentionally loopback. Disable only the custom
    // target policy for this smoke daemon after capabilities are attested.
    await rpc(rpcPort, secret, 'aria2.changeGlobalOption', [{ 'network-target-policy': 'none' }]);
    console.log(`[INFO] aria2 ${version.version || 'unknown'}; optional Firelink route capabilities available`);
  } else {
    console.log(`[INFO] aria2 ${version.version || 'unknown'}; using stock system-resolver capabilities`);
  }
  const systemFixtureOptions = routeCapabilitiesAvailable
    ? { ...ARIA2_SYSTEM_RESOLVER_OPTIONS, 'network-target-policy': 'none' }
    : { ...ARIA2_SYSTEM_RESOLVER_OPTIONS };

  const uriResult = await rpc(rpcPort, secret, 'aria2.addUri', [[`http://127.0.0.1:${contentPort}/file`], {
    ...systemFixtureOptions,
    out: 'resolver-normal.bin',
  }]);
  const uriOptions = await rpc(rpcPort, secret, 'aria2.getOption', [uriResult]);
  assertAria2SystemResolverOptions(uriOptions, 'direct aria2.addUri');

  const torrent = bencode({
    info: {
      length: 1,
      name: 'resolver-torrent.bin',
      pieces: Buffer.alloc(20),
      'piece length': 16384,
    },
  }).toString('base64');
  const torrentResult = await rpc(rpcPort, secret, 'aria2.addTorrent', [torrent, [], {
    ...systemFixtureOptions,
    dir: tempRoot,
  }]);
  const torrentOptions = await rpc(rpcPort, secret, 'aria2.getOption', [torrentResult]);
  assertAria2SystemResolverOptions(torrentOptions, 'direct aria2.addTorrent');

  const proxyRoute = 'http://127.0.0.1:9';
  const normalizedProxyRoute = new URL(proxyRoute).toString();
  const proxiedUriResult = await rpc(rpcPort, secret, 'aria2.addUri', [['https://route-owned.invalid/file'], {
    ...systemFixtureOptions,
    'all-proxy': proxyRoute,
    pause: 'true',
    out: 'resolver-proxied.bin',
  }]);
  const proxiedUriOptions = await rpc(rpcPort, secret, 'aria2.getOption', [proxiedUriResult]);
  if (proxiedUriOptions['all-proxy'] !== normalizedProxyRoute) {
    throw new Error(`aria2.addUri did not retain the configured proxy route: ${JSON.stringify(proxiedUriOptions)}`);
  }
  assertAria2SystemResolverOptions(proxiedUriOptions, 'proxied aria2.addUri');

  const proxiedTorrentResult = await rpc(rpcPort, secret, 'aria2.addTorrent', [torrent, [], {
    ...systemFixtureOptions,
    'all-proxy': proxyRoute,
    pause: 'true',
    dir: tempRoot,
  }]);
  const proxiedTorrentOptions = await rpc(rpcPort, secret, 'aria2.getOption', [proxiedTorrentResult]);
  if (proxiedTorrentOptions['all-proxy'] !== normalizedProxyRoute) {
    throw new Error(`aria2.addTorrent did not retain the configured proxy route: ${JSON.stringify(proxiedTorrentOptions)}`);
  }
  assertAria2SystemResolverOptions(proxiedTorrentOptions, 'proxied aria2.addTorrent');

  if (routeCapabilitiesAvailable) {
    const alternateResult = await rpc(rpcPort, secret, 'aria2.addUri', [['https://route-owned.invalid/alternate'], {
      ...ARIA2_ROUTE_OPTIONS,
      pause: 'true',
      out: 'resolver-alternate.bin',
    }]);
    const alternateOptions = await rpc(rpcPort, secret, 'aria2.getOption', [alternateResult]);
    assertAria2RouteOptions(alternateOptions, 'alternate aria2.addUri');
    await forceRemoveIfPresent(rpcPort, secret, alternateResult);
  }
  await forceRemoveIfPresent(rpcPort, secret, proxiedUriResult);
  await forceRemoveIfPresent(rpcPort, secret, proxiedTorrentResult);

  console.log('[PASS] Aria2 preserved system route options for direct/proxied normal/Torrent transfers');
} catch (error) {
  const detail = stderr.trim();
  throw new Error(`${error.message}${detail ? `\n${detail}` : ''}`);
} finally {
  try {
    await stop(child, rpcPort, secret);
  } finally {
    await new Promise(resolve => contentServer.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
