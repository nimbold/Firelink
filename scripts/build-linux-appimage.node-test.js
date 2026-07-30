import assert from 'node:assert/strict';
import test from 'node:test';
import { APPIMAGE_CONFIG, appImageBundleArguments } from './build-linux-appimage.js';

test('AppImage config keeps notices while excluding the staged engine payload', () => {
  assert.deepEqual(JSON.parse(APPIMAGE_CONFIG), {
    bundle: {
      resources: {
        '../THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
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
