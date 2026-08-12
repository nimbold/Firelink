import { describe, expect, it } from 'vitest';
import {
  canPauseDownload,
  canRedownload,
  canStartDownload,
  countDownloadActions,
  formatDownloadActionCount,
  getPauseResumeAction,
  isIdentityLocked,
  isTransferLocked,
  startActionLabel,
} from './downloadActions';

describe('download action policy', () => {
  it('allows queued items to be paused before their first dispatch', () => {
    expect(canStartDownload('staged')).toBe(true);
    expect(canPauseDownload('staged')).toBe(true);

    for (const status of ['ready', 'paused', 'failed'] as const) {
      expect(canStartDownload(status)).toBe(true);
      expect(canPauseDownload(status)).toBe(false);
    }
    for (const status of ['staged', 'queued', 'downloading', 'seeding', 'processing', 'verifying', 'retrying'] as const) {
      expect(canPauseDownload(status)).toBe(true);
    }
    for (const status of ['queued', 'downloading', 'processing', 'retrying'] as const) {
      expect(canStartDownload(status)).toBe(false);
    }
  });

  it('limits redownload to terminal or paused states', () => {
    expect(canRedownload('completed')).toBe(true);
    expect(canRedownload('failed')).toBe(true);
    expect(canRedownload('paused')).toBe(true);
    expect(canRedownload('downloading')).toBe(false);
    expect(canRedownload('seeding')).toBe(false);
  });

  it('only exposes pause or resume for the details-view toggle', () => {
    expect(getPauseResumeAction('queued')).toBe('pause');
    expect(getPauseResumeAction('downloading')).toBe('pause');
    expect(getPauseResumeAction('processing')).toBe('pause');
    expect(getPauseResumeAction('verifying')).toBe('pause');
    expect(getPauseResumeAction('seeding')).toBe('pause');
    expect(getPauseResumeAction('retrying')).toBe('pause');
    expect(getPauseResumeAction('paused')).toBe('resume');

    for (const status of ['ready', 'completed', 'failed'] as const) {
      expect(getPauseResumeAction(status)).toBeNull();
    }
    expect(getPauseResumeAction('staged')).toBe('pause');
  });

  it('provides consistent labels and edit locks', () => {
    expect(startActionLabel('ready')).toBe('Start');
    expect(startActionLabel('failed')).toBe('Start');
    expect(startActionLabel('paused')).toBe('Resume');
    expect(isTransferLocked('processing')).toBe(true);
    expect(isTransferLocked('seeding')).toBe(true);
    expect(isIdentityLocked('completed')).toBe(true);
    expect(isTransferLocked('completed')).toBe(false);
  });

  it('counts only eligible actions for a multi-selection', () => {
    const counts = countDownloadActions([
      { status: 'queued' },
      { status: 'downloading' },
      { status: 'paused' },
      { status: 'ready' },
      { status: 'staged' },
      { status: 'failed' },
      { status: 'completed' },
    ]);

    expect(counts).toEqual({ pause: 3, resume: 3 });
  });

  it('keeps large action badges compact without changing the accessible count', () => {
    expect(formatDownloadActionCount(2)).toBe('2');
    expect(formatDownloadActionCount(99)).toBe('99');
    expect(formatDownloadActionCount(100)).toBe('99+');
  });
});
