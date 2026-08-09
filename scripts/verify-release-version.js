#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPackageVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function readTauriVersion(root) {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
  ).version;
}

function readCargoVersion(root) {
  const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const packageSection = cargo.match(/^\[package\]\s*([\s\S]*?)(?=^\[)/m)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) {
    throw new Error('Could not read the [package] version from src-tauri/Cargo.toml.');
  }
  return version;
}

function versionFromRef(ref) {
  if (!ref || !ref.startsWith('v')) {
    throw new Error(`Expected a semantic version tag such as v1.2.3, received ${ref || 'nothing'}.`);
  }
  const version = ref.slice(1);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Release tag ${ref} does not contain a valid semantic version.`);
  }
  return version;
}

const versions = {
  'package.json': readPackageVersion(repositoryRoot),
  'src-tauri/Cargo.toml': readCargoVersion(repositoryRoot),
  'src-tauri/tauri.conf.json': readTauriVersion(repositoryRoot),
};
const uniqueVersions = new Set(Object.values(versions));
if (uniqueVersions.size !== 1) {
  console.error('Application version manifests do not agree:');
  for (const [file, version] of Object.entries(versions)) console.error(`  ${file}=${version}`);
  process.exit(1);
}

const allowUntagged = process.argv.includes('--allow-untagged');
const tag = argValue('--tag') || process.env.GITHUB_REF_NAME;
const expected = allowUntagged ? Object.values(versions)[0] : versionFromRef(tag);
const mismatches = Object.entries(versions)
  .filter(([, version]) => version !== expected)
  .map(([file, version]) => `${file}=${version}`);

if (!allowUntagged && mismatches.length > 0) {
  console.error(`Release tag ${tag} does not match the application manifests (expected ${expected}).`);
  for (const mismatch of mismatches) console.error(`  ${mismatch}`);
  process.exit(1);
}

console.log(
  allowUntagged
    ? `Non-publishing package version ${expected} matches ${Object.keys(versions).length} manifests.`
    : `Release version ${expected} matches ${Object.keys(versions).length} manifests.`
);
