import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertPayloadManifestProvenance,
  buildPayloadProvenance,
  readAndValidatePayloadManifest,
} from './engine-payload-manifest.js';
import { sha256 } from './engine-payload-integrity.js';

const TARGET = 'x86_64-unknown-linux-gnu';
const SOURCES = {
  'yt-dlp': {
    version: '2026.08.19',
    url: 'https://example.invalid/yt-dlp.zip',
    sha256: 'a'.repeat(64),
  },
  deno: {
    version: '2.9.6',
    url: 'https://example.invalid/deno.zip',
    sha256: 'b'.repeat(64),
  },
  ffmpeg: {
    version: '9.0.1',
    url: 'https://example.invalid/ffmpeg.tar.xz',
    sha256: 'c'.repeat(64),
  },
  aria2c: {
    version: '1.37.0-firelink-native-dns-v1',
    url: 'https://example.invalid/aria2.tar.xz',
    sha256: 'd'.repeat(64),
    buildFromSource: true,
    patchSha256: 'e'.repeat(64),
    allocationTelemetry: true,
    firelinkRouteContract: {
      revision: 'firelink-native-dns-v1',
      dnsResolver: 'native-async',
      networkTargetPolicy: 'firelink-v1',
      networkTargetPolicyDigest: 'sha256:test',
    },
  },
};

function createPayload() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-engine-manifest-'));
  const file = path.join(root, 'aria2c');
  fs.writeFileSync(file, 'verified engine');
  const manifest = {
    schemaVersion: 1,
    target: TARGET,
    generatedFrom: buildPayloadProvenance(SOURCES),
    files: { aria2c: sha256(file) },
  };
  fs.writeFileSync(path.join(root, 'payload-manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { root, manifest };
}

test('payload manifest validation binds files and source provenance', () => {
  const { root, manifest } = createPayload();
  try {
    assert.deepEqual(readAndValidatePayloadManifest(root, SOURCES, TARGET), manifest);
    assert.doesNotThrow(() => assertPayloadManifestProvenance(manifest, SOURCES, TARGET));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('payload manifest validation rejects changed provenance and path traversal', () => {
  const { root, manifest } = createPayload();
  try {
    const changed = { ...manifest, generatedFrom: { ...manifest.generatedFrom } };
    changed.generatedFrom.aria2c = {
      ...changed.generatedFrom.aria2c,
      patchSha256: 'f'.repeat(64),
    };
    fs.writeFileSync(path.join(root, 'payload-manifest.json'), JSON.stringify(changed));
    assert.throws(
      () => readAndValidatePayloadManifest(root, SOURCES, TARGET),
      /provenance mismatch/,
    );

    const traversal = {
      ...manifest,
      files: { '../outside': '0'.repeat(64) },
    };
    fs.writeFileSync(path.join(root, 'payload-manifest.json'), JSON.stringify(traversal));
    assert.throws(
      () => readAndValidatePayloadManifest(root, SOURCES, TARGET),
      /escapes its root|files do not match/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
