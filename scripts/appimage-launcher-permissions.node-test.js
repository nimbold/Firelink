import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  normalizeAppRunPermissions,
  verifyAppRunPermissions,
} from './appimage-launcher-permissions.js';

function createAppDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-appimage-launcher-test-'));
  const hookDirectory = path.join(root, 'apprun-hooks');
  fs.mkdirSync(hookDirectory);
  fs.writeFileSync(
    path.join(root, 'AppRun'),
    '#!/usr/bin/env bash\nsource "$this_dir"/apprun-hooks/"linuxdeploy-plugin-gtk.sh"\nexec "$this_dir"/AppRun.wrapped "$@"\n',
  );
  fs.writeFileSync(path.join(root, 'AppRun.wrapped'), 'ELF launcher fixture');
  fs.writeFileSync(path.join(hookDirectory, 'linuxdeploy-plugin-gtk.sh'), '# GTK hook fixture\n');
  return root;
}

function setAccessibleExcept(root, overrides = {}) {
  fs.chmodSync(root, overrides.root ?? 0o755);
  fs.chmodSync(path.join(root, 'AppRun'), overrides.appRun ?? 0o755);
  fs.chmodSync(path.join(root, 'AppRun.wrapped'), overrides.appRunWrapped ?? 0o755);
  fs.chmodSync(path.join(root, 'apprun-hooks'), overrides.hookDirectory ?? 0o755);
  fs.chmodSync(path.join(root, 'apprun-hooks', 'linuxdeploy-plugin-gtk.sh'), overrides.hook ?? 0o644);
}

test('normalizes AppImage root, launch files, and the sourced hook for root-owned mounts', () => {
  const root = createAppDir();
  try {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(path.join(root, 'AppRun'), 0o700);
    fs.chmodSync(path.join(root, 'AppRun.wrapped'), 0o770);
    fs.chmodSync(path.join(root, 'apprun-hooks'), 0o700);
    fs.chmodSync(path.join(root, 'apprun-hooks', 'linuxdeploy-plugin-gtk.sh'), 0o600);

    assert.equal(normalizeAppRunPermissions(root), true);
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, 'AppRun')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, 'AppRun.wrapped')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, 'apprun-hooks')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, 'apprun-hooks', 'linuxdeploy-plugin-gtk.sh')).mode & 0o777, 0o644);
    assert.equal(verifyAppRunPermissions(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-pack verification rejects an owner/group-only wrapped launcher', () => {
  const root = createAppDir();
  try {
    setAccessibleExcept(root, { appRunWrapped: 0o770 });

    assert.throws(() => verifyAppRunPermissions(root), /other users.*mode 0770/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when the AppRun wrapper contract changes', () => {
  const root = createAppDir();
  try {
    fs.writeFileSync(path.join(root, 'AppRun'), '#!/usr/bin/env bash\nexec "$this_dir"/launch-v2 "$@"\n');
    setAccessibleExcept(root, { appRunWrapped: 0o770 });

    assert.throws(() => normalizeAppRunPermissions(root), /does not invoke the supported AppRun\.wrapped launcher/);
    assert.equal(fs.statSync(path.join(root, 'AppRun.wrapped')).mode & 0o777, 0o770);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when AppRun invokes a near-match launcher with a decoy AppRun.wrapped', () => {
  const root = createAppDir();
  try {
    fs.writeFileSync(
      path.join(root, 'AppRun'),
      '#!/usr/bin/env bash\nsource "$this_dir"/apprun-hooks/"linuxdeploy-plugin-gtk.sh"\nexec "$this_dir"/AppRun.wrapped.real "$@"\n',
    );
    fs.writeFileSync(path.join(root, 'AppRun.wrapped.real'), 'Actual launcher fixture');
    setAccessibleExcept(root, { appRunWrapped: 0o700 });

    assert.throws(() => normalizeAppRunPermissions(root), /does not invoke the supported AppRun\.wrapped launcher/);
    assert.equal(fs.statSync(path.join(root, 'AppRun.wrapped')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'AppRun.wrapped.real')).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('post-pack verification rejects an inaccessible AppDir root and AppRun hook path', () => {
  const root = createAppDir();
  try {
    setAccessibleExcept(root, { root: 0o700 });
    assert.throws(() => verifyAppRunPermissions(root), /AppDir root.*mode 0700/);

    setAccessibleExcept(root, { hookDirectory: 0o700 });
    assert.throws(() => verifyAppRunPermissions(root), /hook directory.*mode 0700/);

    setAccessibleExcept(root, { hook: 0o600 });
    assert.throws(() => verifyAppRunPermissions(root), /GTK AppRun hook.*mode 0600/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an AppRun.wrapped symlink instead of chmodding its target', { skip: process.platform === 'win32' }, () => {
  const root = createAppDir();
  const outside = `${root}-outside`;
  try {
    setAccessibleExcept(root);
    fs.writeFileSync(outside, 'outside AppDir');
    fs.chmodSync(outside, 0o600);
    fs.unlinkSync(path.join(root, 'AppRun.wrapped'));
    fs.symlinkSync(outside, path.join(root, 'AppRun.wrapped'));

    assert.throws(() => normalizeAppRunPermissions(root), /must not be a symbolic link/);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
