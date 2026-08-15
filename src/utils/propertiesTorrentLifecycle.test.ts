import { describe, expect, it } from 'vitest';
import { isTorrentLiveStatus } from './propertiesTorrentLifecycle';

describe('Torrent live lifecycle', () => {
  it('identifies statuses with live Aria2 telemetry', () => {
    expect(isTorrentLiveStatus('downloading')).toBe(true);
    expect(isTorrentLiveStatus('retrying')).toBe(true);
    expect(isTorrentLiveStatus('paused')).toBe(false);
    expect(isTorrentLiveStatus('completed')).toBe(false);
    expect(isTorrentLiveStatus('seeding')).toBe(true);
  });
});
