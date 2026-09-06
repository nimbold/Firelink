#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveOutputRoot,
  resolveTargetTriple,
} from './engine-workspace.js';
import {
  ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS,
  assertAria2Baseline,
  assertAria2AllocationCapabilities,
} from './aria2-route-contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const archMap = { x64: 'x86_64', arm64: 'aarch64' };
const platformMap = {
  darwin: 'apple-darwin',
  win32: 'pc-windows-msvc',
  linux: 'unknown-linux-gnu',
};

const currentArch = archMap[os.arch()];
const currentPlatform = platformMap[os.platform()];

if (!currentArch || !currentPlatform) {
  console.error(`Unsupported architecture or platform: ${os.arch()} / ${os.platform()}`);
  process.exit(1);
}

const targetTriple = resolveTargetTriple();
const hostTriple = `${currentArch}-${currentPlatform}`;
const canExecuteTarget = targetTriple === hostTriple;
const isWindows = targetTriple.includes('windows');
const isMacOS = targetTriple.includes('apple-darwin');
const isLinux = targetTriple.includes('linux');
const ext = isWindows ? '.exe' : '';
const suffix = `-${targetTriple}${ext}`;

const scriptsDir = __dirname;
const searchRoot = argValue('--search-root');
function findEngineRoot(root) {
  const expected = `yt-dlp-${targetTriple}${ext}`;
  const matches = [];
  const resolvedRoot = path.resolve(root);
  const hasExpectedEngineFile = directory => {
    try {
      return fs.lstatSync(path.join(directory, expected)).isFile();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new Error(`Unable to inspect packaged engine root '${directory}': ${error.message}`);
    }
  };
  if (hasExpectedEngineFile(resolvedRoot)) {
    matches.push(resolvedRoot);
  }
  const walk = directory => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect packaged engine directory '${directory}': ${error.message}`);
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (hasExpectedEngineFile(candidate)) matches.push(candidate);
        walk(candidate);
      }
    }
  };
  walk(resolvedRoot);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one packaged engine root under ${root}, found ${matches.length}`);
  }
  return matches[0];
}

const configuredRoot = argValue('--root')
  || (process.argv.includes('--staged')
    ? path.join(resolveOutputRoot(), targetTriple)
    : searchRoot
      ? findEngineRoot(searchRoot)
      : null);
const binariesDir = configuredRoot
  ? path.resolve(configuredRoot)
  : path.join(scriptsDir, '..', 'src-tauri', 'binaries');
const requiredEngines = ['yt-dlp', 'aria2c', 'ffmpeg', 'deno'];
const stagedVerification = process.argv.includes('--staged');

const FORBIDDEN_OTOOL_PATHS = ['/opt/homebrew', '/usr/local/Cellar'];
const FORBIDDEN_STDERR = [
  'Failed to load Python shared library',
  'Library not loaded',
  'image not found',
  'Connection refused',
];

let exitCode = 0;

function fail(msg) {
  console.error(`[FAIL] ${msg}`);
  exitCode = 1;
}

function ok(msg) {
  console.log(`[OK] ${msg}`);
}

function rejectSymlinks(root, label) {
  if (!fs.existsSync(root)) {
    return;
  }

  let symlinkCount = 0;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        fail(`Unsupported symlink in ${label}: ${relative}`);
        symlinkCount += 1;
      } else if (entry.isDirectory()) {
        walk(file);
      }
    }
  };

  walk(root);
  if (symlinkCount === 0) {
    ok(`${label} contains no symlinks`);
  }
}

function binName(engine) {
  return `${engine}${suffix}`;
}

function binPath(engine) {
  return path.join(binariesDir, binName(engine));
}

function engineEnv(engine) {
  if (engine !== 'aria2c') {
    return process.env;
  }

  const modulesDir = path.join(binariesDir, 'aria2-libs');
  if (!fs.existsSync(modulesDir)) {
    return process.env;
  }

  return {
    ...process.env,
    OPENSSL_MODULES: modulesDir,
  };
}

