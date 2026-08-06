#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const userAgent = 'firelink-update-check';
const fetchRetryDelaysMs = [250, 1_000];
const fetchTimeoutMs = 30_000;
const retryableHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function httpResponseError(response, url) {
  const status = [response.status, response.statusText].filter(Boolean).join(' ');
  return new Error(`${status}: ${url}`);
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
}

function normalizeVersion(value) {
  return String(value || '')
    .replace(/^v/, '')
    .replace(/^release-/, '');
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part));
  const b = normalizeVersion(right).split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av > bv ? 1 : -1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

function npmOutdated(cwd) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`npm workspace is missing package.json: ${cwd}`);
  }
  try {
    execFileSync('npm', ['outdated', '--json'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return {};
  } catch (error) {
    if (error.status !== 1) {
      const details = error.stderr?.toString().trim();
      throw new Error(details || `npm outdated failed in ${cwd}`);
    }
    const output = error.stdout?.toString() || '{}';
    return JSON.parse(output || '{}');
  }
}

async function fetchJson(url) {
  return fetchWithContext(url, response => response.json());
}

async function fetchText(url) {
  return fetchWithContext(url, response => response.text());
}

async function fetchWithContext(url, readResponse) {
  let lastError;
  for (let attempt = 0; attempt <= fetchRetryDelaysMs.length; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': userAgent },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt === fetchRetryDelaysMs.length) break;
      await new Promise(resolve => setTimeout(resolve, fetchRetryDelaysMs[attempt]));
      continue;
    }

    if (!response.ok) {
      const error = httpResponseError(response, url);
      if (!retryableHttpStatuses.has(response.status) || attempt === fetchRetryDelaysMs.length) {
        await response.body?.cancel();
        throw error;
      }
      await response.body?.cancel();
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, fetchRetryDelaysMs[attempt]));
      continue;
    }

    try {
      return await readResponse(response);
    } catch (error) {
      lastError = error;
      if (attempt === fetchRetryDelaysMs.length) break;
      await new Promise(resolve => setTimeout(resolve, fetchRetryDelaysMs[attempt]));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`fetch failed for ${url}: ${detail}`, { cause: lastError });
}

async function githubLatest(repo) {
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!release || Array.isArray(release) || typeof release.tag_name !== 'string' || !release.tag_name.trim()) {
    throw new Error(`GitHub latest release response for ${repo} has no usable tag_name`);
  }
  return release;
}

async function latestFfmpegStable() {
  const html = await fetchText('https://ffmpeg.org/releases/');
  const versions = [...html.matchAll(/ffmpeg-(\d+\.\d+(?:\.\d+)?)\.tar\.xz/g)].map(match => match[1]);
  const latest = [...new Set(versions)].sort(compareVersions).at(-1);
  if (!latest) throw new Error('FFmpeg release page contained no usable stable release version');
  return latest;
}

async function latestMartinRiedlMacArm64Release() {
  const html = await fetchText('https://ffmpeg.martin-riedl.de/');
  const releaseSection = html.split('Download Release Build')[1] || '';
  const match =
    releaseSection.match(/macOS \(Apple Silicon\/arm64\)[\s\S]*?<b>Release:\s*<\/b>\s*([0-9.]+)/) ||
    releaseSection.match(/macOS \(Apple Silicon\/arm64\)[\s\S]*?Release:\s*([0-9.]+)/);
  return match?.[1];
}

async function latestMartinRiedlMacArm64Snapshot() {
  const html = await fetchText('https://ffmpeg.martin-riedl.de/');
  const snapshotSection = html.split('Download Snapshot Build')[1]?.split('Download Release Build')[0] || '';
  const card = snapshotSection.match(/<h3>macOS \(Apple Silicon\/arm64\)<\/h3>[\s\S]*?<\/div>/)?.[0] || '';
  const match =
    card.match(/<b>Release:\s*<\/b>\s*([A-Za-z0-9.-]+)/) ||
    card.match(/Release:\s*([A-Za-z0-9.-]+)/);
  const url = card.match(/href="([^"]+\/ffmpeg\.zip)"/)?.[1];
  return match?.[1]
    ? { version: match[1], url: url ? new URL(url, 'https://ffmpeg.martin-riedl.de').href : undefined }
    : undefined;
}

async function latestBtbnFfmpegN81Build() {
  const releases = await fetchJson('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10');
  for (const release of releases) {
    if (release.tag_name === 'latest') continue;
    const assets = (release.assets || [])
      .map(asset => {
        const match = asset.name.match(/^ffmpeg-n(8\.1\.\d+-\d+-g[0-9a-f]+)-(win64|linux64)-gpl-8\.1\.(?:zip|tar\.xz)$/);
        if (!match) return undefined;
        return {
          target: match[2] === 'win64' ? 'windows' : 'linux',
          version: match[1],
          url: asset.browser_download_url,
        };
      })
      .filter(Boolean);
    const unique = [...new Set(assets.map(asset => asset.version))];
    const byTarget = Object.fromEntries(assets.map(asset => [asset.target, asset]));
    if (unique.length === 1 && byTarget.windows && byTarget.linux) {
      return {
        version: unique[0],
        urls: { windows: byTarget.windows.url, linux: byTarget.linux.url },
      };
    }
  }
  return undefined;
}

function printNpmReport(label, outdated) {
  const entries = Object.entries(outdated);
  if (!entries.length) {
    console.log(`${label}: current`);
    return 0;
  }
  console.log(`${label}: ${entries.length} outdated package(s)`);
  for (const [name, info] of entries) {
    console.log(`  ${name}: ${info.current} -> ${info.latest} (wanted ${info.wanted})`);
  }
  return entries.length;
}

