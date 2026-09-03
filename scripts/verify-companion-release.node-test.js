import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { exactVersionTag, verifyCompanionRelease } from './verify-companion-release.js';

function createFixture(packageVersion, manifestVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-companion-release-'));
  const extensionRoot = path.join(root, 'Extensions', 'Browser');
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, 'package.json'),
    `${JSON.stringify({ version: packageVersion }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(extensionRoot, 'manifest.json'),
    `${JSON.stringify({ version: manifestVersion }, null, 2)}\n`
  );
  return root;
}

test('accepts matching Companion metadata and exact release tag', () => {
  const root = createFixture('2.0.7', '2.0.7');
  try {
    let resolvedExpectedTag;
    assert.deepEqual(
      verifyCompanionRelease({
        repositoryRoot: root,
        resolveExactTag: (_extensionRoot, expectedTag) => {
          resolvedExpectedTag = expectedTag;
          return 'v2.0.7';
        },
      }),
      { tag: 'v2.0.7', version: '2.0.7' }
    );
    assert.equal(resolvedExpectedTag, 'v2.0.7');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects mismatched Companion package and manifest versions', () => {
  const root = createFixture('2.0.7', '2.0.6');
  try {
    assert.throws(
      () => verifyCompanionRelease({ repositoryRoot: root, resolveExactTag: () => 'v2.0.7' }),
      /versions do not agree/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a malformed Companion semantic version before tag lookup', () => {
  const root = createFixture('--contains=HEAD', '--contains=HEAD');
  let tagLookupCalled = false;
  try {
    assert.throws(
      () => verifyCompanionRelease({
        repositoryRoot: root,
        resolveExactTag: () => {
          tagLookupCalled = true;
          return 'v--contains=HEAD';
        },
      }),
      /not a valid semantic version/
    );
    assert.equal(tagLookupCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an untagged Companion commit', () => {
  const root = createFixture('2.0.7', '2.0.7');
  try {
    assert.throws(
      () => verifyCompanionRelease({ repositoryRoot: root, resolveExactTag: () => null }),
      /not exactly tagged v2.0.7/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts aligned untagged Companion metadata for a non-publishing audit', () => {
  const root = createFixture('2.0.7', '2.0.7');
  let tagLookupCalled = false;
  try {
    assert.deepEqual(
      verifyCompanionRelease({
        repositoryRoot: root,
        requireExactTag: false,
        resolveExactTag: () => {
          tagLookupCalled = true;
          return null;
        },
      }),
      { tag: null, version: '2.0.7' }
    );
    assert.equal(tagLookupCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a Companion tag for another version', () => {
  const root = createFixture('2.0.7', '2.0.7');
  try {
    assert.throws(
      () => verifyCompanionRelease({ repositoryRoot: root, resolveExactTag: () => 'v2.0.6' }),
      /does not match v2.0.7/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exactVersionTag resolves tag on HEAD with isolated git environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-git-test-'));
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    execFileSync('git', ['init', root], { env: gitEnv, stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'test'], { env: gitEnv, stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'tag', 'v2.0.7'], { env: gitEnv, stdio: 'ignore' });

    const globalConfig = path.join(root, 'global.gitconfig');
    fs.writeFileSync(globalConfig, '[alias]\n\ttag = !printf "v2.0.8\\n"\n');
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    assert.equal(exactVersionTag(root, 'v2.0.7'), 'v2.0.7');
    assert.equal(exactVersionTag(root, 'v2.0.8'), null);
  } finally {
    if (previousGlobalConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
