import type { PropertiesSnapshot } from '../propertiesBridge';

export type PropertiesConnectionKind = 'media' | 'torrent' | 'aria2';
export type PropertiesConnectionLabelKey = 'fragmentConcurrency' | 'torrentConnectedPeers' | 'connections';

export type PropertiesConnectionPresentation = {
  kind: PropertiesConnectionKind;
  showHeaderMetric: boolean;
  labelKey: PropertiesConnectionLabelKey;
  value: string;
};

const displayCount = (value: number | undefined): string => value == null ? '—' : String(value);

export const getPropertiesConnectionPresentation = (
  snapshot: Pick<PropertiesSnapshot, 'isMedia' | 'isTorrent' | 'connections' | 'activeConnections' | 'requestedConnections' | 'connectedPeers'>,
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
      value: displayCount(snapshot.connectedPeers),
    };
  }

  return {
    kind: 'aria2',
    showHeaderMetric: true,
    labelKey: 'connections',
    value: `${displayCount(snapshot.activeConnections)} / ${displayCount(snapshot.requestedConnections ?? snapshot.connections)}`,
  };
};
