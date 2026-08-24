import { describe, expect, it } from 'vitest';
import {
  appendRequestUrlsAfterVersion,
  commonMediaFormatsForRows,
  canSubmitMetadataRows,
  commonMediaQualitiesForRows,
  durableDownloadUrl,
  mediaFormatSelectorForRow,
  mediaFileNameForSelectedFormat,
  mediaFormatForFormat,
  mediaQualityForRow,
  mediaTypeForFormat,
  metadataSummaryMessage,
  isYouTubePlaylistUrl,
  isMagnetUrl,
  isMetadataRefreshableRow,
  isRemoteTorrentUrl,
  playlistFilePrefix,
  reconcileDownloadRows,
  refreshFailedMetadataRows,
  selectExactMediaSelection,
  selectExactMediaQuality,
  updateRowIfCurrent,
  type AddDownloadDraftRow
} from './addDownloadMetadata';
import i18n, { changeAppLocale } from '../i18n';

const row = (
  overrides: Partial<AddDownloadDraftRow> = {}
): AddDownloadDraftRow => ({
  id: 'row-1',
  sourceUrl: 'https://example.com/file.zip',
  downloadUrl: 'https://example.com/file.zip',
  file: 'file.zip',
  status: 'ready',
  generation: 1,
  isMedia: false,
  ...overrides
});

