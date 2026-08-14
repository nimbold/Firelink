import { describe, expect, it } from 'vitest';
import { isCurrentTorrentPeerSummary, isTorrentPeerSummaryStatus } from './propertiesPeerSummary';

describe('Torrent peer summary lifecycle', () => {
  it('accepts only the current active Torrent lifecycle', () => {
    const request = {
      currentDownloadId: 'torrent-1',
      requestDownloadId: 'torrent-1',
      currentLifecycleEpoch: 8,
      requestLifecycleEpoch: 8,
      currentStatus: 'downloading',
    };
    expect(isCurrentTorrentPeerSummary(request)).toBe(true);
    expect(isCurrentTorrentPeerSummary({ ...request, currentLifecycleEpoch: 9 })).toBe(false);
    expect(isCurrentTorrentPeerSummary({ ...request, requestDownloadId: 'torrent-2' })).toBe(false);
  });

  it('stops live summary polling for paused and completed lifecycles', () => {
    expect(isTorrentPeerSummaryStatus('paused')).toBe(false);
    expect(isTorrentPeerSummaryStatus('completed')).toBe(false);
    expect(isTorrentPeerSummaryStatus('seeding')).toBe(true);
  });
});
