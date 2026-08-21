import { describe, expect, it } from 'vitest';
import { createEngineStatusRequestTracker } from './engineStatusRequests';

describe('engine status request tracker', () => {
  it('invalidates an older result for the same engine after a forced recheck', () => {
    const tracker = createEngineStatusRequestTracker();
    const first = tracker.begin('aria2');
    const second = tracker.begin('aria2');

    expect(tracker.isCurrent('aria2', first)).toBe(false);
    expect(tracker.isCurrent('aria2', second)).toBe(true);
  });

  it('keeps independent engine checks current independently', () => {
    const tracker = createEngineStatusRequestTracker();
    const aria2 = tracker.begin('aria2');
    const ytdlp = tracker.begin('ytdlp');

    expect(tracker.isCurrent('aria2', aria2)).toBe(true);
    expect(tracker.isCurrent('ytdlp', ytdlp)).toBe(true);
  });
});