// ───── Check 1: Sidecar existence ─────
console.log(`\n─── 1. Sidecar existence (${targetTriple}) ───`);
for (const eng of requiredEngines) {
  const p = binPath(eng);
  if (fs.existsSync(p)) {
    ok(`Found ${binName(eng)}`);
  } else {
    fail(`Missing ${binName(eng)}`);
  }
}

if (exitCode !== 0) {
  console.error('\nAborting: missing required sidecars.');
  process.exit(1);
}

// ───── Check 2: Executable permission ─────
console.log('\n─── 2. Executable permission ───');
for (const eng of requiredEngines) {
  if (isWindows) {
    ok(`Executable permission is represented by PE format on Windows: ${binName(eng)}`);
    continue;
  }
  try {
    fs.accessSync(binPath(eng), fs.constants.X_OK);
    ok(`Executable ${binName(eng)}`);
  } catch {
    fail(`Not executable ${binName(eng)}`);
  }
}

// ───── Check 3: file(1) identification ─────
console.log('\n─── 3. file(1) identification ───');
for (const eng of requiredEngines) {
  if (os.platform() === 'win32') {
    try {
      const header = fs.readFileSync(binPath(eng)).subarray(0, 2).toString('ascii');
      if (header === 'MZ') {
        ok(`${binName(eng)}: Windows PE executable`);
      } else {
        fail(`${binName(eng)}: missing Windows PE MZ header`);
      }
    } catch (e) {
      fail(`identify ${binName(eng)}: ${e.message}`);
    }
    continue;
  }
  try {
    const out = execFileSync('file', ['--brief', binPath(eng)], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    ok(`${binName(eng)}: ${out}`);
  } catch (e) {
    fail(`file ${binName(eng)}: ${e.message}`);
  }
}

// ───── Check 4 & 5: otool -L linkage (macOS only) ─────
if (isMacOS) {
  console.log('\n─── 4 & 5. otool -L linkage check ───');
  for (const eng of requiredEngines) {
    const p = binPath(eng);
    try {
      const out = execFileSync('otool', ['-L', p], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      const lines = out
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean);
      let hasBad = false;
      for (const fp of FORBIDDEN_OTOOL_PATHS) {
        for (const line of lines) {
          if (line.includes(fp)) {
            fail(`${binName(eng)} links to '${fp}': ${line}`);
            hasBad = true;
          }
        }
      }
      if (!hasBad) {
        ok(`${binName(eng)}: no local-only dylib paths`);
      }
    } catch (e) {
      fail(`otool -L ${binName(eng)}: ${e.message}`);
    }
  }
}

// ───── Check 6: yt-dlp packaging ─────
console.log('\n─── 6. yt-dlp packaging ───');
{
  const yt = binPath('yt-dlp');
  if (!fs.existsSync(yt)) {
    fail('yt-dlp binary not found, cannot verify packaging');
  } else {
    const internalDir = path.join(binariesDir, '_internal');
    const hasInternal = fs.existsSync(internalDir) && fs.statSync(internalDir).isDirectory();

    if (hasInternal) {
      console.log('  Detected PyInstaller onedir layout (_internal/ present)');
      let entries;
      try {
        entries = fs.readdirSync(internalDir);
        ok(`_internal/ directory exists with ${entries.length} entries`);
      } catch (e) {
        fail(`Cannot read _internal/: ${e.message}`);
      }
      rejectSymlinks(internalDir, '_internal/');

      const requiredRuntimeFiles = [
        path.join(internalDir, 'yt_dlp_ejs', 'yt', 'solver', 'core.min.js'),
        path.join(internalDir, 'yt_dlp_ejs', 'yt', 'solver', 'lib.min.js'),
      ];
      for (const required of requiredRuntimeFiles) {
        if (fs.existsSync(required)) {
          ok(`yt-dlp runtime component: ${path.relative(binariesDir, required)}`);
        } else {
          fail(`Missing yt-dlp runtime component: ${path.relative(binariesDir, required)}`);
        }
      }
      const runtimeCandidates = isWindows
        ? fs.readdirSync(internalDir).filter(name => /^python.*\.dll$/i.test(name))
        : isLinux
          ? fs.readdirSync(internalDir).filter(name => /^libpython.*\.so/i.test(name) || name === 'Python')
          : ['Python', 'Python.framework'].filter(name => fs.existsSync(path.join(internalDir, name)));
      if (runtimeCandidates.length > 0) {
        ok(`yt-dlp embedded Python runtime: ${runtimeCandidates[0]}`);
      } else {
        fail(`Missing embedded Python runtime in ${internalDir}`);
      }
    } else {
      fail('yt-dlp must use the self-contained onedir distribution; onefile adds ~17 seconds to every launch');
    }
  }
}

const aria2LibsDir = path.join(binariesDir, 'aria2-libs');
if (fs.existsSync(aria2LibsDir) && fs.statSync(aria2LibsDir).isDirectory()) {
  rejectSymlinks(aria2LibsDir, 'aria2-libs/');
}

// ───── Check 7, 8 & 9: Engine version self-tests ─────
console.log('\n─── 7 & 8 & 9. Engine version self-tests ───');

function runEngine(label, engine, args, timeout = 30000) {
  const p = binPath(engine);
  if (!fs.existsSync(p)) {
    fail(`${label} binary not found at ${p}`);
    return;
  }
  let stderr = '';
  try {
    const stdout = execFileSync(p, args, {
      encoding: 'utf-8',
      env: engineEnv(engine),
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const firstLine = stdout.trim().split('\n')[0];
    ok(`${label} version: ${firstLine}`);
  } catch (e) {
    stderr = e.stderr || '';
    const stdout = e.stdout || '';
    const detail = stdout.trim().split('\n')[0] || e.message;
    fail(`${label} execution failed: ${detail}`);
  }
  if (stderr) {
    for (const pattern of FORBIDDEN_STDERR) {
      if (stderr.includes(pattern)) {
        fail(`${label} stderr contains '${pattern}'`);
      }
    }
  }
}

function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);

    timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('exit', onExit);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      finish(true);
    }
  });
}

