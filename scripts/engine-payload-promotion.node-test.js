import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  promoteDirectory,
  recoverInterruptedPromotion,
  removeOrphanedProvisioningDirectories,
  removePathWithRetry,
} from './engine-payload-promotion.js';

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-payload-promotion-'));
}

test('promotes a verified staging directory and replaces the previous payload', async () => {
  const root = temporaryDirectory();
  try {
    const destination = path.join(root, 'target');
    const staging = path.join(root, 'staging', 'payload');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'engine'), 'old');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'engine'), 'new');

    await promoteDirectory(staging, destination);

    assert.equal(fs.readFileSync(path.join(destination, 'engine'), 'utf8'), 'new');
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.readdirSync(root).some(name => name.includes('.previous-')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an invalid staging path without removing the previous payload', async () => {
  const root = temporaryDirectory();
  try {
    const destination = path.join(root, 'target');
    const staging = path.join(root, 'staging-file');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'engine'), 'old');
    fs.writeFileSync(staging, 'not a directory');

    await assert.rejects(() => promoteDirectory(staging, destination), /not a directory/);
    assert.equal(fs.readFileSync(path.join(destination, 'engine'), 'utf8'), 'old');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovers one interrupted previous payload before publishing a replacement', async () => {
  const root = temporaryDirectory();
  try {
    const destination = path.join(root, 'target');
    const backup = path.join(root, '.target.previous-123-456');
    const staging = path.join(root, 'staging', 'payload');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'engine'), 'old');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'engine'), 'new');

    await promoteDirectory(staging, destination);

    assert.equal(fs.readFileSync(path.join(destination, 'engine'), 'utf8'), 'new');
    assert.equal(fs.existsSync(backup), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when interrupted recovery has multiple candidates', () => {
  const root = temporaryDirectory();
  try {
    const destination = path.join(root, 'target');
    const firstBackup = path.join(root, '.target.previous-123-456');
    const secondBackup = path.join(root, '.target.previous-789-012');
    fs.mkdirSync(firstBackup, { recursive: true });
    fs.mkdirSync(secondBackup, { recursive: true });

    assert.throws(
      () => recoverInterruptedPromotion(destination),
      /found 2 previous payloads/
    );
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(firstBackup), true);
    assert.equal(fs.existsSync(secondBackup), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes a temporary payload tree after it becomes disposable', async () => {
  const root = temporaryDirectory();
  try {
    const temporary = path.join(root, 'temporary');
    fs.mkdirSync(path.join(temporary, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'nested', 'archive'), 'payload');

    await removePathWithRetry(temporary);

    assert.equal(fs.existsSync(temporary), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes orphaned backups from dead provisioners after a successful publish', async () => {
  const root = temporaryDirectory();
  try {
    const destination = path.join(root, 'target');
    const orphanedBackup = path.join(root, '.target.previous-999999999-123456');
    const staging = path.join(root, 'staging', 'payload');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'engine'), 'old');
    fs.mkdirSync(orphanedBackup, { recursive: true });
    fs.writeFileSync(path.join(orphanedBackup, 'engine'), 'orphaned');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'engine'), 'new');

    await promoteDirectory(staging, destination);

    assert.equal(fs.existsSync(orphanedBackup), false);
    assert.equal(fs.readFileSync(path.join(destination, 'engine'), 'utf8'), 'new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes only provisioning staging owned by a dead PID', async () => {
  const root = temporaryDirectory();
  try {
    const target = 'x86_64-unknown-linux-gnu';
    const orphaned = path.join(root, `.firelink-engines-${target}-999999999-dead`);
    const live = path.join(root, `.firelink-engines-${target}-${process.pid}-live`);
    const legacy = path.join(root, `.firelink-engines-${target}-legacy`);
    fs.mkdirSync(orphaned, { recursive: true });
    fs.mkdirSync(live, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });

    await removeOrphanedProvisioningDirectories(root, target);

    assert.equal(fs.existsSync(orphaned), false);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(legacy), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
