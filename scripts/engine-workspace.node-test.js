import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSafeTarget,
  assertSafeOutputRoot,
  createEngineWorkspace,
  engineResourceConfig,
  removeEngineWorkspace,
  resolveOutputRoot,
  resolveTargetTriple,
} from './engine-workspace.js';

test('target resolution accepts explicit and inline target arguments', () => {
  assert.equal(
    resolveTargetTriple(['--target', 'x86_64-unknown-linux-gnu'], {}, 'darwin', 'arm64'),
    'x86_64-unknown-linux-gnu',
  );
  assert.equal(
    resolveTargetTriple(['--target=x86_64-pc-windows-msvc'], {}, 'darwin', 'arm64'),
    'x86_64-pc-windows-msvc',
  );
});

test('target validation rejects path traversal before filesystem use', () => {
  assert.throws(() => assertSafeTarget('../outside'), /Invalid target triple/);
  assert.throws(
    () => resolveTargetTriple(['--target', 'x86_64/../../outside'], {}, 'darwin', 'arm64'),
    /Invalid target triple/,
  );
});

test('engine workspaces are unique and produce an absolute Tauri resource mapping', async () => {
  const first = createEngineWorkspace('aarch64-apple-darwin');
  const second = createEngineWorkspace('aarch64-apple-darwin');
  try {
    assert.notEqual(first.workspace, second.workspace);
    assert.equal(fs.statSync(first.outputRoot).isDirectory(), true);
    const config = JSON.parse(engineResourceConfig(first.outputRoot));
    assert.equal(
      config.bundle.resources[`${path.resolve(first.outputRoot)}${path.sep}`],
      'engine-dist/',
    );
  } finally {
    await removeEngineWorkspace(first.workspace);
    await removeEngineWorkspace(second.workspace);
  }
});

test('staging requires an explicit private output workspace', () => {
  assert.throws(() => resolveOutputRoot([], {}), /No engine output workspace/);
  assert.equal(
    resolveOutputRoot(['--output-root', '/tmp/firelink-engine-run'], {}).endsWith(
      path.join('firelink-engine-run'),
    ),
    true,
  );
});

test('shared repository output roots and descendants are rejected', () => {
  const repoRoot = path.resolve('/repo');
  assert.throws(
    () => assertSafeOutputRoot('/repo/src-tauri/engine-dist/target', [
      repoRoot,
      path.join(repoRoot, 'src-tauri'),
      path.join(repoRoot, 'src-tauri', 'engine-dist'),
    ]),
    /repository-shared engine workspace/,
  );
});

test('output roots are checked after resolving symlinked parents', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-engine-workspace-test-'));
  const sharedRoot = path.join(temporaryRoot, 'shared');
  const linkedRoot = path.join(temporaryRoot, 'linked');
  try {
    fs.mkdirSync(path.join(sharedRoot, 'src-tauri', 'engine-dist'), { recursive: true });
    fs.symlinkSync(sharedRoot, linkedRoot, 'dir');
    assert.throws(
      () => assertSafeOutputRoot(path.join(linkedRoot, 'src-tauri', 'engine-dist', 'target'), [
        sharedRoot,
        path.join(sharedRoot, 'src-tauri'),
        path.join(sharedRoot, 'src-tauri', 'engine-dist'),
      ]),
      /repository-shared engine workspace/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
