import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repositoryRoot, 'scripts', 'verify-release-version.js');
const currentVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
).version;

function runVerifier(tag) {
  return spawnSync(process.execPath, [verifier, '--tag', tag], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('release version verifier accepts the aligned current version', () => {
  const result = runVerifier(`v${currentVersion}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Release version ${currentVersion} matches`));
});

test('release version verifier rejects the already-published prior tag', () => {
  const result = runVerifier('v1.1.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the application manifests/);
});

test('release version verifier rejects non-semver tag names', () => {
  const result = runVerifier('release-candidate');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /semantic version tag/);
});
