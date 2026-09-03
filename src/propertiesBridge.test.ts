import { describe, expect, it, vi } from 'vitest';
import { emitTo } from '@tauri-apps/api/event';
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
  attachAsyncPropertiesListener,
  beginExclusivePropertiesAction,
  classifyPropertiesActionRequest,
  createFrameCoalescer,
  decodePropertiesPatchValue,
  encodePropertiesPatchValue,
  enqueuePropertiesAction,
  formatPropertiesQueuePlacement,
  getPropertiesLifecycleAction,
  isExpectedPropertiesDiagnosticUnavailable,
  propertiesDiagnosticPhase,
  propertiesActionRequestKey,
  propertiesDiagnosticRequestState,
  propertiesTorrentPeerLimit,
  propertiesWindowEventTarget,
  resetPropertiesActionState,
  redactPropertiesError,
  sanitizePropertiesSnapshot,
  sendPropertiesSnapshot,
  shouldAcceptPropertiesActionRequest,
} from './propertiesBridge';
import { copyEditablePropertiesPatch, isLivePropertiesPatch } from './components/PropertiesWindowBridgeHost';

describe('Properties window bridge', () => {
  it('keeps optional override resets explicit across the JSON IPC boundary', () => {
    const encoded = encodePropertiesPatchValue<string>(undefined);

    expect(encoded).toBeNull();
    expect(JSON.parse(JSON.stringify({ torrentEncryptionPolicy: encoded }))).toEqual({
      torrentEncryptionPolicy: null,
    });
    expect(decodePropertiesPatchValue(encoded)).toBeUndefined();
    expect(decodePropertiesPatchValue('prealloc')).toBe('prealloc');
  });

  it('uses a WebviewWindow target for directed child events', () => {
    expect(propertiesWindowEventTarget('properties-1')).toEqual({
      kind: 'WebviewWindow',
      label: 'properties-1',
    });
  });

  it('targets the initial snapshot at the child WebviewWindow', async () => {
    vi.mocked(emitTo).mockClear();
    const payload = {} as Parameters<typeof sendPropertiesSnapshot>[1];

    await sendPropertiesSnapshot('properties-1', payload);

    expect(emitTo).toHaveBeenCalledWith(
      { kind: 'WebviewWindow', label: 'properties-1' },
      'properties-window-snapshot',
      payload,
    );
  });

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
    expect(snapshot.windowChrome).toEqual({ controlStyle: 'macos', side: 'left' });
  });

  it('adds resolver error metadata without exposing the queue-internal mode', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'dns-1',
      fileName: 'example.bin',
      url: 'https://example.test/file',
      status: 'failed',
      category: 'Other',
      dateAdded: '',
      lastResolverFallback: true,
      lastError: 'aria2 error code 19: Name resolution for example.test failed: Could not contact DNS servers.',
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    });

    expect(snapshot.lastErrorKind).toBe('nameResolution');
    expect(snapshot.lastResolverFallback).toBe(true);
    expect(snapshot).not.toHaveProperty('aria2ResolverMode');
  });

  it('redacts credentials from Properties errors at the renderer boundary', () => {
    const error = redactPropertiesError(new Error(
      'GET https://user:pa@ss@example.test/file?token=secret&x=1 Authorization: Bearer bearer-secret',
    ));
    expect(error).not.toContain('pa@ss@example');
    expect(error).not.toContain('token=secret');
    expect(error).not.toContain('bearer-secret');
    expect(error).toContain('[redacted]');
  });

  it('projects the latest live telemetry without exposing secrets', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'torrent-1',
      fileName: 'example',
      url: 'https://example.test/file',
      status: 'seeding',
      isTorrent: true,
      category: 'Other',
      dateAdded: '',
      speed: '-',
      eta: '-',
      fraction: 0,
      uploadedBytes: 1,
      password: 'secret',
      connections: 16,
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
        active_connections: 0,
        requested_connections: 8,
        uploaded_bytes: 9,
        upload_speed: '1 MiB/s',
        num_seeders: 0,
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
      torrentUploadedBytes: 9,
      uploadSpeed: '1 MiB/s',
      torrentConnectedPeers: 0,
      torrentConnectedSeeders: 0,
      torrentSeededSeconds: 12,
      moveProgress: 0.5,
    });
    expect(snapshot).not.toHaveProperty('activeConnections');
    expect(snapshot).not.toHaveProperty('requestedConnections');
    expect(snapshot).not.toHaveProperty('connections');

    const normalSnapshot = sanitizePropertiesSnapshot({
      id: 'http-1',
      fileName: 'example.bin',
      url: 'https://example.test/file',
      status: 'downloading',
      category: 'Other',
      dateAdded: '',
      connections: 8,
      isTorrent: false,
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, {
      progress: {
        id: 'http-1',
        fraction: 0.5,
        speed: '1 MiB/s',
        eta: '5s',
        size: '4 MiB',
        size_is_final: true,
        active_connections: 3,
        requested_connections: 8,
        effective_connections: 1,
      },
    });
    expect(normalSnapshot).toMatchObject({
      activeConnections: 3,
      requestedConnections: 8,
      effectiveConnections: 1,
    });
    expect(normalSnapshot).not.toHaveProperty('connectedPeers');
  });

  it('adds a user-facing queue name to the sanitized snapshot', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'queued-1',
      fileName: 'example.bin',
      url: 'https://example.test/file',
      status: 'queued',
      queueId: 'internal-queue-id',
      queuePosition: 2,
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, undefined, { queueName: 'Main Queue' });

    expect(snapshot.queueName).toBe('Main Queue');
    expect(snapshot.queueId).toBe('internal-queue-id');
  });

  it('projects the transient allocation phase without changing the persisted download status', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'allocating-1',
      fileName: 'large.bin',
      url: 'https://example.test/file',
      status: 'downloading',
      category: 'Other',
      dateAdded: '',
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, undefined, { allocationPending: true });

    expect(snapshot.status).toBe('downloading');
    expect(snapshot.allocationPending).toBe(true);
  });

  it('does not project Aria2 connection telemetry onto media snapshots', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'media-1',
      fileName: 'video.mp4',
      url: 'https://example.test/video',
      status: 'downloading',
      category: 'Other',
      dateAdded: '',
      isMedia: true,
      connections: 16,
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, {
      progress: {
        id: 'media-1',
        fraction: 0.5,
        speed: '1 MiB/s',
        eta: '5s',
        size: '4 MiB',
        size_is_final: false,
        active_connections: 8,
        requested_connections: 16,
      },
    });

    expect(snapshot.connections).toBe(16);
    expect(snapshot).not.toHaveProperty('activeConnections');
    expect(snapshot).not.toHaveProperty('requestedConnections');
  });

  it('preserves resolved Properties window chrome in the sanitized snapshot', () => {
    const snapshot = sanitizePropertiesSnapshot({
      id: 'chrome-1',
      fileName: 'example.bin',
      url: 'https://example.test/file',
      status: 'paused',
      category: 'Other',
      dateAdded: '',
    } as DownloadItem, {
      theme: 'dark',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, undefined, {
      windowChrome: { controlStyle: 'windows', side: 'right' },
    });

    expect(snapshot.windowChrome).toEqual({ controlStyle: 'windows', side: 'right' });
  });

  it('keeps diagnostic refreshes quiet when cached data exists', () => {
    expect(propertiesDiagnosticPhase(false, 'request-start')).toBe('initial');
    expect(propertiesDiagnosticPhase(false, 'request-start', true)).toBe('refreshing');
    expect(propertiesDiagnosticPhase(true, 'request-start')).toBe('refreshing');
    expect(propertiesDiagnosticPhase(true, 'success')).toBe('idle');
    expect(propertiesDiagnosticPhase(true, 'expected-unavailable')).toBe('stale');
    expect(propertiesDiagnosticPhase(false, 'expected-unavailable')).toBe('unavailable');
    expect(propertiesDiagnosticPhase(true, 'unexpected-error')).toBe('error');
    expect(propertiesDiagnosticRequestState(false, false, false)).toMatchObject({
      loading: true,
      refreshing: false,
      resetMessage: true,
      phase: 'initial',
    });
    expect(propertiesDiagnosticRequestState(false, true, false)).toMatchObject({
      loading: false,
      refreshing: false,
      resetMessage: false,
      phase: 'refreshing',
    });
    expect(propertiesDiagnosticRequestState(true, true, true)).toMatchObject({
      loading: false,
      refreshing: true,
      resetMessage: true,
      phase: 'refreshing',
    });
  });

  it('formats queue placement without ever using a raw queue id', () => {
    const formatPosition = (position: number) => `Position ${position}`;
    expect(formatPropertiesQueuePlacement('Main Queue', 2, formatPosition))
      .toBe('Main Queue · Position 3');
    expect(formatPropertiesQueuePlacement(undefined, 2, formatPosition))
      .toBe('Position 3');
    expect(formatPropertiesQueuePlacement('Main Queue', undefined, formatPosition))
      .toBe('Main Queue');
    expect(formatPropertiesQueuePlacement('  Main Queue  ', 1.5, formatPosition))
      .toBe('Main Queue');
    expect(formatPropertiesQueuePlacement(undefined, Number.NaN, formatPosition))
      .toBe('—');
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
    expect(getPropertiesLifecycleAction('queued')).toBe('pause');
    expect(getPropertiesLifecycleAction('retrying')).toBe('pause');
    expect(getPropertiesLifecycleAction('paused')).toBe('resume');
    expect(getPropertiesLifecycleAction('ready')).toBe('start');
    expect(getPropertiesLifecycleAction('staged')).toBe('pause');
    expect(getPropertiesLifecycleAction('failed')).toBe('retry');
    expect(getPropertiesLifecycleAction('completed')).toBeNull();
  });

  it('preserves validated SFTP fingerprints and rejects identity edits after dispatch', () => {
    expect(copyEditablePropertiesPatch({ sftpHostKeyMd: 'MD5=0123456789abcdef0123456789abcdef' }, {
      isTorrent: false,
      status: 'ready',
    })).toMatchObject({ sftpHostKeyMd: 'md5=0123456789abcdef0123456789abcdef' });

    expect(() => copyEditablePropertiesPatch({ fileName: 'renamed.bin' }, {
      isTorrent: false,
      status: 'completed',
    })).toThrow('read-only');
    expect(() => copyEditablePropertiesPatch({ destination: '/new/path' }, {
      isTorrent: true,
      status: 'paused',
    })).toThrow('read-only');
    expect(() => copyEditablePropertiesPatch({ fileName: 'queued.bin' }, {
      isTorrent: false,
      status: 'queued',
    })).toThrow('read-only');
  });

  it('allows only native live controls for active Properties saves', () => {
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: false, status: 'downloading' },
      { speedLimit: '2M' },
    )).toBe(true);
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: true, status: 'seeding' },
      { torrentUploadLimit: '1M', torrentMaxPeers: 120, torrentPeerSpeedLimit: '256K' },
    )).toBe(true);
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: true, status: 'seeding' },
      { speedLimit: '2M' },
    )).toBe(false);
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: true, status: 'verifying' },
      { torrentUploadLimit: '1M' },
    )).toBe(false);
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: true, status: 'waitingToSeed' },
      { torrentMaxPeers: 120 },
    )).toBe(false);
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: true, status: 'downloading' },
      { torrentTrackers: 'https://tracker.example/announce' },
    )).toBe(false);
    expect(isLivePropertiesPatch(
      { isMedia: true, isTorrent: false, status: 'downloading' },
      { speedLimit: '2M' },
    )).toBe(false);
    expect(isLivePropertiesPatch(
      { isMedia: false, isTorrent: false, status: 'paused' },
      { speedLimit: '2M' },
    )).toBe(false);
  });

  it('keeps Torrent peer-cap telemetry distinct from generic connections', () => {
    expect(propertiesTorrentPeerLimit(undefined)).toBe(55);
    expect(propertiesTorrentPeerLimit(120)).toBe(120);
    expect(propertiesTorrentPeerLimit(0)).toBe(0);
    expect(propertiesTorrentPeerLimit(16.5)).toBe(55);
  });

  it('recognizes expected diagnostics gaps without hiding real RPC failures', () => {
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('live Torrent file progress is unavailable'))).toBe(true);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('active Torrent transfer has no current gid mapping'))).toBe(true);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('active Torrent transfer has a stale control epoch'))).toBe(true);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('active Torrent has a stale control epoch'))).toBe(true);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('Torrent lifecycle changed while reading peer diagnostics'))).toBe(true);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('Torrent lifecycle changed while reading peer summary'))).toBe(true);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('aria2.getPeers failed: unavailable response'))).toBe(false);
    expect(isExpectedPropertiesDiagnosticUnavailable(new Error('aria2.getFiles failed: connection refused'))).toBe(false);
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

  it('rejects actions from a superseded renderer session and older request IDs', () => {
    const registration = {
      downloadId: 'download-1',
      sessionId: 'session-new',
      latestRequestId: 4,
    };

    expect(shouldAcceptPropertiesActionRequest(registration, {
      downloadId: 'download-1',
      sessionId: 'session-old',
      requestId: 99,
    })).toBe(false);
    expect(shouldAcceptPropertiesActionRequest(registration, {
      downloadId: 'download-1',
      sessionId: 'session-new',
      requestId: 4,
    })).toBe(false);
    expect(shouldAcceptPropertiesActionRequest(registration, {
      downloadId: 'download-1',
      sessionId: 'session-new',
      requestId: 5,
    })).toBe(true);
  });

  it('rejects a request whose download binding does not match the window', () => {
    expect(shouldAcceptPropertiesActionRequest({
      downloadId: 'download-1',
      sessionId: 'session-1',
      latestRequestId: 0,
    }, {
      downloadId: 'download-2',
      sessionId: 'session-1',
      requestId: 1,
    })).toBe(false);
  });

  it('replays completed duplicate requests after a lost result and deduplicates retries', () => {
    const registration = {
      downloadId: 'download-1',
      sessionId: 'session-1',
      latestRequestId: 4,
    };
    const request = { downloadId: 'download-1', sessionId: 'session-1', requestId: 4 };

    expect(classifyPropertiesActionRequest(registration, { ...request, requestId: 5 }, false, false)).toBe('accept');
    expect(classifyPropertiesActionRequest(registration, request, true, false)).toBe('replay');
    expect(classifyPropertiesActionRequest(registration, request, false, true)).toBe('pending');
    expect(classifyPropertiesActionRequest(registration, { ...request, requestId: 3 }, false, false)).toBe('ignore');
    expect(classifyPropertiesActionRequest(registration, { ...request, sessionId: 'session-old' }, false, false)).toBe('ignore');

    const base = { windowLabel: 'properties-1', sessionId: 'session-1', requestId: 4 };
    expect(propertiesActionRequestKey(base)).not.toBe(propertiesActionRequestKey({ ...base, requestId: 5 }));
    expect(propertiesActionRequestKey(base)).not.toBe(propertiesActionRequestKey({ ...base, sessionId: 'session-2' }));
    expect(propertiesActionRequestKey(base)).not.toBe(propertiesActionRequestKey({ ...base, windowLabel: 'properties-2' }));
  });

  it('resets pending action state while advancing the bridge-generation request cursor', () => {
    expect(resetPropertiesActionState(9)).toEqual({
      requestId: 10,
      pendingAction: null,
      request: null,
    });
    expect(resetPropertiesActionState(Number.MAX_SAFE_INTEGER).requestId).toBe(1);
  });

  it('serializes actions per window and continues after an earlier action fails', async () => {
    const chains = new Map<string, Promise<void>>();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });

    const first = enqueuePropertiesAction(chains, 'window:download', async () => {
      events.push('first-start');
      markFirstStarted();
      await firstGate;
      events.push('first-end');
      throw new Error('first action failed');
    });
    const second = enqueuePropertiesAction(chains, 'window:download', async () => {
      events.push('second');
    });

    await firstStarted;
    expect(events).toEqual(['first-start']);
    releaseFirst();
    const results = await Promise.allSettled([first, second]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(events).toEqual(['first-start', 'first-end', 'second']);
    expect(chains.size).toBe(0);
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

  it('unlistens a Tauri listener that resolves after bridge cleanup', async () => {
    let resolveListener!: (unlisten: () => void) => void;
    const listener = new Promise<() => void>(resolve => { resolveListener = resolve; });
    let disposed = true;
    let assigned = false;
    let unlistened = false;

    attachAsyncPropertiesListener(
      listener,
      () => disposed,
      () => { assigned = true; },
    );
    resolveListener(() => { unlistened = true; });
    await listener;
    await Promise.resolve();

    expect(assigned).toBe(false);
    expect(unlistened).toBe(true);
  });

  it('assigns a live Tauri listener while the bridge is mounted', async () => {
    let resolveListener!: (unlisten: () => void) => void;
    const listener = new Promise<() => void>(resolve => { resolveListener = resolve; });
    const unlisten = vi.fn();
    let assigned: (() => void) | undefined;

    attachAsyncPropertiesListener(listener, () => false, value => { assigned = value; });
    resolveListener(unlisten);
    await listener;
    await Promise.resolve();

    expect(assigned).toBe(unlisten);
    expect(unlisten).not.toHaveBeenCalled();
  });

  it('strictly validates numeric boundaries, speed limits, and tracker syntax in patch copies', () => {
    const baseItem = { isTorrent: false, status: 'ready' as const };
    const torrentItem = { isTorrent: true, status: 'paused' as const };

    // Connections bounds (1 to 16, whole numbers)
    expect(() => copyEditablePropertiesPatch({ connections: 0 }, baseItem)).toThrow('Connections must be a whole number from 1 to 16');
    expect(() => copyEditablePropertiesPatch({ connections: 17 }, baseItem)).toThrow('Connections must be a whole number from 1 to 16');
    expect(() => copyEditablePropertiesPatch({ connections: 1.5 }, baseItem)).toThrow('Connections must be a whole number from 1 to 16');
    expect(() => copyEditablePropertiesPatch({ connections: Number.NaN }, baseItem)).toThrow('Connections must be a whole number from 1 to 16');
    expect(copyEditablePropertiesPatch({ connections: 1 }, baseItem)).toMatchObject({ connections: 1 });
    expect(copyEditablePropertiesPatch({ connections: 16 }, baseItem)).toMatchObject({ connections: 16 });

    // Torrent max peers bounds (0 to 1000, whole numbers)
    expect(() => copyEditablePropertiesPatch({ torrentMaxPeers: -1 }, torrentItem)).toThrow('Torrent maximum peers must be a whole number from 0 to 1000');
    expect(() => copyEditablePropertiesPatch({ torrentMaxPeers: 1001 }, torrentItem)).toThrow('Torrent maximum peers must be a whole number from 0 to 1000');
    expect(() => copyEditablePropertiesPatch({ torrentMaxPeers: 10.5 }, torrentItem)).toThrow('Torrent maximum peers must be a whole number from 0 to 1000');
    expect(copyEditablePropertiesPatch({ torrentMaxPeers: 0 }, torrentItem)).toMatchObject({ torrentMaxPeers: 0 });
    expect(copyEditablePropertiesPatch({ torrentMaxPeers: 1000 }, torrentItem)).toMatchObject({ torrentMaxPeers: 1000 });

    // Speed limit normalization and invalid formats
    expect(() => copyEditablePropertiesPatch({ speedLimit: 'invalid' }, baseItem)).toThrow('Invalid download speed limit');
    expect(() => copyEditablePropertiesPatch({ speedLimit: '0M' }, baseItem)).toThrow('Invalid download speed limit');
    expect(() => copyEditablePropertiesPatch({ speedLimit: '-5M' }, baseItem)).toThrow('Invalid download speed limit');
    expect(copyEditablePropertiesPatch({ speedLimit: '2M' }, baseItem)).toMatchObject({ speedLimit: '2M' });
    expect(copyEditablePropertiesPatch({ speedLimit: ' 500K ' }, baseItem)).toMatchObject({ speedLimit: '500K' });
    expect(copyEditablePropertiesPatch({ speedLimit: '' }, baseItem).speedLimit).toBeUndefined();

    // Torrent seed settings
    expect(() => copyEditablePropertiesPatch({ torrentSeedTime: -1 }, torrentItem)).toThrow('Invalid torrentSeedTime');
    expect(() => copyEditablePropertiesPatch({ torrentSeedTime: Number.NaN }, torrentItem)).toThrow('Invalid torrentSeedTime');
    expect(() => copyEditablePropertiesPatch({ torrentSeedRatio: -0.1 }, torrentItem)).toThrow('Invalid torrentSeedRatio');
    expect(copyEditablePropertiesPatch({ torrentSeedTime: 0 }, torrentItem)).toMatchObject({ torrentSeedTime: 0 });
    expect(copyEditablePropertiesPatch({ torrentSeedRatio: 1.5 }, torrentItem)).toMatchObject({ torrentSeedRatio: 1.5 });

    // Torrent stop timeout
    expect(() => copyEditablePropertiesPatch({ torrentStopTimeout: -1 }, torrentItem)).toThrow('Invalid torrentStopTimeout');
    expect(() => copyEditablePropertiesPatch({ torrentStopTimeout: 7 * 24 * 60 * 60 + 1 }, torrentItem)).toThrow('Invalid torrentStopTimeout');
    expect(copyEditablePropertiesPatch({ torrentStopTimeout: 3600 }, torrentItem)).toMatchObject({ torrentStopTimeout: 3600 });

    // Torrent trackers validation
    expect(() => copyEditablePropertiesPatch({ torrentTrackers: 'not-a-url' }, torrentItem)).toThrow('Invalid Torrent tracker list');
    expect(() => copyEditablePropertiesPatch({ torrentTrackers: 'ftp://unsupported.tracker/announce' }, torrentItem)).toThrow('Invalid Torrent tracker list');
    expect(copyEditablePropertiesPatch({ torrentTrackers: 'https://tracker.example/announce' }, torrentItem))
      .toMatchObject({ torrentTrackers: 'https://tracker.example/announce' });

    // Torrent policies
    expect(() => copyEditablePropertiesPatch({ torrentEncryptionPolicy: 'invalid' as any }, torrentItem)).toThrow('Invalid torrentEncryptionPolicy');
    expect(() => copyEditablePropertiesPatch({ torrentFileAllocation: 'invalid' as any }, torrentItem)).toThrow('Invalid torrentFileAllocation');
    expect(copyEditablePropertiesPatch({ torrentEncryptionPolicy: 'require-crypto' }, torrentItem)).toMatchObject({ torrentEncryptionPolicy: 'require-crypto' });
    expect(copyEditablePropertiesPatch({ torrentFileAllocation: 'prealloc' }, torrentItem)).toMatchObject({ torrentFileAllocation: 'prealloc' });
  });
});
