#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const userAgent = 'firelink-update-check';
const fetchRetryDelaysMs = [250, 1_000];
const fetchTimeoutMs = 30_000;
const cargoOutputLimit = 64 * 1024 * 1024;
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

function parseSha256Digest(value) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(value || ''));
  return match?.[1].toLowerCase();
}

function releaseAssetHashes(release) {
  return Object.fromEntries(
    (release?.assets || [])
      .map(asset => {
        const digest = parseSha256Digest(asset.digest);
        return digest && typeof asset.browser_download_url === 'string'
          ? [asset.browser_download_url, digest]
          : undefined;
      })
      .filter(Boolean),
  );
}

function providerAssetHashes({ ytDlp, deno, aria2 }) {
  return {
    ...releaseAssetHashes(ytDlp),
    ...releaseAssetHashes(deno),
    ...releaseAssetHashes(aria2),
  };
}

function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmOutdated(cwd) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`npm workspace is missing package.json: ${cwd}`);
  }
  try {
    execFileSync(npmExecutable(), ['outdated', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  const card = releaseSection.match(/<h3>macOS \(Apple Silicon\/arm64\)<\/h3>[\s\S]*?<\/div>/)?.[0] || '';
  const version =
    card.match(/<b>Release:\s*<\/b>\s*([0-9.]+)/)?.[1] ||
    card.match(/Release:\s*([0-9.]+)/)?.[1];
  const relativeUrl = card.match(/href="([^"]+\/ffmpeg\.zip)"/)?.[1];
  if (!version || !relativeUrl) return undefined;
  const url = new URL(relativeUrl, 'https://ffmpeg.martin-riedl.de').href;
  const checksum = await fetchText(`${url}.sha256`);
  const sha256 = checksum.match(/\b([0-9a-f]{64})\b/i)?.[1]?.toLowerCase();
  return sha256 ? { version, url, sha256 } : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function latestBtbnFfmpegStableBuild(stableVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(stableVersion)) {
    throw new Error(`unsupported FFmpeg stable version: ${stableVersion}`);
  }
  const stableSeries = stableVersion.split('.').slice(0, 2).join('.');
  const versionPattern = escapeRegExp(stableVersion);
  const seriesPattern = escapeRegExp(stableSeries);
  const assetPattern = new RegExp(
    `^ffmpeg-n(${versionPattern}-\\d+-g[0-9a-f]+)-(win64|linux64)-gpl-${seriesPattern}\\.(?:zip|tar\\.xz)$`
  );
  const releases = await fetchJson('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10');
  if (!Array.isArray(releases)) throw new Error('BtbN releases response is not an array');
  for (const release of releases) {
    if (release.tag_name === 'latest') continue;
    const assets = (release.assets || [])
      .map(asset => {
        const match = asset.name.match(assetPattern);
        if (!match) return undefined;
        return {
          target: match[2] === 'win64' ? 'windows' : 'linux',
          version: match[1],
          url: asset.browser_download_url,
          sha256: parseSha256Digest(asset.digest),
        };
      })
      .filter(Boolean);
    const unique = [...new Set(assets.map(asset => asset.version))];
    const byTarget = Object.fromEntries(assets.map(asset => [asset.target, asset]));
    if (
      unique.length === 1 &&
      byTarget.windows?.sha256 &&
      byTarget.linux?.sha256
    ) {
      return {
        version: unique[0],
        urls: { windows: byTarget.windows.url, linux: byTarget.linux.url },
        hashes: { windows: byTarget.windows.sha256, linux: byTarget.linux.sha256 },
      };
    }
  }
  return undefined;
}

function cargoPackages(metadata) {
  if (!metadata || !Array.isArray(metadata.packages)) {
    throw new Error('Cargo metadata contained no package list');
  }
  return metadata.packages.map(pkg => ({
    name: pkg.name,
    version: pkg.version,
    source: pkg.source || 'path',
  }));
}

function diffCargoMetadata(currentMetadata, updatedMetadata) {
  const current = cargoPackages(currentMetadata);
  const updated = cargoPackages(updatedMetadata);
  const groups = new Map();
  for (const [side, packages] of [['current', current], ['updated', updated]]) {
    for (const pkg of packages) {
      const key = `${pkg.name}\0${pkg.source}`;
      const group = groups.get(key) || { name: pkg.name, source: pkg.source, current: [], updated: [] };
      group[side].push(pkg.version);
      groups.set(key, group);
    }
  }

  const changes = [];
  for (const group of groups.values()) {
    const oldVersions = [...group.current];
    const newVersions = [...group.updated];
    for (let index = oldVersions.length - 1; index >= 0; index -= 1) {
      const unchangedIndex = newVersions.indexOf(oldVersions[index]);
      if (unchangedIndex >= 0) {
        oldVersions.splice(index, 1);
        newVersions.splice(unchangedIndex, 1);
      }
    }
    oldVersions.sort(compareVersions);
    newVersions.sort(compareVersions);
    for (let index = 0; index < Math.min(oldVersions.length, newVersions.length); index += 1) {
      changes.push({
        name: group.name,
        version: oldVersions[index],
        latest: newVersions[index],
        source: group.source,
      });
    }
  }
  return changes.sort((left, right) => left.name.localeCompare(right.name));
}

function cargoMetadata(manifestPath) {
  return JSON.parse(execFileSync('cargo', [
    'metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath,
  ], { encoding: 'utf8', maxBuffer: cargoOutputLimit, stdio: ['ignore', 'pipe', 'pipe'] }));
}

function cargoCompatibleUpdates() {
  const sourceDir = path.join(repoRoot, 'src-tauri');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'firelink-cargo-update-'));
  try {
    fs.copyFileSync(path.join(sourceDir, 'Cargo.toml'), path.join(temporaryRoot, 'Cargo.toml'));
    fs.copyFileSync(path.join(sourceDir, 'Cargo.lock'), path.join(temporaryRoot, 'Cargo.lock'));
    fs.mkdirSync(path.join(temporaryRoot, 'src'));
    fs.writeFileSync(path.join(temporaryRoot, 'src', 'lib.rs'), '');
    const manifestPath = path.join(temporaryRoot, 'Cargo.toml');
    const current = cargoMetadata(path.join(sourceDir, 'Cargo.toml'));
    execFileSync('cargo', ['update', '--manifest-path', manifestPath], {
      encoding: 'utf8',
      maxBuffer: cargoOutputLimit,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return diffCargoMetadata(current, cargoMetadata(manifestPath));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function printCargoReport(updates) {
  if (!updates.length) {
    console.log('Rust Cargo: current');
    return 0;
  }
  console.log(`Rust Cargo: ${updates.length} compatible locked package update(s)`);
  for (const update of updates) {
    console.log(`  ${update.name}: ${update.version} -> ${update.latest}`);
  }
  return updates.length;
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
      rows.push({
        target,
        engine,
        version: meta.version,
        url: meta.url,
        sha256: meta.sha256,
        sourceSha256: meta.sourceSha256,
      });
    }
  }
  return rows;
}

function packagedEngineVersions(engineLock) {
  const rows = [];
  for (const [target, targetLock] of Object.entries(engineLock.targets || {})) {
    for (const [engine, meta] of Object.entries(targetLock.engines || {})) {
      rows.push({
        target,
        engine,
        version: meta.version,
        url: meta.url,
        sha256: meta.sha256,
        sourceSha256: meta.sourceSha256,
      });
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
  targetSpecificEngines = new Set(),
  latestHashesByTargetEngine = {},
  latestHashesByUrl = {},
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
    const latestHash = latestHashesByTargetEngine[targetKey] || latestHashesByUrl[row.url];
    const checkedHash = row.sourceSha256 || row.sha256;
    const currentHash = typeof checkedHash === 'string' ? checkedHash.toLowerCase() : '';
    const hashOutdated = Boolean(latestHash && currentHash !== latestHash);
    const status = versionOutdated
      ? 'outdated'
      : sourceOutdated
        ? 'source-outdated'
        : hashOutdated
          ? 'hash-outdated'
          : 'current';
    if (status !== 'current') outdated += 1;
    console.log(`  ${row.target} ${row.engine}: ${current} -> ${wanted} ${status}`);
    if (sourceOutdated) console.log(`    source: ${row.url} -> ${latestUrl}`);
    if (hashOutdated) console.log(`    source sha256: ${checkedHash || 'missing'} -> ${latestHash}`);
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
  outdatedCount += printCargoReport(cargoCompatibleUpdates());

  const ffmpegStablePromise = latestFfmpegStable();
  const providerChecks = [
    ['yt-dlp latest release', () => githubLatest('yt-dlp/yt-dlp')],
    ['Deno latest release', () => githubLatest('denoland/deno')],
    ['aria2 latest release', () => githubLatest('aria2/aria2')],
    [
      'FFmpeg stable release',
      async () => {
        const version = await ffmpegStablePromise;
        if (!version) throw new Error('FFmpeg release provider response has no usable version');
        return version;
      },
    ],
    [
      'Martin Riedl macOS release',
      async () => {
        const build = await latestMartinRiedlMacArm64Release();
        const stableVersion = await ffmpegStablePromise;
        if (!build?.version || !build.url || !build.sha256 || build.version !== stableVersion) {
          throw new Error('Martin Riedl FFmpeg provider response has no complete matching macOS arm64 stable build');
        }
        return build;
      },
    ],
    [
      'BtbN FFmpeg Windows/Linux build',
      async () => {
        const build = await latestBtbnFfmpegStableBuild(await ffmpegStablePromise);
        if (
          !build?.version ||
          !build.urls?.windows ||
          !build.urls?.linux ||
          !build.hashes?.windows ||
          !build.hashes?.linux
        ) {
          throw new Error('BtbN FFmpeg provider response has no complete Windows/Linux build with SHA-256 digests');
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
  const martinRiedlMacArm64Release = providerValue(4);
  const btbnFfmpegStableBuild = providerValue(5);
  const latestByEngine = {
    'yt-dlp': ytDlp?.tag_name,
    deno: deno?.tag_name,
    aria2c: aria2?.tag_name,
    ffmpeg,
  };
  const latestByTargetEngine = {};
  const latestUrlsByTargetEngine = {};
  const latestHashesByTargetEngine = {};
  const latestHashesByUrl = providerAssetHashes({ ytDlp, deno, aria2 });
  if (btbnFfmpegStableBuild?.version && btbnFfmpegStableBuild.urls?.windows && btbnFfmpegStableBuild.urls?.linux) {
    latestByTargetEngine['x86_64-pc-windows-msvc:ffmpeg'] = btbnFfmpegStableBuild.version;
    latestByTargetEngine['x86_64-unknown-linux-gnu:ffmpeg'] = btbnFfmpegStableBuild.version;
    latestUrlsByTargetEngine['x86_64-pc-windows-msvc:ffmpeg'] = btbnFfmpegStableBuild.urls.windows;
    latestUrlsByTargetEngine['x86_64-unknown-linux-gnu:ffmpeg'] = btbnFfmpegStableBuild.urls.linux;
    latestHashesByTargetEngine['x86_64-pc-windows-msvc:ffmpeg'] = btbnFfmpegStableBuild.hashes?.windows;
    latestHashesByTargetEngine['x86_64-unknown-linux-gnu:ffmpeg'] = btbnFfmpegStableBuild.hashes?.linux;
  }
  if (martinRiedlMacArm64Release?.version && martinRiedlMacArm64Release.url) {
    latestByTargetEngine['aarch64-apple-darwin:ffmpeg'] = martinRiedlMacArm64Release.version;
    latestUrlsByTargetEngine['aarch64-apple-darwin:ffmpeg'] = martinRiedlMacArm64Release.url;
    latestHashesByTargetEngine['aarch64-apple-darwin:ffmpeg'] = martinRiedlMacArm64Release.sha256;
  }
  const displayVersion = value => (value ? normalizeVersion(value) : 'unavailable');

  console.log('\nlatest engines:');
  for (const [engine, version] of Object.entries(latestByEngine)) {
    console.log(`  ${engine}: ${displayVersion(version)}`);
  }
  console.log('\nlatest engine provider builds:');
  console.log(`  BtbN FFmpeg stable Windows/Linux: ${displayVersion(btbnFfmpegStableBuild?.version)}`);
  console.log(`  Martin Riedl FFmpeg macOS arm64 stable: ${displayVersion(martinRiedlMacArm64Release?.version)}`);

  const targetSpecificEngines = new Set(['ffmpeg']);
  const engineCheckFailures = [];
  const runEngineCheck = (label, rows) => {
    try {
      return checkRows(
        rows,
        latestByEngine,
        latestByTargetEngine,
        latestUrlsByTargetEngine,
        targetSpecificEngines,
        latestHashesByTargetEngine,
        latestHashesByUrl,
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

export {
  checkRows,
  diffCargoMetadata,
  fetchJson,
  fetchText,
  fetchWithContext,
  latestBtbnFfmpegStableBuild,
  latestMartinRiedlMacArm64Release,
  npmExecutable,
  providerAssetHashes,
};
