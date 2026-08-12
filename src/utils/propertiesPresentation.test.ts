import { describe, expect, it } from 'vitest';
import { getPropertiesConnectionPresentation, getPropertiesProgress } from './propertiesPresentation';

describe('Properties connection presentation', () => {
  it('uses move progress instead of the completed download fraction during relocation', () => {
    expect(getPropertiesProgress({
      status: 'moving',
      moveProgress: 0.42,
      fraction: 1,
      downloadedBytes: 100,
      totalBytes: 100,
      totalIsEstimate: false,
      isMedia: false,
      size: '100 B',
    })).toBe(0.42);
    expect(getPropertiesProgress({
      status: 'moving',
      moveProgress: 4,
      fraction: 0,
      isMedia: false,
    })).toBe(1);
    expect(getPropertiesProgress({
      status: 'moving',
      fraction: 1,
      downloadedBytes: 100,
      totalBytes: 100,
      isMedia: false,
    })).toBe(0);
  });

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
