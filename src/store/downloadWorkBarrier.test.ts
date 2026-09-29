import { afterEach, describe, expect, it } from 'vitest';
import {
  beginDownloadWork,
  closeDownloadWorkAdmission,
  reopenDownloadWorkAdmission,
  resetDownloadWorkBarrierForTests,
  waitForPendingDownloadWork
} from './downloadWorkBarrier';

describe('download work exit barrier', () => {
  afterEach(() => resetDownloadWorkBarrierForTests());

  it('waits for every active Add transaction before allowing the final persistence flush', async () => {
    const releaseFirst = beginDownloadWork();
    const releaseSecond = beginDownloadWork();
    expect(releaseFirst).toBeTypeOf('function');
    expect(releaseSecond).toBeTypeOf('function');

    closeDownloadWorkAdmission();
    let barrierPassed = false;
    const barrier = waitForPendingDownloadWork().then(() => { barrierPassed = true; });

    releaseFirst?.();
    await Promise.resolve();
    expect(barrierPassed).toBe(false);
    releaseSecond?.();
    await barrier;
    expect(barrierPassed).toBe(true);
  });

  it('rejects new Add transactions while exiting and accepts them after cancellation', () => {
    closeDownloadWorkAdmission();
    expect(beginDownloadWork()).toBeNull();

    reopenDownloadWorkAdmission();
    const release = beginDownloadWork();
    expect(release).toBeTypeOf('function');
    release?.();
  });
});
