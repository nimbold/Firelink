import { describe, expect, it, vi } from 'vitest';
import type { DownloadItem } from './store/useDownloadStore';

vi.mock('./ipc', () => ({
  invokeCommand: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  emitTo: vi.fn(),
}));

import {
  applySecretPatch,
  beginExclusivePropertiesAction,
  createFrameCoalescer,
  getPropertiesLifecycleAction,
  sanitizePropertiesSnapshot,
} from './propertiesBridge';

describe('Properties window bridge', () => {
  it('sanitizes transfer secrets while preserving presence flags', () => {
    const item = {
      id: 'download-1',
      fileName: 'example.iso',
      url: 'https://example.test/file',
      password: 'password',
      cookies: 'sid=secret',
      headers: 'Authorization: Bearer secret',
      username: 'user',
      mirrors: 'https://user:secret@example.test/mirror',
    } as DownloadItem;

    const snapshot = sanitizePropertiesSnapshot(item, {
      theme: 'nord',
      fontFamily: 'inter',
      appFontSize: 'large',
      listRowDensity: 'compact',
      locale: 'fa',
    });

    expect(snapshot).not.toHaveProperty('password');
    expect(snapshot).not.toHaveProperty('cookies');
    expect(snapshot).not.toHaveProperty('headers');
    expect(snapshot).not.toHaveProperty('username');
    expect(snapshot).not.toHaveProperty('mirrors');
    expect(snapshot.hasPassword).toBe(true);
    expect(snapshot.hasCookies).toBe(true);
    expect(snapshot.hasHeaders).toBe(true);
    expect(snapshot.hasUsername).toBe(true);
    expect(snapshot.hasMirrors).toBe(true);
    expect(snapshot.appearance).toEqual({
      theme: 'nord',
      fontFamily: 'inter',
      appFontSize: 'large',
      listRowDensity: 'compact',
      locale: 'fa',
    });
  });

  it('projects the latest live telemetry without exposing secrets', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'torrent-1',
      fileName: 'example',
      url: 'https://example.test/file',
      status: 'seeding',
      category: 'Other',
      dateAdded: '',
      speed: '-',
      eta: '-',
      fraction: 0,
      uploadedBytes: 1,
      password: 'secret',
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, {
      progress: {
        id: 'torrent-1',
        fraction: 0.75,
        speed: '2 MiB/s',
        eta: '10s',
        size: '4 MiB',
        size_is_final: true,
        downloaded_bytes: 3,
        total_bytes: 4,
        total_is_estimate: false,
        active_connections: 4,
        requested_connections: 8,
        uploaded_bytes: 9,
        upload_speed: '1 MiB/s',
        num_seeders: 6,
        torrent_seeded_seconds: 12,
      },
      moveProgress: 0.5,
    });

    expect(snapshot).not.toHaveProperty('password');
    expect(snapshot).toMatchObject({
      fraction: 0.75,
      speed: '1 MiB/s',
      eta: '-',
      downloadedBytes: 3,
      totalBytes: 4,
      totalIsEstimate: false,
      activeConnections: 4,
      requestedConnections: 8,
      torrentUploadedBytes: 9,
      uploadSpeed: '1 MiB/s',
      torrentSeeders: 6,
      torrentSeededSeconds: 12,
      moveProgress: 0.5,
    });
  });

  it('applies explicit secret changes without conflating unchanged fields', () => {
    expect(applySecretPatch(undefined, 'existing')).toBe('existing');
    expect(applySecretPatch({ kind: 'unchanged' }, 'existing')).toBe('existing');
    expect(applySecretPatch({ kind: 'replace', value: 'new' }, 'existing')).toBe('new');
    expect(applySecretPatch({ kind: 'clear' }, 'existing')).toBeUndefined();
    expect(() => applySecretPatch({ kind: 'replace', value: 42 }, 'existing')).toThrow('Invalid secret value');
    expect(() => applySecretPatch({ kind: 'unexpected' }, 'existing')).toThrow('Invalid secret patch');
  });

  it('derives truthful lifecycle commands from the current status', () => {
    expect(getPropertiesLifecycleAction('downloading')).toBe('pause');
    expect(getPropertiesLifecycleAction('retrying')).toBe('pause');
    expect(getPropertiesLifecycleAction('paused')).toBe('resume');
    expect(getPropertiesLifecycleAction('ready')).toBe('start');
    expect(getPropertiesLifecycleAction('staged')).toBe('start');
    expect(getPropertiesLifecycleAction('failed')).toBe('retry');
    expect(getPropertiesLifecycleAction('completed')).toBeNull();
  });

  it('keeps the first action locked when a duplicate request is rejected', () => {
    const inFlight = new Set<string>();
    const release = beginExclusivePropertiesAction(inFlight, 'window:download');

    expect(() => beginExclusivePropertiesAction(inFlight, 'window:download'))
      .toThrow('Another Properties action is still in progress');
    expect(inFlight.has('window:download')).toBe(true);

    release();
    release();
    expect(inFlight.has('window:download')).toBe(false);
  });

  it('coalesces repeated snapshot requests to one callback per animation frame', () => {
    const frames = new Map<number, FrameRequestCallback>();
    const delivered: string[] = [];
    let nextHandle = 0;
    const coalescer = createFrameCoalescer(
      key => delivered.push(key),
      callback => {
        const handle = ++nextHandle;
        frames.set(handle, callback);
        return handle;
      },
      handle => {
        frames.delete(handle);
      },
    );

    coalescer.schedule('properties-1');
    coalescer.schedule('properties-1');
    coalescer.schedule('properties-2');
    expect(frames.size).toBe(2);
    for (const [handle, callback] of [...frames]) {
      frames.delete(handle);
      callback(0);
    }
    expect(delivered).toEqual(['properties-1', 'properties-2']);

    coalescer.schedule('properties-1');
    coalescer.cancelAll();
    expect(frames.size).toBe(0);
  });
});