function sourceEngineVersions(sourceLock) {
  const rows = [];
  for (const [target, engines] of Object.entries(sourceLock.targets || {})) {
    for (const [engine, meta] of Object.entries(engines)) {
      rows.push({ target, engine, version: meta.version, url: meta.url });
    }
  }
  return rows;
}

function packagedEngineVersions(engineLock) {
  const rows = [];
  for (const [target, targetLock] of Object.entries(engineLock.targets || {})) {
    for (const [engine, meta] of Object.entries(targetLock.engines || {})) {
      rows.push({ target, engine, version: meta.version, url: meta.url });
    }
  }
  return rows;
}

function checkRows(rows, latestByEngine, latestByTargetEngine = {}, latestUrlsByTargetEngine = {}) {
  let outdated = 0;
  for (const row of rows) {
    const latest = latestByTargetEngine[`${row.target}:${row.engine}`] || latestByEngine[row.engine];
    if (typeof latest !== 'string' || !latest.trim()) {
      throw new Error(`Latest version is unavailable for ${row.target} ${row.engine}`);
    }
    const current = normalizeVersion(row.version);
    const wanted = normalizeVersion(latest);
    const latestUrl = latestUrlsByTargetEngine[`${row.target}:${row.engine}`];
    const versionOutdated = compareVersions(current, wanted) < 0;
    const sourceOutdated = Boolean(latestUrl && row.url && row.url !== latestUrl);
    const status = versionOutdated ? 'outdated' : sourceOutdated ? 'source-outdated' : 'current';
    if (status !== 'current') outdated += 1;
    console.log(`  ${row.target} ${row.engine}: ${current} -> ${wanted} ${status}`);
    if (sourceOutdated) console.log(`    source: ${row.url} -> ${latestUrl}`);
  }
  return outdated;
}

async function main() {
  let outdatedCount = 0;

  outdatedCount += printNpmReport('root npm', npmOutdated(repoRoot));
  outdatedCount += printNpmReport(
    'Browser extension npm',
    npmOutdated(path.join(repoRoot, 'Extensions', 'Browser'))
  );

  const [
    ytDlp,
    deno,
    aria2,
    ffmpeg,
    martinRiedlMacArm64Ffmpeg,
    martinRiedlMacArm64Snapshot,
    btbnFfmpegN81Build,
  ] = await Promise.all([
    githubLatest('yt-dlp/yt-dlp'),
    githubLatest('denoland/deno'),
    githubLatest('aria2/aria2'),
    latestFfmpegStable(),
    latestMartinRiedlMacArm64Release(),
    latestMartinRiedlMacArm64Snapshot(),
    latestBtbnFfmpegN81Build(),
  ]);
  const latestByEngine = {
    'yt-dlp': ytDlp.tag_name,
    deno: deno.tag_name,
    aria2c: aria2.tag_name,
    ffmpeg,
  };
  if (
    !btbnFfmpegN81Build?.version ||
    !btbnFfmpegN81Build.urls?.windows ||
    !btbnFfmpegN81Build.urls?.linux
  ) {
    throw new Error('BtbN FFmpeg provider response has no complete Windows/Linux build');
  }
  if (!martinRiedlMacArm64Snapshot?.version || !martinRiedlMacArm64Snapshot.url) {
    throw new Error('Martin Riedl FFmpeg provider response has no complete macOS arm64 snapshot');
  }
  const latestByTargetEngine = {
    'x86_64-pc-windows-msvc:ffmpeg': btbnFfmpegN81Build.version,
    'x86_64-unknown-linux-gnu:ffmpeg': btbnFfmpegN81Build.version,
    'aarch64-apple-darwin:ffmpeg': martinRiedlMacArm64Snapshot.version,
  };
  const latestUrlsByTargetEngine = {
    'x86_64-pc-windows-msvc:ffmpeg': btbnFfmpegN81Build.urls.windows,
    'x86_64-unknown-linux-gnu:ffmpeg': btbnFfmpegN81Build.urls.linux,
    'aarch64-apple-darwin:ffmpeg': martinRiedlMacArm64Snapshot.url,
  };

  console.log('\nlatest engines:');
  for (const [engine, version] of Object.entries(latestByEngine)) {
    console.log(`  ${engine}: ${normalizeVersion(version)}`);
  }
  console.log('\nlatest engine provider builds:');
  console.log(`  BtbN FFmpeg n8.1 Windows/Linux: ${normalizeVersion(btbnFfmpegN81Build?.version || ffmpeg)}`);
  console.log(`  Martin Riedl FFmpeg macOS arm64 snapshot: ${normalizeVersion(martinRiedlMacArm64Snapshot?.version || martinRiedlMacArm64Ffmpeg)}`);

  console.log('\nengine source lock:');
  outdatedCount += checkRows(
    sourceEngineVersions(parseJsonFile('engine-sources.lock.json')),
    latestByEngine,
    latestByTargetEngine,
    latestUrlsByTargetEngine
  );

  console.log('\npackaged engine lock:');
  outdatedCount += checkRows(
    packagedEngineVersions(parseJsonFile('engines.lock.json')),
    latestByEngine,
    latestByTargetEngine,
    latestUrlsByTargetEngine
  );

  if (outdatedCount > 0) {
    console.error(`\n${outdatedCount} outdated item(s) found.`);
    process.exit(1);
  }
  console.log('\nAll checked packages and engines are current.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export { checkRows, fetchJson, fetchText, fetchWithContext };
