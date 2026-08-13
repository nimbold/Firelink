import { describe, expect, it } from 'vitest';
import { shouldApplyTorrentNetworkInputResult } from './torrentNetworkInput';

describe('Torrent network input request fencing', () => {
  it('rejects a response from an older request', () => {
    expect(shouldApplyTorrentNetworkInputResult(1, 2, 4, 4)).toBe(false);
  });

  it('rejects a response after the user edits the draft', () => {
    expect(shouldApplyTorrentNetworkInputResult(2, 2, 3, 4)).toBe(false);
  });

  it('accepts only the current request for the current draft', () => {
    expect(shouldApplyTorrentNetworkInputResult(3, 3, 5, 5)).toBe(true);
  });
});
