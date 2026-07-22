import type { DownloadItem } from '../bindings/DownloadItem';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';
import { isTransferActiveStatus } from './downloads';

export interface DownloadSummary {
  itemCount: number;
  activeCount: number;
  downloadedBytes: number | null;
  remainingBytes: number | null;
  remainingIsEstimated: boolean;
}

type ProgressMap = Readonly<Record<string, DownloadProgressEvent | undefined>>;

const usableBytes = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const isFreshDownloadStatus = (status: DownloadItem['status']): boolean =>
  status === 'ready' ||
  status === 'staged' ||
  status === 'queued' ||
  status === 'downloading' ||
  status === 'processing' ||
  status === 'retrying';

const hasPositiveProgress = (download: DownloadItem): boolean =>
  typeof download.fraction === 'number' &&
  Number.isFinite(download.fraction) &&
  download.fraction > 0;

const canInferNoDownloadedBytes = (download: DownloadItem): boolean =>
  !hasPositiveProgress(download) &&
  (isFreshDownloadStatus(download.status) || download.status === 'paused');

const effectiveByteState = (
  download: DownloadItem,
  progress: DownloadProgressEvent | undefined
): { downloadedBytes?: number; totalBytes?: number; totalIsEstimate: boolean } => {
  const usesStoredMediaTotal = download.isMedia === true && progress && !progress.size_is_final;
  const storedTotalIsEstimate = download.totalIsEstimate === true ||
    download.size?.trim().startsWith('~') === true;
  const totalBytes = usesStoredMediaTotal
    ? usableBytes(download.totalBytes)
    : usableBytes(progress?.total_bytes) ?? usableBytes(download.totalBytes);
  const downloadedBytes =
    usableBytes(progress?.downloaded_bytes) ??
    usableBytes(download.downloadedBytes) ??
    (download.status === 'completed' ? totalBytes : undefined) ??
    (canInferNoDownloadedBytes(download) ? 0 : undefined);
  const totalIsEstimate = usesStoredMediaTotal
    ? storedTotalIsEstimate
    : (progress?.total_is_estimate ?? storedTotalIsEstimate) === true;

  return { downloadedBytes, totalBytes, totalIsEstimate };
};

export const summarizeDownloads = (
  downloads: readonly DownloadItem[],
  progressMap: ProgressMap = {}
): DownloadSummary => {
  if (downloads.length === 0) {
    return {
      itemCount: 0,
      activeCount: 0,
      downloadedBytes: null,
      remainingBytes: null,
      remainingIsEstimated: false,
    };
  }

  let downloadedBytes = 0;
  let remainingBytes = 0;
  let downloadedKnown = true;
  let remainingKnown = true;
  let remainingIsEstimated = false;
  let activeCount = 0;

  for (const download of downloads) {
    const state = effectiveByteState(download, progressMap[download.id]);
    if (isTransferActiveStatus(download.status)) activeCount += 1;
    if (state.downloadedBytes === undefined) {
      downloadedKnown = false;
    } else {
      const nextDownloadedBytes = downloadedBytes + state.downloadedBytes;
      if (Number.isFinite(nextDownloadedBytes)) {
        downloadedBytes = nextDownloadedBytes;
      } else {
        downloadedKnown = false;
      }
    }

    if (
      state.totalBytes === undefined ||
      state.downloadedBytes === undefined ||
      state.downloadedBytes > state.totalBytes
    ) {
      remainingKnown = false;
    } else {
      const nextRemainingBytes = remainingBytes + Math.max(0, state.totalBytes - state.downloadedBytes);
      if (Number.isFinite(nextRemainingBytes)) {
        remainingBytes = nextRemainingBytes;
        remainingIsEstimated ||= state.totalIsEstimate;
      } else {
        remainingKnown = false;
      }
    }
  }

  return {
    itemCount: downloads.length,
    activeCount,
    downloadedBytes: downloadedKnown ? downloadedBytes : null,
    remainingBytes: remainingKnown ? remainingBytes : null,
    remainingIsEstimated,
  };
};
