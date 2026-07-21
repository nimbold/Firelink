import type { DownloadSortColumn } from './downloadTableSorting';

export type DownloadTableColumnKey = DownloadSortColumn;
export type DownloadColumnAlignment = 'left' | 'center' | 'right';

export const DEFAULT_COLUMN_ORDER = [
  'File Name',
  'Size',
  'Status',
  'Speed',
  'ETA',
  'Date Added',
] as const satisfies readonly DownloadTableColumnKey[];

export const DEFAULT_COLUMN_WIDTHS = [340, 100, 220, 100, 80, 170] as const;
export const COLUMN_MINIMUMS = [160, 58, 92, 58, 48, 112] as const;

export const COLUMN_WIDTHS_STORAGE_KEY = 'firelink-download-column-widths';
export const COLUMN_ORDER_STORAGE_KEY = 'firelink-download-column-order';
export const COLUMN_ALIGNMENTS_STORAGE_KEY = 'firelink-download-column-alignments';

export const DEFAULT_COLUMN_ALIGNMENTS: Record<DownloadTableColumnKey, DownloadColumnAlignment> = {
  'File Name': 'left',
  Size: 'left',
  Status: 'left',
  Speed: 'left',
  ETA: 'left',
  'Date Added': 'left',
};

export const COLUMN_ALIGNMENT_JUSTIFY: Record<DownloadColumnAlignment, 'flex-start' | 'center' | 'flex-end'> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

const isColumnKey = (value: unknown): value is DownloadTableColumnKey =>
  typeof value === 'string' && (DEFAULT_COLUMN_ORDER as readonly string[]).includes(value);

const isColumnAlignment = (value: unknown): value is DownloadColumnAlignment =>
  value === 'left' || value === 'center' || value === 'right';

export const normalizeColumnOrder = (value: unknown): DownloadTableColumnKey[] => {
  const seen = new Set<DownloadTableColumnKey>();
  const normalized: DownloadTableColumnKey[] = [];

  if (Array.isArray(value)) {
    for (const candidate of value) {
      if (isColumnKey(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        normalized.push(candidate);
      }
    }
  }

  for (const key of DEFAULT_COLUMN_ORDER) {
    if (!seen.has(key)) normalized.push(key);
  }

  return normalized;
};

export const normalizeColumnWidths = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length !== DEFAULT_COLUMN_WIDTHS.length) {
    return [...DEFAULT_COLUMN_WIDTHS];
  }

  return value.map((width, index) =>
    typeof width === 'number' && Number.isFinite(width)
      ? Math.max(COLUMN_MINIMUMS[index], width)
      : DEFAULT_COLUMN_WIDTHS[index]
  );
};

export const normalizeColumnAlignments = (value: unknown): Record<DownloadTableColumnKey, DownloadColumnAlignment> => {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<Record<DownloadTableColumnKey, unknown>>
    : {};

  return DEFAULT_COLUMN_ORDER.reduce((alignments, key) => {
    alignments[key] = isColumnAlignment(candidate[key])
      ? candidate[key]
      : DEFAULT_COLUMN_ALIGNMENTS[key];
    return alignments;
  }, {} as Record<DownloadTableColumnKey, DownloadColumnAlignment>);
};

export const columnIndex = (key: DownloadTableColumnKey): number =>
  DEFAULT_COLUMN_ORDER.indexOf(key);
