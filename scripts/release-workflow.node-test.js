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

test('CI and release Linux dependency installation are mirror-normalized and bounded', () => {
  for (const [name, workflow] of [['release', releaseWorkflow], ['CI', ciWorkflow]]) {
    assert.match(workflow, /azure\\\.archive\\\.ubuntu\\\.com/, `${name} must normalize Azure Ubuntu mirrors`);
    assert.equal((workflow.match(/Acquire::Retries=3/g) || []).length, 2, `${name} must bound both apt-get update and install`);
    assert.equal((workflow.match(/timeout --foreground --signal=TERM --kill-after=30s 10m apt-get/g) || []).length, 2, `${name} must timeout both apt-get update and install`);
    assert.doesNotMatch(workflow, /(?:^|\s)sudo apt-get (?:update|install)\b/m, `${name} must not run unbounded sudo apt-get`);
  }
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

test('Linux release pins immutable appimagetool and runtime releases with retries', () => {
  assert.doesNotMatch(releaseWorkflow, /releases\/download\/continuous\//);
  assert.match(releaseWorkflow, /APPIMAGETOOL_URL: https:\/\/github\.com\/AppImage\/appimagetool\/releases\/download\/1\.9\.1\/appimagetool-x86_64\.AppImage/);
  assert.match(releaseWorkflow, /APPIMAGETOOL_SHA256: ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0/);
  assert.match(releaseWorkflow, /APPIMAGETOOL_RUNTIME_URL: https:\/\/github\.com\/AppImage\/type2-runtime\/releases\/download\/20251108\/runtime-x86_64/);
  assert.match(releaseWorkflow, /APPIMAGETOOL_RUNTIME_SHA256: 2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d/);
  assert.match(releaseWorkflow, /curl -fsSL --retry 3 --retry-all-errors --connect-timeout 30 --max-time 120/);
  assert.match(releaseWorkflow, /echo "\$APPIMAGETOOL_RUNTIME_SHA256  \$RUNNER_TEMP\/appimage-runtime" \| sha256sum -c -/);
  assert.match(releaseWorkflow, /LDAI_RUNTIME_FILE: \$\{\{ runner\.temp \}\}\/appimage-runtime/);
  assert.match(releaseWorkflow, /--runtime-file "\$RUNNER_TEMP\/appimage-runtime"/);
  assert.ok(
    releaseWorkflow.indexOf('- name: Install pinned appimagetool (Linux only)')
      < releaseWorkflow.indexOf('- name: Build Linux AppImage from existing binary'),
    'pinned appimagetool and runtime must be installed before AppImage bundling',
  );
});

test('release workflow scopes write permissions to publish and bounds all jobs', () => {
  const beforeJobs = releaseWorkflow.slice(0, releaseWorkflow.indexOf('\njobs:'));
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf('\n  publish:'));
  assert.match(beforeJobs, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(beforeJobs, /contents: write/);
  assert.match(publishJob, /permissions:\s*\n\s+contents: write/);
  assert.equal((releaseWorkflow.match(/timeout-minutes:/g) || []).length, 3);
});

test('CI covers the declared Node floor and current runtimes while native jobs use Node 24 LTS', () => {
  assert.match(ciWorkflow, /node: \[22\.23\.5, 24\.22\.3, 26\.13\.1\]/);
  assert.equal((ciWorkflow.match(/node-version: 24\.22\.3/g) || []).length, 1);
  assert.equal((releaseWorkflow.match(/node-version: 24\.22\.3/g) || []).length, 1);
  assert.doesNotMatch(`${ciWorkflow}\n${releaseWorkflow}`, /node-version: 24\.22\.0/);
});

test('Tauri CI and release workflows pin stable explicitly and Windows support floor is consistent', () => {
  const workflows = `${ciWorkflow}\n${releaseWorkflow}`;
  assert.equal((workflows.match(/dtolnay\/rust-toolchain@39008827e6b4319a349e9a42dfc90579dd25f1ca/g) || []).length, 3);
  assert.equal((workflows.match(/toolchain: stable/g) || []).length, 3);
  assert.doesNotMatch(workflows, /dtolnay\/rust-toolchain@b725eda525362e7cf34af9a7243cac1e3f01a7ec/);
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
  assert.match(releaseWorkflow, /& 7z a -tzip \$portableZip "\$portableRoot\\\*" -y\s*\n\s*if \(\$LASTEXITCODE -ne 0\)/);
});
