import fs from 'node:fs';
import path from 'node:path';

import { collectRegularFiles, sha256 } from './engine-payload-integrity.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function buildPayloadProvenance(targetSources) {
  if (!targetSources || typeof targetSources !== 'object') {
    throw new Error('Engine source lock is missing the target provenance.');
  }

  return Object.fromEntries(
    Object.entries(targetSources).map(([name, source]) => [
      name,
      {
        version: source.version,
        url: source.url || source.sourceUrl,
        sha256: source.sha256 || source.sourceSha256,
        ...(source.buildFromSource === true
          ? {
            patchSha256: source.patchSha256,
            allocationTelemetry: source.allocationTelemetry === true,
          }
          : {}),
        ...(name === 'aria2c' && source.firelinkRouteContract
          ? { firelinkRouteContract: source.firelinkRouteContract }
          : {}),
      },
    ]),
  );
}

export function assertPayloadManifestProvenance(manifest, targetSources, target) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error(`Unsupported engine payload manifest schema for ${target}.`);
  }
  if (manifest.target !== target) {
    throw new Error(`Engine payload manifest target mismatch for ${target}.`);
  }

  const expected = buildPayloadProvenance(targetSources);
  if (JSON.stringify(canonicalize(manifest.generatedFrom))
      !== JSON.stringify(canonicalize(expected))) {
    throw new Error(`Engine payload manifest provenance mismatch for ${target}.`);
  }
}

function resolveManifestFile(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new Error('Engine payload manifest contains an invalid file path.');
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  const relativeToRoot = path.relative(resolvedRoot, candidate);
  if (
    relativeToRoot === '..'
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Engine payload manifest escapes its root: ${relative}.`);
  }
  return candidate;
}

export function readAndValidatePayloadManifest(root, targetSources, target) {
  const manifestPath = path.join(root, 'payload-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Engine payload manifest is missing for ${target}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Engine payload manifest is invalid for ${target}: ${error.message}`);
  }

  assertPayloadManifestProvenance(manifest, targetSources, target);
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error(`Engine payload manifest files are invalid for ${target}.`);
  }

  const expectedFiles = Object.keys(manifest.files).sort();
  const resolvedFiles = new Map(
    expectedFiles.map(relative => [relative, resolveManifestFile(root, relative)]),
  );
  const actualFiles = collectRegularFiles(root, {
    ignoredNames: ['payload-manifest.json'],
  }).map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Engine payload files do not match the manifest for ${target}.`);
  }

  for (const relative of expectedFiles) {
    const expected = manifest.files[relative];
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Engine payload manifest checksum is invalid: ${relative}.`);
    }
    const file = resolvedFiles.get(relative);
    if (!fs.statSync(file).isFile() || sha256(file) !== expected) {
      throw new Error(`Engine payload manifest checksum mismatch: ${relative}.`);
    }
  }

  return manifest;
}
