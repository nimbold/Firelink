import { describe, expect, it } from 'vitest';
import type { DownloadItem } from '../bindings/DownloadItem';
import {
  downloadFileNamesMatch,
  downloadFileNameWithSuffix,
  downloadMediaKindsMatch,
  MAX_DOWNLOAD_FILENAME_BYTES,
  canonicalizeDownloadFileName,
  categoryForDownload,
  categoryForFileName,
  isAllocationPhaseVisible,
  isAllocationPhaseEligible,
  isValidTorrentExcludeTrackerList,
  isValidTorrentTrackerList,
  normalizeTorrentEncryptionPolicy,
  normalizeTorrentMaxOpenFiles,
  normalizeTorrentPrioritizePiece,
  normalizeTorrentWebSeedDrafts,
  parseTorrentPreviewPriority,
  serializeTorrentPreviewPriority,
  torrentWebSeedDraftsFromSeeds,
  normalizeTorrentTrackerInterval,
  normalizeTorrentTrackerTimeout,
  headerNameHasCredentialMaterial,
  headersWithoutCredentialMaterial,
  redactDownloadForPersistence,
  resolveDownloadConnections
} from './downloads';

const item = (status: DownloadItem['status']): DownloadItem => ({
  id: 'download-1',
  url: 'https://example.com/file.bin',
  fileName: 'file.bin',
  status,
  category: 'Other',
  dateAdded: '2026-07-15T00:00:00.000Z',
  downloadedBytes: 1024,
  totalBytes: 4096,
  totalIsEstimate: false
});

describe('download category detection', () => {
  it('classifies torrent files and explicit Torrent rows separately from filename types', () => {
    expect(categoryForFileName('Example.torrent')).toBe('Torrents');
    expect(categoryForFileName('Example', true)).toBe('Torrents');
    expect(categoryForFileName('Example.mkv', true)).toBe('Torrents');
    expect(categoryForFileName('Example.mkv')).toBe('Movies');
    expect(categoryForDownload('Renamed', true, 'Other')).toBe('Other');
    expect(categoryForDownload('Renamed', true, 'Torrents')).toBe('Torrents');
  });
});

describe('download persistence progress snapshots', () => {
  it('does not write active byte counters on every progress event', () => {
    const persisted = redactDownloadForPersistence(item('downloading'));

    expect(persisted.downloadedBytes).toBeUndefined();
    expect(persisted.totalBytes).toBeUndefined();
    expect(persisted.totalIsEstimate).toBeUndefined();
  });

  it('keeps byte counters for paused snapshots', () => {
    const persisted = redactDownloadForPersistence(item('paused'));

    expect(persisted.downloadedBytes).toBe(1024);
    expect(persisted.totalBytes).toBe(4096);
    expect(persisted.totalIsEstimate).toBe(false);
  });

  it('does not persist live resolver error classification', () => {
    const sanitized = redactDownloadForPersistence({
      ...item('failed'),
      lastErrorKind: 'nameResolution',
      lastResolverFallback: true,
    });
    expect(sanitized.lastErrorKind).toBeUndefined();
    expect(sanitized.lastResolverFallback).toBeUndefined();
  });

  it('marks redacted downloads that need credentials after restart', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      username: 'alice',
      password: 'secret',
      cookies: 'session=redacted',
      headers: 'Authorization: redacted',
    });
    expect(persisted.credentialsRequired).toBe(true);
    expect(persisted.password).toBeUndefined();
    expect(persisted.cookies).toBeUndefined();
    expect(persisted.headers).toBeUndefined();
  });

  it('does not gate browser request context headers after restart', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      headers: 'Referer: https://example.com/page\nUser-Agent: Browser',
    });

    expect(persisted.credentialsRequired).toBeUndefined();
    expect(persisted.headers).toBe('Referer: https://example.com/page\nUser-Agent: Browser');
  });

  it('requires confirmation when a Referer contains restart-sensitive URL context', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      headers: 'Referer: https://example.com/page?session=secret#part',
    });

    expect(persisted.credentialsRequired).toBe(true);
    expect(persisted.headers).toBe('Referer: https://example.com/page');
    expect(JSON.stringify(persisted)).not.toContain('secret');
  });

  it('sanitizes saved request context for an explicit credentialless retry', () => {
    expect(headersWithoutCredentialMaterial(
      'Referer: https://example.com/page?session=secret#part\nAuthorization: Bearer secret\nUser-Agent: Browser'
    )).toBe('Referer: https://example.com/page\nUser-Agent: Browser');
  });

  it('marks username-only authentication as requiring credentials after restart', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      username: 'alice',
    });

    expect(persisted.credentialsRequired).toBe(true);
    expect(persisted.username).toBe('alice');
  });

  it('fails closed for unknown custom headers that may carry credentials', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      headers: 'X-Download-Token: secret',
    });

    expect(persisted.credentialsRequired).toBe(true);
    expect(persisted.headers).toBeUndefined();
  });

  it('fails closed for empty unknown credential headers', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      headers: 'X-Auth-Token:',
    });

    expect(persisted.credentialsRequired).toBe(true);
    expect(persisted.headers).toBeUndefined();
  });

  it('does not create a credential gate for Torrent metadata context', () => {
    const persisted = redactDownloadForPersistence({
      ...item('paused'),
      isTorrent: true,
      username: 'browser-user',
      password: 'secret',
      cookies: 'session=metadata-only',
      headers: 'User-Agent: browser',
      credentialsRequired: true,
    });

    expect(persisted.credentialsRequired).toBeUndefined();
    expect(persisted.username).toBeUndefined();
    expect(persisted.password).toBeUndefined();
    expect(persisted.cookies).toBeUndefined();
    expect(persisted.headers).toBeUndefined();
  });

  it.each(['queued', 'staged', 'retrying', 'processing'] as const)(
    'keeps byte counters for %s snapshots',
    (status) => {
      const persisted = redactDownloadForPersistence(item(status));

      expect(persisted.downloadedBytes).toBe(1024);
      expect(persisted.totalBytes).toBe(4096);
      expect(persisted.totalIsEstimate).toBe(false);
    }
  );

  it('does not persist verification byte counters across restart', () => {
    const persisted = redactDownloadForPersistence(item('verifying'));

    expect(persisted.downloadedBytes).toBeUndefined();
    expect(persisted.totalBytes).toBeUndefined();
    expect(persisted.totalIsEstimate).toBeUndefined();
  });
});

