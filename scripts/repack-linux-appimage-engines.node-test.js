import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repackScript = path.join(repositoryRoot, 'scripts', 'repack-linux-appimage-engines.js');

test('repack rejects targets that could escape the engine payload path', () => {
  const result = spawnSync(process.execPath, [repackScript, '--target', '../../../../../../tmp'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      FIRELINK_TARGET_TRIPLE: '',
      TAURI_ENV_TARGET_TRIPLE: '',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported AppImage target: \.\.\/\.\./);
  assert.doesNotMatch(result.stderr, /ENOENT|appimagetool/);
});
