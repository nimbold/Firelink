import type { DownloadItem } from '../bindings/DownloadItem';

export type DownloadSortColumn = 'File Name' | 'Size' | 'Status' | 'Speed' | 'ETA' | 'Date Added';
export type DownloadSortDirection = 'asc' | 'desc';

export type DownloadSortConfig = {
  column: DownloadSortColumn;
  direction: DownloadSortDirection;
};

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  KIB: 1024,
  MB: 1024 ** 2,
  MIB: 1024 ** 2,
  GB: 1024 ** 3,
  GIB: 1024 ** 3,
  TB: 1024 ** 4,
  TIB: 1024 ** 4,
};

const valueOrNull = (value?: string): string | null => {
  let trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('~') || trimmed.startsWith('≈')) {
    trimmed = trimmed.slice(1).trim();
  }
  return trimmed && trimmed !== '-' && !/^unknown$/i.test(trimmed) ? trimmed : null;
};

const parseUnitValue = (value?: string, units = SIZE_UNITS): number | null => {
  const normalized = valueOrNull(value);
  if (!normalized) return null;
  const match = normalized.match(/^([\d.,]+)\s*([KMGT]?I?B)(?:\/s)?$/i);
  if (!match) {
    const number = Number(normalized.replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  const amount = Number(match[1].replace(/,/g, ''));
  const multiplier = units[match[2].toUpperCase()];
  return Number.isFinite(amount) && multiplier ? amount * multiplier : null;
};

export const parseDownloadSize = (value?: string): number | null => parseUnitValue(value);

export const resolveSortableSize = (download: DownloadItem): number | null => {
  if (typeof download.totalBytes === 'number' && Number.isFinite(download.totalBytes) && download.totalBytes > 0) {
    return download.totalBytes;
  }
  if (download.status === 'completed' && typeof download.downloadedBytes === 'number' && Number.isFinite(download.downloadedBytes) && download.downloadedBytes > 0) {
    return download.downloadedBytes;
  }
  return parseDownloadSize(download.size);
};

export const parseDownloadSpeed = (value?: string): number | null =>
  parseUnitValue(value, SIZE_UNITS);

export const parseDownloadEta = (value?: string): number | null => {
  const normalized = valueOrNull(value);
  if (!normalized) return null;

  const clockParts = normalized.split(':').map(part => Number(part));
  if (clockParts.length >= 2 && clockParts.every(Number.isFinite)) {
    return clockParts.reduce((total, part, index) => total + part * 60 ** (clockParts.length - index - 1), 0);
  }

  let seconds = 0;
  let matched = false;
  for (const [pattern, multiplier] of [[/(\d+(?:\.\d+)?)h/i, 3600], [/(\d+(?:\.\d+)?)m/i, 60], [/(\d+(?:\.\d+)?)s/i, 1]] as const) {
    const match = normalized.match(pattern);
    if (match) {
      seconds += Number(match[1]) * multiplier;
      matched = true;
    }
  }
  return matched && Number.isFinite(seconds) ? seconds : null;
};

const compareValues = (
  left: string | number | null,
  right: string | number | null,
  direction: DownloadSortDirection
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const comparison = typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
  return direction === 'asc' ? comparison : -comparison;
};

const parseDownloadDate = (value?: string): number | null => {
  if (!value?.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const sortDownloads = (downloads: DownloadItem[], config: DownloadSortConfig): DownloadItem[] => {
  const sorted = [...downloads].sort((left, right) => {
    let comparison: number;
    switch (config.column) {
      case 'File Name':
        comparison = compareValues(left.fileName || left.url, right.fileName || right.url, config.direction);
        break;
      case 'Size':
        comparison = compareValues(resolveSortableSize(left), resolveSortableSize(right), config.direction);
        break;
      case 'Status':
        comparison = compareValues(left.status, right.status, config.direction);
        break;
      case 'Speed':
        comparison = compareValues(parseDownloadSpeed(left.speed), parseDownloadSpeed(right.speed), config.direction);
        break;
      case 'ETA':
        comparison = compareValues(parseDownloadEta(left.eta), parseDownloadEta(right.eta), config.direction);
        break;
      case 'Date Added':
        comparison = compareValues(parseDownloadDate(left.dateAdded), parseDownloadDate(right.dateAdded), config.direction);
        break;
    }

    if (comparison === 0) comparison = left.id.localeCompare(right.id);
    return comparison;
  });
  return sorted;
};
