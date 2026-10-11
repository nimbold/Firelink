import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ipc', () => ({ invokeCommand: vi.fn() }));

import { invokeCommand } from '../ipc';
import {
  fetchMediaMetadataDeduped,
  fetchMediaPlaylistMetadataDeduped
} from './mediaMetadata';
import type { MediaMetadata } from '../bindings/MediaMetadata';
import type { MediaPlaylistMetadata } from '../bindings/MediaPlaylistMetadata';

describe('media metadata request deduplication', () => {
  beforeEach(() => {
    vi.mocked(invokeCommand).mockReset().mockImplementation(() => Promise.resolve({} as never));
  });

  it('keeps concurrent metadata requests for different browser profiles separate', async () => {
    const request = {
      url: 'https://example.com/watch?v=1',
      cookieFile: null,
      cookieBrowser: 'opera',
      cookieBrowserProfile: 'C:\\Users\\Nima\\Opera GX Stable',
      userAgent: null,
      username: null,
      password: null,
      headers: null,
      cookies: null,
      proxy: null
    };

    const firstProfileRequest = fetchMediaMetadataDeduped(request);
    const sameProfileRequest = fetchMediaMetadataDeduped({ ...request });
    const otherProfileRequest = fetchMediaMetadataDeduped({
      ...request,
      cookieBrowserProfile: 'C:\\Users\\Nima\\Opera Stable'
    });

    expect(sameProfileRequest).toBe(firstProfileRequest);
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledWith(
      'fetch_media_metadata',
      expect.objectContaining({ cookieBrowserProfile: request.cookieBrowserProfile })
    );
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledWith(
      'fetch_media_metadata',
      expect.objectContaining({ cookieBrowserProfile: 'C:\\Users\\Nima\\Opera Stable' })
    );
    await Promise.all([
      firstProfileRequest as Promise<MediaMetadata>,
      otherProfileRequest as Promise<MediaMetadata>
    ]);
  });

  it('keeps concurrent playlist requests for different browser profiles separate', async () => {
    const request = {
      url: 'https://example.com/playlist',
      cookieFile: null,
      cookieBrowser: 'opera',
      cookieBrowserProfile: 'C:\\Users\\Nima\\Opera GX Stable',
      userAgent: null,
      username: null,
      password: null,
      headers: null,
      cookies: null,
      proxy: null
    };

    const gxRequest = fetchMediaPlaylistMetadataDeduped(request);
    const stableRequest = fetchMediaPlaylistMetadataDeduped({
      ...request,
      cookieBrowserProfile: 'C:\\Users\\Nima\\Opera Stable'
    });

    expect(vi.mocked(invokeCommand)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledWith(
      'fetch_media_playlist_metadata',
      expect.objectContaining({ cookieBrowserProfile: request.cookieBrowserProfile })
    );
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledWith(
      'fetch_media_playlist_metadata',
      expect.objectContaining({ cookieBrowserProfile: 'C:\\Users\\Nima\\Opera Stable' })
    );
    await Promise.all([
      gxRequest as Promise<MediaPlaylistMetadata>,
      stableRequest as Promise<MediaPlaylistMetadata>
    ]);
  });
});
