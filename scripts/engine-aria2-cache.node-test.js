import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getAria2BuildScriptSha256,
  restoreAria2Cache,
  saveAria2Cache,
  validateAria2Cache,
} from './engine-aria2-cache.js';
import { sha256 } from './engine-payload-integrity.js';

const TARGET = 'x86_64-pc-windows-msvc';
const ARIA2_SOURCE = {
  version: '1.37.0-firelink-native-dns-v1',
  url: 'https://example.invalid/aria2.tar.xz',
  sha256: 'a'.repeat(64),
  buildFromSource: true,
  patch: 'scripts/aria2/firelink.patch',
  patchSha256: 'b'.repeat(64),
  allocationTelemetry: true,
};

function createTestWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-aria2-cache-test-'));
  const payloadDir = path.join(root, 'payload');
  const cacheRoot = path.join(root, 'cache', TARGET);
  fs.mkdirSync(payloadDir, { recursive: true });

  const exeName = `aria2c-${TARGET}.exe`;
  const exePath = path.join(payloadDir, exeName);
  fs.writeFileSync(exePath, 'binary-content-for-testing');

  const libsDir = path.join(payloadDir, 'aria2-libs');
  fs.mkdirSync(libsDir, { recursive: true });
  fs.writeFileSync(path.join(libsDir, 'test.dll'), 'dll-content');

  return { root, payloadDir, cacheRoot, exeName, exePath, libsDir };
}

test('validateAria2Cache fails closed when cache manifest is missing or invalid', () => {
  const { root, cacheRoot } = createTestWorkspace();
  try {
    const missing = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: 'c'.repeat(64),
      executableSuffix: '.exe',
    });
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, 'manifest-not-found');

    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, 'aria2-build-manifest.json'), 'not json');
    const corrupt = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: 'c'.repeat(64),
      executableSuffix: '.exe',
    });
    assert.equal(corrupt.valid, false);
    assert.equal(corrupt.reason, 'manifest-corrupted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('saveAria2Cache, validateAria2Cache, and restoreAria2Cache work end-to-end', async () => {
  const { root, payloadDir, cacheRoot, libsDir } = createTestWorkspace();
  try {
    const buildScriptSha = 'c'.repeat(64);
    const toolchainFingerprint = 'toolchain-v1';

    await saveAria2Cache({
      aria2CacheRoot: cacheRoot,
      payloadDestination: payloadDir,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      toolchainFingerprint,
      executableSuffix: '.exe',
      aria2Runtime: libsDir,
      isWindows: true,
    });

    const valid = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      toolchainFingerprint,
      executableSuffix: '.exe',
    });
    assert.equal(valid.valid, true);

    const wrongFingerprint = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      toolchainFingerprint: 'toolchain-v2',
      executableSuffix: '.exe',
    });
    assert.equal(wrongFingerprint.valid, false);
    assert.equal(wrongFingerprint.reason, 'toolchain-fingerprint-mismatch');

    const restoreDir = path.join(root, 'restored');
    fs.mkdirSync(restoreDir, { recursive: true });
    restoreAria2Cache({
      aria2CacheRoot: cacheRoot,
      payloadDestination: restoreDir,
      target: TARGET,
      executableSuffix: '.exe',
      isWindows: true,
    });

    assert.equal(
      sha256(path.join(restoreDir, `aria2c-${TARGET}.exe`)),
      sha256(path.join(payloadDir, `aria2c-${TARGET}.exe`))
    );
    assert.equal(
      sha256(path.join(restoreDir, 'aria2-libs', 'test.dll')),
      sha256(path.join(payloadDir, 'aria2-libs', 'test.dll'))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validateAria2Cache rejects tampered files or rogue untracked files', async () => {
  const { root, payloadDir, cacheRoot, libsDir } = createTestWorkspace();
  try {
    const buildScriptSha = 'c'.repeat(64);
    await saveAria2Cache({
      aria2CacheRoot: cacheRoot,
      payloadDestination: payloadDir,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      executableSuffix: '.exe',
      aria2Runtime: libsDir,
      isWindows: true,
    });

    // Tamper with cached exe
    const exePath = path.join(cacheRoot, `aria2c-${TARGET}.exe`);
    fs.appendFileSync(exePath, 'tampered');
    const tamperedExe = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      executableSuffix: '.exe',
    });
    assert.equal(tamperedExe.valid, false);
    assert.equal(tamperedExe.reason, 'executable-mismatch');

    // Restore exe, tamper with library
    fs.writeFileSync(exePath, 'binary-content-for-testing');
    const libPath = path.join(cacheRoot, 'aria2-libs', 'test.dll');
    fs.appendFileSync(libPath, 'tampered');
    const tamperedLib = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      executableSuffix: '.exe',
    });
    assert.equal(tamperedLib.valid, false);
    assert.equal(tamperedLib.reason, 'library-mismatch');

    // Restore library, add rogue file
    fs.writeFileSync(libPath, 'dll-content');
    fs.writeFileSync(path.join(cacheRoot, 'rogue.txt'), 'rogue');
    const rogueFile = validateAria2Cache({
      aria2CacheRoot: cacheRoot,
      target: TARGET,
      aria2Source: ARIA2_SOURCE,
      buildScriptSha256: buildScriptSha,
      executableSuffix: '.exe',
    });
    assert.equal(rogueFile.valid, false);
    assert.equal(rogueFile.reason, 'file-list-mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getAria2BuildScriptSha256 reads and hashes build.sh with normalized line endings', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const hash = getAria2BuildScriptSha256(repoRoot);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
});