describe('credential-bearing extension header names', () => {
  it('classifies named and marker-based credential headers while preserving browser context names', () => {
    expect(headerNameHasCredentialMaterial('X-Api-Key')).toBe(true);
    expect(headerNameHasCredentialMaterial('X-Request-Signature')).toBe(true);
    expect(headerNameHasCredentialMaterial('X-Session')).toBe(true);
    expect(headerNameHasCredentialMaterial('Set-Cookie2')).toBe(true);
    expect(headerNameHasCredentialMaterial('User-Agent')).toBe(false);
    expect(headerNameHasCredentialMaterial('X-Trace')).toBe(false);
  });
});

describe('allocation phase visibility', () => {
  it('does not override paused or completed statuses', () => {
    expect(isAllocationPhaseVisible(true, 'ready')).toBe(true);
    expect(isAllocationPhaseVisible(true, 'failed')).toBe(true);
    expect(isAllocationPhaseVisible(true, 'paused')).toBe(false);
    expect(isAllocationPhaseVisible(true, 'completed')).toBe(false);
    expect(isAllocationPhaseVisible(false, 'downloading')).toBe(false);
  });

  it('keeps native Torrent allocation settings out of the transient UI phase', () => {
    expect(isAllocationPhaseEligible({ isTorrent: true, torrentFileAllocation: undefined })).toBe(false);
    expect(isAllocationPhaseEligible({ isTorrent: true, torrentFileAllocation: 'prealloc' })).toBe(false);
    expect(isAllocationPhaseEligible({ isTorrent: true, torrentFileAllocation: 'none' })).toBe(false);
    expect(isAllocationPhaseEligible({ isTorrent: true, torrentVerifyOnly: true })).toBe(false);
    expect(isAllocationPhaseEligible({ isTorrent: true, isMedia: true })).toBe(false);
    expect(isAllocationPhaseEligible({ isTorrent: false, isMedia: false })).toBe(true);
  });
});

describe('Torrent tracker input validation', () => {
  it('accepts supported trackers separated by lines or commas', () => {
    expect(isValidTorrentTrackerList(
      ' https://tracker.example/announce\nudp://tracker.example:6969/announce '
    )).toBe(true);
    expect(isValidTorrentTrackerList('https://tracker.example/announce,https://tracker.example/announce')).toBe(true);
  });

  it('rejects unsupported, credential-bearing, empty, and oversized entries', () => {
    expect(isValidTorrentTrackerList('ftp://tracker.example/announce')).toBe(false);
    expect(isValidTorrentTrackerList('https://user:pass@tracker.example/announce')).toBe(false);
    expect(isValidTorrentTrackerList('https://tracker.example/announce,')).toBe(false);
    expect(isValidTorrentTrackerList(Array.from({ length: 65 }, (_, index) => `https://tracker${index}.example/announce`).join('\n'))).toBe(false);
  });

  it('accepts wildcard exclusions but rejects ambiguous mixtures', () => {
    expect(isValidTorrentExcludeTrackerList('*')).toBe(true);
    expect(isValidTorrentExcludeTrackerList('https://tracker.example/announce\nudp://tracker.example:6969/announce')).toBe(true);
    expect(isValidTorrentExcludeTrackerList('*,https://tracker.example/announce')).toBe(false);
    expect(isValidTorrentExcludeTrackerList('https://tracker.example/announce,*')).toBe(false);
    expect(isValidTorrentExcludeTrackerList('https://user:pass@tracker.example/announce')).toBe(false);
  });
});

