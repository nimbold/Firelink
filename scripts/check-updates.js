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

function unavailableLatestVersionError(target, engine, targetSpecific) {
  const error = new Error(
    `${targetSpecific ? 'Latest provider version' : 'Latest version'} is unavailable for ${target} ${engine}`
  );
  error.code = 'LATEST_VERSION_UNAVAILABLE';
  return error;
}

function checkRows(
  rows,
  latestByEngine,
  latestByTargetEngine = {},
  latestUrlsByTargetEngine = {},
  targetSpecificEngines = new Set()
) {
  let outdated = 0;
  for (const row of rows) {
    const targetSpecific = targetSpecificEngines.has(row.engine);
    const targetKey = `${row.target}:${row.engine}`;
    const latest = targetSpecific
      ? latestByTargetEngine[targetKey]
      : latestByTargetEngine[targetKey] || latestByEngine[row.engine];
    if (typeof latest !== 'string' || !latest.trim()) {
      throw unavailableLatestVersionError(row.target, row.engine, targetSpecific);
    }
    const current = normalizeVersion(row.version);
    const wanted = normalizeVersion(latest);
    const latestUrl = latestUrlsByTargetEngine[targetKey];
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

  const providerChecks = [
    ['yt-dlp latest release', () => githubLatest('yt-dlp/yt-dlp')],
    ['Deno latest release', () => githubLatest('denoland/deno')],
    ['aria2 latest release', () => githubLatest('aria2/aria2')],
    [
      'FFmpeg stable release',
      async () => {
        const version = await latestFfmpegStable();
        if (!version) throw new Error('FFmpeg release provider response has no usable version');
        return version;
      },
    ],
    [
      'Martin Riedl macOS release',
      async () => {
        const version = await latestMartinRiedlMacArm64Release();
        if (!version) throw new Error('Martin Riedl macOS release provider response has no usable version');
        return version;
      },
    ],
    [
      'Martin Riedl macOS snapshot',
      async () => {
        const build = await latestMartinRiedlMacArm64Snapshot();
        if (!build?.version || !build.url) {
          throw new Error('Martin Riedl FFmpeg provider response has no complete macOS arm64 snapshot');
        }
        return build;
      },
    ],
    [
      'BtbN FFmpeg Windows/Linux build',
      async () => {
        const build = await latestBtbnFfmpegN81Build();
        if (!build?.version || !build.urls?.windows || !build.urls?.linux) {
          throw new Error('BtbN FFmpeg provider response has no complete Windows/Linux build');
        }
        return build;
      },
    ],
  ];
  const providerResults = await Promise.allSettled(providerChecks.map(([, check]) => check()));
  const providerFailures = [];
  for (const [index, [label]] of providerChecks.entries()) {
    const result = providerResults[index];
    if (result.status === 'rejected') {
      const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
      providerFailures.push(label);
      console.error(`provider unavailable: ${label}: ${detail}`);
    }
  }
  const providerValue = index =>
    providerResults[index].status === 'fulfilled' ? providerResults[index].value : undefined;
  const ytDlp = providerValue(0);
  const deno = providerValue(1);
  const aria2 = providerValue(2);
  const ffmpeg = providerValue(3);
  const martinRiedlMacArm64Snapshot = providerValue(5);
  const btbnFfmpegN81Build = providerValue(6);
  const latestByEngine = {
    'yt-dlp': ytDlp?.tag_name,
    deno: deno?.tag_name,
    aria2c: aria2?.tag_name,
    ffmpeg,
  };
  const latestByTargetEngine = {};
  const latestUrlsByTargetEngine = {};
  if (btbnFfmpegN81Build?.version && btbnFfmpegN81Build.urls?.windows && btbnFfmpegN81Build.urls?.linux) {
    latestByTargetEngine['x86_64-pc-windows-msvc:ffmpeg'] = btbnFfmpegN81Build.version;
    latestByTargetEngine['x86_64-unknown-linux-gnu:ffmpeg'] = btbnFfmpegN81Build.version;
    latestUrlsByTargetEngine['x86_64-pc-windows-msvc:ffmpeg'] = btbnFfmpegN81Build.urls.windows;
    latestUrlsByTargetEngine['x86_64-unknown-linux-gnu:ffmpeg'] = btbnFfmpegN81Build.urls.linux;
  }
  if (martinRiedlMacArm64Snapshot?.version && martinRiedlMacArm64Snapshot.url) {
    latestByTargetEngine['aarch64-apple-darwin:ffmpeg'] = martinRiedlMacArm64Snapshot.version;
    latestUrlsByTargetEngine['aarch64-apple-darwin:ffmpeg'] = martinRiedlMacArm64Snapshot.url;
  }
  const displayVersion = value => (value ? normalizeVersion(value) : 'unavailable');

  console.log('\nlatest engines:');
  for (const [engine, version] of Object.entries(latestByEngine)) {
    console.log(`  ${engine}: ${displayVersion(version)}`);
  }
  console.log('\nlatest engine provider builds:');
  console.log(`  BtbN FFmpeg n8.1 Windows/Linux: ${displayVersion(btbnFfmpegN81Build?.version)}`);
  console.log(`  Martin Riedl FFmpeg macOS arm64 snapshot: ${displayVersion(martinRiedlMacArm64Snapshot?.version)}`);

  const targetSpecificEngines = new Set(['ffmpeg']);
  const engineCheckFailures = [];
  const runEngineCheck = (label, rows) => {
    try {
      return checkRows(
        rows,
        latestByEngine,
        latestByTargetEngine,
        latestUrlsByTargetEngine,
        targetSpecificEngines
      );
    } catch (error) {
      if (error?.code !== 'LATEST_VERSION_UNAVAILABLE') throw error;
      const detail = error instanceof Error ? error.message : String(error);
      engineCheckFailures.push(label);
      console.error(`engine provider unavailable: ${label}: ${detail}`);
      return 0;
    }
  };

  console.log('\nengine source lock:');
  outdatedCount += runEngineCheck(
    'engine source lock',
    sourceEngineVersions(parseJsonFile('engine-sources.lock.json')),
  );

  console.log('\npackaged engine lock:');
  outdatedCount += runEngineCheck(
    'packaged engine lock',
    packagedEngineVersions(parseJsonFile('engines.lock.json')),
  );

  if (outdatedCount > 0) {
    console.error(`\n${outdatedCount} outdated item(s) found.`);
    process.exit(1);
  }
  if (providerFailures.length > 0) {
    console.error(`\n${providerFailures.length} provider check(s) unavailable; refusing to claim that all updates are current.`);
  }
  if (engineCheckFailures.length > 0) {
    console.error(`\n${engineCheckFailures.length} engine lock check(s) unavailable; refusing to claim that all engines are current.`);
  }
  if (providerFailures.length > 0 || engineCheckFailures.length > 0) {
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
