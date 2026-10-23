import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRows,
  diffCargoMetadata,
  fetchJson,
  fetchText,
  latestBtbnFfmpegStableBuild,
  latestMartinRiedlMacArm64Release,
  hasUpdateCheckFailures,
  npmExecutable,
  npmOutdated,
  npmUpdateRows,
  providerAssetHashes,
} from './check-updates.js';

async function withMockFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function btbnAsset(tag, name, digest) {
  return {
    name,
    browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${name}`,
    digest,
  };
}

function btbnRelease(tag, assets, publishedAt = '2026-10-22T13:00:00Z') {
  return { tag_name: tag, published_at: publishedAt, assets };
}

test('fetchJson retries transient HTTP responses before succeeding', async () => {
  let attempts = 0;
  const result = await withMockFetch(async () => {
    attempts += 1;
    if (attempts < 3) return new Response('temporarily unavailable', { status: 503 });
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }, () => fetchJson('https://example.test/releases'));

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(attempts, 3);
});

test('fetchText does not retry terminal HTTP responses', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withMockFetch(async () => {
        attempts += 1;
        return new Response('not found', { status: 404 });
      }, () => fetchText('https://example.test/missing')),
    /404: https:\/\/example\.test\/missing/
  );
  assert.equal(attempts, 1);
});

test('checkRows reports an unverified row when a latest version is unavailable', () => {
  const report = checkRows(
    [{ target: 'test-target', engine: 'test-engine', version: '1.0.0', url: 'https://example.test/engine' }],
    {},
  );

  assert.equal(report.rows[0].status, 'unverified');
  assert.equal(report.counts.unverified, 1);
});

test('checkRows does not fall back to the generic release for target-specific engines', () => {
  const report = checkRows(
    [{ target: 'test-target', engine: 'ffmpeg', version: '8.1.2', url: 'https://example.test/engine' }],
    { ffmpeg: '9.0.1' },
    {},
    {},
    new Set(['ffmpeg']),
  );

  assert.equal(report.rows[0].status, 'unverified');
  assert.equal(report.counts.unverified, 1);
});

test('checkRows detects a provider hash change when version and URL are current', () => {
  const report = checkRows(
    [{
      target: 'test-target',
      engine: 'test-engine',
      version: '1.0.0',
      url: 'https://example.test/engine',
      sha256: 'a'.repeat(64),
    }],
    { 'test-engine': '1.0.0' },
    {},
    {},
    new Set(),
    {},
    { 'https://example.test/engine': 'b'.repeat(64) },
  );

  assert.equal(report.rows[0].status, 'hash-mismatch');
  assert.equal(report.counts['hash-mismatch'], 1);
});

test('checkRows fails closed when the provider supplies no digest', () => {
  const report = checkRows(
    [{
      target: 'test-target',
      engine: 'test-engine',
      version: '1.0.0',
      url: 'https://example.test/engine',
      sha256: 'a'.repeat(64),
    }],
    { 'test-engine': '1.0.0' },
  );

  assert.equal(report.rows[0].status, 'unverified');
  assert.match(report.rows[0].reason, /verifiable SHA-256/);
  assert.equal(report.counts.unverified, 1);
});

test('checkRows compares packaged source provenance without confusing the payload digest', () => {
  const report = checkRows(
    [{
      target: 'aarch64-apple-darwin',
      engine: 'ffmpeg',
      version: '9.0.1',
      url: 'https://example.test/ffmpeg.zip',
      sourceSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
    }],
    { ffmpeg: '9.0.1' },
    { 'aarch64-apple-darwin:ffmpeg': '9.0.1' },
    { 'aarch64-apple-darwin:ffmpeg': 'https://example.test/ffmpeg.zip' },
    new Set(['ffmpeg']),
    { 'aarch64-apple-darwin:ffmpeg': 'a'.repeat(64) },
  );

  assert.equal(report.rows[0].status, 'current');
  assert.equal(report.counts.current, 1);
});

test('checkRows detects an aria2 asset digest change when the provider supplies it', () => {
  const url = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
  const digest = 'b'.repeat(64);
  const hashes = providerAssetHashes({
    aria2: { assets: [{ browser_download_url: url, digest: `sha256:${digest}` }] },
  });

  const report = checkRows(
    [{
      target: 'x86_64-pc-windows-msvc',
      engine: 'aria2c',
      version: '1.37.0',
      url,
      sha256: 'a'.repeat(64),
    }],
    { aria2c: '1.37.0' },
    {},
    {},
    new Set(),
    {},
    hashes.hashesByUrl,
  );

  assert.equal(report.rows[0].status, 'hash-mismatch');
  assert.equal(report.counts['hash-mismatch'], 1);
});

test('GitHub engine digests require the exact target asset name and release URL', () => {
  const tag = '2026.10.20';
  const windowsDigest = 'a'.repeat(64);
  const hashes = providerAssetHashes({
    ytDlp: {
      tag_name: tag,
      assets: [
        {
          name: 'yt-dlp_win.zip',
          browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_win.zip`,
          digest: `sha256:${windowsDigest}`,
        },
        {
          name: 'yt-dlp_macos.zip',
          browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux.zip`,
          digest: `sha256:${'b'.repeat(64)}`,
        },
      ],
    },
    deno: {
      tag_name: `v${tag}`,
      assets: [{
        name: 'deno-x86_64-unknown-linux-gnu.zip',
        browser_download_url: `https://github.com/denoland/deno/releases/download/v${tag}/deno-x86_64-pc-windows-msvc.zip`,
        digest: `sha256:${'c'.repeat(64)}`,
      }],
    },
  });

  assert.deepEqual(hashes.hashesByTargetEngine, {
    'x86_64-pc-windows-msvc:yt-dlp': windowsDigest,
  });
  assert.equal(hashes.urlsByTargetEngine['x86_64-unknown-linux-gnu:yt-dlp'], undefined);

  const report = checkRows(
    [{
      target: 'x86_64-unknown-linux-gnu',
      engine: 'yt-dlp',
      version: tag,
      url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux.zip`,
      sha256: 'b'.repeat(64),
    }],
    { 'yt-dlp': tag },
    {},
    hashes.urlsByTargetEngine,
    new Set(),
    hashes.hashesByTargetEngine,
    hashes.hashesByUrl,
  );
  assert.equal(report.rows[0].status, 'unverified');
  assert.match(report.rows[0].reason, /verifiable SHA-256/);
});

test('GitHub engine assets without a digest remain unverified', () => {
  const tag = 'v2.9.8';
  const hashes = providerAssetHashes({
    deno: {
      tag_name: tag,
      assets: [{
        name: 'deno-x86_64-unknown-linux-gnu.zip',
        browser_download_url: `https://github.com/denoland/deno/releases/download/${tag}/deno-x86_64-unknown-linux-gnu.zip`,
      }],
    },
  });
  const report = checkRows(
    [{
      target: 'x86_64-unknown-linux-gnu',
      engine: 'deno',
      version: '2.9.8',
      url: `https://github.com/denoland/deno/releases/download/${tag}/deno-x86_64-unknown-linux-gnu.zip`,
      sha256: 'd'.repeat(64),
    }],
    { deno: '2.9.8' },
    {},
    hashes.urlsByTargetEngine,
    new Set(),
    hashes.hashesByTargetEngine,
    hashes.hashesByUrl,
  );

  assert.equal(report.rows[0].status, 'unverified');
  assert.match(report.rows[0].reason, /verifiable SHA-256/);
});

