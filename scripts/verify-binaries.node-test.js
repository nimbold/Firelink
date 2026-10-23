import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(repoRoot, 'scripts');
const sourceBinaries = path.join(repoRoot, 'src-tauri', 'binaries');
const target = 'aarch64-apple-darwin';

function linkOrCopy(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      throw error;
    }
    fs.copyFileSync(source, destination);
  }
}

function cloneDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      cloneDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      linkOrCopy(sourcePath, destinationPath);
    } else {
      throw new Error(`Unexpected filesystem entry in packaged fixture: ${sourcePath}`);
    }
  }
}

function packageFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-verify-binaries-'));
  const root = path.join(base, 'binaries');
  cloneDirectory(sourceBinaries, root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return root;
}

function replaceWithTamperedFile(file) {
  const mode = fs.statSync(file).mode & 0o777;
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'tampered packaged engine payload', { mode });
}

function verifyMacPackage(root) {
  return spawnSync(process.execPath, [
    path.join(scriptsDir, 'verify-binaries.js'),
    '--root', root,
    '--target', target,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

test('final macOS package verification rejects a tampered locked executable', t => {
  const root = packageFixture(t);
  replaceWithTamperedFile(path.join(root, `deno-${target}`));

  const result = verifyMacPackage(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`deno-${target} SHA-256 does not match engines\\.lock\\.json`));
});

test('final macOS package verification rejects a tampered locked runtime tree', t => {
  const root = packageFixture(t);
  replaceWithTamperedFile(path.join(
    root,
    '_internal',
    'yt_dlp_ejs',
    'yt',
    'solver',
    'core.min.js',
  ));

  const result = verifyMacPackage(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /_internal runtime-tree hashes do not match engines\.lock\.json/);
});
