import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyCompanionRelease } from './verify-companion-release.js';

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
