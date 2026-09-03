import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const releaseWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

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
  assert.match(releaseWorkflow, /rename_asset '\*\.AppImage' "Firelink_\$\{VERSION\}_Linux-x64\.AppImage"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.deb' "Firelink_\$\{VERSION\}_Linux-x64\.deb"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.rpm' "Firelink_\$\{VERSION\}_Linux-x64\.rpm"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.exe' "Firelink_\$\{VERSION\}_Windows-x64-setup\.exe"/);
  assert.match(releaseWorkflow, /rename_asset '\*\.zip' "Firelink_\$\{VERSION\}_Windows-x64-portable\.zip"/);
});

test('Windows release job packages portable ZIP with portable.flag and data cleanup', () => {
  assert.match(releaseWorkflow, /Set-Content -Path \(Join-Path \$portableRoot 'portable\.flag'\) -Value 'portable'/);
  assert.match(releaseWorkflow, /node scripts\/smoke-packaged-app\.js --executable \$portableExe --assert-no-visible-child-windows --assert-portable-data/);
  assert.match(releaseWorkflow, /Remove-Item -Recurse -Force \$portableDataDir/);
  assert.match(releaseWorkflow, /refusing to package a ZIP containing runtime data/);
});
