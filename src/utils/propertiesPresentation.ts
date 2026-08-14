import type { PropertiesSnapshot } from '../propertiesBridge';
import { resolveDownloadFraction } from './downloadProgress';

export type PropertiesConnectionKind = 'media' | 'torrent' | 'aria2';
export type PropertiesConnectionLabelKey = 'fragmentConcurrency' | 'torrentConnectedPeers' | 'connections';
export type PropertiesTorrentPeerSummary = {
  totalPeers: number;
  totalSeeders: number;
};

export type PropertiesConnectionPresentation = {
  kind: PropertiesConnectionKind;
  showHeaderMetric: boolean;
  labelKey: PropertiesConnectionLabelKey;
  value: string;
  torrentPeerSummary?: PropertiesTorrentPeerSummary;
};

const displayCount = (value: number | undefined): string => value == null ? '—' : String(value);

export const getPropertiesProgress = (
  snapshot: Pick<PropertiesSnapshot, 'status' | 'moveProgress' | 'fraction' | 'downloadedBytes' | 'totalBytes' | 'totalIsEstimate' | 'isMedia' | 'size'>,
): number => snapshot.status === 'moving'
  ? Math.max(0, Math.min(1, snapshot.moveProgress ?? 0))
  : resolveDownloadFraction(snapshot);

export const getPropertiesConnectionPresentation = (
  snapshot: Pick<PropertiesSnapshot, 'isMedia' | 'isTorrent' | 'connections' | 'activeConnections' | 'requestedConnections'>,
  torrentPeerSummary?: PropertiesTorrentPeerSummary | null,
): PropertiesConnectionPresentation => {
  if (snapshot.isMedia === true) {
    return {
      kind: 'media',
      showHeaderMetric: false,
      labelKey: 'fragmentConcurrency',
      value: displayCount(snapshot.connections),
    };
  }

  if (snapshot.isTorrent === true) {
    return {
      kind: 'torrent',
      showHeaderMetric: true,
      labelKey: 'torrentConnectedPeers',
      value: '—',
      ...(torrentPeerSummary ? { torrentPeerSummary } : {}),
    };
  }

  return {
    kind: 'aria2',
    showHeaderMetric: true,
    labelKey: 'connections',
    value: `${displayCount(snapshot.activeConnections)} / ${displayCount(snapshot.requestedConnections ?? snapshot.connections)}`,
  };
};
