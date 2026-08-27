import { describe, expect, it } from 'vitest';
import { formatDownloadBytes, formatDownloadTotal, resolveDownloadSizeDisplay } from './downloadProgress';

describe('download progress size display', () => {
  it('formats byte counts using the binary units used by the download engines', () => {
    expect(formatDownloadBytes(0)).toBe('0 B');
    expect(formatDownloadBytes(1.2 * 1024 ** 3)).toBe('1.20 GB');
  });

  it('keeps estimated totals distinguishable from exact totals', () => {
    expect(resolveDownloadSizeDisplay({
      downloadedBytes: 1.2 * 1024 ** 3,
      totalBytes: 2.4 * 1024 ** 3,
      totalIsEstimate: true,
      fallbackSize: 'Unknown'
    })).toEqual({
      downloaded: '1.20',
      total: '2.40',
      unit: 'GB',
      totalIsEstimate: true,
      fallback: 'Unknown'
    });
  });

  it('converts downloaded bytes into the total size unit', () => {
    expect(resolveDownloadSizeDisplay({
      downloadedBytes: 512 * 1024 ** 2,
      totalBytes: 2 * 1024 ** 3,
      fallbackSize: '2 GB'
    })).toMatchObject({
      downloaded: '0.50',
      total: '2.00',
      unit: 'GB'
    });
  });

  it('formats a completed download using only its total size', () => {
    const display = resolveDownloadSizeDisplay({
      downloadedBytes: 1.2 * 1024 ** 3,
      totalBytes: 2.4 * 1024 ** 3,
      fallbackSize: '2.4 GB'
    });

    expect(formatDownloadTotal(display)).toBe('2.40 GB');
  });
});
