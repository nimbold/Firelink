import type { DownloadStatus } from '../bindings/DownloadStatus';

const STARTABLE_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'ready',
  'staged',
  'paused',
  'failed',
]);

const PAUSABLE_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'queued',
  'downloading',
  'processing',
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
  status === 'downloading' || status === 'processing' || status === 'retrying';

export const isIdentityLocked = (status: DownloadStatus): boolean =>
  isTransferLocked(status) || status === 'completed';
