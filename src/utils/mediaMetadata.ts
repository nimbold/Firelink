import { invokeCommand as invoke } from '../ipc';
import type { MediaMetadata } from '../bindings/MediaMetadata';
import type { MediaPlaylistMetadata } from '../bindings/MediaPlaylistMetadata';

type FetchMediaMetadataArgs = {
  url: string;
  cookieFile: string | null;
  cookieBrowser: string | null;
  userAgent: string | null;
  username: string | null;
  password: string | null;
  headers: string | null;
  cookies: string | null;
  proxy: string | null;
};

const inFlightMediaMetadata = new Map<string, Promise<MediaMetadata>>();
const inFlightMediaPlaylists = new Map<string, Promise<MediaPlaylistMetadata>>();

const metadataKey = (args: FetchMediaMetadataArgs) =>
  JSON.stringify([
    args.url,
    args.cookieFile,
    args.cookieBrowser,
    args.userAgent,
    args.username,
    args.password,
    args.headers,
    args.cookies,
    args.proxy
  ]);

export const fetchMediaMetadataDeduped = (args: FetchMediaMetadataArgs): Promise<MediaMetadata> => {
  const key = metadataKey(args);
  const existing = inFlightMediaMetadata.get(key);
  if (existing) return existing;

  const request = invoke('fetch_media_metadata', args)
    .finally(() => {
      inFlightMediaMetadata.delete(key);
    });
  inFlightMediaMetadata.set(key, request);
  return request;
};

export const fetchMediaPlaylistMetadataDeduped = (
  args: FetchMediaMetadataArgs
): Promise<MediaPlaylistMetadata> => {
  const key = metadataKey(args);
  const existing = inFlightMediaPlaylists.get(key);
  if (existing) return existing;

  const request = invoke('fetch_media_playlist_metadata', args)
    .finally(() => {
      inFlightMediaPlaylists.delete(key);
    });
  inFlightMediaPlaylists.set(key, request);
  return request;
};
