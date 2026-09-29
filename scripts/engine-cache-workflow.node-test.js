import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const ciWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const releaseWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const engineToolchainFingerprint = fs.readFileSync(
  path.join(repositoryRoot, 'scripts', 'engine-toolchain-fingerprint.js'),
  'utf8',
);
const engineProvisioner = fs.readFileSync(
  path.join(repositoryRoot, 'scripts', 'provision-engines.js'),
  'utf8',
);
const aria2BuildScript = fs.readFileSync(
  path.join(repositoryRoot, 'scripts', 'aria2', 'build.sh'),
  'utf8',
);
const cacheActionSha = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';

test('frontend CI covers the supported Node lines and native builds use the current LTS', () => {
  const frontendJob = ciWorkflow.slice(
    ciWorkflow.indexOf('\n  frontend:'),
    ciWorkflow.indexOf('\n  desktop:'),
  );
  const desktopJob = ciWorkflow.slice(ciWorkflow.indexOf('\n  desktop:'));

  assert.match(ciWorkflow, /uses: actions\/setup-node@v7(?:\.\d+){0,2}/);
  assert.match(frontendJob, /node:\s*\[22\.23\.3,\s*24\.21\.0\]/);
  assert.match(frontendJob, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(desktopJob, /node-version: 24\.21\.0/);
  assert.match(releaseWorkflow, /node-version: 24\.21\.0/);
  assert.doesNotMatch(`${ciWorkflow}\n${releaseWorkflow}`, /node-version: 22\.12(?:\D|$)/);
});

test('macOS CI and release jobs target the macOS 27 arm64 runner image', () => {
  assert.match(ciWorkflow, /- os: xcode-27\s+target: aarch64-apple-darwin/);
  assert.match(releaseWorkflow, /os: xcode-27/);
  assert.doesNotMatch(`${ciWorkflow}\n${releaseWorkflow}`, /os: macos-(?:latest|26)(?:\s|$)/);
});

test('Windows Aria2 build, dependency fingerprint, and CI install use MSYS2 UCRT64 consistently', () => {
  const ucrtPackages = [...engineToolchainFingerprint.matchAll(/^\s*'(mingw-w64-ucrt-x86_64-[^']+)',?$/gm)]
    .map((match) => match[1]);
  assert.ok(ucrtPackages.length > 0, 'the Aria2 cache fingerprint must include UCRT64 packages');

  for (const [name, workflow] of [['CI', ciWorkflow], ['release', releaseWorkflow]]) {
    const setupStep = workflow.match(/uses: msys2\/setup-msys2@[^\n]+\n\s+with:\n\s+msystem: (\S+)\n\s+install: >-\n((?:\s+[^\n]+\n)+)/);
    assert.ok(setupStep, `${name} must configure the MSYS2 build environment`);
    assert.equal(setupStep[1], 'UCRT64');
    const installedPackages = new Set(setupStep[2].trim().split(/\s+/));
    for (const packageName of ucrtPackages) {
      assert.ok(installedPackages.has(packageName), `${name} must install fingerprinted package ${packageName}`);
    }
    assert.doesNotMatch(setupStep[2], /mingw-w64-x86_64-/);
  }

  assert.match(engineProvisioner, /MSYSTEM: 'UCRT64'/);
  assert.match(aria2BuildScript, /\$\{MSYSTEM:-\}.*!= "UCRT64"/s);
  assert.match(aria2BuildScript, /mingw_prefix=\/ucrt64/);
  assert.match(engineToolchainFingerprint, /const msystem = run\(bash, \['-lc', 'printf/);
  assert.match(engineToolchainFingerprint, /if \(msystem !== 'UCRT64'\)/);
  assert.match(engineToolchainFingerprint, /records\.push\(`msystem=\$\{msystem\}`\)/);
});

test('third-party workflow actions are pinned to full commit SHAs with ref comments', () => {
  for (const [name, workflow] of [['CI', ciWorkflow], ['release', releaseWorkflow]]) {
    for (const match of workflow.matchAll(/^\s+uses:\s*([^\s#]+)(?:\s+#\s*(.*))?$/gm)) {
      const [, reference, comment = ''] = match;
      const owner = reference.split('/')[0];
      if (owner === 'actions') continue;

      assert.match(reference, /^[^@]+@[0-9a-f]{40}$/, `${name} action must use a full commit SHA: ${reference}`);
      assert.notEqual(comment.trim(), '', `${name} action pin needs a version or ref comment: ${reference}`);
    }
  }
});

function assertSafeEngineCacheWorkflow(workflow) {
  assert.match(workflow, new RegExp(`actions/cache/restore@${cacheActionSha}`));
  assert.match(workflow, /key: firelink-engine-payload-v1-\$\{\{ matrix\.target \}\}-\$\{\{ steps\.engine-toolchain\.outputs\.fingerprint \}\}/);
  assert.match(workflow, /engine-sources\.lock\.json/);
  assert.match(workflow, /scripts\/aria2\/\*\*/);
  assert.match(workflow, /scripts\/engine-\*\.js/);
  assert.match(workflow, /scripts\/verify-binaries\.js/);
  assert.doesNotMatch(workflow, /restore-keys:/);

  const restore = workflow.indexOf('actions/cache/restore@');
  const validation = workflow.indexOf('id: engine-cache-validation');
  const provision = workflow.indexOf('node scripts/provision-engines.js');
  assert.ok(restore >= 0 && restore < validation && validation < provision);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /FIRELINK_TARGET_TRIPLE: \$\{\{ matrix\.target \}\}/);
}

test('CI and release restore only exact, validated engine payload caches', () => {
  assertSafeEngineCacheWorkflow(ciWorkflow);
  assertSafeEngineCacheWorkflow(releaseWorkflow);
});

test('only trusted main pushes save the shared engine cache', () => {
  assert.match(ciWorkflow, new RegExp(`actions/cache/save@${cacheActionSha}`));
  const save = ciWorkflow.slice(ciWorkflow.indexOf('- name: Save verified engine payload cache'));
  assert.match(save, /github\.event_name == 'push'/);
  assert.match(save, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(releaseWorkflow, /actions\/cache\/save@/);
});

test('CI and release use granular Aria2 build caching and safe timeouts', () => {
  assert.match(ciWorkflow, /timeout-minutes: (?:4[5-9]|[5-9][0-9])/);
  assert.match(ciWorkflow, /uses: Swatinem\/rust-cache@[0-9a-f]{40} # v2\.9\.2/);
  assert.match(ciWorkflow, /key: firelink-aria2-build-v1-\$\{\{ matrix\.target \}\}-\$\{\{ steps\.engine-toolchain\.outputs\.aria2-fingerprint \}\}/);
  assert.match(releaseWorkflow, /key: firelink-aria2-build-v1-\$\{\{ matrix\.target \}\}-\$\{\{ steps\.engine-toolchain\.outputs\.aria2-fingerprint \}\}/);
  const saveAria2 = ciWorkflow.slice(ciWorkflow.indexOf('- name: Save verified Aria2 build cache'));
  assert.match(saveAria2, /github\.event_name == 'push'/);
  assert.match(saveAria2, /github\.ref == 'refs\/heads\/main'/);
});
