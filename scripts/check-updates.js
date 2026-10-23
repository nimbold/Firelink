#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

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

const targetGithubAssets = {
  'yt-dlp': {
    'aarch64-apple-darwin': {
      repository: 'yt-dlp/yt-dlp',
      name: 'yt-dlp_macos.zip',
    },
    'x86_64-pc-windows-msvc': {
      repository: 'yt-dlp/yt-dlp',
      name: 'yt-dlp_win.zip',
    },
    'x86_64-unknown-linux-gnu': {
      repository: 'yt-dlp/yt-dlp',
      name: 'yt-dlp_linux.zip',
    },
  },
  deno: {
    'aarch64-apple-darwin': {
      repository: 'denoland/deno',
      name: 'deno-aarch64-apple-darwin.zip',
    },
    'x86_64-pc-windows-msvc': {
      repository: 'denoland/deno',
      name: 'deno-x86_64-pc-windows-msvc.zip',
    },
    'x86_64-unknown-linux-gnu': {
      repository: 'denoland/deno',
      name: 'deno-x86_64-unknown-linux-gnu.zip',
    },
  },
};

function isCanonicalGithubReleaseAsset(release, asset, repository) {
  if (
    typeof release?.tag_name !== 'string'
    || typeof asset?.name !== 'string'
    || typeof asset?.browser_download_url !== 'string'
  ) {
    return false;
  }

  try {
    const url = new URL(asset.browser_download_url);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname === `/${repository}/releases/download/${release.tag_name}/${asset.name}`;
  } catch {
    return false;
  }
}

function releaseTargetAsset(release, { repository, name }) {
  if (!Array.isArray(release?.assets)) return undefined;
  const matches = release.assets.filter(asset => asset?.name === name);
  if (matches.length !== 1 || !isCanonicalGithubReleaseAsset(release, matches[0], repository)) {
    return undefined;
  }

  return {
    url: matches[0].browser_download_url,
    sha256: parseSha256Digest(matches[0].digest),
  };
}

function providerAssetHashes({ ytDlp, deno, aria2 }) {
  const hashesByTargetEngine = {};
  const urlsByTargetEngine = {};
  for (const [engine, release] of [['yt-dlp', ytDlp], ['deno', deno]]) {
    for (const [target, identity] of Object.entries(targetGithubAssets[engine])) {
      const asset = releaseTargetAsset(release, identity);
      if (!asset) continue;
      const key = `${target}:${engine}`;
      urlsByTargetEngine[key] = asset.url;
      if (asset.sha256) hashesByTargetEngine[key] = asset.sha256;
    }
  }

  return {
    hashesByTargetEngine,
    urlsByTargetEngine,
    hashesByUrl: releaseAssetHashes(aria2),
  };
}

