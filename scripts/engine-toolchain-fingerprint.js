#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WINDOWS_PACKAGES = [
  'autoconf',
  'automake',
  'libtool',
  'gettext-devel',
  'pkgconf',
  'make',
  'patch',
  'binutils',
  'mingw-w64-x86_64-gcc',
  'mingw-w64-x86_64-binutils',
  'mingw-w64-x86_64-pkgconf',
  'mingw-w64-x86_64-openssl',
  'mingw-w64-x86_64-libssh2',
  'mingw-w64-x86_64-c-ares',
  'mingw-w64-x86_64-expat',
  'mingw-w64-x86_64-sqlite3',
  'mingw-w64-x86_64-zlib',
];

const LINUX_PACKAGES = [
  'gcc',
  'g++',
  'make',
  'patch',
  'binutils',
  'autoconf',
  'automake',
  'libtool',
  'gettext',
  'autopoint',
  'pkg-config',
  'libssl-dev',
  'libssh2-1-dev',
  'libgcrypt20-dev',
  'libc-ares-dev',
  'libexpat1-dev',
  'libsqlite3-dev',
  'zlib1g-dev',
];

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replaceAll('\r\n', '\n').trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Could not fingerprint the engine toolchain with ${command}: ${detail}`);
  }
}

function writeOutput(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
  } else {
    process.stdout.write(line);
  }
}

function main() {
  const target = process.env.FIRELINK_TARGET_TRIPLE;
  if (!target) throw new Error('FIRELINK_TARGET_TRIPLE is required.');

  const records = [`target=${target}`];
  if (process.platform === 'win32') {
    const msysRoot = process.env.FIRELINK_MSYS2_ROOT;
    if (!msysRoot) throw new Error('FIRELINK_MSYS2_ROOT is required on Windows.');
    const bash = path.join(msysRoot, 'usr', 'bin', 'bash.exe');
    const packages = WINDOWS_PACKAGES.join(' ');
    records.push(`msys2-packages=${run(bash, ['-lc', `pacman -Q ${packages}`])}`);
  } else if (process.platform === 'linux') {
    records.push(`debian-packages=${run('dpkg-query', [
      '-W',
      '-f=${binary:Package}=${Version}\\n',
      ...LINUX_PACKAGES,
    ])}`);
    for (const [command, args] of [
      ['gcc', ['--version']],
      ['make', ['--version']],
      ['autoconf', ['--version']],
      ['automake', ['--version']],
      ['pkg-config', ['--version']],
    ]) {
      records.push(`${command}=${run(command, args).split('\n', 1)[0]}`);
    }
  } else {
    throw new Error(`Unsupported engine toolchain host: ${process.platform}`);
  }

  const fingerprint = crypto.createHash('sha256').update(records.join('\n')).digest('hex');
  writeOutput('fingerprint', fingerprint);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
