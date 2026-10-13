#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
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

const runAsync = (label, args) => new Promise((resolve, reject) => {
  const child = spawn(ffmpegPath, [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-nostats',
    '-y',
    ...args,
  ], {
    cwd: workspace,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  let stderrBytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);

  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 8 * 1024 * 1024) stderr.push(chunk);
    else child.kill('SIGKILL');
  });
  child.once('error', error => {
    clearTimeout(timeout);
    reject(new Error(`${label} could not start: ${error.message}`));
  });
  child.once('close', (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve();
      return;
    }
    const output = Buffer.concat(stderr).toString('utf8').trim();
    const reason = timedOut ? 'timed out after 30 seconds' : signal || code || 'unknown error';
    reject(new Error(`${label} failed (${reason})${output ? `:\n${output}` : '.'}`));
  });
});

const startByteRangeHttpServer = async (playlistName, streamName) => {
  const playlistBody = fs.readFileSync(path.join(workspace, playlistName));
  const streamPath = path.join(workspace, streamName);
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requestPath === `/${playlistName}`) {
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': playlistBody.length,
        connection: 'close',
      });
      response.end(playlistBody);
      return;
    }
    if (requestPath !== `/${streamName}`) {
      response.writeHead(404, { connection: 'close' });
      response.end();
      return;
    }

    const size = fs.statSync(streamPath).size;
    const rangeHeader = request.headers.range;
    if (rangeHeader === undefined) {
      response.writeHead(200, {
        'accept-ranges': 'bytes',
        'content-length': size,
        connection: 'close',
      });
      createReadStream(streamPath).pipe(response);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) {
      response.writeHead(416, { 'content-range': `bytes */${size}`, connection: 'close' });
      response.end();
      return;
    }
    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1]
      ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1)
      : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      response.writeHead(416, { 'content-range': `bytes */${size}`, connection: 'close' });
      response.end();
      return;
    }

    response.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
      connection: 'close',
    });
    createReadStream(streamPath, { start, end }).pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise(resolve => server.close(resolve));
    throw new Error('The local byte-range server did not bind an IP address.');
  }

  return {
    url: `http://127.0.0.1:${address.port}/${playlistName}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
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
  const vorbisAudio = 'audio-vorbis.ogg';
  const vorbisRemux = 'vorbis-remux.mkv';

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

  run('Vorbis encoding', [
    '-i', source,
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'libvorbis',
    '-q:a', '4',
    vorbisAudio,
  ]);
  assertNonEmpty('Vorbis encoding', vorbisAudio);
  run('Vorbis remux', [
    '-i', videoOnly,
    '-i', vorbisAudio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c', 'copy',
    vorbisRemux,
  ]);
  assertNonEmpty('Vorbis remux', vorbisRemux);
  assertDecodesAudioAndVideo('Vorbis remux', vorbisRemux);

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

  const byteRangePlaylist = 'stream-byterange.m3u8';
  const byteRangeStream = 'stream-byterange.ts';
  run('HLS byte-range packaging', [
    '-i', source,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'single_file',
    '-hls_segment_filename', byteRangeStream,
    byteRangePlaylist,
  ]);
  assertNonEmpty('HLS byte-range packaging', byteRangePlaylist);
  if (!fs.readFileSync(path.join(workspace, byteRangePlaylist), 'utf8').includes('#EXT-X-BYTERANGE:')) {
    throw new Error('HLS byte-range packaging produced no byte-range segments.');
  }

  const byteRangeRemux = 'hls-byterange-remux.mkv';
  const byteRangeServer = await startByteRangeHttpServer(byteRangePlaylist, byteRangeStream);
  try {
    await runAsync('HLS byte-range input remux', [
      '-i', byteRangeServer.url,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-c', 'copy',
      byteRangeRemux,
    ]);
  } finally {
    await byteRangeServer.close();
  }
  assertNonEmpty('HLS byte-range input remux', byteRangeRemux);
  assertDecodesAudioAndVideo('HLS byte-range remux', byteRangeRemux);

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

  console.log(`FFmpeg media smoke passed for ${target} (Vorbis encode/remux, split/merge, HLS byte ranges, HLS, and DASH).`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
