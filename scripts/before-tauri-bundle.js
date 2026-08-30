#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { resolveOutputRoot, resolveTargetTriple } from './engine-workspace.js';

if (
  process.env.FIRELINK_SKIP_ENGINE_RESOURCE === '1'
  || process.env.FIRELINK_ENGINE_BUNDLE_PREPARED === '1'
) {
  process.exit(0);
}

// Staging belongs to beforeBuildCommand or the standalone-bundle wrapper.
// This hook is a read-only fence against a missing payload immediately before
// Tauri consumes the resource tree.
const target = resolveTargetTriple();
const outputRoot = resolveOutputRoot();
const suffix = target.includes('windows') ? '.exe' : '';
const destination = path.join(outputRoot, target);
const expectedNames = ['yt-dlp', 'aria2c', 'ffmpeg', 'deno']
  .map(engine => `${engine}-${target}${suffix}`);

for (const name of expectedNames) {
  const candidate = path.join(destination, name);
  if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile()) {
    throw new Error(`Prepared engine payload is incomplete: ${candidate}`);
  }
}

console.log(`Prepared engine payload is present for ${target} at ${destination}`);
