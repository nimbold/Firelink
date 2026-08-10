import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const packagedAppPath = process.env.FIRELINK_MACOS_APP;

if (packagedAppPath) {
  test('packaged macOS app exports the Torrent UTI and magnet URL scheme', () => {
    assert.equal(process.platform, 'darwin', 'packaged macOS association checks require macOS');
    const infoPlistPath = path.join(packagedAppPath, 'Contents', 'Info.plist');
    assert.ok(fs.existsSync(infoPlistPath), `missing packaged Info.plist: ${infoPlistPath}`);

    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', infoPlistPath], {
      encoding: 'utf8'
    }));
    const urlTypes = Array.isArray(plist.CFBundleURLTypes) ? plist.CFBundleURLTypes : [];
    const schemes = urlTypes.flatMap(entry => (
      entry && typeof entry === 'object' && Array.isArray(entry.CFBundleURLSchemes)
        ? entry.CFBundleURLSchemes.filter(scheme => typeof scheme === 'string')
        : []
    ));
    assert.ok(schemes.includes('firelink'), 'packaged app must retain the Firelink deep-link scheme');
    assert.ok(schemes.includes('magnet'), 'packaged app must export the magnet URL scheme');

    const documentTypes = Array.isArray(plist.CFBundleDocumentTypes) ? plist.CFBundleDocumentTypes : [];
    const torrentDocument = documentTypes.find(entry =>
      entry
      && typeof entry === 'object'
      && Array.isArray(entry.CFBundleTypeExtensions)
      && entry.CFBundleTypeExtensions.some(extension =>
        typeof extension === 'string' && extension.toLowerCase() === 'torrent'
      )
    );
    assert.ok(torrentDocument, 'packaged app must claim the .torrent extension');
    assert.ok(
      Array.isArray(torrentDocument.LSItemContentTypes)
      && torrentDocument.LSItemContentTypes.includes('org.bittorrent.torrent'),
      'packaged app must claim the standard BitTorrent UTI'
    );
  });
}
