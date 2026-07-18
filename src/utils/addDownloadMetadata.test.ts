import { describe, expect, it } from 'vitest';
import {
  appendRequestUrlsAfterVersion,
  canSubmitMetadataRows,
  mediaFormatSelectorForRow,
  mediaFileNameForSelectedFormat,
  metadataSummaryMessage,
  isYouTubePlaylistUrl,
  playlistFilePrefix,
  reconcileDownloadRows,
  refreshFailedMetadataRows,
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
