import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { collectRegularFiles, sha256 } from './engine-payload-integrity.js';
import { promoteDirectory, removePathWithRetry } from './engine-payload-promotion.js';

export function getAria2BuildScriptSha256(repoRoot) {
  const buildScriptPath = path.join(repoRoot, 'scripts/aria2/build.sh');
  return crypto.createHash('sha256')
    .update(fs.readFileSync(buildScriptPath, 'utf8').replaceAll('\r\n', '\n'))
    .digest('hex');
}

export function validateAria2Cache({
  aria2CacheRoot,
  target,
  aria2Source,
  buildScriptSha256,
  toolchainFingerprint = null,
  executableSuffix = '',
}) {
  const manifestPath = path.join(aria2CacheRoot, 'aria2-build-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, reason: 'manifest-not-found' };
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== 1
      || manifest.target !== target
      || manifest.sourceSha256 !== aria2Source.sha256
      || manifest.patchSha256 !== aria2Source.patchSha256
      || manifest.buildScriptSha256 !== buildScriptSha256
    ) {
      return { valid: false, reason: 'manifest-metadata-mismatch' };
    }

    if (
      toolchainFingerprint !== null
      && manifest.toolchainFingerprint !== toolchainFingerprint
    ) {
      return { valid: false, reason: 'toolchain-fingerprint-mismatch' };
    }

    const exeName = `aria2c-${target}${executableSuffix}`;
    const cachedExe = path.join(aria2CacheRoot, exeName);
    if (!fs.existsSync(cachedExe) || sha256(cachedExe) !== manifest.files?.[exeName]) {
      return { valid: false, reason: 'executable-mismatch' };
    }

    if (manifest.files) {
      for (const [rel, expectedSha] of Object.entries(manifest.files)) {
        if (rel === exeName) continue;
        const libFile = path.join(aria2CacheRoot, rel);
        if (!fs.existsSync(libFile) || sha256(libFile) !== expectedSha) {
          return { valid: false, reason: 'library-mismatch' };
        }
      }
    }

    const actualFiles = collectRegularFiles(aria2CacheRoot, {
      ignoredNames: ['aria2-build-manifest.json'],
    }).map(f => path.relative(aria2CacheRoot, f).split(path.sep).join('/'));
    const expectedFiles = Object.keys(manifest.files || {}).sort();
    actualFiles.sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      return { valid: false, reason: 'file-list-mismatch' };
    }

    return { valid: true, manifest };
  } catch {
    return { valid: false, reason: 'manifest-corrupted' };
  }
}

export function restoreAria2Cache({
  aria2CacheRoot,
  payloadDestination,
  target,
  executableSuffix = '',
  isWindows = false,
}) {
  const exeName = `aria2c-${target}${executableSuffix}`;
  const cachedExe = path.join(aria2CacheRoot, exeName);
  const targetExe = path.join(payloadDestination, exeName);
  fs.copyFileSync(cachedExe, targetExe);
  if (!isWindows) fs.chmodSync(targetExe, 0o755);

  const cachedLibs = path.join(aria2CacheRoot, 'aria2-libs');
  if (fs.existsSync(cachedLibs)) {
    fs.cpSync(cachedLibs, path.join(payloadDestination, 'aria2-libs'), {
      recursive: true,
      preserveTimestamps: true,
    });
  }
}

export async function saveAria2Cache({
  aria2CacheRoot,
  payloadDestination,
  target,
  aria2Source,
  buildScriptSha256,
  toolchainFingerprint = null,
  executableSuffix = '',
  aria2Runtime = null,
  isWindows = false,
}) {
  const cacheParent = path.dirname(aria2CacheRoot);
  fs.mkdirSync(cacheParent, { recursive: true });

  const stagingDir = fs.mkdtempSync(
    path.join(cacheParent, `.${path.basename(aria2CacheRoot)}-staging-${process.pid}-`)
  );

  try {
    const targetExeName = `aria2c-${target}${executableSuffix}`;
    const cachedExeDest = path.join(stagingDir, targetExeName);
    fs.copyFileSync(path.join(payloadDestination, targetExeName), cachedExeDest);
    if (!isWindows) fs.chmodSync(cachedExeDest, 0o755);

    const manifestFiles = {
      [targetExeName]: sha256(cachedExeDest),
    };

    if (aria2Runtime && fs.existsSync(aria2Runtime)) {
      const cachedLibsDest = path.join(stagingDir, 'aria2-libs');
      fs.cpSync(aria2Runtime, cachedLibsDest, { recursive: true, preserveTimestamps: true });
      const libFiles = collectRegularFiles(cachedLibsDest);
      for (const lib of libFiles) {
        const rel = path.relative(stagingDir, lib).split(path.sep).join('/');
        manifestFiles[rel] = sha256(lib);
      }
    }

    const cacheManifest = {
      schemaVersion: 1,
      target,
      sourceSha256: aria2Source.sha256,
      patchSha256: aria2Source.patchSha256,
      buildScriptSha256,
      toolchainFingerprint: toolchainFingerprint || null,
      files: manifestFiles,
    };

    fs.writeFileSync(
      path.join(stagingDir, 'aria2-build-manifest.json'),
      `${JSON.stringify(cacheManifest, null, 2)}\n`
    );

    await promoteDirectory(stagingDir, aria2CacheRoot);
  } catch (error) {
    try {
      await removePathWithRetry(stagingDir);
    } catch {}
    throw error;
  }
}
