import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMN_ALIGNMENTS,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  buildColumnGridTemplate,
  getDownloadActionPosition,
  getColumnGridColumn,
  normalizeColumnAlignments,
  normalizeColumnOrder,
  normalizeColumnWidths,
} from './downloadTableColumns';

describe('download table column preferences', () => {
  it('normalizes a persisted order without losing or duplicating columns', () => {
    expect(normalizeColumnOrder(['Status', 'Status', 'not-a-column', 'File Name'])).toEqual([
      'Status',
      'File Name',
      'Size',
      'Speed',
      'ETA',
      'Date Added',
    ]);
  });

  it('clamps persisted widths to column minimums and restores malformed entries', () => {
    expect(normalizeColumnWidths([10, 70, Number.POSITIVE_INFINITY, 80, '48', 140])).toEqual([
      160,
      70,
      220,
      80,
      80,
      144,
    ]);

    expect(normalizeColumnWidths([0, 100, 220, 100, 80, 170])[0]).toBe(160);
  });

  it('keeps only supported positional alignment values', () => {
    expect(normalizeColumnAlignments({
      'File Name': 'center',
      Size: 'right',
      Status: 'invalid',
      Speed: 'left',
    })).toEqual({
      ...DEFAULT_COLUMN_ALIGNMENTS,
      'File Name': 'center',
      Size: 'right',
      Speed: 'left',
    });
  });

  it('restores the default order for malformed persisted data', () => {
    expect(normalizeColumnOrder(null)).toEqual([...DEFAULT_COLUMN_ORDER]);
    expect(normalizeColumnAlignments(null)).toEqual(DEFAULT_COLUMN_ALIGNMENTS);
  });

  it('keeps every data column fixed while reserving a flexible fill track after them', () => {
    expect(buildColumnGridTemplate([...DEFAULT_COLUMN_ORDER], [...DEFAULT_COLUMN_WIDTHS])).toBe(
      '340px 100px 220px 100px 80px 170px minmax(0, 1fr)'
    );
    expect(getColumnGridColumn('Date Added', [...DEFAULT_COLUMN_ORDER])).toBe('6');
    expect(getColumnGridColumn('Date Added', ['Date Added', ...DEFAULT_COLUMN_ORDER.slice(0, -1)])).toBeUndefined();
    expect(getColumnGridColumn('ETA', ['Date Added', 'File Name', 'Size', 'Status', 'Speed', 'ETA'])).toBe('6');
  });

  it('keeps row actions inside the visible row edge while preserving viewport anchoring for clipped rows', () => {
    const viewport = { top: 0, right: 800, bottom: 600, left: 0 };
    expect(getDownloadActionPosition(
      { top: 40, right: 1000, bottom: 72, left: -200 },
      viewport,
      viewport,
      800
    )).toMatchObject({
      right: 8,
      height: 28,
      visibility: 'visible',
    });

    expect(getDownloadActionPosition(
      { top: 40, right: 400, bottom: 72, left: 100 },
      viewport,
      viewport,
      800,
      16
    )).toMatchObject({
      right: 416,
      visibility: 'visible',
    });

    expect(getDownloadActionPosition(
      { top: 40, right: 400, bottom: 72, left: 100 },
      viewport,
      viewport,
      800
    )).toMatchObject({
      right: 408,
      visibility: 'visible',
    });

    expect(getDownloadActionPosition(
      { top: 40, right: -20, bottom: 72, left: -300 },
      viewport,
      viewport,
      800
    ).visibility).toBe('hidden');
  });
});
