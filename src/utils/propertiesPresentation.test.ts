import { describe, expect, it } from 'vitest';
import { getPropertiesConnectionPresentation } from './propertiesPresentation';

describe('Properties connection presentation', () => {
  it('keeps media concurrency out of the live header metrics', () => {
    expect(getPropertiesConnectionPresentation({
      isMedia: true,
      isTorrent: false,
      connections: 16,
      activeConnections: 8,
      requestedConnections: 16,
    })).toEqual({
      kind: 'media',
      showHeaderMetric: false,
      labelKey: 'fragmentConcurrency',
      value: '16',
    });
  });

  it('keeps Aria2 active and requested connections together', () => {
    expect(getPropertiesConnectionPresentation({
      isMedia: false,
      isTorrent: false,
      connections: 8,
      activeConnections: 3,
      requestedConnections: 8,
    })).toEqual({
      kind: 'aria2',
      showHeaderMetric: true,
      labelKey: 'connections',
      value: '3 / 8',
    });
  });

  it('uses connected peers for Torrents', () => {
    expect(getPropertiesConnectionPresentation({
      isMedia: false,
      isTorrent: true,
      connectedPeers: 4,
    })).toEqual({
      kind: 'torrent',
      showHeaderMetric: true,
      labelKey: 'torrentConnectedPeers',
      value: '4',
    });
  });
});