test('macOS yt-dlp uses the locked official archive identity and fails closed on bad metadata', () => {
  const target = 'aarch64-apple-darwin';
  const tag = '2026.10.21';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_macos.zip`;
  const archiveDigest = 'a'.repeat(64);
  const row = {
    target,
    engine: 'yt-dlp',
    version: tag,
    url,
    sourceSha256: archiveDigest,
    sha256: 'b'.repeat(64),
  };
  const reportFor = hashes => checkRows(
    [row],
    { 'yt-dlp': tag },
    {},
    hashes.urlsByTargetEngine,
    new Set(),
    hashes.hashesByTargetEngine,
    hashes.hashesByUrl,
  );
  const validAsset = {
    name: 'yt-dlp_macos.zip',
    browser_download_url: url,
    digest: `sha256:${archiveDigest}`,
  };

  const validHashes = providerAssetHashes({
    ytDlp: { tag_name: tag, assets: [validAsset] },
  });
  assert.equal(validHashes.hashesByTargetEngine[`${target}:yt-dlp`], archiveDigest);
  assert.equal(reportFor(validHashes).rows[0].status, 'current');

  const wrongAssetHashes = providerAssetHashes({
    ytDlp: {
      tag_name: tag,
      assets: [{
        ...validAsset,
        browser_download_url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp_linux.zip`,
      }],
    },
  });
  assert.equal(wrongAssetHashes.hashesByTargetEngine[`${target}:yt-dlp`], undefined);
  assert.equal(reportFor(wrongAssetHashes).rows[0].status, 'unverified');

  const missingDigestHashes = providerAssetHashes({
    ytDlp: { tag_name: tag, assets: [{ name: validAsset.name, browser_download_url: url }] },
  });
  assert.equal(missingDigestHashes.urlsByTargetEngine[`${target}:yt-dlp`], url);
  assert.equal(missingDigestHashes.hashesByTargetEngine[`${target}:yt-dlp`], undefined);
  assert.equal(reportFor(missingDigestHashes).rows[0].status, 'unverified');
});

