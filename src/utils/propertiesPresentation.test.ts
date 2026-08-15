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

  it('shows effective Aria2 connections when the transfer is degraded', () => {
    expect(getPropertiesConnectionPresentation({
      isMedia: false,
      isTorrent: false,
      connections: 16,
      activeConnections: 1,
      requestedConnections: 16,
      effectiveConnections: 1,
    })).toMatchObject({
      kind: 'aria2',
      labelKey: 'connections',
      value: '1 / 1',
    });
  });

  it('does not use tellActive connections for the Torrent header', () => {
    expect(getPropertiesConnectionPresentation({
      isMedia: false,
      isTorrent: true,
    })).toEqual({
      kind: 'torrent',
      showHeaderMetric: true,
      labelKey: 'torrentPeersSeeders',
      value: '—',
      torrentPeerCounts: {
        connectedPeers: undefined,
        connectedSeeders: undefined,
      },
    });
  });

  it('uses live connected peer and seeder counts from the Properties snapshot', () => {
    expect(getPropertiesConnectionPresentation({
      isMedia: false,
      isTorrent: true,
      torrentConnectedPeers: 10,
      torrentConnectedSeeders: 2,
    })).toEqual({
      kind: 'torrent',
      showHeaderMetric: true,
      labelKey: 'torrentPeersSeeders',
      value: '—',
      torrentPeerCounts: {
        connectedPeers: 10,
        connectedSeeders: 2,
      },
    });
  });
});
