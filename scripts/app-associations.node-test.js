import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')
);

const torrentAssociation = tauriConfig.bundle.fileAssociations.find(association =>
  association.ext?.some(extension => extension.toLowerCase() === 'torrent')
);

test('declares the native macOS BitTorrent content type', () => {
  assert.ok(torrentAssociation, 'the bundle must declare a .torrent association');
  assert.equal(torrentAssociation.mimeType, 'application/x-bittorrent');
  assert.deepEqual(torrentAssociation.exportedType, {
    identifier: 'org.bittorrent.torrent',
    conformsTo: ['public.data', 'public.item']
  });
  assert.equal(
    torrentAssociation.contentTypes,
    undefined,
    'the UTI declaration supplies the extension and MIME tags for clean installs'
  );
});

test('declares magnet as a desktop deep-link scheme', () => {
  assert.deepEqual(tauriConfig.plugins['deep-link'].desktop.schemes, ['firelink', 'magnet']);
});