test('checkRows preserves independent row results when one provider is unavailable', () => {
  const report = checkRows(
    [
      { target: 'test-target', engine: 'yt-dlp', version: '1.0.0', url: 'https://example.test/yt-dlp' },
      { target: 'test-target', engine: 'deno', version: '1.0.0', url: 'https://example.test/deno' },
    ],
    { 'yt-dlp': '1.0.0', deno: '1.0.0' },
    {},
    {},
    new Set(),
    {},
    {},
    {},
    { deno: { status: 'unverified', detail: 'GitHub response failed' } },
  );

  assert.deepEqual(
    report.rows.map(row => [row.engine, row.status]),
    [['yt-dlp', 'current'], ['deno', 'unverified']],
  );
  assert.equal(report.counts.current, 1);
  assert.equal(report.counts.unverified, 1);
});

test('checkRows reports provider-behind instead of using generic FFmpeg data', () => {
  const report = checkRows(
    [{ target: 'test-target', engine: 'ffmpeg', version: '9.0.1', url: 'https://example.test/ffmpeg' }],
    { ffmpeg: '9.0.2' },
    {},
    {},
    new Set(['ffmpeg']),
    {},
    {},
    { 'test-target:ffmpeg': { status: 'provider-behind', detail: 'matching target build is not published' } },
  );

  assert.equal(report.rows[0].status, 'provider-behind');
  assert.equal(report.rows[0].latest, undefined);
  assert.equal(report.counts['provider-behind'], 1);
});

test('checkRows still reports Deno after an FFmpeg provider failure', () => {
  const report = checkRows(
    [
      { target: 'test-target', engine: 'ffmpeg', version: '9.0.1', url: 'https://example.test/ffmpeg' },
      { target: 'test-target', engine: 'deno', version: '2.9.6', url: 'https://example.test/deno' },
    ],
    { ffmpeg: '9.0.2', deno: '2.9.7' },
    { 'test-target:deno': '2.9.7' },
    {},
    new Set(['ffmpeg']),
    {},
    {},
    { 'test-target:ffmpeg': { status: 'unverified', detail: 'FFmpeg provider request failed' } },
  );

  assert.deepEqual(
    report.rows.map(row => [row.engine, row.status]),
    [['ffmpeg', 'unverified'], ['deno', 'outdated']],
  );
  assert.equal(report.rows.length, 2);
  assert.equal(report.counts.unverified, 1);
  assert.equal(report.counts.outdated, 1);
});

test('update checks fail when npm or Cargo rows are outdated', () => {
  assert.equal(hasUpdateCheckFailures({
    outdatedCount: 1,
    engineIssueCount: 0,
    providerFailures: [],
    providerBehind: [],
  }), true);
});

test('update checks pass only when every blocking count is clear', () => {
  assert.equal(hasUpdateCheckFailures({
    outdatedCount: 0,
    engineIssueCount: 0,
    providerFailures: [],
    providerBehind: [],
  }), false);
});

