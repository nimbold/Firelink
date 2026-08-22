import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const releaseWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

test('release Linux dependency installation is mirror-normalized and bounded', () => {
  assert.match(releaseWorkflow, /azure\\\.archive\\\.ubuntu\\\.com/);
  assert.equal((releaseWorkflow.match(/Acquire::Retries=3/g) || []).length, 2);
  assert.equal((releaseWorkflow.match(/timeout --foreground --signal=TERM --kill-after=30s 10m apt-get/g) || []).length, 2);
  assert.doesNotMatch(releaseWorkflow, /^\s*sudo apt-get (update|install)/m);
});