describe('Torrent piece priority validation', () => {
  it('normalizes head and tail preview policies', () => {
    expect(normalizeTorrentPrioritizePiece(' tail = 64k, HEAD ')).toBe('head,tail=64K');
    expect(normalizeTorrentPrioritizePiece('head=1m,tail=1024M')).toBe('head=1M,tail=1024M');
    expect(normalizeTorrentPrioritizePiece('')).toBeNull();
  });

  it('rejects duplicate, unsupported, malformed, and oversized policies', () => {
    for (const value of ['head,head', 'middle', 'head=0K', 'tail=1G', 'head=1K,', 'head=1025M']) {
      expect(normalizeTorrentPrioritizePiece(value)).toBeNull();
    }
  });
});

describe('Torrent preview controls', () => {
  it('hydrates legacy head and tail syntax into independent controls', () => {
    expect(parseTorrentPreviewPriority('tail=64k, HEAD')).toEqual({ head: '1M', tail: '64K' });
  });

  it('serializes enabled controls with native-compatible defaults', () => {
    expect(serializeTorrentPreviewPriority(true, '', true, '2m')).toBe('head=1M,tail=2M');
    expect(serializeTorrentPreviewPriority(false, '1M', false, '1M')).toBeNull();
  });
});

describe('Torrent web-seed row normalization', () => {
  const files = [{ index: 1 }, { index: 2 }];

  it('round-trips rows and removes exact duplicates', () => {
    const rows = torrentWebSeedDraftsFromSeeds([
      { fileIndex: 1, uri: 'https://mirror.example/a' },
      { fileIndex: 1, uri: 'https://mirror.example/a' }
    ]);
    expect(normalizeTorrentWebSeedDrafts(rows, files)).toEqual([
      { fileIndex: 1, uri: 'https://mirror.example/a' }
    ]);
  });

  it('uses the only file for a fixed single-file selector', () => {
    expect(normalizeTorrentWebSeedDrafts([{ fileIndex: null, uri: 'https://mirror.example/a' }], [{ index: 1 }])).toEqual([
      { fileIndex: 1, uri: 'https://mirror.example/a' }
    ]);
  });

  it('rejects unsafe, incomplete, and out-of-range rows', () => {
    expect(normalizeTorrentWebSeedDrafts([{ fileIndex: 1, uri: 'ftp://mirror.example/a' }], files)).toBeNull();
    expect(normalizeTorrentWebSeedDrafts([{ fileIndex: null, uri: 'https://mirror.example/a' }], files)).toBeNull();
    expect(normalizeTorrentWebSeedDrafts([{ fileIndex: 9, uri: 'https://mirror.example/a' }], files)).toBeNull();
    expect(normalizeTorrentWebSeedDrafts([{ fileIndex: 1, uri: 'https://user:pass@mirror.example/a' }], files)).toBeNull();
    expect(normalizeTorrentWebSeedDrafts([{ fileIndex: 1, uri: `https://mirror.example/${'é'.repeat(1100)}` }], files)).toBeNull();
  });

  it('bounds the number of rows before they reach the native boundary', () => {
    expect(normalizeTorrentWebSeedDrafts(
      Array.from({ length: 65 }, (_, index) => ({ fileIndex: 1, uri: `https://mirror.example/${index}` })),
      files
    )).toBeNull();
  });
});

describe('Torrent encryption policy validation', () => {
  it('accepts only the canonical policy states', () => {
    expect(normalizeTorrentEncryptionPolicy('disabled')).toBe('disabled');
    expect(normalizeTorrentEncryptionPolicy('require-crypto')).toBe('require-crypto');
    expect(normalizeTorrentEncryptionPolicy('force-encryption')).toBe('force-encryption');
  });

  it('clears unknown or malformed persisted values', () => {
    expect(normalizeTorrentEncryptionPolicy(undefined)).toBeUndefined();
    expect(normalizeTorrentEncryptionPolicy('arc4')).toBeUndefined();
    expect(normalizeTorrentEncryptionPolicy(true)).toBeUndefined();
  });
});