function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function npmOutdated(cwd, {
  platform = process.platform,
  runFile = execFileSync,
  runShell = execSync,
} = {}) {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`npm workspace is missing package.json: ${cwd}`);
  }
  const args = ['outdated', '--all', '--json'];
  const options = {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    if (platform === 'win32') {
      // npm.cmd is a command shim, not a native executable. Keep the command
      // fixed here (no user-controlled arguments) and let cmd.exe run it.
      runShell(`${npmExecutable(platform)} ${args.join(' ')}`, options);
    } else {
      runFile(npmExecutable(platform), args, options);
    }
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
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(stableVersion)) {
    throw new Error(`unsupported FFmpeg stable version: ${stableVersion}`);
  }
  const stableSeries = stableVersion.split('.').slice(0, 2).join('.');
  const versionPattern = escapeRegExp(stableVersion);
  const seriesPattern = escapeRegExp(stableSeries);
  const assetPattern = new RegExp(
    `^ffmpeg-n(${versionPattern}(?:-\\d+-g[0-9a-f]+)?)-(win64|linux64)-gpl-${seriesPattern}\\.(?:zip|tar\\.xz)$`
  );
  const releases = await fetchJson('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10');
  if (!Array.isArray(releases)) throw new Error('BtbN releases response is not an array');
  const candidates = [];
  for (const release of releases) {
    if (release.tag_name === 'latest') continue;
    const assets = (Array.isArray(release.assets) ? release.assets : [])
      .map(asset => {
        const match = typeof asset?.name === 'string' ? asset.name.match(assetPattern) : undefined;
        if (!match) return undefined;
        return {
          target: match[2] === 'win64' ? 'windows' : 'linux',
          version: match[1],
          url: asset.browser_download_url,
          sha256: parseSha256Digest(asset.digest),
          canonical: isCanonicalGithubReleaseAsset(release, asset, 'BtbN/FFmpeg-Builds'),
        };
      })
      .filter(Boolean);
    if (assets.length === 0) continue;

    const publishedAt = Date.parse(release.published_at);
    if (!Number.isFinite(publishedAt)) return undefined;
    candidates.push({ assets, publishedAt });
  }

  // The release-list endpoint does not define an ordering contract. Select by
  // publication time, then fail closed if the newest matching autobuild is
  // incomplete or unverifiable instead of falling back to an older build.
  candidates.sort((left, right) => right.publishedAt - left.publishedAt);
  if (
    candidates.length > 1 &&
    candidates[0].publishedAt === candidates[1].publishedAt
  ) {
    return undefined;
  }
  const assets = candidates[0]?.assets;
  if (!assets) return undefined;

  const unique = [...new Set(assets.map(asset => asset.version))];
  const byTarget = Object.fromEntries(
    ['windows', 'linux'].map(target => [
      target,
      assets.filter(asset => asset.target === target),
    ]),
  );
  if (
    unique.length === 1 &&
    byTarget.windows.length === 1 &&
    byTarget.linux.length === 1 &&
    byTarget.windows[0].canonical &&
    byTarget.linux[0].canonical &&
    byTarget.windows[0].sha256 &&
    byTarget.linux[0].sha256
  ) {
    return {
      version: unique[0],
      urls: { windows: byTarget.windows[0].url, linux: byTarget.linux[0].url },
      hashes: { windows: byTarget.windows[0].sha256, linux: byTarget.linux[0].sha256 },
    };
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
    for (const version of oldVersions.slice(newVersions.length)) {
      changes.push({
        name: group.name,
        version,
        latest: null,
        source: group.source,
      });
    }
    for (const latest of newVersions.slice(oldVersions.length)) {
      changes.push({
        name: group.name,
        version: null,
        latest,
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
    console.log(`  ${update.name}: ${update.version ?? '(absent)'} -> ${update.latest ?? '(removed)'}`);
  }
  return updates.length;
}

function npmUpdateRows(outdated, { cwd = process.cwd(), lockfilePackages = {} } = {}) {
  if (!outdated || typeof outdated !== 'object' || Array.isArray(outdated)) {
    throw new Error('npm outdated response was not a package map');
  }

  const lockfileVersionAtLocation = location => {
    if (typeof location !== 'string' || !location.trim()) return undefined;
    let lockfilePath = location.trim().replaceAll('\\', '/');
    if (path.isAbsolute(location)) {
      const relativePath = path.relative(cwd, location);
      if (path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
        return undefined;
      }
      lockfilePath = relativePath.split(path.sep).join('/');
    }
    lockfilePath = lockfilePath.replace(/^\.\//, '');
    if (lockfilePath === '..' || lockfilePath.startsWith('../')) return undefined;
    return normalizeVersion(lockfilePackages[lockfilePath]?.version);
  };
  const lockfileVersionsForName = name => {
    const suffix = `/node_modules/${name}`;
    return Object.entries(lockfilePackages)
      .filter(([lockfilePath]) => lockfilePath === `node_modules/${name}` || lockfilePath.endsWith(suffix))
      .map(([, entry]) => normalizeVersion(entry?.version))
      .filter(Boolean);
  };

  const rows = new Map();
  for (const [name, value] of Object.entries(outdated)) {
    const records = Array.isArray(value) ? value : [value];
    const normalizedRecords = records.map(info => {
      if (!info || typeof info !== 'object' || Array.isArray(info)) {
        throw new Error(`npm outdated response for ${name} was not a package record`);
      }
      return {
        info,
        installedVersion: normalizeVersion(info.current),
        locatedVersion: lockfileVersionAtLocation(info.location),
        wanted: normalizeVersion(info.wanted),
        latest: normalizeVersion(info.latest),
      };
    });
    for (const record of normalizedRecords) {
      if (!record.wanted || !record.latest) {
        throw new Error(`npm outdated response for ${name} omitted wanted or latest version`);
      }
    }

    const unresolved = normalizedRecords
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => !record.installedVersion && !record.locatedVersion);
    const lockVersions = unresolved.length ? lockfileVersionsForName(name) : [];
    const resolvedLockVersions = new Map();
    if (lockVersions.length === 1) {
      for (const { index } of unresolved) resolvedLockVersions.set(index, lockVersions[0]);
    } else if (lockVersions.length > 1) {
      if (lockVersions.length !== unresolved.length) {
        throw new Error(`npm outdated response for ${name} omitted locations for duplicate package-lock entries`);
      }

      const remainingLockVersions = [...lockVersions];
      const remainingRecords = [];
      for (const { record, index } of unresolved) {
        const wanted = semver.valid(record.wanted);
        if (!wanted) continue;
        const exactIndex = remainingLockVersions.findIndex(version => semver.valid(version)
          && semver.eq(version, wanted));
        if (exactIndex >= 0) {
          resolvedLockVersions.set(index, remainingLockVersions.splice(exactIndex, 1)[0]);
        } else {
          remainingRecords.push({ record, index, wanted });
        }
      }

      if (remainingRecords.length !== remainingLockVersions.length) {
        throw new Error(`npm outdated response for ${name} could not be matched safely to package-lock entries`);
      }
      remainingRecords.sort((left, right) => semver.compare(left.wanted, right.wanted));
      remainingLockVersions.sort((left, right) => {
        const leftVersion = semver.valid(left);
        const rightVersion = semver.valid(right);
        if (!leftVersion || !rightVersion) {
          throw new Error(`npm lockfile contains a non-semver duplicate for ${name}`);
        }
        return semver.compare(leftVersion, rightVersion);
      });
      remainingRecords.forEach(({ index }, offset) => {
        resolvedLockVersions.set(index, remainingLockVersions[offset]);
      });
    }

    for (const [index, record] of normalizedRecords.entries()) {
      const currentVersions = record.installedVersion
        ? [record.installedVersion]
        : record.locatedVersion
          ? [record.locatedVersion]
          : resolvedLockVersions.has(index)
            ? [resolvedLockVersions.get(index)]
            : [];
      // npm can include optional or peer packages that are absent from both
      // this host's physical tree and the lockfile. They are not resolved
      // Firelink dependencies. When lock entries exist, map them to records
      // by physical location or the matching npm `wanted` version.
      if (!currentVersions.length) continue;

      if (!semver.valid(record.wanted) || !semver.valid(record.latest)) continue;
      for (const current of currentVersions) {
        if (!semver.valid(current) || semver.gte(current, record.wanted)) continue;

        const key = `${name}\0${current}\0${record.wanted}\0${record.latest}`;
        const row = rows.get(key) || {
          name,
          current,
          wanted: record.wanted,
          latest: record.latest,
          lockfileOnly: !record.installedVersion,
          dependents: new Set(),
        };
        row.lockfileOnly = row.lockfileOnly && !record.installedVersion;
        if (typeof record.info.dependent === 'string' && record.info.dependent.trim()) {
          row.dependents.add(record.info.dependent.trim());
        }
        rows.set(key, row);
      }
    }
  }

  return [...rows.values()]
    .map(row => ({ ...row, dependents: [...row.dependents].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name)
      || left.current.localeCompare(right.current)
      || left.wanted.localeCompare(right.wanted));
}

function hasUpdateCheckFailures({
  outdatedCount,
  engineIssueCount,
  providerFailures,
  providerBehind,
}) {
  return outdatedCount > 0
    || engineIssueCount > 0
    || providerFailures.length > 0
    || providerBehind.length > 0;
}

function printNpmReport(label, outdated, cwd) {
  let lockfilePackages = {};
  if (Object.keys(outdated).length > 0) {
    const lockfilePath = path.join(cwd, 'package-lock.json');
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    if (!lockfile.packages || typeof lockfile.packages !== 'object' || Array.isArray(lockfile.packages)) {
      throw new Error(`npm lockfile did not contain a package map: ${lockfilePath}`);
    }
    lockfilePackages = lockfile.packages;
  }
  const rows = npmUpdateRows(outdated, { cwd, lockfilePackages });
  if (!rows.length) {
    console.log(`${label}: current`);
    return 0;
  }
  console.log(`${label}: ${rows.length} compatible package update(s)`);
  for (const row of rows) {
    const dependents = row.dependents.length ? ` via ${row.dependents.join(', ')}` : '';
    const source = row.lockfileOnly ? ' (from lockfile)' : '';
    console.log(`  ${row.name}: ${row.current}${source} -> ${row.wanted} (latest ${row.latest})${dependents}`);
  }
  return rows.length;
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

function checkRows(
  rows,
  latestByEngine,
  latestByTargetEngine = {},
  latestUrlsByTargetEngine = {},
  targetSpecificEngines = new Set(),
  latestHashesByTargetEngine = {},
  latestHashesByUrl = {},
  providerStatusesByTargetEngine = {},
  providerStatusesByEngine = {},
) {
  const report = {
    rows: [],
    counts: {
      current: 0,
      outdated: 0,
      'hash-mismatch': 0,
      'provider-behind': 0,
      unverified: 0,
    },
  };

  const providerStatus = value => {
    if (!value) return undefined;
    if (typeof value === 'string') return { status: value };
    return value;
  };

  const printRow = rowResult => {
    const wanted = rowResult.latest || 'unavailable';
    console.log(`  ${rowResult.target} ${rowResult.engine}: ${rowResult.current} -> ${wanted} ${rowResult.status}`);
    if (rowResult.reason) console.log(`    reason: ${rowResult.reason}`);
    if (rowResult.source) console.log(`    source: ${rowResult.source}`);
    if (rowResult.hash) {
      console.log(`    source sha256: ${rowResult.hash.current || 'missing'} -> ${rowResult.hash.latest || 'unavailable'}`);
    }
  };

  for (const row of rows) {
    const targetSpecific = targetSpecificEngines.has(row.engine);
    const targetKey = `${row.target}:${row.engine}`;
    const provider = providerStatus(
      providerStatusesByTargetEngine[targetKey] || providerStatusesByEngine[row.engine],
    );
    const latest = targetSpecific
      ? latestByTargetEngine[targetKey]
      : latestByTargetEngine[targetKey] || latestByEngine[row.engine];

    if (provider?.status === 'provider-behind' || provider?.status === 'unverified') {
      const rowResult = {
        ...row,
        current: normalizeVersion(row.version),
        latest: latest ? normalizeVersion(latest) : undefined,
        status: provider.status,
        reason: provider.detail,
      };
      report.rows.push(rowResult);
      report.counts[provider.status] += 1;
      printRow(rowResult);
      continue;
    }

    if (typeof latest !== 'string' || !latest.trim()) {
      const rowResult = {
        ...row,
        current: normalizeVersion(row.version),
        latest: undefined,
        status: 'unverified',
        reason: `${targetSpecific ? 'target-specific provider' : 'latest provider'} version is unavailable`,
      };
      report.rows.push(rowResult);
      report.counts.unverified += 1;
      printRow(rowResult);
      continue;
    }

    const current = normalizeVersion(row.version);
    const wanted = normalizeVersion(latest);
    const latestUrl = latestUrlsByTargetEngine[targetKey];
    const versionOutdated = compareVersions(current, wanted) < 0;
    const sourceOutdated = Boolean(latestUrl && row.url && row.url !== latestUrl);
    const latestHash = latestHashesByTargetEngine[targetKey]
      || (['yt-dlp', 'deno', 'ffmpeg'].includes(row.engine)
        ? undefined
        : latestHashesByUrl[row.url]);
    const checkedHash = row.sourceSha256 || row.sha256;
    const currentHash = typeof checkedHash === 'string' ? checkedHash.toLowerCase() : '';
    const hashMismatch = Boolean(latestHash && currentHash !== latestHash);
    const hashRequired =
      (Object.hasOwn(row, 'sha256') || Object.hasOwn(row, 'sourceSha256'))
      && (typeof row.sourceSha256 === 'string' || typeof row.url === 'string');
    const hashUnavailable = Boolean(hashRequired && !latestHash);
    const status = versionOutdated
      ? 'outdated'
      : sourceOutdated
        ? 'outdated'
        : hashMismatch
          ? 'hash-mismatch'
          : hashUnavailable
            ? 'unverified'
            : 'current';

    const rowResult = {
      ...row,
      current,
      latest: wanted,
      status,
      source: sourceOutdated ? `${row.url} -> ${latestUrl}` : undefined,
      hash: hashMismatch || hashUnavailable
        ? { current: checkedHash, latest: latestHash }
        : undefined,
      reason: hashUnavailable ? 'provider did not supply a verifiable SHA-256 digest' : undefined,
    };
    report.rows.push(rowResult);
    report.counts[status] += 1;
    printRow(rowResult);
  }
  return report;
}

async function main() {
  let outdatedCount = 0;

  outdatedCount += printNpmReport('root npm', npmOutdated(repoRoot), repoRoot);
  outdatedCount += printNpmReport(
    'Browser extension npm',
    npmOutdated(path.join(repoRoot, 'Extensions', 'Browser')),
    path.join(repoRoot, 'Extensions', 'Browser')
  );
  outdatedCount += printCargoReport(cargoCompatibleUpdates());

  const ffmpegStablePromise = latestFfmpegStable();
  const providerChecks = [
    ['yt-dlp latest release', async () => ({
      status: 'available',
      value: await githubLatest('yt-dlp/yt-dlp'),
    })],
    ['Deno latest release', async () => ({
      status: 'available',
      value: await githubLatest('denoland/deno'),
    })],
    ['aria2 latest release', async () => ({
      status: 'available',
      value: await githubLatest('aria2/aria2'),
    })],
    [
      'FFmpeg stable release',
      async () => {
        const version = await ffmpegStablePromise;
        if (!version) throw new Error('FFmpeg release provider response has no usable version');
        return { status: 'available', value: version };
      },
    ],
    [
      'Martin Riedl macOS release',
      async () => {
        const build = await latestMartinRiedlMacArm64Release();
        const stableVersion = await ffmpegStablePromise;
        if (
          !build?.version ||
          !build.url ||
          !build.sha256 ||
          compareVersions(build.version, stableVersion) !== 0
        ) {
          return {
            status: 'provider-behind',
            detail: 'no complete matching macOS arm64 stable build is published',
          };
        }
        return { status: 'available', value: build };
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
          return {
            status: 'provider-behind',
            detail: 'no complete matching Windows/Linux stable build with SHA-256 digests is published',
          };
        }
        return { status: 'available', value: build };
      },
    ],
  ];
  const providerResults = await Promise.allSettled(providerChecks.map(([, check]) => check()));
  const providerFailures = [];
  const providerBehind = [];
  const providerOutcomes = providerChecks.map(([label], index) => {
    const result = providerResults[index];
    if (result.status === 'rejected') {
      const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return { status: 'unverified', detail, label };
    }
    if (
      !result.value ||
      !['available', 'provider-behind'].includes(result.value.status)
    ) {
      return { status: 'unverified', detail: 'provider returned an invalid result', label };
    }
    return { ...result.value, label };
  });
  for (const [index, [label]] of providerChecks.entries()) {
    const outcome = providerOutcomes[index];
    if (outcome.status === 'unverified') {
      providerFailures.push(label);
      console.error(`provider unavailable: ${label}: ${outcome.detail}`);
    } else if (outcome.status === 'provider-behind') {
      providerBehind.push(label);
      console.error(`provider behind: ${label}: ${outcome.detail}`);
    }
  }
  const providerValue = index =>
    providerOutcomes[index].status === 'available' ? providerOutcomes[index].value : undefined;
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
  const assetData = providerAssetHashes({ ytDlp, deno, aria2 });
  const latestUrlsByTargetEngine = { ...assetData.urlsByTargetEngine };
  const latestHashesByTargetEngine = { ...assetData.hashesByTargetEngine };
  const latestHashesByUrl = assetData.hashesByUrl;
  const providerStatus = outcome => outcome.status === 'available'
    ? undefined
    : { status: outcome.status, detail: outcome.detail };
  const providerStatusesByEngine = {
    'yt-dlp': providerStatus(providerOutcomes[0]),
    deno: providerStatus(providerOutcomes[1]),
    aria2c: providerStatus(providerOutcomes[2]),
  };
  const providerStatusesByTargetEngine = {
    'aarch64-apple-darwin:ffmpeg': providerStatus(providerOutcomes[4]),
    'x86_64-pc-windows-msvc:ffmpeg': providerStatus(providerOutcomes[5]),
    'x86_64-unknown-linux-gnu:ffmpeg': providerStatus(providerOutcomes[5]),
  };
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
  const engineReports = [];
  const runEngineCheck = (label, rows) => {
    const report = checkRows(
      rows,
      latestByEngine,
      latestByTargetEngine,
      latestUrlsByTargetEngine,
      targetSpecificEngines,
      latestHashesByTargetEngine,
      latestHashesByUrl,
      providerStatusesByTargetEngine,
      providerStatusesByEngine,
    );
    engineReports.push({ label, ...report });
    return report;
  };

  console.log('\nengine source lock:');
  runEngineCheck(
    'engine source lock',
    sourceEngineVersions(parseJsonFile('engine-sources.lock.json')),
  );

  console.log('\npackaged engine lock:');
  runEngineCheck(
    'packaged engine lock',
    packagedEngineVersions(parseJsonFile('engines.lock.json')),
  );

  const engineCounts = engineReports.reduce((totals, report) => {
    for (const [status, count] of Object.entries(report.counts)) totals[status] += count;
    return totals;
  }, { current: 0, outdated: 0, 'hash-mismatch': 0, 'provider-behind': 0, unverified: 0 });
  const engineIssueCount = Object.entries(engineCounts)
    .filter(([status]) => status !== 'current')
    .reduce((total, [, count]) => total + count, 0);

  if (engineIssueCount > 0) {
    console.error('\nengine row status summary:');
    for (const [status, count] of Object.entries(engineCounts)) {
      if (status !== 'current' && count > 0) console.error(`  ${status}: ${count}`);
    }
  }

  if (outdatedCount > 0) {
    console.error(`\n${outdatedCount} outdated item(s) found.`);
  }
  if (providerFailures.length > 0) {
    console.error(`\n${providerFailures.length} provider check(s) unavailable; refusing to claim that all updates are current.`);
  }
  if (providerBehind.length > 0) {
    console.error(`\n${providerBehind.length} provider build check(s) are behind the latest stable release; refusing to claim that all updates are current.`);
  }
  if (hasUpdateCheckFailures({ outdatedCount, engineIssueCount, providerFailures, providerBehind })) {
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
  hasUpdateCheckFailures,
  latestBtbnFfmpegStableBuild,
  latestMartinRiedlMacArm64Release,
  npmExecutable,
  npmOutdated,
  npmUpdateRows,
  providerAssetHashes,
};
