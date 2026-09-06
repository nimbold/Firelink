#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectRegularFiles, sha256 } from './engine-payload-integrity.js';
import { buildPayloadProvenance } from './engine-payload-manifest.js';
import { downloadEngineArchive } from './engine-download.js';
import {
  promoteDirectory,
  recoverInterruptedPromotion,
  removeOrphanedProvisioningDirectories,
  removePathWithRetry,
} from './engine-payload-promotion.js';
import { assertAria2RouteSource } from './aria2-route-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const sourceLock = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'engine-sources.lock.json'), 'utf8')
);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const target = argValue('--target')
  || process.env.FIRELINK_TARGET_TRIPLE
  || process.env.TAURI_ENV_TARGET_TRIPLE;
if (!target) {
  console.error('Pass --target <Rust target triple>.');
  process.exit(1);
}

const targetSources = sourceLock.targets?.[target];
if (!targetSources) {
  console.error(`No source lock exists for ${target}.`);
  process.exit(1);
}

if (targetSources.aria2c?.firelinkRouteContract) {
  try {
    assertAria2RouteSource(targetSources.aria2c, target);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const destination = path.join(repoRoot, 'src-tauri', 'provisioned-engines', target);
const isWindows = target.includes('windows');
const executableSuffix = isWindows ? '.exe' : '';
const provisioningAbortController = new AbortController();
const signalNames = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM']
  : ['SIGINT', 'SIGTERM', 'SIGHUP'];
const signalHandlers = new Map();
for (const signalName of signalNames) {
  const handler = () => {
    if (!provisioningAbortController.signal.aborted) {
      provisioningAbortController.abort(new Error(`Engine provisioning interrupted by ${signalName}`));
    }
  };
  signalHandlers.set(signalName, handler);
  process.on(signalName, handler);
}

let temporary;
let payloadDestination;

function throwIfProvisioningAborted() {
  if (provisioningAbortController.signal.aborted) {
    throw provisioningAbortController.signal.reason;
  }
}

async function download(name, source) {
  throwIfProvisioningAborted();
  const sourcePath = new URL(source.url).pathname;
  const archive = path.join(
    temporary,
    `${name}${sourcePath.endsWith('.tar.xz') ? '.tar.xz' : '.zip'}`
  );
  await downloadEngineArchive({
    name,
    url: source.url,
    archive,
    expectedSha256: source.sha256,
    signal: provisioningAbortController.signal,
  });
  throwIfProvisioningAborted();
  const extracted = path.join(temporary, `${name}-extracted`);
  fs.mkdirSync(extracted);
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    await execFileAsync('unzip', ['-q', archive, '-d', extracted], {
      stdio: 'inherit',
      signal: provisioningAbortController.signal,
    });
  } else {
    await execFileAsync('tar', ['-xf', archive, '-C', extracted], {
      stdio: 'inherit',
      signal: provisioningAbortController.signal,
    });
  }
  throwIfProvisioningAborted();
  return extracted;
}

function findFile(root, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const matches = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && wanted.has(entry.name.toLowerCase())) matches.push(file);
    }
  };
  walk(root);
  if (matches.length !== 1) {
    throw new Error(`Expected one of [${names.join(', ')}] under ${root}, found ${matches.length}`);
  }
  return matches[0];
}

function copyExecutable(source, engine) {
  const output = path.join(payloadDestination, `${engine}-${target}${executableSuffix}`);
  fs.copyFileSync(source, output);
  if (!isWindows) fs.chmodSync(output, 0o755);
}

function writePayloadManifest() {
  const files = collectRegularFiles(payloadDestination, {
    ignoredNames: ['payload-manifest.json'],
  });
  const manifest = {
    schemaVersion: 1,
    target,
    generatedFrom: buildPayloadProvenance(targetSources),
    files: Object.fromEntries(
      files.map(file => [
        path.relative(payloadDestination, file).split(path.sep).join('/'),
        sha256(file)
      ])
    )
  };
  fs.writeFileSync(
    path.join(payloadDestination, 'payload-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

try {
  const destinationParent = path.dirname(destination);
  fs.mkdirSync(destinationParent, { recursive: true });
  recoverInterruptedPromotion(destination);
  await removeOrphanedProvisioningDirectories(destinationParent, target);
  throwIfProvisioningAborted();
  // Keep staging on the destination filesystem so the final rename is atomic.
  temporary = fs.mkdtempSync(
    path.join(destinationParent, `.firelink-engines-${target}-${process.pid}-`)
  );
  payloadDestination = path.join(temporary, 'payload');
  fs.mkdirSync(payloadDestination, { recursive: true });

  const ytdlp = await download('yt-dlp', targetSources['yt-dlp']);
  copyExecutable(
    findFile(ytdlp, isWindows ? ['yt-dlp.exe'] : ['yt-dlp_linux']),
    'yt-dlp'
  );
  fs.cpSync(path.join(ytdlp, '_internal'), path.join(payloadDestination, '_internal'), {
    recursive: true,
    preserveTimestamps: true
  });

  const deno = await download('deno', targetSources.deno);
  copyExecutable(findFile(deno, isWindows ? ['deno.exe'] : ['deno']), 'deno');

  const ffmpeg = await download('ffmpeg', targetSources.ffmpeg);
  copyExecutable(findFile(ffmpeg, isWindows ? ['ffmpeg.exe'] : ['ffmpeg']), 'ffmpeg');

  const aria2 = await download('aria2c', targetSources.aria2c);
  const aria2Source = targetSources.aria2c;
  if (aria2Source.buildFromSource !== true || aria2Source.allocationTelemetry !== true) {
    throw new Error('Aria2 provisioning requires the allocation telemetry source build.');
  }
  const patchFile = path.join(repoRoot, aria2Source.patch);
  if (sha256(patchFile) !== aria2Source.patchSha256) throw new Error('Aria2 source patch checksum mismatch');
  const sourceRoots = fs.readdirSync(aria2, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(aria2, entry.name, 'configure.ac')))
    .map(entry => path.join(aria2, entry.name));
  if (sourceRoots.length !== 1) throw new Error('Aria2 archive must contain exactly one source root');
  const [sourceRoot] = sourceRoots;
  const bash = isWindows ? path.join(process.env.FIRELINK_MSYS2_ROOT || 'C:/msys64', 'usr/bin/bash.exe') : 'bash';
  await execFileAsync(bash, [path.join(repoRoot, 'scripts/aria2/build.sh').replaceAll('\\', '/'), sourceRoot, patchFile], {
    signal: provisioningAbortController.signal,
    env: { ...process.env, ...(isWindows ? { MSYSTEM: 'MINGW64' } : {}) },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  copyExecutable(path.join(sourceRoot, 'firelink-build', 'src', `aria2c${executableSuffix}`), 'aria2c');
  const aria2Runtime = path.join(sourceRoot, 'aria2-libs');
  if (fs.existsSync(aria2Runtime)) {
    fs.cpSync(aria2Runtime, path.join(payloadDestination, 'aria2-libs'), {
      recursive: true,
      preserveTimestamps: true,
    });
  }

  writePayloadManifest();
  throwIfProvisioningAborted();
  await promoteDirectory(payloadDestination, destination);
  console.log(`Provisioned locked engine payload at ${destination}`);
} finally {
  if (temporary) await removePathWithRetry(temporary);
  for (const [signalName, handler] of signalHandlers) {
    process.removeListener(signalName, handler);
  }
}
