export interface DownloadSizeDisplay {
  downloaded: string | null;
  total: string | null;
  unit: string | null;
  totalIsEstimate: boolean;
  fallback: string;
}

export type DownloadFractionInput = {
  fraction?: number | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  totalIsEstimate?: boolean | null;
  isMedia?: boolean | null;
  size?: string | null;
  status?: string | null;
};

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

const isUsableByteCount = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isUsableFraction = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const clampFraction = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Resolves the fraction shown by progress bars when a live fraction is not
 * available. Volatile fractions are intentionally omitted from persisted
 * downloads, but paused rows retain exact byte counters so their progress can
 * still be reconstructed after restart. Estimated media totals are excluded:
 * they describe a provisional denominator and must not become a false visual
 * claim about completion.
 */
export const resolveDownloadFraction = ({
  fraction,
  downloadedBytes,
  totalBytes,
  totalIsEstimate = false,
  isMedia = false,
  size,
  status
}: DownloadFractionInput): number => {
  if (status === 'completed') return 1;

  const storedFraction = isUsableFraction(fraction) ? fraction : undefined;
  if (storedFraction !== undefined && storedFraction > 0) return storedFraction;

  const hasEstimatedTotal = totalIsEstimate === true ||
    (isMedia === true && size?.trim().startsWith('~') === true);
  if (
    !hasEstimatedTotal &&
    isUsableByteCount(downloadedBytes) &&
    isUsableByteCount(totalBytes) &&
    totalBytes > 0
  ) {
    return clampFraction(downloadedBytes / totalBytes);
  }

  return storedFraction ?? 0;
};

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

export const formatTorrentDuration = (seconds: number, locale: string): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const rounded = Math.round(seconds);
  const unit = (value: number, name: 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value);
  if (rounded >= 3600) {
    return `${unit(Math.floor(rounded / 3600), 'hour')} ${unit(Math.floor((rounded % 3600) / 60), 'minute')}`;
  }
  if (rounded >= 60) {
    return `${unit(Math.floor(rounded / 60), 'minute')} ${unit(rounded % 60, 'second')}`;
  }
  return unit(rounded, 'second');
};

export const formatTorrentRatio = (uploadedBytes: number, denominatorBytes: number, locale: string): string => {
  if (!Number.isFinite(uploadedBytes) || uploadedBytes < 0 || !Number.isFinite(denominatorBytes) || denominatorBytes <= 0) {
    return '—';
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  }).format(uploadedBytes / denominatorBytes);
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
    case 'moving':
      return 'download-status-processing';
    case 'verifying':
      return 'download-status-processing';
    case 'seeding':
      return 'download-status-seeding';
    case 'queued':
    case 'staged':
      return 'download-status-queued';
    case 'retrying':
      return 'download-status-retrying';
    default:
      return 'download-status-downloading';
  }
};
