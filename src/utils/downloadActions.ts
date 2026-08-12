import type { DownloadStatus } from '../bindings/DownloadStatus';

const STARTABLE_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'ready',
  'staged',
  'paused',
  'waitingToSeed',
  'failed',
]);

const PAUSABLE_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'staged',
  'queued',
  'downloading',
  'seeding',
  'waitingToSeed',
  'processing',
  'verifying',
  'retrying',
]);

const REDOWNLOADABLE_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'completed',
  'failed',
  'paused',
]);

export const canStartDownload = (status: DownloadStatus): boolean =>
  STARTABLE_STATUSES.has(status);

export const canPauseDownload = (status: DownloadStatus): boolean =>
  PAUSABLE_STATUSES.has(status);

export interface DownloadActionCounts {
  pause: number;
  resume: number;
}

/**
 * Count the actions that a bulk pause/resume control can actually apply.
 * Keep this derived from the same predicates used by the individual row
 * buttons so a badge never promises to affect an ineligible item.
 */
export const countDownloadActions = (
  downloads: ReadonlyArray<{ status: DownloadStatus }>
): DownloadActionCounts => downloads.reduce<DownloadActionCounts>((counts, download) => {
  if (canPauseDownload(download.status)) counts.pause += 1;
  if (download.status === 'paused'
    || (canStartDownload(download.status) && !canPauseDownload(download.status))) {
    counts.resume += 1;
  }
  return counts;
}, { pause: 0, resume: 0 });

export const formatDownloadActionCount = (count: number): string =>
  count > 99 ? '99+' : String(count);

export type PauseResumeAction = 'pause' | 'resume';

export const getPauseResumeAction = (status: DownloadStatus): PauseResumeAction | null => {
  if (canPauseDownload(status)) return 'pause';
  if (status === 'paused') return 'resume';
  return null;
};

export const canRedownload = (status: DownloadStatus): boolean =>
  REDOWNLOADABLE_STATUSES.has(status);

export const startActionLabel = (status: DownloadStatus): 'Start' | 'Resume' =>
  status === 'ready' || status === 'staged' || status === 'failed' ? 'Start' : 'Resume';

export const isTransferLocked = (status: DownloadStatus): boolean =>
  status === 'downloading' || status === 'processing' || status === 'verifying' || status === 'seeding' || status === 'waitingToSeed' || status === 'retrying' || status === 'moving';

export const isIdentityLocked = (status: DownloadStatus): boolean =>
  isTransferLocked(status) || status === 'completed';
