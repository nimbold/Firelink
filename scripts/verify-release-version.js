#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Flag ${name} requires a value.`);
  }
  return value;
}

function readPackageVersion(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Could not read a valid version from package.json.');
  }
  return version;
}

function readTauriVersion(root) {
  const version = JSON.parse(
    fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
  ).version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Could not read a valid version from src-tauri/tauri.conf.json.');
  }
  return version;
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

function readPackageLockVersions(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const topVersion = lock?.version;
  const rootPackageVersion = lock?.packages?.['']?.version;
  if (typeof topVersion !== 'string' || !topVersion.trim()
    || typeof rootPackageVersion !== 'string' || !rootPackageVersion.trim()) {
    throw new Error('Could not read root versions from package-lock.json.');
  }
  return { topVersion, rootPackageVersion };
}

function readCargoLockVersion(root) {
  const cargoLock = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  const blocks = cargoLock.split(/^\[\[package\]\]\r?\n/m).slice(1);
  const rootBlocks = blocks.filter(block =>
    /^name = "firelink"$/m.test(block) && !/^source = /m.test(block)
  );
  if (rootBlocks.length !== 1) {
    throw new Error(`Expected exactly one workspace firelink [[package]] block in src-tauri/Cargo.lock, found ${rootBlocks.length}.`);
  }
  const match = rootBlocks[0].match(/^version = "([^"]+)"$/m);
  if (!match) {
    throw new Error('Could not read the firelink [[package]] version from src-tauri/Cargo.lock.');
  }
  return match[1];
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

const targetRoot = path.resolve(argValue('--root') || repositoryRoot);
const packageLock = readPackageLockVersions(targetRoot);
const versions = {
  'package.json': readPackageVersion(targetRoot),
  'package-lock.json': packageLock.topVersion,
  'package-lock.json (packages[""])': packageLock.rootPackageVersion,
  'src-tauri/Cargo.toml': readCargoVersion(targetRoot),
  'src-tauri/Cargo.lock': readCargoLockVersion(targetRoot),
  'src-tauri/tauri.conf.json': readTauriVersion(targetRoot),
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
