const TORRENT_PEER_SUMMARY_ACTIVE_STATUSES = [
  'downloading',
  'verifying',
  'seeding',
  'waitingToSeed',
  'retrying',
] as const;

export const isTorrentPeerSummaryStatus = (status: string): boolean =>
  (TORRENT_PEER_SUMMARY_ACTIVE_STATUSES as readonly string[]).includes(status);

export const isCurrentTorrentPeerSummary = ({
  currentDownloadId,
  requestDownloadId,
  currentLifecycleEpoch,
  requestLifecycleEpoch,
  currentStatus,
}: {
  currentDownloadId: string | null;
  requestDownloadId: string;
  currentLifecycleEpoch: number;
  requestLifecycleEpoch: number;
  currentStatus: string;
}): boolean => currentDownloadId === requestDownloadId
  && currentLifecycleEpoch === requestLifecycleEpoch
  && isTorrentPeerSummaryStatus(currentStatus);