describe('add download metadata workflow', () => {
  it('keeps the stable source URL instead of persisting a resolved redirect', () => {
    const sourceUrl = 'https://github.com/example/project/releases/download/v1/file.zip';
    const signedRedirect = 'https://release-assets.githubusercontent.com/github-production-release-asset/asset?se=2099-01-01T00%3A00%3A00Z&sig=redacted';

    expect(durableDownloadUrl(sourceUrl)).toBe(sourceUrl);
    expect(durableDownloadUrl(sourceUrl)).not.toBe(signedRedirect);
  });

  it('preserves rows by normalized source URL and creates only new rows', () => {
    const existing = row({ file: 'server-name.zip' });
    let nextId = 0;
    const rows = reconcileDownloadRows(
      'https://example.com/file.zip\nhttps://example.com/new.zip',
      [existing],
      undefined,
      new Set(),
      () => `new-${nextId++}`
    );

    expect(rows[0]).toBe(existing);
    expect(rows[1]).toMatchObject({
      id: 'new-0',
      status: 'loading',
      file: 'new.zip'
    });
  });

  it('deduplicates normalized URLs and marks malformed or unsupported URLs invalid', () => {
    let nextId = 0;
    const rows = reconcileDownloadRows(
      'https://example.com/a\nhttps://example.com/a\nfile:///tmp/private\nnot-a-url',
      [],
      undefined,
      new Set(),
      () => `row-${nextId++}`
    );

    expect(rows.map(item => item.status)).toEqual(['loading', 'invalid', 'invalid']);
  });

  it('recognizes pure YouTube playlist URLs without changing video-plus-playlist behavior', () => {
    expect(isYouTubePlaylistUrl('https://www.youtube.com/playlist?list=PL123')).toBe(true);
    expect(isYouTubePlaylistUrl('https://www.youtube.com/playlist/?list=PL123')).toBe(true);
    expect(isYouTubePlaylistUrl('https://music.youtube.com/playlist?list=PL123')).toBe(true);
    expect(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=video&list=PL123')).toBe(false);
    expect(isYouTubePlaylistUrl('https://example.com/playlist?list=PL123')).toBe(false);
  });

  it('admits magnets and local torrent files through the Add window metadata path', () => {
    const rows = reconcileDownloadRows(
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example\nfile:///tmp/Example.torrent',
      []
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      isTorrent: true,
      isMedia: false,
      status: 'ready',
      file: 'Example',
      torrentMetadataStatus: 'loading'
    });
    expect(rows[1]).toMatchObject({
      isTorrent: true,
      isMedia: false,
      sourceUrl: 'file:///tmp/Example.torrent',
      status: 'loading'
    });
    expect(rows[0].torrentCacheId).toBe(`${rows[0].id}-1`);
    expect(rows[1].torrentCacheId).toBe(`${rows[1].id}-1`);
    expect(isMagnetUrl(rows[0].sourceUrl)).toBe(true);
  });

  it('admits remote .torrent URLs through the Torrent metadata path', () => {
    expect(isRemoteTorrentUrl('https://example.com/files/sample.torrent?download=1')).toBe(true);
    expect(isRemoteTorrentUrl('https://example.com/files/sample.zip')).toBe(false);

    const rows = reconcileDownloadRows('https://example.com/files/sample.torrent?download=1', []);

    expect(rows[0]).toMatchObject({
      isTorrent: true,
      isMedia: false,
      status: 'loading'
    });
  });

  it('preserves an explicit torrent handoff for an opaque remote URL', () => {
    const sourceUrl = 'https://example.com/download?id=opaque';
    const rows = reconcileDownloadRows(
      sourceUrl,
      [],
      'example.torrent',
      new Set(),
      undefined,
      {},
      {},
      {},
      {},
      new Set([sourceUrl])
    );

    expect(rows[0]).toMatchObject({
      sourceUrl,
      isTorrent: true,
      torrentCacheId: `${rows[0].id}-1`,
      file: 'example.torrent'
    });
  });

  it('gives refreshed torrent metadata a new cache identity', () => {
    const existing = row({
      id: 'torrent-row',
      sourceUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      downloadUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      isTorrent: true,
      torrentCacheId: 'torrent-row-1',
      torrentPath: '/managed/torrent-row-1.torrent',
      torrentInfoHash: '0123456789abcdef0123456789abcdef01234567',
      generation: 1,
      requestContextVersion: 1
    });

    const refreshed = reconcileDownloadRows(
      existing.sourceUrl,
      [existing],
      undefined,
      new Set(),
      undefined,
      {},
      { [existing.sourceUrl]: 2 }
    );

    expect(refreshed[0]).toMatchObject({
      generation: 2,
      torrentCacheId: 'torrent-row-2',
      torrentPath: undefined,
      torrentInfoHash: undefined,
      torrentFiles: undefined
    });
  });

  it('keeps a playlist as one loading row until discovery succeeds', () => {
    const rows = reconcileDownloadRows(
      'https://www.youtube.com/playlist?list=PL123',
      []
    );

    expect(rows[0]).toMatchObject({
      isMedia: true,
      isPlaylist: true,
      status: 'loading'
    });
  });

  it('expands playlist entries into independently identifiable media rows', () => {
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123';
    const rows = reconcileDownloadRows(
      playlistUrl,
      [],
      undefined,
      new Set(),
      undefined,
      {},
      { [playlistUrl]: 4 },
      {
        [playlistUrl]: {
          title: 'Example playlist',
          playlist_id: 'PL123',
          entry_count: 2,
          skipped_entries: 1,
          truncated: false,
          entries: [
            { id: 'one', url: 'https://www.youtube.com/watch?v=one', title: 'First', playlist_index: 1 },
            { id: 'one-duplicate', url: 'https://www.youtube.com/watch?v=one', title: 'Duplicate', playlist_index: 2 },
            { id: 'two', url: 'https://www.youtube.com/watch?v=two', title: 'Second', playlist_index: 3 }
          ]
        }
      }
    );

    expect(rows).toHaveLength(2);
    expect(rows.map(item => item.sourceUrl)).toEqual([
      'https://www.youtube.com/watch?v=one',
      'https://www.youtube.com/watch?v=two'
    ]);
    expect(rows[0]).toMatchObject({
      file: '001 - First',
      isMedia: true,
      playlistSourceUrl: playlistUrl,
      playlistTitle: 'Example playlist',
      playlistIndex: 1,
      playlistCount: 2,
      requestContextVersion: 4,
      status: 'loading'
    });
    expect(rows[1].file).toBe('003 - Second');
    expect(rows.every(item => !item.isPlaylist)).toBe(true);
  });

  it('uses a stable three-digit playlist prefix and widens it for four-digit lists', () => {
    expect(playlistFilePrefix(1, 12)).toBe('001 - ');
    expect(playlistFilePrefix(12, 12)).toBe('012 - ');
    expect(playlistFilePrefix(1000, 1000)).toBe('1000 - ');
    expect(playlistFilePrefix(undefined, 12)).toBe('');
  });

  it('propagates a playlist selection to entries discovered after the user deselects it', () => {
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123';
    const rows = reconcileDownloadRows(
      playlistUrl,
      [],
      undefined,
      new Set(),
      undefined,
      {},
      {},
      {
        [playlistUrl]: {
          title: 'Example playlist',
          playlist_id: 'PL123',
          entry_count: 1,
          skipped_entries: 0,
          truncated: false,
          entries: [{ id: 'one', url: 'https://www.youtube.com/watch?v=one', title: 'First', playlist_index: 1 }]
        }
      },
      { [playlistUrl]: false }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].selected).toBe(false);
  });

  it('preserves entry-level selection when expanded rows are recreated', () => {
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123';
    const expansion = {
      [playlistUrl]: {
        title: 'Example playlist',
        playlist_id: 'PL123',
        entry_count: 2,
        skipped_entries: 0,
        truncated: false,
        entries: [
          { id: 'one', url: 'https://www.youtube.com/watch?v=one', title: 'First', playlist_index: 1 },
          { id: 'two', url: 'https://www.youtube.com/watch?v=two', title: 'Second', playlist_index: 2 }
        ]
      }
    };

    const rows = reconcileDownloadRows(
      playlistUrl,
      [],
      undefined,
      new Set(),
      undefined,
      {},
      {},
      expansion,
      {
        'https://www.youtube.com/watch?v=one': false,
        'https://www.youtube.com/watch?v=two': true
      }
    );

    expect(rows.map(item => item.selected)).toEqual([false, true]);
  });

  it('does not leave a loading playlist row when every entry is already present', () => {
    const videoUrl = 'https://www.youtube.com/watch?v=one';
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123';
    const rows = reconcileDownloadRows(
      `${videoUrl}\n${playlistUrl}`,
      [],
      undefined,
      new Set(),
      undefined,
      {},
      {},
      {
        [playlistUrl]: {
          title: 'Example playlist',
          playlist_id: 'PL123',
          entry_count: 1,
          skipped_entries: 0,
          truncated: false,
          entries: [{ id: 'one', url: videoUrl, title: 'First', playlist_index: 1 }]
        }
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUrl).toBe(videoUrl);
    expect(rows.some(item => item.isPlaylist)).toBe(false);
  });

  it('forces explicit extension media fetches through media metadata for any http page', () => {
    const rows = reconcileDownloadRows(
      'https://adult.example/watch/123',
      [],
      undefined,
      new Set(['https://adult.example/watch/123'])
    );

    expect(rows[0]).toMatchObject({
      sourceUrl: 'https://adult.example/watch/123',
      isMedia: true,
      status: 'loading'
    });
  });

  it('keeps extension-provided filenames scoped to their individual URLs', () => {
    const rows = reconcileDownloadRows(
      'https://first.example/download\nhttps://second.example/download',
      [],
      undefined,
      new Set(),
      () => crypto.randomUUID(),
      {
        'https://first.example/download': 'first.zip',
        'https://second.example/download': 'second.zip'
      }
    );

    expect(rows.map(item => item.file)).toEqual(['first.zip', 'second.zip']);
  });

  it('refreshes an existing row when a newer extension handoff changes its request context', () => {
    const existing = row({
      isMedia: true,
      status: 'ready',
      generation: 4,
      requestContextVersion: 1,
      formats: [{
        name: '1080p MP4',
        selector: '137+140',
        ext: 'mp4',
        formatLabel: 'MP4',
        detail: '10 MB',
        type: 'Video',
        bytes: 10
      }],
      selectedFormat: 0
    });

    const refreshed = reconcileDownloadRows(
      existing.sourceUrl,
      [existing],
      undefined,
      new Set(),
      () => 'unused',
      {},
      { [existing.sourceUrl]: 2 }
    );

    expect(refreshed[0]).toMatchObject({
      status: 'loading',
      generation: 5,
      requestContextVersion: 2,
      formats: undefined,
      selectedFormat: undefined
    });
  });

  it('replaces a stale filename when a newer handoff supplies a new one', () => {
    const existing = row({
      file: 'old-name.zip',
      requestContextVersion: 1,
      generation: 2,
      size: '10 MB',
      sizeBytes: 10,
      resumable: true
    });

    const refreshed = reconcileDownloadRows(
      existing.sourceUrl,
      [existing],
      undefined,
      new Set(),
      () => 'unused',
      { [existing.sourceUrl]: 'new-name.zip' },
      { [existing.sourceUrl]: 2 }
    );

    expect(refreshed[0]).toMatchObject({
      file: 'new-name.zip',
      status: 'loading',
      generation: 3,
      requestContextVersion: 2,
      size: undefined,
      sizeBytes: undefined,
      resumable: undefined
    });
  });

  it('drops stale playlist provenance when an entry remains after its playlist is removed', () => {
    const videoUrl = 'https://www.youtube.com/watch?v=one';
    const playlistUrl = 'https://www.youtube.com/playlist?list=PL123';
    const existing = row({
      sourceUrl: videoUrl,
      downloadUrl: videoUrl,
      file: '001 - First.mp4',
      status: 'ready',
      generation: 3,
      isMedia: true,
      playlistSourceUrl: playlistUrl,
      playlistTitle: 'Example playlist',
      playlistIndex: 1,
      playlistCount: 2,
      playlistEntryTitle: 'First',
      requestContextVersion: 7,
      size: '10 MB',
      sizeBytes: 10,
      resumable: true
    });

    const rows = reconcileDownloadRows(videoUrl, [existing]);

    expect(rows[0]).toMatchObject({
      file: 'watch',
      status: 'loading',
      generation: 4,
      isMedia: true,
      playlistSourceUrl: undefined,
      playlistIndex: undefined,
      size: undefined,
      sizeBytes: undefined,
      resumable: undefined,
      requestContextVersion: undefined
    });
  });

  it('appends every unseen handoff after the observed version', () => {
    const merged = appendRequestUrlsAfterVersion(
      'https://existing.example/file.zip',
      {
        'https://first.example/file.zip': { version: 2 },
        'https://second.example/file.zip': { version: 3 },
        'https://existing.example/file.zip': { version: 4 }
      },
      1
    );

    expect(merged).toBe(
      'https://existing.example/file.zip\n' +
      'https://first.example/file.zip\n' +
      'https://second.example/file.zip'
    );
  });

  it('upgrades an existing normal row when the user explicitly fetches it as media', () => {
    const existing = row({
      sourceUrl: 'https://adult.example/watch/123',
      downloadUrl: 'https://adult.example/watch/123',
      file: '123',
      status: 'ready',
      generation: 2,
      isMedia: false
    });

    const rows = reconcileDownloadRows(
      'https://adult.example/watch/123',
      [existing],
      undefined,
      new Set(['https://adult.example/watch/123'])
    );

    expect(rows[0]).toMatchObject({
      sourceUrl: 'https://adult.example/watch/123',
      isMedia: true,
      status: 'loading',
      generation: 3,
      formats: undefined,
      selectedFormat: undefined
    });
  });

  it('refreshes only failed metadata and preserves successful format selection', () => {
    const ready = row({
      id: 'ready',
      isMedia: true,
      formats: [{
        name: '1080p MP4',
        selector: 'best',
        ext: 'mp4',
        formatLabel: '1080p',
        detail: '10 MB',
        type: 'Video',
        bytes: 10
      }],
      selectedFormat: 0
    });
    const failed = row({ id: 'failed', status: 'metadata-error', generation: 4 });

    const refreshed = refreshFailedMetadataRows([ready, failed]);

    expect(refreshed[0]).toBe(ready);
    expect(refreshed[1]).toMatchObject({ status: 'loading', generation: 5 });
  });

  it('does not duplicate an in-flight magnet probe and refreshes it after failure', () => {
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
    const admitted = reconcileDownloadRows(magnet, [])[0];

    expect(admitted.status).toBe('ready');
    expect(canSubmitMetadataRows([admitted])).toBe(true);
    expect(isMetadataRefreshableRow(admitted)).toBe(false);

    const failed = { ...admitted, torrentMetadataStatus: 'error' as const };
    const refreshed = refreshFailedMetadataRows([failed])[0];
    expect(refreshed).toMatchObject({
      status: 'loading',
      generation: 2,
      torrentCacheId: `${admitted.id}-2`,
    });
    expect(isMetadataRefreshableRow(failed)).toBe(true);
    expect(isMetadataRefreshableRow({ ...admitted, status: 'loading' })).toBe(false);
    expect(isMetadataRefreshableRow(row())).toBe(false);
  });

  it('refreshes only selected metadata rows when requested by the preview action', () => {
    const selected = row({
      id: 'selected-magnet',
      sourceUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      isTorrent: true,
      selected: true
    });
    const unselected = row({
      id: 'unselected-magnet',
      sourceUrl: 'magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      isTorrent: true,
      selected: false
    });

    const refreshed = refreshFailedMetadataRows([selected, unselected], true);

    expect(refreshed[0]).toMatchObject({ status: 'loading', generation: 2 });
    expect(refreshed[1]).toBe(unselected);
  });

  it('invalidates stale torrent metadata before an optional refresh', () => {
    const refreshed = refreshFailedMetadataRows([row({
      isTorrent: true,
      sourceUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
      status: 'ready',
      torrentPath: '/managed/old.torrent',
      torrentCacheId: 'old-cache',
      torrentInfoHash: 'old-hash',
      torrentFiles: [{ index: 1, path: 'old.bin', length: 10 }],
      selectedTorrentFileIndices: [1]
    })])[0];

    expect(refreshed).toMatchObject({
      status: 'loading',
      generation: 2,
      torrentCacheId: 'row-1-2',
      torrentMetadataStatus: 'loading'
    });
    expect(refreshed.torrentPath).toBeUndefined();
    expect(refreshed.torrentInfoHash).toBeUndefined();
    expect(refreshed.torrentFiles).toBeUndefined();
    expect(refreshed.selectedTorrentFileIndices).toBeUndefined();
  });

  it('migrates legacy magnet fallback rows to transfer-ready state', () => {
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
    const legacy = row({
      sourceUrl: magnet,
      downloadUrl: 'torrent:stale-metadata-hash',
      status: 'fallback',
      isTorrent: true,
      torrentPath: '/managed/stale.torrent',
      torrentCacheId: 'legacy-cache',
      torrentInfoHash: 'legacy-hash',
      torrentFiles: [{ index: 1, path: 'stale.bin', length: 10 }],
      selectedTorrentFileIndices: [1]
    });

    const migrated = reconcileDownloadRows(magnet, [legacy])[0];

    expect(migrated).toMatchObject({
      status: 'ready',
      downloadUrl: magnet,
      isTorrent: true,
      torrentMetadataStatus: 'loading'
    });
    expect(migrated.torrentPath).toBeUndefined();
    expect(migrated.torrentCacheId).toBeUndefined();
    expect(migrated.torrentInfoHash).toBeUndefined();
    expect(migrated.torrentFiles).toBeUndefined();
    expect(migrated.selectedTorrentFileIndices).toBeUndefined();
  });

  it('ignores stale metadata results after generation changes', () => {
    const current = row({ generation: 2, status: 'loading' });
    const updated = updateRowIfCurrent(
      [current],
      current.id,
      current.sourceUrl,
      1,
      value => ({ ...value, status: 'ready' })
    );

    expect(updated[0]).toBe(current);
  });

  it('allows normal-download fallback but blocks unresolved explicit media', () => {
    expect(canSubmitMetadataRows([
      row(),
      row({ id: 'fallback', status: 'metadata-error' })
    ])).toBe(true);
    expect(canSubmitMetadataRows([
      row({ id: 'unsafe', status: 'metadata-error', metadataBlockedReason: 'unsafe-url' })
    ])).toBe(false);
    expect(canSubmitMetadataRows([
      row(),
      row({ id: 'media-fallback', status: 'metadata-error', isMedia: true })
    ])).toBe(false);
    expect(canSubmitMetadataRows([row({ status: 'loading' })])).toBe(false);
    expect(canSubmitMetadataRows([row({ status: 'invalid' })])).toBe(false);
  });

  it('validates only selected rows and requires at least one selection', () => {
    expect(canSubmitMetadataRows([
      row({ status: 'loading' }),
      row({ id: 'skipped', status: 'invalid', selected: false })
    ])).toBe(false);
    expect(canSubmitMetadataRows([
      row({ status: 'ready' }),
      row({ id: 'skipped', status: 'invalid', selected: false })
    ])).toBe(true);
    expect(canSubmitMetadataRows([
      row({ selected: false }),
      row({ id: 'skipped', selected: false })
    ])).toBe(false);
    expect(metadataSummaryMessage([
      row({ status: 'metadata-error', selected: false }),
      row({ id: 'ready', status: 'ready' })
    ])).toContain('Ready to add 1 download');
    expect(metadataSummaryMessage([
      row({ status: 'metadata-error' }),
      row({ id: 'skipped', status: 'ready', selected: false })
    ])).toContain('can still be added');
  });

  it('keeps failed media routing without a format selector', () => {
    const failedMedia = row({
      status: 'metadata-error',
      isMedia: true,
      formats: undefined,
      selectedFormat: undefined
    });

    expect(failedMedia.isMedia).toBe(true);
    expect(mediaFormatSelectorForRow(failedMedia)).toBeUndefined();
  });

  it('replaces only known media container suffixes when selecting formats', () => {
    const mediaRow = row({
      isMedia: true,
      formats: [
        {
          name: '1080p MP4',
          selector: 'mp4',
          ext: 'mp4',
          formatLabel: '1080p',
          detail: '10 MB',
          type: 'Video',
          bytes: 10
        },
        {
          name: '1080p MKV',
          selector: 'mkv',
          ext: 'mkv',
          formatLabel: '1080p',
          detail: '11 MB',
          type: 'Video',
          bytes: 11
        }
      ],
      selectedFormat: 1
    });

    expect(mediaFileNameForSelectedFormat('Version 1.5', mediaRow)).toBe('Version 1.5.mkv');
    expect(mediaFileNameForSelectedFormat('Version 1.5.mp4', mediaRow)).toBe('Version 1.5.mkv');
  });

  it('reports fallback and invalid states accurately', () => {
    expect(metadataSummaryMessage([
      row(),
      row({ id: 'fallback', status: 'metadata-error' })
    ])).toBe('1 download ready; 1 will use fallback filename and unknown size.');
    expect(metadataSummaryMessage([
      row({ status: 'metadata-error' })
    ])).toContain('can still be added');
    expect(metadataSummaryMessage([
      row({ status: 'metadata-error', metadataBlockedReason: 'unsafe-url' })
    ])).toContain('unsafe URL');
    expect(metadataSummaryMessage([
      row({ status: 'metadata-error', isMedia: true })
    ])).toContain('Refresh metadata before adding');
    expect(metadataSummaryMessage([
      row({ status: 'invalid' })
    ])).toContain('Correct or remove 1 invalid URL');
  });

  it('offers only qualities shared by every selected ready media row', () => {
    const formats = (qualities: string[]) => qualities.map((quality, index) => ({
      name: `${quality} MP4`,
      quality,
      selector: `${quality}-${index}`,
      ext: 'mp4',
      formatLabel: quality,
      detail: '10 MB',
      type: 'Video',
      bytes: 10
    }));
    const rows = [
      row({ id: 'one', isMedia: true, formats: formats(['1080p', '720p']), selectedFormat: 0 }),
      row({ id: 'two', isMedia: true, formats: formats(['720p', '480p']), selectedFormat: 0 })
    ];

    expect(commonMediaQualitiesForRows(rows)).toEqual(['720p']);
    expect(mediaQualityForRow(rows[0])).toBe('1080p');
  });

  it('keeps playlist choices available when one ready row remains selected', () => {
    const formats = [
      {
        name: '720p MP4',
        quality: '720p',
        selector: '720',
        ext: 'mp4',
        formatLabel: 'MP4 • H.264',
        detail: '10 MB',
        type: 'Video',
        bytes: 10
      },
      {
        name: 'Audio only M4A',
        quality: 'Audio only',
        selector: 'audio',
        ext: 'm4a',
        formatLabel: 'M4A • AAC',
        detail: '4 MB',
        type: 'Audio',
        bytes: 4
      }
    ];
    const selectedRow = row({ isMedia: true, formats, selectedFormat: 0 });

    expect(commonMediaFormatsForRows([selectedRow], 'Video')).toEqual(['MP4']);
    expect(commonMediaQualitiesForRows([selectedRow], 'Video', 'MP4')).toEqual(['720p']);
    expect(commonMediaFormatsForRows([selectedRow], 'Audio')).toEqual(['M4A']);
    expect(commonMediaQualitiesForRows([selectedRow], 'Audio', 'M4A')).toEqual(['Audio only']);
  });

  it('does not offer a shared format when its qualities do not overlap', () => {
    const format = (quality: string, id: string) => [{
      name: `${quality} MP4`,
      quality,
      selector: id,
      ext: 'mp4',
      formatLabel: 'MP4 • H.264',
      detail: '10 MB',
      type: 'Video',
      bytes: 10
    }];
    const rows = [
      row({ id: 'one', isMedia: true, formats: format('1080p', 'one'), selectedFormat: 0 }),
      row({ id: 'two', isMedia: true, formats: format('720p', 'two'), selectedFormat: 0 })
    ];

    expect(commonMediaFormatsForRows(rows, 'Video')).toEqual([]);
  });

  it('filters playlist choices by media type and format', () => {
    const formats = (qualities: string[], idPrefix: string) => [
      ...qualities.flatMap((quality, index) => [
        {
          name: `${quality} MKV`,
          quality,
          selector: `${idPrefix}-mkv-${index}`,
          ext: 'mkv',
          formatLabel: 'MKV • H.264',
          detail: '10 MB',
          type: 'Video',
          bytes: 10
        },
        {
          name: `${quality} MP4`,
          quality,
          selector: `${idPrefix}-mp4-${index}`,
          ext: 'mp4',
          formatLabel: 'MP4 • H.264',
          detail: '10 MB',
          type: 'Video',
          bytes: 10
        }
      ]),
      {
        name: 'Audio only M4A',
        quality: 'Audio only',
        selector: `${idPrefix}-m4a`,
        ext: 'm4a',
        formatLabel: 'M4A • AAC',
        detail: '4 MB',
        type: 'Audio',
        bytes: 4
      },
      {
        name: 'Audio only WEBM',
        quality: 'Audio only',
        selector: `${idPrefix}-webm`,
        ext: 'webm',
        formatLabel: 'WEBM • Opus',
        detail: '4 MB',
        type: 'Audio',
        bytes: 4
      }
    ];
    const rows = [
      row({ id: 'one', isMedia: true, formats: formats(['1080p', '720p'], 'one'), selectedFormat: 0 }),
      row({ id: 'two', isMedia: true, formats: formats(['720p', '480p'], 'two'), selectedFormat: 0 })
    ];

    expect(commonMediaFormatsForRows(rows, 'Video')).toEqual(['MKV', 'MP4']);
    expect(commonMediaQualitiesForRows(rows, 'Video', 'MP4')).toEqual(['720p']);
    expect(commonMediaFormatsForRows(rows, 'Audio')).toEqual(['M4A', 'WEBM']);
    expect(commonMediaQualitiesForRows(rows, 'Audio', 'M4A')).toEqual(['Audio only']);
    expect(mediaTypeForFormat(rows[0].formats![4])).toBe('Audio');
    expect(mediaFormatForFormat(rows[0].formats![4])).toBe('M4A');
  });

  it('applies an exact playlist media selection without falling back to another format', () => {
    const formats = (id: string) => [
      {
        name: '720p MKV',
        quality: '720p',
        selector: `${id}-mkv`,
        ext: 'mkv',
        formatLabel: 'MKV • H.264',
        detail: '10 MB',
        type: 'Video',
        bytes: 10
      },
      {
        name: '720p MP4',
        quality: '720p',
        selector: `${id}-mp4`,
        ext: 'mp4',
        formatLabel: 'MP4 • H.264',
        detail: '9 MB',
        type: 'Video',
        bytes: 9
      }
    ];
    const rows = [
      row({ id: 'one', isMedia: true, file: 'one.mkv', formats: formats('one'), selectedFormat: 0 }),
      row({ id: 'two', isMedia: true, file: 'two.mkv', formats: formats('two'), selectedFormat: 0 })
    ];

    const selected = selectExactMediaSelection(rows, ['one', 'two'], {
      mediaType: 'Video',
      format: 'MP4',
      quality: '720p'
    });
    expect(selected[0]).toMatchObject({ selectedFormat: 1, file: 'one.mp4' });
    expect(selected[1]).toMatchObject({ selectedFormat: 1, file: 'two.mp4' });
    expect(selectExactMediaSelection(rows, ['one', 'two'], {
      mediaType: 'Video',
      format: 'WEBM',
      quality: '720p'
    })).toEqual(rows);
  });

  it('applies an exact bulk quality without falling back to a higher or lower stream', () => {
    const mediaRow = row({
      id: 'media',
      file: 'clip.mp4',
      isMedia: true,
      formats: [{
        name: '1080p MP4',
        quality: '1080p',
        selector: '1080',
        ext: 'mp4',
        formatLabel: '1080p',
        detail: '10 MB',
        type: 'Video',
        bytes: 10
      }],
      selectedFormat: 0
    });

    const unchanged = selectExactMediaQuality([mediaRow], ['media'], '720p');
    expect(unchanged[0]).toBe(mediaRow);
    expect(selectExactMediaQuality([mediaRow], ['media'], '1080p')[0]).toMatchObject({
      selectedFormat: 0,
      file: 'clip.mp4'
    });
  });

  it('uses few forms for Russian and Ukrainian metadata summaries', async () => {
    const originalLanguage = i18n.language;
    const twoReadyRows = [row(), row({ id: 'row-2' })];

    try {
      await changeAppLocale('ru');
      expect(metadataSummaryMessage(twoReadyRows)).toBe('Готово к добавлению: 2 загрузки.');

      await changeAppLocale('uk');
      expect(metadataSummaryMessage(twoReadyRows)).toBe('Готово до додавання: 2 завантаження.');
    } finally {
      await changeAppLocale(originalLanguage === 'uk' || originalLanguage === 'ru' ? originalLanguage : 'en');
    }
  });
});
