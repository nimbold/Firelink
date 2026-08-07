import { describe, expect, it } from 'vitest';
import {
  formatDownloadBytes,
  formatDownloadTotal,
  resolveDownloadFraction,
  resolveDownloadSizeDisplay,
} from './downloadProgress';

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

describe('resolveDownloadFraction', () => {
  it('reconstructs paused progress from exact persisted byte counters', () => {
    expect(resolveDownloadFraction({
      status: 'paused',
      downloadedBytes: 662 * 1024 ** 2,
      totalBytes: 2.94 * 1024 ** 3,
    })).toBeCloseTo(0.2199, 3);
  });

  it('uses a live fraction when it is available', () => {
    expect(resolveDownloadFraction({
      fraction: 0.37,
      downloadedBytes: 90,
      totalBytes: 100,
      status: 'downloading',
    })).toBe(0.37);
  });

  it('does not infer progress from an estimated media total', () => {
    expect(resolveDownloadFraction({
      fraction: 0,
      downloadedBytes: 900,
      totalBytes: 1000,
      totalIsEstimate: true,
      isMedia: true,
      size: '~1000 B',
      status: 'paused',
    })).toBe(0);
  });

  it('keeps zero at the start and does not divide by an unknown total', () => {
    expect(resolveDownloadFraction({
      downloadedBytes: 0,
      totalBytes: 0,
      status: 'paused',
    })).toBe(0);
    expect(resolveDownloadFraction({
      downloadedBytes: 500,
      status: 'paused',
    })).toBe(0);
  });

  it('shows completed downloads as complete even when volatile fraction was removed', () => {
    expect(resolveDownloadFraction({
      status: 'completed',
      downloadedBytes: 0,
      totalBytes: 100,
    })).toBe(1);
  });

  it('clamps inconsistent exact byte counters', () => {
    expect(resolveDownloadFraction({
      downloadedBytes: 150,
      totalBytes: 100,
      status: 'paused',
    })).toBe(1);
  });
});
