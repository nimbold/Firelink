#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectRegularFiles, sha256 } from './engine-payload-integrity.js';
import {
  promoteDirectory,
  recoverInterruptedPromotion,
  removePathWithRetry,
} from './engine-payload-promotion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
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

const destination = path.join(repoRoot, 'src-tauri', 'provisioned-engines', target);
const destinationParent = path.dirname(destination);
fs.mkdirSync(destinationParent, { recursive: true });
recoverInterruptedPromotion(destination);
// Keep staging on the destination filesystem so the final rename is atomic.
const temporary = fs.mkdtempSync(path.join(destinationParent, `.firelink-engines-${target}-`));
const payloadDestination = path.join(temporary, 'payload');
fs.mkdirSync(payloadDestination, { recursive: true });
const isWindows = target.includes('windows');
const executableSuffix = isWindows ? '.exe' : '';
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
const DOWNLOAD_RETRY_DELAYS_MS = [2_000, 5_000];
const FILE_LOCK_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function removeFileWithRetry(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(file, { force: true });
      return;
    } catch (error) {
      const retryable = process.platform === 'win32'
        && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!retryable || attempt >= FILE_LOCK_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(FILE_LOCK_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function createDownloadTimeout() {
  const controller = new AbortController();
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new Error(`Download idle for ${DOWNLOAD_IDLE_TIMEOUT_MS}ms`));
    }, DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const dispose = () => clearTimeout(timer);
  refresh();
  return { signal: controller.signal, refresh, dispose };
}

async function download(name, source) {
  const sourcePath = new URL(source.url).pathname;
  const archive = path.join(
    temporary,
    `${name}${sourcePath.endsWith('.tar.xz') ? '.tar.xz' : '.zip'}`
  );

  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const downloadTimeout = createDownloadTimeout();
    try {
      const response = await fetch(source.url, {
        redirect: 'follow',
        signal: downloadTimeout.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
      }

      await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
          transform(chunk, encoding, callback) {
            downloadTimeout.refresh();
            callback(null, chunk, encoding);
          },
        }),
        fs.createWriteStream(archive),
        { signal: downloadTimeout.signal }
      );
      break;
    } catch (error) {
      lastError = error;
      await removeFileWithRetry(archive);
      if (attempt === DOWNLOAD_ATTEMPTS) {
        throw new Error(
          `Failed to download ${name} after ${DOWNLOAD_ATTEMPTS} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
      await sleep(DOWNLOAD_RETRY_DELAYS_MS[attempt - 1]);
    } finally {
      downloadTimeout.dispose();
    }
  }

  if (lastError && !fs.existsSync(archive)) {
    throw lastError;
  }

  const actual = sha256(archive);
  if (actual !== source.sha256) {
    throw new Error(`Archive checksum mismatch for ${name}. Expected ${source.sha256}, got ${actual}`);
  }
  const extracted = path.join(temporary, `${name}-extracted`);
  fs.mkdirSync(extracted);
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archive, '-d', extracted], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
  }
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
          sha256: source.sha256 || source.sourceSha256
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
  await promoteDirectory(payloadDestination, destination);
  console.log(`Provisioned locked engine payload at ${destination}`);
} finally {
  await removePathWithRetry(temporary);
}
