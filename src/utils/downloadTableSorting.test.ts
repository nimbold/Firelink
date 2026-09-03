import { describe, expect, it } from 'vitest';
import type { DownloadItem } from '../bindings/DownloadItem';
import {
  parseDownloadEta,
  parseDownloadSize,
  sortDownloads,
  type DownloadSortConfig
} from './downloadTableSorting';
import { redactDownloadForPersistence } from './downloads';

const item = (id: string, overrides: Partial<DownloadItem> = {}): DownloadItem => ({
  id,
  url: `https://example.test/${id}`,
  fileName: id,
  status: 'queued',
  category: 'Other',
  dateAdded: '2026-07-14T00:00:00.000Z',
  ...overrides
});

const sortedIds = (downloads: DownloadItem[], config: DownloadSortConfig): string[] =>
  sortDownloads(downloads, config).map(download => download.id);

describe('download table sorting', () => {
  it('compares human-readable sizes by bytes instead of their leading number', () => {
    expect(parseDownloadSize('1 MB')).toBe(1024 ** 2);
    expect(sortedIds([
      item('one-mb', { size: '1 MB' }),
      item('900-kb', { size: '900 KB' }),
      item('two-mb', { size: '2 MB' })
    ], { column: 'Size', direction: 'asc' })).toEqual(['900-kb', 'one-mb', 'two-mb']);
  });

  it('supports clock and unit ETA values and keeps unknown values last', () => {
    expect(parseDownloadEta('01:02:03')).toBe(3723);
    expect(parseDownloadEta('2m 5s')).toBe(125);
    expect(sortedIds([
      item('unknown', { eta: '-' }),
      item('long', { eta: '2m' }),
      item('short', { eta: '10s' })
    ], { column: 'ETA', direction: 'asc' })).toEqual(['short', 'long', 'unknown']);
  });

  it('sorts descending on the second click without reverting to an unsorted list', () => {
    const downloads = [item('b', { fileName: 'Beta' }), item('a', { fileName: 'Alpha' })];
    expect(sortedIds(downloads, { column: 'File Name', direction: 'asc' })).toEqual(['a', 'b']);
    expect(sortedIds(downloads, { column: 'File Name', direction: 'desc' })).toEqual(['b', 'a']);
  });

  it('does not persist volatile progress fields', () => {
    const persisted = redactDownloadForPersistence(item('volatile', {
      fraction: 0.75,
      speed: '1 MB/s',
      eta: '10s'
    }));
    expect(persisted.fraction).toBeUndefined();
    expect(persisted.speed).toBeUndefined();
    expect(persisted.eta).toBeUndefined();
  });

  it('parses estimated sizes with ~ or ≈ prefixes and sorts them accurately', () => {
    expect(parseDownloadSize('~1.2 GB')).toBe(1.2 * 1024 ** 3);
    expect(parseDownloadSize('~ 500 MB')).toBe(500 * 1024 ** 2);
    expect(parseDownloadSize('≈250 KB')).toBe(250 * 1024);

    expect(sortedIds([
      item('missing', { size: '-' }),
      item('est-1g', { size: '~1 GB' }),
      item('final-500m', { size: '500 MB' }),
      item('exact-bytes', { totalBytes: 2 * 1024 ** 3 }),
    ], { column: 'Size', direction: 'asc' })).toEqual([
      'final-500m',
      'est-1g',
      'exact-bytes',
      'missing'
    ]);
  });

  it('keeps unknown and missing values last in descending sort for Size, Speed, ETA, and Date Added', () => {
    expect(sortedIds([
      item('unknown-size', { size: '-' }),
      item('small-size', { size: '100 MB' }),
      item('large-size', { size: '1 GB' }),
    ], { column: 'Size', direction: 'desc' })).toEqual([
      'large-size',
      'small-size',
      'unknown-size'
    ]);

    expect(sortedIds([
      item('unknown-speed', { speed: '-' }),
      item('fast-speed', { speed: '10 MB/s' }),
      item('slow-speed', { speed: '1 MB/s' }),
    ], { column: 'Speed', direction: 'desc' })).toEqual([
      'fast-speed',
      'slow-speed',
      'unknown-speed'
    ]);

    expect(sortedIds([
      item('unknown-eta', { eta: '-' }),
      item('long-eta', { eta: '2h' }),
      item('short-eta', { eta: '5m' }),
    ], { column: 'ETA', direction: 'desc' })).toEqual([
      'long-eta',
      'short-eta',
      'unknown-eta'
    ]);

    expect(sortedIds([
      item('unknown-date', { dateAdded: '' }),
      item('newer-date', { dateAdded: '2026-08-01T00:00:00.000Z' }),
      item('older-date', { dateAdded: '2026-01-01T00:00:00.000Z' }),
    ], { column: 'Date Added', direction: 'desc' })).toEqual([
      'newer-date',
      'older-date',
      'unknown-date'
    ]);
  });
});