async function terminateProcess(proc, label) {
  if (proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill('SIGTERM');
    } catch {}
    if (await waitForProcessExit(proc, 2000)) {
      return true;
    }

    try {
      proc.kill('SIGKILL');
    } catch {}
    if (await waitForProcessExit(proc, 2000)) {
      return true;
    }

    fail(`${label} did not terminate after SIGTERM and SIGKILL.`);
    return false;
  }

  return true;
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine the verifier RPC port.'));
        return;
      }

      const port = address.port;
      server.close(error => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function isPortBindingFailure(message) {
  return /address already in use|failed to bind|could not bind|listen failed/i.test(message);
}

const coldStartTimeout = isMacOS ? 120000 : 30000;
if (canExecuteTarget) {
  runEngine('yt-dlp cold start', 'yt-dlp', ['--version'], coldStartTimeout);
  runEngine('yt-dlp warm start', 'yt-dlp', ['--version'], 8000);
  runEngine('ffmpeg cold start', 'ffmpeg', ['-version'], coldStartTimeout);
  runEngine('deno cold start', 'deno', ['--version'], coldStartTimeout);
  runEngine('aria2c cold start', 'aria2c', ['--version'], coldStartTimeout);
  if (isMacOS) {
    // Unsigned binaries can incur a one-time macOS provenance scan after copying.
    // Warm checks enforce engine startup performance after that OS validation.
    runEngine('ffmpeg warm start', 'ffmpeg', ['-version'], 8000);
    runEngine('deno warm start', 'deno', ['--version'], 8000);
    runEngine('aria2c warm start', 'aria2c', ['--version'], 8000);
  }
} else {
  console.log(`  Runtime tests skipped on ${hostTriple}; native ${targetTriple} CI runs them.`);
}

// ───── aria2 RPC smoke test (native target only) ─────
if (canExecuteTarget) {
  console.log('\n─── aria2 RPC smoke test ───');
  await (async function testAria2Rpc() {
    const p = binPath('aria2c');
    if (!fs.existsSync(p)) {
      fail('aria2c binary not found, cannot run RPC test');
      return;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'firelink-verify',
      method: 'aria2.getVersion',
      params: [],
    });

    let result = { ok: false, error: 'RPC test did not run.' };
    let rpcStderr = '';
    const maxPortAttempts = 3;
    for (let portAttempt = 0; portAttempt < maxPortAttempts; portAttempt += 1) {
      let port;
      try {
        port = await findAvailablePort();
      } catch (error) {
        result = { ok: false, error: `Could not reserve an RPC port: ${error.message}` };
        break;
      }

      const proc = spawn(p, [
        '--enable-rpc',
        `--rpc-listen-port=${port}`,
        '--rpc-max-request-size=1K',
        '--quiet',
        '--console-log-level=error',
        '--rpc-listen-all=false',
        ...ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS,
      ], {
        env: engineEnv('aria2c'),
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 15000,
      });

      let spawnError = null;
      let childExit = null;
      let attemptStderr = '';
      proc.once('error', error => {
        spawnError = error;
      });
      proc.once('exit', (code, signal) => {
        childExit = { code, signal };
      });
      proc.stderr.on('data', data => {
        attemptStderr += data.toString();
      });

      const attemptResult = await new Promise(resolve => {
        const maxAttempts = 20;
        let attempts = 0;

        function resolveProcessFailure() {
          if (spawnError) {
            resolve({ ok: false, error: `aria2c failed to spawn: ${spawnError.message}` });
          } else if (childExit) {
            resolve({
              ok: false,
              error: `aria2c exited before RPC became ready with code ${childExit.code} signal ${childExit.signal}.`,
            });
          }
        }

        function tryFetch() {
          if (spawnError || childExit) {
            resolveProcessFailure();
            return;
          }

          attempts += 1;
          fetch(`http://127.0.0.1:${port}/jsonrpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
            .then(async response => {
              resolve({ ok: true, data: await response.text() });
            })
            .catch(() => {
              if (spawnError || childExit) {
                resolveProcessFailure();
              } else if (attempts >= maxAttempts) {
                resolve({ ok: false, error: `RPC not ready after ${maxAttempts} attempts` });
              } else {
                setTimeout(tryFetch, 300);
              }
            });
        }

        tryFetch();
      });

      const exitedBeforeCleanup = childExit;
      const terminated = proc.pid
        ? await terminateProcess(proc, 'aria2 RPC verifier process')
        : true;
      rpcStderr = attemptStderr;
      result = attemptResult;

      if (
        result.ok
        && exitedBeforeCleanup
        && (exitedBeforeCleanup.code !== 0 || exitedBeforeCleanup.signal !== null)
      ) {
        result = {
          ok: false,
          error: `aria2c exited after responding with code ${exitedBeforeCleanup.code} signal ${exitedBeforeCleanup.signal}.`,
        };
      }

      if (!terminated || result.ok || !isPortBindingFailure(`${result.error || ''}\n${rpcStderr}`)) {
        break;
      }

      if (portAttempt + 1 < maxPortAttempts) {
        console.log(`[INFO] RPC port ${port} became unavailable; retrying with a new port.`);
      }
    }

    if (result.ok) {
      try {
        const resp = JSON.parse(result.data);
        if (resp?.result?.version) {
          assertAria2Baseline(resp.result);
          assertAria2AllocationCapabilities(resp.result);
          ok(`aria2 RPC version: ${resp.result.version}`);
        } else {
          fail(`aria2 RPC unexpected response: ${result.data}`);
        }
      } catch (e) {
        fail(`aria2 RPC parse error: ${e.message}`);
      }
    } else {
      fail(result.error);
    }

    if (rpcStderr) {
      for (const pattern of FORBIDDEN_STDERR) {
        if (rpcStderr.includes(pattern)) {
          fail(`aria2 RPC stderr contains '${pattern}'`);
        }
      }
    }
  })();
}

// ───── Result ─────
console.log('');
if (exitCode !== 0) {
  console.error(`[FAIL] ${exitCode} engine verification check(s) failed.`);
  process.exit(1);
} else {
  console.log('[PASS] All engine verification checks passed.');
  process.exit(0);
}