test('npm outdated runs the Windows command shim through a shell', () => {
  assert.equal(npmExecutable('win32'), 'npm.cmd');
  assert.equal(npmExecutable('darwin'), 'npm');
  assert.equal(npmExecutable('linux'), 'npm');

  let shellCommand;
  let shellOptions;
  let fileRunCalled = false;
  assert.deepEqual(npmOutdated(process.cwd(), {
    platform: 'win32',
    runFile: () => { fileRunCalled = true; },
    runShell: (command, options) => {
      shellCommand = command;
      shellOptions = options;
      return '{}';
    },
  }), {});
  assert.equal(shellCommand, 'npm.cmd outdated --all --json');
  assert.equal(shellOptions.cwd, process.cwd());
  assert.equal(shellOptions.encoding, 'utf8');
  assert.equal(fileRunCalled, false);
});

test('npm update rows deduplicate nested records and retain compatible and major versions', () => {
  const rows = npmUpdateRows({
    '@babel/runtime': [
      {
        current: '7.29.7',
        wanted: '7.29.10',
        latest: '8.0.7',
        dependent: 'react-i18next',
        location: '/workspace/node_modules/@babel/runtime',
      },
      {
        current: '7.29.7',
        wanted: '7.29.10',
        latest: '8.0.7',
        dependent: 'another-package',
        location: '/workspace/node_modules/@babel/runtime',
      },
      {
        current: '7.29.7',
        wanted: '7.29.10',
        latest: '8.0.7',
        dependent: 'react-i18next',
        location: '/workspace/node_modules/@babel/runtime',
      },
    ],
  });

  assert.deepEqual(rows, [{
    name: '@babel/runtime',
    current: '7.29.7',
    wanted: '7.29.10',
    latest: '8.0.7',
    lockfileOnly: false,
    dependents: ['another-package', 'react-i18next'],
  }]);
});

test('npm update rows safely ignore absent optional platform packages', () => {
  const rows = npmUpdateRows({
    '@rolldown/binding-linux-x64-gnu': {
      wanted: '1.2.14',
      latest: '1.2.14',
      dependent: 'rolldown',
      location: '/workspace/node_modules/@rolldown/binding-linux-x64-gnu',
    },
    '@types/node': [
      {
        wanted: '26.6.5',
        latest: '26.6.5',
        dependent: 'vite',
      },
      {
        wanted: '26.6.5',
        latest: '26.6.5',
        dependent: 'vitest',
      },
    ],
  }, {
    cwd: '/workspace',
    lockfilePackages: {
      'node_modules/@rolldown/binding-linux-x64-gnu': { version: '1.2.14' },
      'node_modules/@types/node': { version: '26.6.5' },
    },
  });

  assert.deepEqual(rows, []);
});

test('npm update rows find compatible lockfile updates for absent optional packages', () => {
  const rows = npmUpdateRows({
    '@rolldown/binding-linux-x64-gnu': {
      wanted: '1.2.14',
      latest: '1.2.14',
      dependent: 'rolldown',
    },
  }, {
    cwd: '/workspace',
    lockfilePackages: {
      'node_modules/@rolldown/binding-linux-x64-gnu': { version: '1.2.12' },
    },
  });

  assert.deepEqual(rows, [{
    name: '@rolldown/binding-linux-x64-gnu',
    current: '1.2.12',
    wanted: '1.2.14',
    latest: '1.2.14',
    lockfileOnly: true,
    dependents: ['rolldown'],
  }]);
});

test('npm update rows match duplicate optional records to lockfile wanted versions', () => {
  const rows = npmUpdateRows({
    'lightningcss-linux-x64-gnu': [
      { wanted: '1.32.0', latest: '1.33.0', dependent: 'lightningcss' },
      { wanted: '1.33.0', latest: '1.33.0', dependent: 'lightningcss' },
    ],
  }, {
    cwd: '/workspace',
    lockfilePackages: {
      'node_modules/lightningcss-linux-x64-gnu': { version: '1.32.0' },
      'node_modules/vite/node_modules/lightningcss-linux-x64-gnu': { version: '1.33.0' },
    },
  });

  assert.deepEqual(rows, []);
});

