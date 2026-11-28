import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repositoryRoot, 'scripts', 'verify-release-version.js');
const currentVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
).version;

function runVerifier(tag, ...extraArguments) {
  return spawnSync(process.execPath, [verifier, '--tag', tag, ...extraArguments], {
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

test('release version verifier accepts an untagged non-publishing package audit', () => {
  const result = runVerifier('main', '--allow-untagged');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Non-publishing package version ${currentVersion} matches`));
});

function createVersionFixture({
  packageVersion = '1.5.2',
  packageLockVersion = '1.5.2',
  packageLockRootVersion = '1.5.2',
  cargoVersion = '1.5.2',
  cargoLockVersion = '1.5.2',
  tauriVersion = '1.5.2',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-verify-version-'));
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ version: packageLockVersion, packages: { '': { version: packageLockRootVersion } } }),
  );
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "firelink"\nversion = "${cargoVersion}"\n\n[dependencies]\n`,
  );
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'Cargo.lock'),
    `version = 4\n\n[[package]]\nname = "firelink"\nversion = "${cargoLockVersion}"\n`,
  );
  fs.writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: tauriVersion }));
  return root;
}

test('release version verifier rejects stale package-lock.json version', () => {
  const root = createVersionFixture({ packageLockVersion: '1.5.1', packageLockRootVersion: '1.5.1' });
  try {
    const result = runVerifier('v1.5.2', '--root', root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Application version manifests do not agree/);
    assert.match(result.stderr, /package-lock\.json=1\.5\.1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release version verifier rejects stale src-tauri/Cargo.lock firelink version', () => {
  const root = createVersionFixture({ cargoLockVersion: '1.5.1' });
  try {
    const result = runVerifier('v1.5.2', '--root', root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Application version manifests do not agree/);
    assert.match(result.stderr, /src-tauri\/Cargo\.lock=1\.5\.1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release version verifier rejects stale package-lock.json packages[""] version', () => {
  const root = createVersionFixture({ packageLockVersion: '1.5.2', packageLockRootVersion: '1.5.1' });
  try {
    const result = runVerifier('v1.5.2', '--root', root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Application version manifests do not agree/);
    assert.match(result.stderr, /package-lock\.json \(packages\[""\]\)=1\.5\.1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release version verifier ignores registry firelink package in Cargo.lock', () => {
  const root = createVersionFixture();
  fs.writeFileSync(
    path.join(root, 'src-tauri', 'Cargo.lock'),
    [
      'version = 4',
      '',
      '[[package]]',
      'name = "firelink"',
      'version = "0.1.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      '',
      '[[package]]',
      'name = "firelink"',
      'version = "1.5.2"',
      '',
    ].join('\n'),
  );
  try {
    const result = runVerifier('v1.5.2', '--root', root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release version 1\.5\.2 matches 6 manifests/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release version verifier rejects missing --root flag value', () => {
  const result = runVerifier('v1.5.2', '--root');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Flag --root requires a value/);
});
