#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRegularFiles, sha256, treeDigest } from './engine-payload-integrity.js';
import { promoteDirectory, removePathWithRetry } from './engine-payload-promotion.js';
import {
  assertSafeOutputRoot,
  resolveOutputRoot,
  resolveTargetTriple,
} from './engine-workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const binariesRoot = path.join(repoRoot, 'src-tauri', 'binaries');
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'engines.lock.json'), 'utf8'));

const target = resolveTargetTriple();
const outputRoot = assertSafeOutputRoot(resolveOutputRoot(), [
  repoRoot,
  path.join(repoRoot, 'src-tauri'),
  path.join(repoRoot, 'src-tauri', 'engine-dist'),
]);
const isWindowsTarget = target.includes('windows');
const suffix = isWindowsTarget ? '.exe' : '';
const engines = ['yt-dlp', 'aria2c', 'ffmpeg', 'deno'];
const expectedNames = engines.map(engine => `${engine}-${target}${suffix}`);
const targetLock = lock.targets?.[target];

const configuredSource = process.env.FIRELINK_ENGINE_SOURCE_DIR
  ? path.resolve(process.env.FIRELINK_ENGINE_SOURCE_DIR)
  : null;
const canonicalSource = path.join(binariesRoot, target);
const provisionedSource = path.join(repoRoot, 'src-tauri', 'provisioned-engines', target);
const legacyMacSource = target.endsWith('apple-darwin') ? binariesRoot : null;
const source = [configuredSource, canonicalSource, provisionedSource, legacyMacSource]
  .filter(Boolean)
  .find(candidate => expectedNames.every(name => fs.existsSync(path.join(candidate, name))));

if (!source) {
  console.error(`No complete engine payload found for ${target}.`);
  console.error(`Expected source directory: ${canonicalSource}`);
  console.error(`Expected files: ${expectedNames.join(', ')}`);
  process.exit(1);
}

if (targetLock) {
  for (const engine of engines) {
    const name = `${engine}-${target}${suffix}`;
    const expected = targetLock.engines?.[engine]?.sha256;
    const actual = sha256(path.join(source, name));
    if (!expected || actual !== expected) {
      console.error(`Checksum mismatch for ${name}. Expected ${expected || 'missing lock'}, got ${actual}.`);
      process.exit(1);
    }
  }

  for (const [runtimeDir, expected] of Object.entries(targetLock.runtimeTrees || {})) {
    const sourceDir = path.join(source, runtimeDir);
    if (!fs.existsSync(sourceDir)) {
      console.error(`Missing locked runtime directory ${runtimeDir} for ${target}.`);
      process.exit(1);
    }
    const actual = treeDigest(sourceDir);
    if (actual.files !== expected.files || actual.sha256 !== expected.sha256) {
      console.error(`Runtime checksum mismatch for ${runtimeDir}.`);
      process.exit(1);
    }
  }
} else {
  const manifestPath = path.join(source, 'payload-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`No committed lock or payload manifest exists for ${target}.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.target !== target) {
    console.error(`Payload manifest target mismatch: ${manifest.target}`);
    process.exit(1);
  }
  for (const [relative, expected] of Object.entries(manifest.files || {})) {
    const file = path.join(source, relative);
    if (!fs.existsSync(file) || sha256(file) !== expected) {
      console.error(`Payload manifest mismatch: ${relative}`);
      process.exit(1);
    }
  }
  const actualFiles = collectRegularFiles(source, {
    ignoredNames: ['payload-manifest.json'],
  }).map(file => path.relative(source, file).split(path.sep).join('/'));
  const expectedFiles = Object.keys(manifest.files || {}).sort();
  actualFiles.sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    console.error(`Payload contains files not covered by manifest for ${target}.`);
    process.exit(1);
  }
}

fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
const destination = path.join(outputRoot, target);
const temporaryRoot = fs.mkdtempSync(path.join(outputRoot, `.staging-${target}-${process.pid}-`));
const temporaryDestination = path.join(temporaryRoot, target);

try {
  fs.mkdirSync(temporaryDestination, { recursive: true, mode: 0o700 });

  for (const name of expectedNames) {
    fs.copyFileSync(path.join(source, name), path.join(temporaryDestination, name));
    if (!isWindowsTarget) {
      fs.chmodSync(path.join(temporaryDestination, name), 0o755);
    }
  }

  for (const runtimeDir of ['_internal', 'aria2-libs']) {
    const sourceDir = path.join(source, runtimeDir);
    if (fs.existsSync(sourceDir)) {
      fs.cpSync(sourceDir, path.join(temporaryDestination, runtimeDir), {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      });
    }
  }
  const payloadManifest = path.join(source, 'payload-manifest.json');
  if (fs.existsSync(payloadManifest)) {
    fs.copyFileSync(payloadManifest, path.join(temporaryDestination, 'payload-manifest.json'));
  }
  await promoteDirectory(temporaryDestination, destination);
} finally {
  await removePathWithRetry(temporaryRoot);
}

console.log(`Staged Firelink engines for ${target} from ${source} into ${destination}`);
