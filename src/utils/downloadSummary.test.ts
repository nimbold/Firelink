import { describe, expect, it } from 'vitest';
import type { DownloadItem } from '../bindings/DownloadItem';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';
import { summarizeDownloads } from './downloadSummary';

const item = (id: string, overrides: Partial<DownloadItem> = {}): DownloadItem => ({
  id,
  url: `https://example.com/${id}`,
  fileName: `${id}.bin`,
  status: 'ready',
  category: 'Other',
  dateAdded: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const progress = (id: string, overrides: Partial<DownloadProgressEvent> = {}): DownloadProgressEvent => ({
  id,
  fraction: 0.5,
  speed: '1 MiB/s',
  eta: '1m',
  size: null,
  size_is_final: false,
  ...overrides,
});

describe('download summaries', () => {
  it('aggregates exact bytes and transfer-active counts', () => {
    expect(summarizeDownloads([
      item('active', { status: 'downloading', downloadedBytes: 1024, totalBytes: 4096 }),
      item('done', { status: 'completed', totalBytes: 2048 }),
    ])).toEqual({
      itemCount: 2,
      activeCount: 1,
      downloadedBytes: 3072,
      remainingBytes: 3072,
      remainingIsEstimated: false,
    });
  });

  it('treats completed downloads as having no remaining bytes despite stale progress', () => {
    expect(summarizeDownloads([
      item('done', {
        status: 'completed',
        totalBytes: 40 * 1024 ** 2,
        downloadedBytes: 40 * 1024 ** 2,
      }),
    ], {
      done: progress('done', {
        downloaded_bytes: 40 * 1024 ** 2 - 555 * 1024,
        total_bytes: 555 * 1024,
      }),
    })).toEqual({
      itemCount: 1,
      activeCount: 0,
      downloadedBytes: 40 * 1024 ** 2,
      remainingBytes: 0,
      remainingIsEstimated: false,
    });
  });

  it('does not present partial byte totals as complete aggregates', () => {
    expect(summarizeDownloads([
      item('known', { totalBytes: 100, downloadedBytes: 20 }),
      item('unknown', { status: 'failed' }),
    ])).toMatchObject({
      itemCount: 2,
      downloadedBytes: null,
      remainingBytes: null,
    });
  });

  it('infers zero bytes for an unstarted paused item but preserves partial unknowns', () => {
    expect(summarizeDownloads([
      item('paused', { status: 'paused', totalBytes: 1000 }),
    ])).toMatchObject({
      downloadedBytes: 0,
      remainingBytes: 1000,
      remainingIsEstimated: false,
    });

    expect(summarizeDownloads([
      item('partial', { status: 'paused', fraction: 0.4, totalBytes: 1000 }),
    ]).downloadedBytes).toBeNull();
  });

  it('treats a fresh media item as having no downloaded bytes before its first progress event', () => {
    expect(summarizeDownloads([
      item('media', {
        status: 'ready',
        isMedia: true,
        totalBytes: 1024,
        totalIsEstimate: true,
      }),
    ])).toMatchObject({
      downloadedBytes: 0,
      remainingBytes: 1024,
      remainingIsEstimated: true,
    });
  });

  it('keeps non-final media progress on the stored estimated denominator', () => {
    expect(summarizeDownloads([
      item('media', {
        status: 'downloading',
        isMedia: true,
        totalBytes: 2 * 1024 ** 2,
        size: '~2 MB',
      }),
    ], {
      media: progress('media', {
        downloaded_bytes: 512 * 1024,
        total_bytes: 1024,
        total_is_estimate: true,
      }),
    })).toEqual({
      itemCount: 1,
      activeCount: 1,
      downloadedBytes: 512 * 1024,
      remainingBytes: 2 * 1024 ** 2 - 512 * 1024,
      remainingIsEstimated: true,
    });
  });

  it('does not claim zero remaining when an estimate is already below observed bytes', () => {
    expect(summarizeDownloads([
      item('media', {
        status: 'downloading',
        isMedia: true,
        downloadedBytes: 150,
        totalBytes: 100,
        totalIsEstimate: true,
      }),
    ])).toMatchObject({
      downloadedBytes: 150,
      remainingBytes: null,
      remainingIsEstimated: false,
    });
  });

  it('uses a final media progress total when one is available', () => {
    expect(summarizeDownloads([
      item('media', {
        status: 'processing',
        isMedia: true,
        totalBytes: 2 * 1024 ** 2,
        totalIsEstimate: true,
      }),
    ], {
      media: progress('media', {
        downloaded_bytes: 3 * 1024 ** 2,
        total_bytes: 3 * 1024 ** 2,
        size_is_final: true,
        total_is_estimate: false,
      }),
    })).toMatchObject({
      downloadedBytes: 3 * 1024 ** 2,
      remainingBytes: 0,
      remainingIsEstimated: false,
    });
  });

  it('does not overflow aggregate byte counters', () => {
    const huge = Number.MAX_VALUE;
    expect(summarizeDownloads([
      item('one', { totalBytes: huge, downloadedBytes: huge }),
      item('two', { totalBytes: huge, downloadedBytes: huge }),
    ])).toMatchObject({
      downloadedBytes: null,
      remainingBytes: 0,
    });

    expect(summarizeDownloads([
      item('three', { totalBytes: huge, downloadedBytes: 0 }),
      item('four', { totalBytes: huge, downloadedBytes: 0 }),
    ])).toMatchObject({
      downloadedBytes: 0,
      remainingBytes: null,
    });
  });
});
