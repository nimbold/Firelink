import { describe, expect, it } from 'vitest';
import { MediaExitRecoveryQueue } from './mediaExitRecovery';

describe('MediaExitRecoveryQueue', () => {
  it('defers interrupted media until the current exit attempt is canceled', () => {
    const recovery = new MediaExitRecoveryQueue();

    expect(recovery.collect(['media-a', 'media-a', 42], true)).toEqual([]);
    expect(recovery.collect(['media-b', null], true)).toEqual([]);
    expect(recovery.collect(['media-a'], false)).toEqual(['media-a', 'media-b']);
    expect(recovery.collect([], false)).toEqual([]);
  });
});