test('npm update rows retain stale duplicates when current is absent on this platform', () => {
  const rows = npmUpdateRows({
    'lightningcss-linux-x64-gnu': [
      { wanted: '1.33.0', latest: '1.33.0', dependent: 'lightningcss' },
      { wanted: '1.33.0', latest: '1.33.0', dependent: 'lightningcss' },
    ],
  }, {
    cwd: '/workspace',
    lockfilePackages: {
      'node_modules/lightningcss-linux-x64-gnu': { version: '1.32.0' },
      'node_modules/vite/node_modules/lightningcss-linux-x64-gnu': { version: '1.33.0' },
    },
  });

  assert.deepEqual(rows, [{
    name: 'lightningcss-linux-x64-gnu',
    current: '1.32.0',
    wanted: '1.33.0',
    latest: '1.33.0',
    lockfileOnly: true,
    dependents: ['lightningcss'],
  }]);
});

test('npm update rows recognize a prerelease to its compatible stable version', () => {
  const rows = npmUpdateRows({
    package: {
      current: '1.0.0-rc.1',
      wanted: '1.0.0',
      latest: '2.0.0',
    },
  });

  assert.deepEqual(rows, [{
    name: 'package',
    current: '1.0.0-rc.1',
    wanted: '1.0.0',
    latest: '2.0.0',
    lockfileOnly: false,
    dependents: [],
  }]);
});

test('npm update rows ignore absent optional packages that are not in the lockfile', () => {
  assert.deepEqual(npmUpdateRows({
    'optional-package': {
      wanted: '1.2.0',
      latest: '2.0.0',
    },
  }, { cwd: '/workspace' }), []);
});

test('npm update rows fail closed when an absent duplicate has ambiguous lockfile versions', () => {
  assert.throws(() => npmUpdateRows({
    package: {
      wanted: '1.2.0',
      latest: '2.0.0',
    },
  }, {
    lockfilePackages: {
      'node_modules/first/node_modules/package': { version: '1.0.0' },
      'node_modules/second/node_modules/package': { version: '1.1.0' },
    },
  }), /omitted locations for duplicate package-lock entries/);
});

test('npm update rows fail closed for malformed package records', () => {
  assert.throws(
    () => npmUpdateRows({ broken: [{ current: '1.0.0', latest: '2.0.0' }] }),
    /omitted wanted or latest version/,
  );
});

