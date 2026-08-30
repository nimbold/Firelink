import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { commandIsStandaloneBundle, commandUsesEngineTree } from './tauri-command.js';

test('Tauri engine-consuming commands use an engine workspace', () => {
  assert.equal(commandUsesEngineTree(['dev']), true);
  assert.equal(commandUsesEngineTree(['build', '--target', 'x86_64-unknown-linux-gnu']), true);
  assert.equal(commandUsesEngineTree(['bundle', '--bundles', 'appimage']), true);
  assert.equal(commandUsesEngineTree(['info']), false);
  assert.equal(commandUsesEngineTree(['--help']), false);
});

test('standalone bundle commands prepare engines before Tauri starts', () => {
  assert.equal(commandIsStandaloneBundle(['bundle', '--bundles', 'app']), true);
  assert.equal(commandIsStandaloneBundle(['build', '--bundles', 'app']), false);
});

test('the bundle hook accepts a completed wrapper preflight', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, 'before-tauri-bundle.js')],
    {
      cwd: path.join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        FIRELINK_ENGINE_BUNDLE_PREPARED: '1',
        FIRELINK_SKIP_ENGINE_RESOURCE: '',
        FIRELINK_ENGINE_OUTPUT_ROOT: '',
      },
      stdio: 'pipe',
    },
  );
  assert.equal(result.status, 0, result.stderr.toString());
});
