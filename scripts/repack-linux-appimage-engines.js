#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectRegularFiles, sha256 } from './engine-payload-integrity.js';
import {
  normalizeAppRunPermissions,
  verifySquashfsAppRunPermissions,
} from './appimage-launcher-permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  throw new Error(message);
}

function mustBeDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`${label} does not exist or is not a directory: ${directory}`);
  }
}

function mustBeFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`${label} does not exist or is not a file: ${file}`);
  }
}

function findSingleAppImage(directory) {
  mustBeDirectory(directory, 'AppImage bundle directory');
  const appImages = fs
    .readdirSync(directory)
    .filter(name => name.endsWith('.AppImage'))
    .map(name => path.join(directory, name));

  if (appImages.length !== 1) {
    fail(`Expected exactly one AppImage in ${directory}, found ${appImages.length}.`);
  }

  return appImages[0];
}

function validatePayloadManifest(root, target, label) {
  const manifestPath = path.join(root, 'payload-manifest.json');
  mustBeFile(manifestPath, `${label} payload manifest`);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`${label} payload manifest is not valid JSON: ${error.message}`);
  }

  if (manifest.target !== target) {
    fail(`${label} payload target mismatch: expected ${target}, got ${manifest.target}`);
  }

  const expectedFiles = Object.keys(manifest.files || {}).sort();
  const actualFiles = collectRegularFiles(root, { ignoredNames: ['payload-manifest.json'] })
    .map(file => path.relative(root, file).split(path.sep).join('/'))
    .sort();

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail(`${label} payload files do not match payload-manifest.json.`);
  }

  for (const relative of expectedFiles) {
    const file = path.join(root, relative);
    if (sha256(file) !== manifest.files[relative]) {
      fail(`${label} payload checksum mismatch: ${relative}`);
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? 'inherit',
    encoding: options.stdio === 'pipe' ? 'utf8' : undefined,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    if (options.stdio === 'pipe') {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    fail(`${command} exited with status ${result.status}`);
  }

  return options.stdio === 'pipe' ? result.stdout : undefined;
}

function main() {
  const target = argValue('--target') || process.env.FIRELINK_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET_TRIPLE;
  if (!target) {
    fail('Pass --target <triple>.');
  }
  if (target !== 'x86_64-unknown-linux-gnu') {
    fail(`Unsupported AppImage target: ${target}. Expected x86_64-unknown-linux-gnu.`);
  }

  const bundleDirectory = path.join(repoRoot, 'src-tauri', 'target', target, 'release', 'bundle', 'appimage');
  const appDir = path.resolve(argValue('--appdir') || path.join(bundleDirectory, 'Firelink.AppDir'));
  const appImage = path.resolve(argValue('--appimage') || findSingleAppImage(bundleDirectory));
  const appImageTool = path.resolve(argValue('--appimagetool') || process.env.APPIMAGETOOL || 'appimagetool');
  const source = path.join(repoRoot, 'src-tauri', 'provisioned-engines', target);
  const destination = path.join(appDir, 'usr', 'lib', 'Firelink', 'engine-dist', target);

  mustBeDirectory(appDir, 'Firelink.AppDir');
  mustBeDirectory(source, 'Provisioned engine payload');
  mustBeFile(appImage, 'AppImage');
  mustBeFile(appImageTool, 'appimagetool');

  validatePayloadManifest(source, target, 'Provisioned engine');

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  validatePayloadManifest(destination, target, 'AppDir engine');

  // AppImage tooling maps ownership to root in the final SquashFS. Normalize
  // every path needed by AppRun so its root-owned read-only mount remains usable
  // by ordinary users. Reject unknown launcher layouts instead of skipping checks.
  normalizeAppRunPermissions(appDir, 'AppDir');

  fs.chmodSync(appImageTool, 0o755);
  run(appImageTool, [appDir, appImage], {
    env: {
      APPIMAGE_EXTRACT_AND_RUN: '1',
      ARCH: 'x86_64',
    },
  });

  // The AppImage runtime's --appimage-extract creates directories as 0700 and
  // does not restore their SquashFS modes. Inspect the image metadata directly
  // so this check reflects the mounted AppImage rather than extraction policy.
  const squashfsListing = run('unsquashfs', ['-lln', appImage], { stdio: 'pipe' });
  verifySquashfsAppRunPermissions(squashfsListing, 'Repacked AppImage');

  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-appimage-'));
  try {
    fs.chmodSync(appImage, 0o755);
    run(appImage, ['--appimage-extract'], {
      cwd: extractRoot,
      env: { APPIMAGE_EXTRACT_AND_RUN: '1' },
      stdio: 'pipe',
    });

    const squashfsRoot = path.join(extractRoot, 'squashfs-root');
    const extractedPayload = path.join(squashfsRoot, 'usr', 'lib', 'Firelink', 'engine-dist', target);
    mustBeDirectory(extractedPayload, 'Extracted AppImage engine payload');
    validatePayloadManifest(extractedPayload, target, 'Extracted AppImage engine');
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }

  console.log(`Repacked and verified AppImage launcher permissions and engine payload for ${target}.`);
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}
