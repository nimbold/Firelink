export type TorrentPeerWaitPresentationInput = {
  isTorrent?: boolean;
  status: string;
  downloadedBytes?: number | null;
  fraction?: number | null;
  connectedPeers?: number | null;
  connectedSeeders?: number | null;
};

/**
 * A Torrent with no payload or peers is still making legitimate progress
 * through peer discovery. This is a presentation-only label; the persisted
 * and native lifecycle status remains `downloading`.
 */
export const isTorrentWaitingForPeers = ({
  isTorrent,
  status,
  downloadedBytes,
  fraction,
  connectedPeers,
  connectedSeeders,
}: TorrentPeerWaitPresentationInput): boolean => {
  const isFiniteNonNegative = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

  // Missing telemetry is unknown, not zero. In particular, Aria2 can emit an
  // early progress snapshot before numSeeders is available; labelling that
  // snapshot as "Waiting for peers" would make a transient data gap look like
  // a confirmed peer-discovery state.
  if (!isFiniteNonNegative(downloadedBytes)
    || !isFiniteNonNegative(connectedPeers)
    || !isFiniteNonNegative(connectedSeeders)) {
    return false;
  }
  if (fraction !== undefined
    && fraction !== null
    && (!isFiniteNonNegative(fraction) || fraction > 0)) {
    return false;
  }

  return isTorrent === true
    && status === 'downloading'
    && downloadedBytes === 0
    && connectedPeers === 0
    && connectedSeeders === 0;
};
