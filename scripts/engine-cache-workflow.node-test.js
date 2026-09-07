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
const cacheActionSha = '1bd1e32a3bdc45362d1e726936510720a7c30a57';

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
  assert.match(ciWorkflow, /uses: Swatinem\/rust-cache@v2/);
  assert.match(ciWorkflow, /key: firelink-aria2-build-v1-\$\{\{ matrix\.target \}\}-\$\{\{ steps\.engine-toolchain\.outputs\.aria2-fingerprint \}\}/);
  assert.match(releaseWorkflow, /key: firelink-aria2-build-v1-\$\{\{ matrix\.target \}\}-\$\{\{ steps\.engine-toolchain\.outputs\.aria2-fingerprint \}\}/);
  const saveAria2 = ciWorkflow.slice(ciWorkflow.indexOf('- name: Save verified Aria2 build cache'));
  assert.match(saveAria2, /github\.event_name == 'push'/);
  assert.match(saveAria2, /github\.ref == 'refs\/heads\/main'/);
});
