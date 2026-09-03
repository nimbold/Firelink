#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function exactVersionTag(extensionRoot, expectedTag) {
  try {
    const tags = execFileSync(
      'git',
      ['-C', extensionRoot, 'tag', '--points-at', 'HEAD', '--list', '--', expectedTag],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }
    )
      .split(/\r?\n/)
      .map(tag => tag.trim())
      .find(tag => tag === expectedTag);
    return tags || null;
  } catch {
    return null;
  }
}

export function verifyCompanionRelease({
  repositoryRoot = defaultRepositoryRoot,
  resolveExactTag = exactVersionTag,
  requireExactTag = true,
} = {}) {
  const extensionRoot = path.join(repositoryRoot, 'Extensions', 'Browser');
  const packagePath = path.join(extensionRoot, 'package.json');
  const manifestPath = path.join(extensionRoot, 'manifest.json');

  if (!fs.existsSync(packagePath) || !fs.existsSync(manifestPath)) {
    throw new Error('Companion package.json and manifest.json must both exist.');
  }

  const packageVersion = readJson(packagePath).version;
  const manifestVersion = readJson(manifestPath).version;
  if (!packageVersion || packageVersion !== manifestVersion) {
    throw new Error(
      `Companion versions do not agree: package.json=${packageVersion || 'missing'}, ` +
      `manifest.json=${manifestVersion || 'missing'}.`
    );
  }
  if (typeof packageVersion !== 'string' || !SEMVER.test(packageVersion)) {
    throw new Error(`Companion version ${String(packageVersion)} is not a valid semantic version.`);
  }

  const expectedTag = `v${packageVersion}`;
  if (!requireExactTag) {
    return { tag: null, version: packageVersion };
  }
  const tag = resolveExactTag(extensionRoot, expectedTag);
  if (!tag) {
    throw new Error(
      `Companion HEAD is not exactly tagged ${expectedTag}; publish the Companion release first.`
    );
  }
  if (tag !== expectedTag) {
    throw new Error(`Companion HEAD tag ${tag} does not match ${expectedTag}.`);
  }

  return { tag, version: packageVersion };
}

function main() {
  try {
    const requireExactTag = !process.argv.includes('--allow-untagged');
    const { tag, version } = verifyCompanionRelease({ requireExactTag });
    console.log(
      requireExactTag
        ? `Companion release ${version} matches exact tag ${tag}.`
        : `Non-publishing Companion package metadata agrees at version ${version}.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
