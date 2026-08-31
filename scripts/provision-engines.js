#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectRegularFiles, sha256 } from './engine-payload-integrity.js';
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
    generatedFrom: Object.fromEntries(
      Object.entries(targetSources).map(([name, source]) => [
        name,
        {
          version: source.version,
          url: source.url || source.sourceUrl,
          sha256: source.sha256 || source.sourceSha256,
          ...(name === 'aria2c' && source.firelinkRouteContract
            ? { firelinkRouteContract: source.firelinkRouteContract }
            : {})
        }
      ])
    ),
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
  copyExecutable(findFile(aria2, isWindows ? ['aria2c.exe'] : ['aria2c']), 'aria2c');

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
