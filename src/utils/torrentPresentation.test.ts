import { describe, expect, it } from 'vitest';
import { isTorrentWaitingForPeers } from './torrentPresentation';

describe('Torrent waiting presentation', () => {
  it('labels a zero-byte active Torrent with no connected peers or seeders', () => {
    expect(isTorrentWaitingForPeers({
      isTorrent: true,
      status: 'downloading',
      downloadedBytes: 0,
      fraction: 0,
      connectedPeers: 0,
      connectedSeeders: 0,
    })).toBe(true);
  });

  it('does not replace native status once bytes or peers exist', () => {
    expect(isTorrentWaitingForPeers({
      isTorrent: true,
      status: 'downloading',
      downloadedBytes: 1,
      connectedPeers: 0,
      connectedSeeders: 0,
    })).toBe(false);
    expect(isTorrentWaitingForPeers({
      isTorrent: true,
      status: 'downloading',
      downloadedBytes: 0,
      connectedPeers: 1,
      connectedSeeders: 0,
    })).toBe(false);
    expect(isTorrentWaitingForPeers({
      isTorrent: true,
      status: 'paused',
      downloadedBytes: 0,
      connectedPeers: 0,
      connectedSeeders: 0,
    })).toBe(false);
  });

  it('does not treat missing or malformed telemetry as confirmed zero peers', () => {
    expect(isTorrentWaitingForPeers({
      isTorrent: true,
      status: 'downloading',
      downloadedBytes: 0,
      connectedPeers: 0,
      connectedSeeders: undefined,
    })).toBe(false);
    expect(isTorrentWaitingForPeers({
      isTorrent: true,
      status: 'downloading',
      downloadedBytes: 0,
      connectedPeers: -1,
      connectedSeeders: 0,
    })).toBe(false);
  });
});