describe('Torrent tracker timing validation', () => {
  it('accepts bounded timeout values and an automatic interval', () => {
    expect(normalizeTorrentTrackerTimeout('1')).toBe(1);
    expect(normalizeTorrentTrackerTimeout(604800)).toBe(604800);
    expect(normalizeTorrentTrackerInterval('0')).toBe(0);
    expect(normalizeTorrentTrackerInterval(604800)).toBe(604800);
  });

  it('rejects zero timeouts and out-of-range timing values', () => {
    expect(normalizeTorrentTrackerTimeout('0')).toBeUndefined();
    expect(normalizeTorrentTrackerTimeout(604801)).toBeUndefined();
    expect(normalizeTorrentTrackerInterval(-1)).toBeUndefined();
    expect(normalizeTorrentTrackerInterval(604801)).toBeUndefined();
    expect(normalizeTorrentTrackerTimeout('1.5')).toBeUndefined();
  });
});

describe('Torrent open-file limit validation', () => {
  it('accepts bounded integer limits', () => {
    expect(normalizeTorrentMaxOpenFiles(1)).toBe(1);
    expect(normalizeTorrentMaxOpenFiles(4096)).toBe(4096);
  });

  it('rejects zero, fractional, and oversized limits', () => {
    expect(normalizeTorrentMaxOpenFiles(0)).toBeUndefined();
    expect(normalizeTorrentMaxOpenFiles('1.5')).toBeUndefined();
    expect(normalizeTorrentMaxOpenFiles(4097)).toBeUndefined();
  });
});

describe('download connection resolution', () => {
  it('uses a clamped fallback for legacy rows without a saved value', () => {
    expect(resolveDownloadConnections(undefined, 8)).toBe(8);
    expect(resolveDownloadConnections(undefined, 0)).toBe(1);
    expect(resolveDownloadConnections(undefined, Number.NaN)).toBe(16);
  });

  it('clamps malformed saved values before dispatch', () => {
    expect(resolveDownloadConnections(0, 8)).toBe(1);
    expect(resolveDownloadConnections(17, 8)).toBe(16);
    expect(resolveDownloadConnections(Number.NaN, 8)).toBe(8);
  });
});

describe('download filename matching', () => {
  it('matches frontend filenames to the backend Windows device-name canonicalization', () => {
    expect(canonicalizeDownloadFileName('CON.txt')).toBe('CON-.txt');
    expect(canonicalizeDownloadFileName('CON .txt')).toBe('CON -.txt');
    expect(canonicalizeDownloadFileName('com1.archive.zip')).toBe('com1.archive-.zip');
    expect(downloadFileNamesMatch('CON-.txt', 'CON.txt')).toBe(true);
    expect(downloadFileNamesMatch('console.txt', 'CON.txt')).toBe(false);
  });

  it('truncates long names by UTF-8 bytes while preserving the extension', () => {
    const filename = canonicalizeDownloadFileName(`${'title '.repeat(100)}.mp4`);

    expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_BYTES);
    expect(filename.endsWith('.mp4')).toBe(true);
    expect(filename).toContain('…');
  });

  it('does not split a multibyte character at the filesystem boundary', () => {
    const filename = canonicalizeDownloadFileName(`${'😀'.repeat(100)}.mkv`);

    expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_BYTES);
    expect(filename.endsWith('.mkv')).toBe(true);
    expect([...filename].every(character => character !== '\uFFFD')).toBe(true);
  });

  it('keeps alternate names unique and bounded after long-name truncation', () => {
    const filename = downloadFileNameWithSuffix(`${'title '.repeat(100)}.mp4`, ' (1)');

    expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_BYTES);
    expect(filename.endsWith(' (1).mp4')).toBe(true);
  });

  it('matches case and path spelling while preserving the actual filename', () => {
    expect(downloadFileNamesMatch(
      'Media\\Example.Show.S01E01.MKV',
      'example.show.s01e01.mkv'
    )).toBe(true);
  });

  it('does not collapse distinct extensions or names', () => {
    expect(downloadFileNamesMatch('example.zip', 'example.tar')).toBe(false);
    expect(downloadFileNamesMatch('example-1.zip', 'example.zip')).toBe(false);
  });

  it('does not auto-match weak metadata fallback names', () => {
    expect(downloadFileNamesMatch('download', 'download')).toBe(false);
    expect(downloadFileNamesMatch('identifier', 'IDENTIFIER')).toBe(false);
    expect(downloadFileNamesMatch('real-file.bin', 'real-file.bin')).toBe(true);
  });

  it('treats omitted media flags as ordinary downloads', () => {
    expect(downloadMediaKindsMatch(undefined, false)).toBe(true);
    expect(downloadMediaKindsMatch(undefined, true)).toBe(false);
  });
});
