import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDownloadListener, useDownloadProgressStore } from './downloadStore';
import {
  clearDownloadControlIntents,
  initializeDownloadPersistence,
  downloadControlIntentFor,
  setDownloadControlIntent,
  useDownloadStore
} from './useDownloadStore';
import * as ipc from '../ipc';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(),
  listenEvent: vi.fn(),
}));

describe('useDownloadProgressStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined);
    useDownloadProgressStore.setState({ progressMap: {}, retainedProgressMap: {}, moveProgressMap: {} });
    clearDownloadControlIntents();
  });

  it('prunes terminal progress entries', () => {
    useDownloadProgressStore.getState().updateDownloadProgress('download-1', {
      id: 'download-1',
      fraction: 0.5,
      speed: '1 MB/s',
      eta: '10s',
      size: '2 MB',
      size_is_final: false
    });

    useDownloadProgressStore.getState().clearDownloadProgress('download-1');

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
  });

  it('shares listener setup across overlapping consumers and tears down after the last release', async () => {
    const unlisten = vi.fn();
    vi.mocked(ipc.listenEvent).mockResolvedValue(unlisten);

    const first = initDownloadListener();
    const second = initDownloadListener();

    expect(ipc.listenEvent).toHaveBeenCalledTimes(5);

    const releaseFirst = await first;
    const releaseSecond = await second;
    releaseFirst();
    expect(unlisten).not.toHaveBeenCalled();

    releaseSecond();
    expect(unlisten).toHaveBeenCalledTimes(5);
  });

  it('ignores late progress and opposite terminal events from an older lifecycle', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'terminal',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'completed',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'terminal',
      fraction: 0.1,
      speed: '1 MB/s',
      eta: '10s',
      size: '1 MB',
      size_is_final: false
    } });
    handlers['download-state']({ payload: {
      id: 'terminal',
      status: 'failed',
      error: 'stale failure'
    } });

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    expect(useDownloadStore.getState().downloads[0].status).toBe('completed');
    release();
  });

  it('ignores malformed state events instead of projecting an unknown status', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'malformed-state',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'malformed-state',
      status: 'not-a-download-status',
      error: { secret: 'must not enter the store' }
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      id: 'malformed-state',
      status: 'downloading'
    });
    expect(useDownloadStore.getState().downloads[0]).not.toHaveProperty('lastError');
    release();
  });

  it('removes a row from backend pending order when its lifecycle becomes active or retrying', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'pending-transition',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }],
      pendingOrder: ['pending-transition']
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'pending-transition',
      status: 'downloading'
    } });
    expect(useDownloadStore.getState().pendingOrder).toEqual([]);

    useDownloadStore.getState().updateDownload('pending-transition', { status: 'downloading' });
    useDownloadStore.setState({ pendingOrder: ['pending-transition'] });
    handlers['download-state']({ payload: {
      id: 'pending-transition',
      status: 'retrying',
      error: 'network dropped'
    } });
    expect(useDownloadStore.getState().pendingOrder).toEqual([]);
    release();
  });

  it('rejects malformed live progress values at the event boundary', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'malformed-progress',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'malformed-progress',
      fraction: 0.5,
      speed: '1 MB/s',
      eta: '1s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: -1,
      total_bytes: Number.NaN,
      active_connections: -2
    } });

    expect(useDownloadProgressStore.getState().progressMap['malformed-progress'])
      .not.toHaveProperty('downloaded_bytes');
    expect(useDownloadProgressStore.getState().progressMap['malformed-progress'])
      .not.toHaveProperty('total_bytes');
    expect(useDownloadStore.getState().downloads[0]).not.toHaveProperty('downloadedBytes');
    expect(useDownloadStore.getState().downloads[0]).not.toHaveProperty('totalBytes');
    release();
  });

  it('accepts a progress frame that omits the optional size value', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'omitted-size',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'omitted-size',
      fraction: 0.25,
      speed: '1 MB/s',
      eta: '1s',
      size_is_final: false
    } });

    expect(useDownloadProgressStore.getState().progressMap['omitted-size'])
      .toMatchObject({ id: 'omitted-size', fraction: 0.25, size: null });
    release();
  });

  it('keeps the last valid live frame when a malformed fraction arrives', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'invalid-fraction',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'invalid-fraction',
      fraction: 0.4,
      speed: '1 MB/s',
      eta: '1s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: 400
    } });
    handlers['download-progress']({ payload: {
      id: 'invalid-fraction',
      fraction: 2,
      speed: '2 MB/s',
      eta: '0s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: 2000
    } });

    expect(useDownloadProgressStore.getState().progressMap['invalid-fraction'])
      .toMatchObject({ fraction: 0.4, downloaded_bytes: 400 });
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      fraction: 0.4,
      downloadedBytes: 400
    });
    release();
  });

  it('projects native allocation events after admission and ignores stale generations', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'native-allocation',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-allocation']({ payload: {
      id: 'native-allocation',
      pending: true,
      lifecycleGeneration: 'not-a-generation'
    } });
    expect(useDownloadStore.getState().allocationPendingIds.has('native-allocation')).toBe(false);

    handlers['download-allocation']({ payload: {
      id: 'native-allocation',
      pending: true,
      lifecycleGeneration: '0'
    } });
    expect(useDownloadStore.getState().allocationPendingIds.has('native-allocation')).toBe(true);

    handlers['download-allocation']({ payload: {
      id: 'native-allocation',
      pending: false,
      lifecycleGeneration: '1'
    } });
    expect(useDownloadStore.getState().allocationPendingIds.has('native-allocation')).toBe(true);

    handlers['download-allocation']({ payload: {
      id: 'native-allocation',
      pending: false,
      lifecycleGeneration: '0'
    } });
    expect(useDownloadStore.getState().allocationPendingIds.has('native-allocation')).toBe(false);
    release();
  });

  it('retains a native allocation marker received before row hydration', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [],
      allocationPendingIds: new Set()
    });

    const release = await initDownloadListener();
    handlers['download-allocation']({ payload: {
      id: 'hydrating-allocation',
      pending: true,
      lifecycleGeneration: '0'
    } });

    expect(useDownloadStore.getState().allocationPendingIds.has('hydrating-allocation')).toBe(true);

    useDownloadStore.setState({
      downloads: [{
        id: 'hydrating-allocation',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });
    expect(useDownloadStore.getState().allocationPendingIds.has('hydrating-allocation')).toBe(true);

    handlers['download-allocation']({ payload: {
      id: 'hydrating-allocation',
      pending: false,
      lifecycleGeneration: '0'
    } });
    expect(useDownloadStore.getState().allocationPendingIds.has('hydrating-allocation')).toBe(false);
    release();
  });

  it('applies the authoritative destination carried by Torrent move completion', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'moving-torrent',
        url: 'magnet:?xt=urn:btih:test',
        fileName: 'data',
        destination: '/old-root',
        status: 'moving',
        category: 'Other',
        dateAdded: '',
        isTorrent: true,
      }],
    });
    useDownloadProgressStore.getState().setMoveProgress('moving-torrent', 0.8);

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'moving-torrent',
      status: 'paused',
      error: 'stale pause from the previous lifecycle',
    } });

    expect(useDownloadStore.getState().downloads[0].status).toBe('moving');
    expect(useDownloadProgressStore.getState().moveProgressMap['moving-torrent']).toBe(0.8);

    handlers['download-state']({ payload: {
      id: 'moving-torrent',
      status: 'completed',
      error: null,
      destination: '/new-root',
    } });

    expect(useDownloadStore.getState().downloads[0].destination).toBe('/new-root');
    expect(useDownloadStore.getState().downloads[0].status).toBe('completed');
    expect(useDownloadProgressStore.getState().moveProgressMap['moving-torrent']).toBeUndefined();
    release();
  });

  it('invalidates replacement authorization when a native state event changes identity', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'native-identity-change',
        url: 'https://example.com/file.bin',
        fileName: 'old.bin',
        status: 'staged',
        category: 'Other',
        dateAdded: '',
        replaceExistingFingerprint: 'original-target-fingerprint',
      }],
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'native-identity-change',
      status: 'ready',
      error: null,
      fileName: 'new.bin',
    } });

    expect(useDownloadStore.getState().downloads[0].fileName).toBe('new.bin');
    expect(useDownloadStore.getState().downloads[0].replaceExistingFingerprint).toBeUndefined();
    release();
  });

  it('keeps Aria2 connection telemetry from the live progress event', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'connection-telemetry',
        url: 'https://github.com/example/release.zip',
        fileName: 'release.zip',
        status: 'downloading',
        category: 'Compressed',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'connection-telemetry',
      fraction: 0.2,
      speed: '3 MB/s',
      eta: '10s',
      size: '38 MB',
      size_is_final: false,
      active_connections: 16,
      requested_connections: 16
    } });

    expect(useDownloadProgressStore.getState().progressMap['connection-telemetry'])
      .toMatchObject({ active_connections: 16, requested_connections: 16 });
    release();
  });

  it('projects resolver error metadata and clears it when the lifecycle resumes', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'resolver-error',
        url: 'https://example.test/file',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: '',
      }],
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'resolver-error',
      status: 'retrying',
      error: 'aria2 error code 19: Name resolution failed',
      errorKind: 'nameResolution',
      resolverFallback: true,
    } });
    expect(useDownloadStore.getState().downloads[0].lastErrorKind).toBe('nameResolution');
    expect(useDownloadStore.getState().downloads[0].lastResolverFallback).toBe(true);

    handlers['download-state']({ payload: {
      id: 'resolver-error',
      status: 'downloading',
      error: null,
    } });
    expect(useDownloadStore.getState().downloads[0].lastErrorKind).toBeUndefined();
    expect(useDownloadStore.getState().downloads[0].lastResolverFallback).toBeUndefined();
    release();
  });

  it('projects torrent seeding state and upload telemetry', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'torrent-seeding',
        url: 'magnet:?xt=urn:btih:test',
        fileName: 'ubuntu.iso',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'torrent-seeding',
      status: 'seeding'
    } });
    handlers['download-progress']({ payload: {
      id: 'torrent-seeding',
      fraction: 1,
      speed: '0 B/s',
      eta: '-',
      size: '2 GB',
      size_is_final: false,
      uploaded_bytes: 1048576,
      upload_speed: '512 KiB/s',
      num_seeders: 4,
      active_connections: 6,
      requested_connections: 8
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'seeding',
      fraction: 1,
      speed: '512 KiB/s',
      eta: '-'
    });
    expect(useDownloadProgressStore.getState().progressMap['torrent-seeding'])
      .toMatchObject({ uploaded_bytes: 1048576, upload_speed: '512 KiB/s', num_seeders: 4 });
    release();
  });

  it('does not regress a seeding row from a delayed active state event', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'torrent-seeding-race',
        url: 'magnet:?xt=urn:btih:test',
        fileName: 'ubuntu.iso',
        status: 'seeding',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'torrent-seeding-race',
      status: 'downloading'
    } });
    handlers['download-state']({ payload: {
      id: 'torrent-seeding-race',
      status: 'queued'
    } });

    expect(useDownloadStore.getState().downloads[0].status).toBe('seeding');
    release();
  });

  it('accepts Torrent verification while a row is seeding', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'torrent-seeding-verification',
        url: 'magnet:?xt=urn:btih:test',
        fileName: 'ubuntu.iso',
        status: 'seeding',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'torrent-seeding-verification',
      status: 'verifying'
    } });

    expect(useDownloadStore.getState().downloads[0].status).toBe('verifying');
    release();
  });

  it('durably acknowledges a completed Torrent verification before clearing its marker', async () => {
    const handlers: Record<string, (event: any) => unknown> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => unknown;
      return Promise.resolve(vi.fn());
    });
    const persistedMarkers: Array<boolean | undefined> = [];
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: any) => {
      if (command === 'db_commit_download_state') {
        const records = JSON.parse(args.downloadsData) as Array<{ torrentVerifyOnly?: boolean }>;
        persistedMarkers.push(records[0]?.torrentVerifyOnly);
      }
      return undefined;
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'torrent-verification-ack',
        url: 'magnet:?xt=urn:btih:test',
        fileName: 'ubuntu.iso',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        isTorrent: true,
        torrentVerifyOnly: true,
        torrentVerifyRestoreStatus: 'paused'
      }] as any[]
    });
    const disposePersistence = initializeDownloadPersistence('main');

    try {
      const release = await initDownloadListener();
      await handlers['download-state']({ payload: {
        id: 'torrent-verification-ack',
        status: 'paused'
      } });

      expect(persistedMarkers).toEqual([true, undefined]);
      expect(useDownloadStore.getState().downloads[0].torrentVerifyOnly).toBeUndefined();
      release();
    } finally {
      disposePersistence();
    }
  });

  it('clears progress when events arrive after a download row was removed', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadProgressStore.getState().updateDownloadProgress('removed', {
      id: 'removed',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false
    });
    useDownloadStore.setState({ downloads: [] });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'removed',
      fraction: 0.9,
      speed: '2 MB/s',
      eta: '1s',
      size: '9 MB',
      size_is_final: false
    } });

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    release();
  });

  it('drops stale progress when a download returns to a queued lifecycle', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'reused',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'reused',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false
    } });
    handlers['download-state']({ payload: {
      id: 'reused',
      status: 'queued'
    } });
    handlers['download-progress']({ payload: {
      id: 'reused',
      fraction: 0.9,
      speed: '2 MB/s',
      eta: '1s',
      size: '9 MB',
      size_is_final: false
    } });

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    release();
  });

  it('snapshots live progress before clearing it on a terminal transition', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'snapshot',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'snapshot',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false,
      downloaded_bytes: 8192,
      total_bytes: 10240,
      total_is_estimate: true
    } });
    handlers['download-state']({ payload: {
      id: 'snapshot',
      status: 'paused'
    } });

    const row = useDownloadStore.getState().downloads[0];
    expect(row.status).toBe('paused');
    expect(row.fraction).toBe(0.8);
    expect(row.downloadedBytes).toBe(8192);
    expect(row.totalBytes).toBe(10240);
    expect(row.totalIsEstimate).toBe(true);
    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    expect(useDownloadProgressStore.getState().retainedProgressMap.snapshot).toMatchObject({
      fraction: 0.8,
      downloaded_bytes: 8192,
      total_bytes: 10240
    });
    release();
  });

  it('retains progress for failed and paused rows when the live entry is absent', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'terminal-progress',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'terminal-progress',
      fraction: 0.7,
      speed: '1 MB/s',
      eta: '2s',
      size: '10 MB',
      size_is_final: false,
      downloaded_bytes: 7000,
      total_bytes: 10000,
      total_is_estimate: false
    } });
    handlers['download-state']({ payload: {
      id: 'terminal-progress',
      status: 'paused',
    } });
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'paused',
      fraction: 0.7,
      downloadedBytes: 7000
    });

    useDownloadStore.setState(state => ({
      downloads: state.downloads.map(download => ({ ...download, status: 'downloading' as const }))
    }));
    handlers['download-state']({ payload: {
      id: 'terminal-progress',
      status: 'failed',
      error: 'network stopped',
      progress: {
        fraction: 0.8,
        downloadedBytes: 8000,
        totalBytes: 10000,
        totalIsEstimate: false
      }
    } });
    expect(useDownloadProgressStore.getState().progressMap['terminal-progress']).toBeUndefined();
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'failed',
      fraction: 0.8,
      downloadedBytes: 8000,
      totalBytes: 10000,
      totalIsEstimate: false
    });
    release();
  });

  it('keeps retained bytes when a paused GID resumes through a queued state', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'same-gid-resume',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'same-gid-resume',
      fraction: 0.6,
      speed: '1 MB/s',
      eta: '4s',
      size: '10 KB',
      size_is_final: false,
      downloaded_bytes: 6000,
      total_bytes: 10000,
      total_is_estimate: false
    } });
    useDownloadStore.setState(state => ({
      downloads: state.downloads.map(download => ({
        ...download,
        status: 'queued' as const
      }))
    }));
    handlers['download-state']({ payload: {
      id: 'same-gid-resume',
      status: 'queued'
    } });

    expect(useDownloadProgressStore.getState().progressMap['same-gid-resume']).toBeUndefined();
    expect(useDownloadProgressStore.getState().retainedProgressMap['same-gid-resume']).toMatchObject({
      downloaded_bytes: 6000,
      total_bytes: 10000
    });
    release();
  });

  it('keeps the greatest retained byte count across retry frames', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'retry-progress',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    const progress = (fraction: number, downloadedBytes: number) => handlers['download-progress']({ payload: {
      id: 'retry-progress',
      fraction,
      speed: '1 MB/s',
      eta: '2s',
      size: '10 KB',
      size_is_final: false,
      downloaded_bytes: downloadedBytes,
      total_bytes: 10000,
      total_is_estimate: false
    } });
    progress(0.8, 8000);
    handlers['download-state']({ payload: {
      id: 'retry-progress',
      status: 'retrying',
      error: 'network dropped'
    } });
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'retrying',
      fraction: 0.8,
      downloadedBytes: 8000,
      totalBytes: 10000,
      totalIsEstimate: false
    });
    useDownloadStore.getState().updateDownload('retry-progress', { status: 'downloading' });
    progress(0.1, 1000);
    handlers['download-state']({ payload: {
      id: 'retry-progress',
      status: 'failed',
      error: 'retry exhausted'
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      fraction: 0.8,
      downloadedBytes: 8000,
      totalBytes: 10000,
      totalIsEstimate: false
    });
    release();
  });

  it('drops a persisted temporary media estimate when fragmented progress has no total', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'stale-media-estimate',
        url: 'https://youtube.com/watch?v=stale',
        fileName: 'video.mkv',
        status: 'downloading',
        category: 'Movies',
        dateAdded: '',
        isMedia: true,
        downloadedBytes: 11989,
        totalBytes: 1024,
        totalIsEstimate: true,
        size: '~85.7 MB'
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'stale-media-estimate',
      fraction: 0.38,
      speed: '2.7 MB/s',
      eta: '7s',
      size: null,
      size_is_final: false,
      downloaded_bytes: 13000,
      total_bytes: null,
      total_is_estimate: null
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      downloadedBytes: 13000,
      size: undefined
    });
    expect(useDownloadStore.getState().downloads[0].totalBytes).toBeUndefined();
    expect(useDownloadStore.getState().downloads[0].totalIsEstimate).toBeUndefined();
    release();
  });

  it('removes a stale tiny media size after restart when byte counters were volatile', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'stale-media-size',
        url: 'https://youtube.com/watch?v=stale-size',
        fileName: 'video.mkv',
        status: 'downloading',
        category: 'Movies',
        dateAdded: '',
        isMedia: true,
        size: '~1.00 KB'
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'stale-media-size',
      fraction: 0.01,
      speed: '2.7 MB/s',
      eta: '7s',
      size: null,
      size_is_final: false,
      downloaded_bytes: 2048,
      total_bytes: null,
      total_is_estimate: null
    } });

    expect(useDownloadStore.getState().downloads[0].size).toBeUndefined();
    release();
  });

  it('ignores stale active state events after pause but accepts terminal reconciliation', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'paused-race',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'paused-race',
      status: 'downloading'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');

    handlers['download-state']({ payload: {
      id: 'paused-race',
      status: 'completed'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('completed');
    release();
  });

  it('ignores duplicate stale paused events during resume and accepts the new active state', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'resume-race',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });
    setDownloadControlIntent('resume-race', 'resume');

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'resume-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('queued');

    handlers['download-state']({ payload: {
      id: 'resume-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('queued');

    handlers['download-state']({ payload: {
      id: 'resume-race',
      status: 'downloading'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('downloading');
    release();
  });

  it('accepts an explicit pause while a resume transition is in flight', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'resume-pause-race',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });
    setDownloadControlIntent('resume-pause-race', 'resume');

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'resume-pause-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('queued');

    // pauseDownload replaces the resume intent before it asks the backend to
    // pause, so the next paused event is authoritative.
    setDownloadControlIntent('resume-pause-race', 'pause');
    handlers['download-state']({ payload: {
      id: 'resume-pause-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');
    release();
  });

  it('accepts an authoritative resume failure while ignoring stale paused events', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'resume-failure',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });
    setDownloadControlIntent('resume-failure', 'resume');

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'resume-failure',
      status: 'paused',
      error: 'aria2 resume failed'
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'paused',
      lastError: 'aria2 resume failed'
    });
    expect(downloadControlIntentFor('resume-failure')).toBeUndefined();
    release();
  });
});
