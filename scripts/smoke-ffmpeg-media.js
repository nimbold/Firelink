#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTargetTriple } from './engine-workspace.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = resolveTargetTriple();
const suffix = target.includes('windows') ? '.exe' : '';
const engineRoot = process.env.FIRELINK_ENGINE_OUTPUT_ROOT
  ? path.join(path.resolve(process.env.FIRELINK_ENGINE_OUTPUT_ROOT), target)
  : path.join(repoRoot, 'src-tauri', 'binaries');
const ffmpegPath = path.join(engineRoot, `ffmpeg-${target}${suffix}`);

if (!fs.existsSync(ffmpegPath)) {
  throw new Error(`The staged FFmpeg binary does not exist for ${target}.`);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-ffmpeg-smoke-'));
const run = (label, args) => {
  try {
    execFileSync(ffmpegPath, [
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-nostats',
      '-y',
      ...args,
    ], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr]
      .filter(Boolean)
      .map(value => String(value).trim())
      .filter(Boolean)
      .join('\n');
    const reason = error.signal || error.code || error.status || 'unknown error';
    throw new Error(`${label} failed (${reason})${output ? `:\n${output}` : '.'}`);
  }
};

const assertDecodesAudioAndVideo = (label, input) => {
  run(`${label} audio/video stream check`, [
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-f', 'null',
    '-',
  ]);
};

const assertNonEmpty = (label, filePath) => {
  let size;
  try {
    size = fs.statSync(path.join(workspace, filePath)).size;
  } catch {
    throw new Error(`${label} did not produce its expected output.`);
  }
  if (size === 0) throw new Error(`${label} produced an empty output.`);
};

try {
  const source = 'source.mp4';
  const videoOnly = 'video-only.mp4';
  const audioOnly = 'audio-only.m4a';
  const merged = 'merged.mp4';

  run('Synthetic media generation', [
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=3',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-g', '10',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-shortest',
    source,
  ]);
  assertNonEmpty('Synthetic media generation', source);
  assertDecodesAudioAndVideo('Generated source', source);

  run('Video stream split', [
    '-i', source,
    '-map', '0:v:0',
    '-an',
    '-c:v', 'copy',
    videoOnly,
  ]);
  run('Audio stream split', [
    '-i', source,
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'copy',
    audioOnly,
  ]);
  run('Audio/video merge', [
    '-i', videoOnly,
    '-i', audioOnly,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    merged,
  ]);
  assertNonEmpty('Audio/video merge', merged);
  assertDecodesAudioAndVideo('Merged media', merged);

  const hlsPlaylist = 'stream.m3u8';
  run('HLS packaging', [
    '-i', source,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', 'segment-%03d.ts',
    hlsPlaylist,
  ]);
  assertNonEmpty('HLS packaging', hlsPlaylist);
  const hlsSegments = fs.readdirSync(workspace)
    .filter(name => /^segment-\d+\.ts$/.test(name));
  if (hlsSegments.length === 0) throw new Error('HLS packaging produced no media segments.');

  const hlsRemux = 'hls-remux.mkv';
  run('HLS input remux', [
    '-i', hlsPlaylist,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    hlsRemux,
  ]);
  assertNonEmpty('HLS input remux', hlsRemux);
  assertDecodesAudioAndVideo('HLS remux', hlsRemux);

  const dashManifest = 'stream.mpd';
  run('DASH packaging', [
    '-i', source,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    '-f', 'dash',
    '-seg_duration', '1',
    '-use_template', '1',
    '-use_timeline', '1',
    dashManifest,
  ]);
  assertNonEmpty('DASH packaging', dashManifest);
  if (!fs.readFileSync(path.join(workspace, dashManifest), 'utf8').includes('<SegmentTemplate')) {
    throw new Error('DASH packaging produced no segment template.');
  }

  const dashRemux = 'dash-remux.mkv';
  run('DASH input remux', [
    '-i', dashManifest,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    dashRemux,
  ]);
  assertNonEmpty('DASH input remux', dashRemux);
  assertDecodesAudioAndVideo('DASH remux', dashRemux);

  console.log(`FFmpeg media smoke passed for ${target} (split/merge, HLS, and DASH).`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