test('selects a complete BtbN build for the current stable series', async () => {
  const digest = value => `sha256:${value.repeat(64)}`;
  const tag = 'autobuild-test';
  const release = btbnRelease(tag, [
      btbnAsset(tag, 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip', digest('a')),
      btbnAsset(tag, 'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz', digest('b')),
      btbnAsset(tag, 'ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip', digest('c')),
    ]);
  const result = await withMockFetch(
    async () => new Response(JSON.stringify([release]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );

  assert.equal(result.version, '9.0.1-11-ge47273f4d9');
  assert.equal(
    result.urls.windows,
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip`,
  );
  assert.equal(result.hashes.linux, 'b'.repeat(64));
});

test('selects a complete BtbN build for a two-part stable version and tag-exact assets', async () => {
  const digest = value => `sha256:${value.repeat(64)}`;
  const tag = 'autobuild-test';
  const release = btbnRelease(tag, [
      btbnAsset(tag, 'ffmpeg-n9.0-win64-gpl-9.0.zip', digest('e')),
      btbnAsset(tag, 'ffmpeg-n9.0-linux64-gpl-9.0.tar.xz', digest('f')),
    ]);
  const result = await withMockFetch(
    async () => new Response(JSON.stringify([release]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0'),
  );

  assert.equal(result.version, '9.0');
  assert.equal(
    result.urls.windows,
    `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/ffmpeg-n9.0-win64-gpl-9.0.zip`,
  );
  assert.equal(result.hashes.linux, 'f'.repeat(64));
});

test('rejects an incomplete BtbN stable target tuple', async () => {
  const release = btbnRelease('autobuild-test', [btbnAsset(
      'autobuild-test',
      'ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip',
      `sha256:${'a'.repeat(64)}`,
    )]);
  const result = await withMockFetch(
    async () => new Response(JSON.stringify([release]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );
  assert.equal(result, undefined);
});

test('rejects BtbN assets with a mismatched target URL or an absent digest', async () => {
  const tag = 'autobuild-test';
  const windowsName = 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip';
  const linuxName = 'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz';
  const linux = btbnAsset(tag, linuxName, `sha256:${'b'.repeat(64)}`);
  const badWindowsUrl = {
    ...btbnAsset(tag, windowsName, `sha256:${'a'.repeat(64)}`),
    browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${linuxName}`,
  };
  const missingDigest = btbnAsset(tag, windowsName, undefined);

  const mismatched = await withMockFetch(
    async () => new Response(JSON.stringify([btbnRelease(tag, [badWindowsUrl, linux])]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );
  assert.equal(mismatched, undefined);

  const absentDigest = await withMockFetch(
    async () => new Response(JSON.stringify([btbnRelease(tag, [missingDigest, linux])]), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );
  assert.equal(absentDigest, undefined);
});

test('does not fall back to an older BtbN build when the newest matching release is incomplete', async () => {
  const newestTag = 'autobuild-newest';
  const olderTag = 'autobuild-older';
  const windowsName = 'ffmpeg-n9.0.1-12-g123456789ab-win64-gpl-9.0.zip';
  const linuxName = 'ffmpeg-n9.0.1-12-g123456789ab-linux64-gpl-9.0.tar.xz';
  const olderWindowsName = 'ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip';
  const olderLinuxName = 'ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz';
  const releases = [
    btbnRelease(olderTag, [
        btbnAsset(olderTag, olderWindowsName, `sha256:${'c'.repeat(64)}`),
        btbnAsset(olderTag, olderLinuxName, `sha256:${'d'.repeat(64)}`),
      ], '2026-10-21T13:07:52Z'),
    btbnRelease(newestTag, [
        btbnAsset(newestTag, windowsName, undefined),
        btbnAsset(newestTag, linuxName, `sha256:${'b'.repeat(64)}`),
      ], '2026-10-22T13:07:34Z'),
  ];
  const result = await withMockFetch(
    async () => new Response(JSON.stringify(releases), { status: 200 }),
    () => latestBtbnFfmpegStableBuild('9.0.1'),
  );

  assert.equal(result, undefined);
});

test('requires a complete Martin Riedl stable artifact and digest', async () => {
  const html = `
    <h2>Download Release Build</h2>
    <div><h3>macOS (Apple Silicon/arm64)</h3>
    <p><b>Release: </b>9.0.1</p>
    <a href="/download/macos/arm64/build/ffmpeg.zip">FFmpeg (ZIP)</a></div>`;
  const result = await withMockFetch(
    async url => new Response(
      String(url).endsWith('.sha256') ? `${'d'.repeat(64)}  ffmpeg.zip\n` : html,
      { status: 200 },
    ),
    () => latestMartinRiedlMacArm64Release(),
  );
  assert.deepEqual(result, {
    version: '9.0.1',
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/build/ffmpeg.zip',
    sha256: 'd'.repeat(64),
  });
});

test('reports compatible Cargo resolution drift from structured metadata', () => {
  const metadata = versions => ({
    packages: Object.entries(versions).map(([name, version]) => ({
      name,
      version,
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    })),
  });
  assert.deepEqual(
    diffCargoMetadata(metadata({ indexmap: '2.14.1', serde: '1.0.229' }), metadata({
      indexmap: '2.14.2',
      serde: '1.0.229',
    })),
    [{
      name: 'indexmap',
      version: '2.14.1',
      latest: '2.14.2',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    }],
  );
});

test('reports packages added to or removed from the resolved Cargo graph', () => {
  const metadata = packages => ({
    packages: packages.map(([name, version]) => ({
      name,
      version,
      source: 'registry+https://github.com/rust-lang/crates.io-index',
    })),
  });

  assert.deepEqual(
    diffCargoMetadata(
      metadata([['removed-crate', '1.0.0'], ['stable-crate', '1.0.0']]),
      metadata([['added-crate', '2.0.0'], ['stable-crate', '1.0.0']]),
    ),
    [
      {
        name: 'added-crate',
        version: null,
        latest: '2.0.0',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
      },
      {
        name: 'removed-crate',
        version: '1.0.0',
        latest: null,
        source: 'registry+https://github.com/rust-lang/crates.io-index',
      },
    ],
  );
});
