import assert from 'node:assert/strict';
import test from 'node:test';
import { APPIMAGE_CONFIG, appImageBundleArguments } from './build-linux-appimage.js';

test('AppImage config explicitly removes the staged engine payload', () => {
  assert.deepEqual(JSON.parse(APPIMAGE_CONFIG), {
    bundle: {
      resources: {
        'engine-dist/': null,
      },
    },
  });
});

test('AppImage bundling uses the existing binary instead of tauri build', () => {
  const args = appImageBundleArguments('x86_64-unknown-linux-gnu');
  assert.equal(args[3], 'bundle');
  assert.equal(args.includes('build'), false);
  assert.deepEqual(args.slice(-2), ['--config', APPIMAGE_CONFIG]);
});
