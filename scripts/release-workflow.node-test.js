import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const releaseWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const ciWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
const releaseGuide = fs.readFileSync(path.join(repositoryRoot, 'RELEASE.md'), 'utf8');

test('release Linux dependency installation is mirror-normalized and bounded', () => {
  assert.match(releaseWorkflow, /azure\\\.archive\\\.ubuntu\\\.com/);
  assert.equal((releaseWorkflow.match(/Acquire::Retries=3/g) || []).length, 2);
  assert.equal((releaseWorkflow.match(/timeout --foreground --signal=TERM --kill-after=30s 10m apt-get/g) || []).length, 2);
  assert.doesNotMatch(releaseWorkflow, /^\s*sudo apt-get (update|install)/m);
});

test('macOS release verification uses the app mounted from the final DMG', () => {
  assert.match(releaseWorkflow, /npm run verify:macos-signing -- --dmg "\$DMG"/);
  assert.match(releaseWorkflow, /hdiutil attach -nobrowse -readonly -mountpoint "\$MOUNT_POINT" "\$DMG"/);
  assert.match(releaseWorkflow, /find "\$MOUNT_POINT" -maxdepth 1 -type d -name 'Firelink\.app'/);
  assert.match(releaseWorkflow, /node scripts\/verify-binaries\.js --search-root "\$APP"/);
  assert.doesNotMatch(releaseWorkflow, /verify:macos-signing -- --app "\$APP" --dmg/);
});

test('release workflow normalizes all 6 distribution target artifacts', () => {
  assert.match(releaseWorkflow, /rename_asset '\*\.dmg' "Firelink_\$\{VERSION\}_macOS-ARM64\.dmg"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.AppImage' "Firelink-\$\{VERSION\}-x86_64\.AppImage"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.deb' "Firelink_\$\{VERSION\}_Linux-x64\.deb"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.rpm' "Firelink_\$\{VERSION\}_Linux-x64\.rpm"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.exe' "Firelink_\$\{VERSION\}_Windows-x64-setup\.exe"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.zip' "Firelink_\$\{VERSION\}_Windows-x64-portable\.zip"/);
});

test('Linux release pins and verifies appimagetool and its runtime inputs', () => {
  assert.match(releaseWorkflow, /APPIMAGETOOL_SHA256: 95cbe7cce9717fce90c484e34052ee7c7f1d7635b33c12525b4776826a7d29b6/);
  assert.match(releaseWorkflow, /APPIMAGETOOL_RUNTIME_SHA256: 617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46/);
  assert.match(releaseWorkflow, /echo "\$APPIMAGETOOL_RUNTIME_SHA256  \$RUNNER_TEMP\/appimage-runtime" \| sha256sum -c -/);
  assert.match(releaseWorkflow, /APPIMAGETOOL_RUNTIME_FILE: \$\{\{ runner\.temp \}\}\/appimage-runtime/);
});

test('CI covers the declared Node floor and current runtimes while native jobs use Node 24 LTS', () => {
  assert.match(ciWorkflow, /node: \[22\.23\.3, 24\.22\.0, 26\.12\.0\]/);
  assert.equal((ciWorkflow.match(/node-version: 24\.22\.0/g) || []).length, 1);
  assert.equal((releaseWorkflow.match(/node-version: 24\.22\.0/g) || []).length, 1);
  assert.doesNotMatch(`${ciWorkflow}\n${releaseWorkflow}`, /node-version: 24\.21\.0/);
});

test('Tauri CI and release workflows pin stable explicitly and Windows support floor is consistent', () => {
  const workflows = `${ciWorkflow}\n${releaseWorkflow}`;
  assert.equal((workflows.match(/dtolnay\/rust-toolchain@b725eda525362e7cf34af9a7243cac1e3f01a7ec/g) || []).length, 3);
  assert.equal((workflows.match(/toolchain: stable/g) || []).length, 3);
  assert.doesNotMatch(workflows, /dtolnay\/rust-toolchain@686976e191b89faba57d3206551f0f330d8cb249/);
  assert.match(readme, /Windows 10 22H2 or newer/);
  assert.match(releaseGuide, /Windows 10 22H2\+ target/);
  assert.match(releaseGuide, /clean Windows 10 22H2\s+client \(OS build 19045\.x\)/);
  assert.match(releaseGuide, /--assert-no-visible-child-windows.*--assert-portable-data/s);
});

test('Windows release job packages portable ZIP with portable.flag and data cleanup', () => {
  assert.match(releaseWorkflow, /Set-Content -Path \(Join-Path \$portableRoot 'portable\.flag'\) -Value 'portable'/);
  assert.match(releaseWorkflow, /node scripts\/smoke-packaged-app\.js --executable \$portableExe --assert-no-visible-child-windows --assert-portable-data/);
  assert.match(releaseWorkflow, /Remove-Item -Recurse -Force \$portableDataDir/);
  assert.match(releaseWorkflow, /refusing to package a ZIP containing runtime data/);
});
