const TORRENT_LIVE_STATUSES = [
  'downloading',
  'verifying',
  'seeding',
  'waitingToSeed',
  'retrying',
] as const;

export const isTorrentLiveStatus = (status: string): boolean =>
  (TORRENT_LIVE_STATUSES as readonly string[]).includes(status);
