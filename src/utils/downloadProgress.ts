export interface DownloadSizeDisplay {
  downloaded: string | null;
  total: string | null;
  unit: string | null;
  totalIsEstimate: boolean;
  fallback: string;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const isUsableByteCount = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const byteUnitIndex = (bytes: number): number => {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex;
};

const formatDownloadBytesInUnit = (bytes: number, unitIndex: number): string => {
  const value = bytes / 1024 ** unitIndex;
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value < 1024 && unitIndex === 0
    ? `${Math.round(value)}`
    : value.toFixed(precision);
};

export const formatDownloadBytes = (bytes: number): string => {
  const unitIndex = byteUnitIndex(bytes);
  return `${formatDownloadBytesInUnit(bytes, unitIndex)} ${BYTE_UNITS[unitIndex]}`;
};

export const formatDownloadTotal = (display: DownloadSizeDisplay): string =>
  display.total && display.unit
    ? `${display.totalIsEstimate ? '~' : ''}${display.total} ${display.unit}`
    : display.fallback;

export const resolveDownloadSizeDisplay = ({
  downloadedBytes,
  totalBytes,
  totalIsEstimate = false,
  fallbackSize
}: {
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  totalIsEstimate?: boolean;
  fallbackSize?: string | null;
}): DownloadSizeDisplay => ({
  downloaded: isUsableByteCount(downloadedBytes) && isUsableByteCount(totalBytes) && totalBytes > 0
    ? formatDownloadBytesInUnit(downloadedBytes, byteUnitIndex(totalBytes))
    : null,
  total: isUsableByteCount(totalBytes) && totalBytes > 0
    ? formatDownloadBytesInUnit(totalBytes, byteUnitIndex(totalBytes))
    : null,
  unit: isUsableByteCount(totalBytes) && totalBytes > 0
    ? BYTE_UNITS[byteUnitIndex(totalBytes)]
    : null,
  totalIsEstimate: Boolean(totalIsEstimate && isUsableByteCount(totalBytes) && totalBytes > 0),
  fallback: fallbackSize && fallbackSize !== '-' ? fallbackSize : 'Unknown'
});

export const downloadProgressColorClass = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'download-status-completed';
    case 'paused':
      return 'download-status-paused';
    case 'failed':
      return 'download-status-failed';
    case 'processing':
      return 'download-status-processing';
    case 'queued':
    case 'staged':
      return 'download-status-queued';
    case 'retrying':
      return 'download-status-retrying';
    default:
      return 'download-status-downloading';
  }
};
