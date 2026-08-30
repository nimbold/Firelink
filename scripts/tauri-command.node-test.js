import assert from 'node:assert/strict';
import test from 'node:test';
import { commandUsesEngineTree } from './tauri-command.js';

test('Tauri engine-consuming commands hold the shared staging lease', () => {
  assert.equal(commandUsesEngineTree(['dev']), true);
  assert.equal(commandUsesEngineTree(['build', '--target', 'x86_64-unknown-linux-gnu']), true);
  assert.equal(commandUsesEngineTree(['bundle', '--bundles', 'appimage']), true);
  assert.equal(commandUsesEngineTree(['info']), false);
  assert.equal(commandUsesEngineTree(['--help']), false);
});
