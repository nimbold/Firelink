import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commitDownloadState, dispatchItem, flushDownloadPersistence, getProxyArgs, getSiteLogin, hasStaleTemporaryMediaEstimate, initializeDownloadPersistence, MAIN_QUEUE_ID, normalizeCustomProxy, normalizePersistedDownloadProgress, normalizePersistedQueueState, normalizePersistedQueues, useDownloadStore } from './useDownloadStore';
import { useDownloadProgressStore } from './downloadProgressStore';
import { useSettingsStore } from './useSettingsStore';
import * as ipc from '../ipc';
import { MAX_DOWNLOAD_FILENAME_BYTES } from '../utils/downloads';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(),
}));

// Mock window.__TAURI_INTERNALS__ and log to prevent errors
vi.mock('../utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/Users/test'),
  join: vi.fn(async (...parts: string[]) =>
    parts
      .map((part, index) => index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, ''))
      .join('/')
  ),
}));

vi.mock('./useSettingsStore', () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      proxyMode: 'none',
      siteLogins: [],
      globalSpeedLimit: '',
      speedLimitPresetValues: [1, 5, 10],
      logsEnabled: false,
      perServerConnections: 16,
      customUserAgent: '',
      maxAutomaticRetries: 3,
      minimumNormalDownloadSpeedKiB: 0,
      retryNotFoundErrors: false,
      adaptiveMirrorSelection: true,
      mediaCookieSource: 'none',
      baseDownloadFolder: '~/Downloads',
      categorySubfoldersEnabled: true,
      categorySubfolders: {
        Musics: 'Musics',
        Movies: 'Movies',
        Compressed: 'Compressed',
        Documents: 'Documents',
        Pictures: 'Pictures',
        Applications: 'Applications',
        Other: 'Other',
      },
      categoryDirectoryOverrides: {},
      keychainAccessReady: false,
      keychainPromptDismissed: false,
      setShowKeychainModal: vi.fn(),
    })),
  }
}));

describe('useDownloadStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      proxyMode: 'none',
      siteLogins: [],
      globalSpeedLimit: '',
      speedLimitPresetValues: [1, 5, 10],
      logsEnabled: false,
      perServerConnections: 16,
      customUserAgent: '',
      maxAutomaticRetries: 3,
      minimumNormalDownloadSpeedKiB: 0,
      retryNotFoundErrors: false,
      adaptiveMirrorSelection: true,
      mediaCookieSource: 'none',
      baseDownloadFolder: '~/Downloads',
      categorySubfoldersEnabled: true,
      categorySubfolders: {
        Musics: 'Musics',
        Movies: 'Movies',
        Compressed: 'Compressed',
        Documents: 'Documents',
        Pictures: 'Pictures',
        Applications: 'Applications',
        Other: 'Other',
      },
      categoryDirectoryOverrides: {},
      keychainAccessReady: false,
      keychainPromptDismissed: false,
      setShowKeychainModal: vi.fn(),
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    useDownloadStore.setState({
      downloads: [],
      backendRegisteredIds: new Set(),
      allocationPendingIds: new Set(),
      pendingOrder: [],
      isAddModalOpen: false,
      pendingAddUrls: '',
      pendingAddReferer: '',
      pendingAddFilename: '',
      pendingAddHeaders: '',
      pendingAddCookies: '',
      pendingAddMediaUrls: [],
      pendingAddBatch: false,
      pendingAddBatchName: '',
      pendingAddRequestContexts: {},
      pendingAddRequestVersion: 0,
      queues: [{ id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true }],
    });
    useDownloadProgressStore.setState({ progressMap: {}, retainedProgressMap: {}, moveProgressMap: {} });
  });

  it('invalidates in-flight Add-modal handoffs when the modal is toggled', () => {
    const initialVersion = useDownloadStore.getState().pendingAddRequestVersion;

    useDownloadStore.getState().toggleAddModal(true);
    expect(useDownloadStore.getState().pendingAddRequestVersion).toBe(initialVersion + 1);

    useDownloadStore.getState().toggleAddModal(false);
    expect(useDownloadStore.getState().pendingAddRequestVersion).toBe(initialVersion + 2);
  });

  it('normalizes an overlong filename edited in Properties before persisting it', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'properties-long-name',
        url: 'https://example.com/video',
        fileName: 'video.mp4',
        status: 'ready',
        category: 'Movies',
        dateAdded: ''
      }] as any[]
    });

    await useDownloadStore.getState().applyProperties('properties-long-name', {
      fileName: `${'title '.repeat(100)}.mp4`
    });

    const fileName = useDownloadStore.getState().downloads[0].fileName;
    expect(new TextEncoder().encode(fileName).length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILENAME_BYTES);
    expect(fileName.endsWith('.mp4')).toBe(true);
  });

  it('rejects queued identity edits before invalidating their dispatch', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'queued-identity',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'queued',
        category: 'Other',
        dateAdded: '',
      }] as any[],
    });

    await expect(useDownloadStore.getState().applyProperties('queued-identity', {
      fileName: 'renamed.bin',
    })).rejects.toThrow('read-only');
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
      'cancel_enqueue_generation',
      expect.anything(),
    );
  });

  it('keeps the credential-required marker when the last secret is cleared', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'credential-marker',
        url: 'https://secure.example.com/file.bin',
        fileName: 'file.bin',
        status: 'failed',
        category: 'Other',
        dateAdded: '',
        credentialsRequired: true
      }] as any[]
    });

    await useDownloadStore.getState().applyProperties('credential-marker', {
      password: ''
    });
    expect(useDownloadStore.getState().downloads[0].credentialsRequired).toBe(true);

    await useDownloadStore.getState().applyProperties('credential-marker', {
      password: 'secret'
    });
    expect(useDownloadStore.getState().downloads[0].credentialsRequired).toBe(false);
  });

  it('clears a persisted Torrent removal reservation when a paused item disables cleanup', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'paused-torrent-removal',
        url: 'magnet:?xt=urn:btih:abc',
        fileName: 'torrent',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        isTorrent: true,
        torrentFileIndices: [0],
        torrentRemoveUnselectedFile: true
      }] as any[],
      backendRegisteredIds: new Set(['paused-torrent-removal'])
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().applyProperties('paused-torrent-removal', {
      torrentRemoveUnselectedFile: false
    });

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'detach_download_for_reconfigure',
      { id: 'paused-torrent-removal' }
    );
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'clear_torrent_removal_paths',
      { id: 'paused-torrent-removal' }
    );
    expect(useDownloadStore.getState().downloads[0].torrentRemoveUnselectedFile).toBe(false);
  });

  it('detaches a paused backend lifecycle even when the frontend registration set is stale', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'paused-stale-registration',
        url: 'magnet:?xt=urn:btih:abc',
        fileName: 'torrent',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        isTorrent: true,
        torrentFileIndices: [1]
      }] as any[],
      backendRegisteredIds: new Set()
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().applyProperties('paused-stale-registration', {
      torrentFileIndices: [2]
    });

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'detach_download_for_reconfigure',
      { id: 'paused-stale-registration' }
    );
    expect(useDownloadStore.getState().downloads[0].torrentFileIndices).toEqual([2]);
  });

  it('replaces stale media intent when an appended handoff reuses a URL', () => {
    useDownloadStore.getState().openAddModalWithUrls(
      'https://example.com/file.bin', '', '', '', '', true
    );
    useDownloadStore.getState().openAddModalWithUrls(
      'https://example.com/file.bin', '', '', '', '', false
    );

    const state = useDownloadStore.getState();
    expect(state.pendingAddMediaUrls).toEqual([]);
    expect(state.pendingAddRequestContexts['https://example.com/file.bin']?.media).toBe(false);
  });

  it('replaces a paused download URL in place and preserves its progress', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'replace-in-place',
        url: 'https://expired.example/file.bin',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: '2026-07-15T00:00:00.000Z',
        downloadedBytes: 1024,
        totalBytes: 4096,
        fraction: 0.25
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    const replaced = await useDownloadStore.getState().replaceDownload(
      'replace-in-place',
      { url: 'https://fresh.example/file.bin', lastError: undefined },
      { type: 'add-to-queue', queueId: 'main' }
    );

    expect(replaced).toBe(true);
    expect(useDownloadStore.getState().downloads).toEqual([expect.objectContaining({
      id: 'replace-in-place',
      url: 'https://fresh.example/file.bin',
      status: 'paused',
      downloadedBytes: 1024,
      totalBytes: 4096,
      fraction: 0.25
    })]);
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('remove_download', expect.anything());
  });

  it('resumes a replaced paused download without creating a second row', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'replace-and-resume',
        url: 'https://expired.example/file.bin',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        destination: '/tmp',
        downloadedBytes: 2048,
        totalBytes: 4096
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'resume_download') return false;
      if (command === 'enqueue_download') {
        return { id: 'replace-and-resume', filename: 'file.bin' };
      }
      if (command === 'get_pending_order') return [];
      return undefined;
    });

    const replaced = await useDownloadStore.getState().replaceDownload(
      'replace-and-resume',
      { url: 'https://fresh.example/file.bin' },
      { type: 'start-now' }
    );

    expect(replaced).toBe(true);
    expect(useDownloadStore.getState().downloads).toHaveLength(1);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      id: 'replace-and-resume',
      url: 'https://fresh.example/file.bin',
      downloadedBytes: 2048,
      totalBytes: 4096,
      hasBeenDispatched: true
    });
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('remove_download', expect.anything());
  });

  it('serializes a replacement and a concurrent pause as one lifecycle operation', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'replace-pause-race',
        url: 'https://expired.example/file.bin',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: ''
      }] as any[]
    });

    let releaseResume!: () => void;
    let signalResumeStarted!: () => void;
    const resumeStarted = new Promise<void>(resolve => {
      signalResumeStarted = resolve;
    });
    const resumeGate = new Promise<void>(resolve => {
      releaseResume = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'resume_download') {
        signalResumeStarted();
        await resumeGate;
        return true;
      }
      return undefined;
    });

    const replacing = useDownloadStore.getState().replaceDownload(
      'replace-pause-race',
      { url: 'https://fresh.example/file.bin' },
      { type: 'start-now' }
    );
    await resumeStarted;

    const pausing = useDownloadStore.getState().pauseDownload('replace-pause-race');
    await Promise.resolve();
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('pause_download', { id: 'replace-pause-race' });

    releaseResume();
    await replacing;
    await pausing;

    expect(ipc.invokeCommand).toHaveBeenCalledWith('pause_download', { id: 'replace-pause-race' });
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      url: 'https://fresh.example/file.bin',
      status: 'paused'
    });
  });

  it('rejects empty and duplicate queue names', () => {
    useDownloadStore.setState({
      queues: [
        { id: 'main', name: 'Main Queue', isMain: true },
        { id: 'queue-a', name: 'Downloads', isMain: false }
      ]
    });

    expect(useDownloadStore.getState().addQueue('')).toBe(false);
    expect(useDownloadStore.getState().addQueue(' downloads ')).toBe(false);
    expect(useDownloadStore.getState().addQueue('Archive')).toBe(true);
    expect(useDownloadStore.getState().renameQueue('queue-a', ' archive ')).toBe(false);
    expect(useDownloadStore.getState().renameQueue('queue-a', '')).toBe(false);
  });

  it('persists a queue concurrency override only after backend synchronization', async () => {
    useDownloadStore.setState({
      queues: [
        { id: 'main', name: 'Main Queue', isMain: true },
        { id: 'queue-a', name: 'Downloads', isMain: false }
      ]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().setQueueConcurrency('queue-a', 2);

    expect(useDownloadStore.getState().queues).toEqual([
      { id: 'main', name: 'Main Queue', isMain: true },
      { id: 'queue-a', name: 'Downloads', isMain: false, maxConcurrent: 2 }
    ]);
    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith(
      'set_queue_concurrency_limits',
      {
        limits: [
          { id: 'main', maxConcurrent: null },
          { id: 'queue-a', maxConcurrent: 2 }
        ]
      }
    );
  });

  it('retains the previous queue concurrency after backend synchronization fails', async () => {
    useDownloadStore.setState({
      queues: [
        { id: 'main', name: 'Main Queue', isMain: true },
        { id: 'queue-a', name: 'Downloads', isMain: false, maxConcurrent: 2 }
      ]
    });
    vi.mocked(ipc.invokeCommand).mockRejectedValue(new Error('backend unavailable'));

    await expect(useDownloadStore.getState().setQueueConcurrency('queue-a', 3))
      .rejects.toThrow('backend unavailable');
    expect(useDownloadStore.getState().queues[1].maxConcurrent).toBe(2);
  });

  it('rebases queue concurrency updates when queue state changes during IPC', async () => {
    useDownloadStore.setState({
      queues: [
        { id: 'main', name: 'Main Queue', isMain: true },
        { id: 'queue-a', name: 'Downloads', isMain: false }
      ]
    });
    let releaseFirstSync!: () => void;
    const firstSyncReleased = new Promise<void>(resolve => { releaseFirstSync = resolve; });
    let syncCalls = 0;
    vi.mocked(ipc.invokeCommand).mockImplementation(async command => {
      if (command === 'set_queue_concurrency_limits') {
        syncCalls += 1;
        if (syncCalls === 1) await firstSyncReleased;
      }
      return undefined;
    });

    const update = useDownloadStore.getState().setQueueConcurrency('queue-a', 3);
    await vi.waitFor(() => expect(syncCalls).toBe(1));
    useDownloadStore.setState(state => ({
      queues: state.queues.filter(queue => queue.id !== 'queue-a')
    }));
    releaseFirstSync();

    await expect(update).rejects.toThrow('Queue no longer exists.');
    expect(useDownloadStore.getState().queues).toEqual([
      { id: 'main', name: 'Main Queue', isMain: true }
    ]);
    expect(syncCalls).toBe(2);
    const configCalls = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'set_queue_concurrency_limits');
    expect(configCalls[1]).toEqual([
      'set_queue_concurrency_limits',
      { limits: [{ id: 'main', maxConcurrent: null }] }
    ]);
  });

  it('updates an active normal download after applying a live speed limit', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'live-speed',
        status: 'downloading',
        isMedia: false,
        speedLimit: '512K'
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().setDownloadSpeedLimit('live-speed', '2M');

    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_download_speed_limit', {
      id: 'live-speed',
      limit: '2M'
    });
    expect(useDownloadStore.getState().downloads[0].speedLimit).toBe('2M');

    await useDownloadStore.getState().setDownloadSpeedLimit('live-speed', null);
    const speedLimitCalls = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'set_download_speed_limit');
    expect(speedLimitCalls[speedLimitCalls.length - 1]).toEqual(['set_download_speed_limit', {
      id: 'live-speed',
      limit: null
    }]);
    expect(useDownloadStore.getState().downloads[0].speedLimit).toBeUndefined();
  });

  it('updates an active Torrent upload limit while seeding and clears it', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'live-torrent-upload',
        status: 'seeding',
        isMedia: false,
        isTorrent: true,
        torrentUploadLimit: '512K'
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().setTorrentUploadLimit('live-torrent-upload', '2M');

    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_torrent_upload_limit', {
      id: 'live-torrent-upload',
      limit: '2M'
    });
    expect(useDownloadStore.getState().downloads[0].torrentUploadLimit).toBe('2M');

    await useDownloadStore.getState().setTorrentUploadLimit('live-torrent-upload', null);
    const uploadLimitCalls = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'set_torrent_upload_limit');
    expect(uploadLimitCalls[uploadLimitCalls.length - 1]).toEqual(['set_torrent_upload_limit', {
      id: 'live-torrent-upload',
      limit: null
    }]);
    expect(useDownloadStore.getState().downloads[0].torrentUploadLimit).toBeUndefined();
  });

  it('rejects live Torrent upload control for ordinary or inactive downloads', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'ordinary-upload', status: 'downloading', isMedia: false, isTorrent: false },
        { id: 'paused-upload', status: 'paused', isMedia: false, isTorrent: true }
      ] as any[]
    });

    await expect(useDownloadStore.getState().setTorrentUploadLimit('ordinary-upload', '2M'))
      .rejects.toThrow('only for Torrent');
    await expect(useDownloadStore.getState().setTorrentUploadLimit('paused-upload', '2M'))
      .rejects.toThrow('active Torrent');
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('set_torrent_upload_limit', expect.anything());
  });

  it('keeps the prior Torrent upload limit when the backend rejects the update', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'live-torrent-upload-failure',
        status: 'downloading',
        isMedia: false,
        isTorrent: true,
        torrentUploadLimit: '512K'
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async command => {
      if (command === 'set_torrent_upload_limit') throw new Error('aria2 unavailable');
      return undefined;
    });

    await expect(useDownloadStore.getState().setTorrentUploadLimit('live-torrent-upload-failure', '2M'))
      .rejects.toThrow('aria2 unavailable');
    expect(useDownloadStore.getState().downloads[0].torrentUploadLimit).toBe('512K');
  });

  it('updates active Torrent peer options and clears them to Aria2 defaults', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'live-torrent-peers',
        status: 'seeding',
        isMedia: false,
        isTorrent: true,
        torrentMaxPeers: 120,
        torrentPeerSpeedLimit: '512K'
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().setTorrentPeerOptions('live-torrent-peers', '240', '2M');

    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_torrent_peer_options', {
      id: 'live-torrent-peers',
      max_peers: 240,
      peer_speed_limit: '2M'
    });
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      torrentMaxPeers: 240,
      torrentPeerSpeedLimit: '2M'
    });

    await useDownloadStore.getState().setTorrentPeerOptions('live-torrent-peers', null, null);
    const peerOptionCalls = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'set_torrent_peer_options');
    expect(peerOptionCalls[peerOptionCalls.length - 1]).toEqual(['set_torrent_peer_options', {
      id: 'live-torrent-peers',
      max_peers: null,
      peer_speed_limit: null
    }]);
    expect(useDownloadStore.getState().downloads[0].torrentMaxPeers).toBeUndefined();
    expect(useDownloadStore.getState().downloads[0].torrentPeerSpeedLimit).toBeUndefined();
  });

  it('rejects invalid or inactive live Torrent peer options', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'ordinary-peers', status: 'downloading', isMedia: false, isTorrent: false },
        { id: 'paused-peers', status: 'paused', isMedia: false, isTorrent: true }
      ] as any[]
    });

    await expect(useDownloadStore.getState().setTorrentPeerOptions('ordinary-peers', '100', '2M'))
      .rejects.toThrow('only for Torrent');
    await expect(useDownloadStore.getState().setTorrentPeerOptions('paused-peers', '100', '2M'))
      .rejects.toThrow('active Torrent');
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('set_torrent_peer_options', expect.anything());

    useDownloadStore.setState({
      downloads: [{ id: 'invalid-peers', status: 'downloading', isMedia: false, isTorrent: true }] as any[]
    });
    await expect(useDownloadStore.getState().setTorrentPeerOptions('invalid-peers', '1001', '2M'))
      .rejects.toThrow('between 0 and 1000');
    await expect(useDownloadStore.getState().setTorrentPeerOptions('invalid-peers', '100', 'not-a-rate'))
      .rejects.toThrow('valid Torrent peer speed');
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('set_torrent_peer_options', expect.anything());
  });

  it('keeps prior Torrent peer options when the backend rejects the update', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'live-torrent-peers-failure',
        status: 'downloading',
        isMedia: false,
        isTorrent: true,
        torrentMaxPeers: 120,
        torrentPeerSpeedLimit: '512K'
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async command => {
      if (command === 'set_torrent_peer_options') throw new Error('aria2 unavailable');
      return undefined;
    });

    await expect(useDownloadStore.getState().setTorrentPeerOptions('live-torrent-peers-failure', '240', '2M'))
      .rejects.toThrow('aria2 unavailable');
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      torrentMaxPeers: 120,
      torrentPeerSpeedLimit: '512K'
    });
  });

  it('rejects live speed changes for media and inactive downloads', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'media-speed', status: 'downloading', isMedia: true, speedLimit: '1M' },
        { id: 'paused-speed', status: 'paused', isMedia: false, speedLimit: '1M' }
      ] as any[]
    });

    await expect(useDownloadStore.getState().setDownloadSpeedLimit('media-speed', '2M'))
      .rejects.toThrow('media downloads');
    await expect(useDownloadStore.getState().setDownloadSpeedLimit('paused-speed', '2M'))
      .rejects.toThrow('active download');
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('set_download_speed_limit', expect.anything());
  });

  it('keeps the prior live speed limit when the backend rejects the update', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'live-speed-failure',
        status: 'downloading',
        isMedia: false,
        speedLimit: '512K'
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async command => {
      if (command === 'set_download_speed_limit') throw new Error('aria2 unavailable');
      return undefined;
    });

    await expect(useDownloadStore.getState().setDownloadSpeedLimit('live-speed-failure', '2M'))
      .rejects.toThrow('aria2 unavailable');
    expect(useDownloadStore.getState().downloads[0].speedLimit).toBe('512K');
  });

  it('coalesces duplicate live speed updates for one download', async () => {
    useDownloadStore.setState({
      downloads: [{ id: 'live-speed-duplicate', status: 'downloading', isMedia: false }] as any[]
    });
    let releaseBackend!: () => void;
    const backendFinished = new Promise<void>(resolve => { releaseBackend = resolve; });
    vi.mocked(ipc.invokeCommand).mockImplementation(async () => backendFinished);

    const first = useDownloadStore.getState().setDownloadSpeedLimit('live-speed-duplicate', '2M');
    const second = useDownloadStore.getState().setDownloadSpeedLimit('live-speed-duplicate', '3M');
    expect(second).toBe(first);
    releaseBackend();
    await first;

    expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'set_download_speed_limit'))
      .toHaveLength(1);
    expect(useDownloadStore.getState().downloads[0].speedLimit).toBe('2M');
  });

  it('normalizes malformed persisted queues around one canonical main queue', () => {
    expect(normalizePersistedQueues([
      { id: 'custom-a', name: ' Downloads ', isMain: false },
      { id: 'custom-b', name: 'downloads', isMain: false },
      { id: 'custom-a', name: 'Duplicate ID', isMain: false },
      { id: 'legacy-main', name: 'Primary', isMain: true },
      { id: 'empty-name', name: '   ', isMain: false },
      { id: 'main-id', name: 'Ignored Main', isMain: true }
    ])).toEqual([
      { id: '00000000-0000-0000-0000-000000000001', name: 'Primary', isMain: true },
      { id: 'custom-a', name: 'Downloads', isMain: false },
      { id: 'custom-b', name: 'downloads (2)', isMain: false },
      { id: 'empty-name', name: 'Queue empty-na', isMain: false }
    ]);
    expect(normalizePersistedQueueState([
      { id: 'legacy-main', name: 'Primary', isMain: true }
    ]).queueIdRemap.get('legacy-main')).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('keeps only valid persisted queue concurrency overrides', () => {
    expect(normalizePersistedQueues([
      { id: 'main', name: 'Main', isMain: true, maxConcurrent: 4 },
      { id: 'valid', name: 'Valid', isMain: false, maxConcurrent: 12 },
      { id: 'zero', name: 'Zero', isMain: false, maxConcurrent: 0 },
      { id: 'large', name: 'Large', isMain: false, maxConcurrent: 13 },
      { id: 'null', name: 'Null', isMain: false, maxConcurrent: null }
    ])).toEqual([
      { id: '00000000-0000-0000-0000-000000000001', name: 'Main', isMain: true, maxConcurrent: 4 },
      { id: 'valid', name: 'Valid', isMain: false, maxConcurrent: 12 },
      { id: 'zero', name: 'Zero', isMain: false },
      { id: 'large', name: 'Large', isMain: false },
      { id: 'null', name: 'Null', isMain: false }
    ]);
  });

  it('synchronizes normalized queue limits before startup resume can run', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') {
        return [
          JSON.stringify({ id: 'main', name: 'Main', isMain: true, maxConcurrent: 4 }),
          JSON.stringify({ id: 'queue-a', name: 'Queue A', isMain: false, maxConcurrent: 0 })
        ];
      }
      if (cmd === 'db_get_all_downloads') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith(
      'set_queue_concurrency_limits',
      {
        limits: [
          { id: '00000000-0000-0000-0000-000000000001', maxConcurrent: 4 },
          { id: 'queue-a', maxConcurrent: null }
        ]
      }
    );
  });

  it('replaces stale in-memory downloads when startup loads an empty persisted snapshot', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'stale-memory-row',
        url: 'https://example.com/stale.bin',
        fileName: 'stale.bin',
        status: 'completed',
        category: 'Other',
        dateAdded: ''
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(useDownloadStore.getState().downloads).toEqual([]);
  });

  it('remaps persisted downloads when queue records are malformed or missing', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') {
        return [JSON.stringify({ id: 'legacy-main', name: 'Primary', isMain: true })];
      }
      if (cmd === 'db_get_all_downloads') {
        return [
          JSON.stringify({
            id: 'legacy-download',
            url: 'https://example.com/legacy.bin',
            fileName: 'legacy.bin',
            status: 'ready',
            category: 'Other',
            dateAdded: '',
            queueId: 'legacy-main'
          }),
          JSON.stringify({
            id: 'orphan-download',
            url: 'https://example.com/orphan.bin',
            fileName: 'orphan.bin',
            status: 'ready',
            category: 'Other',
            dateAdded: '',
            queueId: 'missing-queue'
          })
        ];
      }
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(useDownloadStore.getState().downloads.map(download => download.queueId))
      .toEqual(['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001']);
  });

  it('skips malformed persisted download records without blocking startup', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [
          '{not-json',
          JSON.stringify(null),
          JSON.stringify([]),
          JSON.stringify({
            id: 'valid-after-corruption',
            url: 'https://example.com/valid.bin',
            fileName: 'valid.bin',
            status: 'ready',
            category: 'Other',
            dateAdded: ''
          })
        ];
      }
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(useDownloadStore.getState().downloads.map(download => download.id))
      .toEqual(['valid-after-corruption']);
  });

  it('moves persisted paused rows behind runnable rows and assigns contiguous positions', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') {
        return [JSON.stringify({ id: 'queue-a', name: 'Queue A', isMain: false })];
      }
      if (cmd === 'db_get_all_downloads') {
        return [
          JSON.stringify({ id: 'active', status: 'downloading', queueId: 'queue-a', queuePosition: 0 }),
          JSON.stringify({ id: 'queued-one', status: 'queued', queueId: 'queue-a', queuePosition: 1 }),
          JSON.stringify({ id: 'paused-one', status: 'paused', queueId: 'queue-a', queuePosition: 2 }),
          JSON.stringify({ id: 'queued-two', status: 'queued', queueId: 'queue-a', queuePosition: 3 }),
          JSON.stringify({ id: 'legacy-invalid', status: 'queued', queueId: 'queue-a', queuePosition: 'not-a-number' })
        ];
      }
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(useDownloadStore.getState().downloads
      .filter(download => download.queueId === 'queue-a')
      .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
      .map(download => download.id)
    ).toEqual(['active', 'queued-one', 'queued-two', 'legacy-invalid', 'paused-one']);
    expect(useDownloadStore.getState().downloads
      .filter(download => download.queueId === 'queue-a')
      .map(download => download.queuePosition)
      .sort((left, right) => (left ?? 0) - (right ?? 0))
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('removes persisted temporary media estimates that are smaller than downloaded bytes', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'stale-media-estimate',
          url: 'https://youtube.com/watch?v=stale',
          fileName: 'video.mkv',
          status: 'queued',
          category: 'Movies',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          isMedia: true,
          size: '~1.00 KB',
          downloadedBytes: 11_989,
          totalBytes: 1_024,
          totalIsEstimate: true
        })];
      }
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      size: undefined,
      downloadedBytes: 11_989,
      totalBytes: undefined,
      totalIsEstimate: undefined
    });
  });

  it('does not discard a legitimate large media estimate when downloaded bytes exceed it', () => {
    const media = {
      isMedia: true,
      downloadedBytes: 90_000_000,
      totalBytes: 89_817_907,
      totalIsEstimate: true,
      size: '~85.7 MB'
    } as const;

    expect(hasStaleTemporaryMediaEstimate(media)).toBe(false);
    expect(normalizePersistedDownloadProgress({
      id: 'large-estimate',
      url: 'https://youtube.com/watch?v=large',
      fileName: 'video.mkv',
      status: 'queued',
      category: 'Movies',
      dateAdded: '',
      ...media
    })).toMatchObject({
      size: '~85.7 MB',
      downloadedBytes: 90_000_000,
      totalBytes: 89_817_907,
      totalIsEstimate: true
    });
  });

  it('does not discard a legitimate small media estimate without contradictory progress', () => {
    const media = {
      isMedia: true,
      size: '~500 B',
      downloadedBytes: 500,
      totalBytes: undefined,
      totalIsEstimate: true
    } as const;

    expect(hasStaleTemporaryMediaEstimate(media)).toBe(false);
    expect(normalizePersistedDownloadProgress({
      id: 'small-media',
      url: 'https://youtube.com/watch?v=small',
      fileName: 'short.mkv',
      status: 'queued',
      category: 'Movies',
      dateAdded: '',
      ...media
    })).toMatchObject(media);
  });

  it('recognizes IEC-formatted temporary media estimates', () => {
    expect(hasStaleTemporaryMediaEstimate({
      isMedia: true,
      size: '~1.00 KiB',
      downloadedBytes: 2_048,
      totalBytes: undefined,
      totalIsEstimate: true
    })).toBe(true);
  });

  it('clears malformed persisted Torrent peer options', () => {
    const normalized = normalizePersistedDownloadProgress({
      id: 'malformed-torrent-options',
      url: 'magnet:?xt=urn:btih:bad',
      fileName: 'payload',
      status: 'queued',
      category: 'Other',
      dateAdded: '',
      isTorrent: true,
      connections: 16,
      torrentMaxPeers: 'not-a-number' as unknown as number,
      torrentPeerSpeedLimit: 0 as unknown as string,
      torrentCheckIntegrity: 'yes' as unknown as boolean,
      torrentTrackers: 123 as unknown as string,
      torrentExcludeTrackers: 123 as unknown as string,
      torrentTrackerConnectTimeout: 0,
      torrentTrackerTimeout: 604801,
      torrentTrackerInterval: -1,
      torrentStopTimeout: 604801,
      torrentPrioritizePiece: 'head=1G',
      torrentRemoveUnselectedFile: 'yes' as unknown as boolean,
      torrentEncryptionPolicy: 'arc4'
    });

    expect(normalized.torrentMaxPeers).toBeUndefined();
    expect(normalized.connections).toBeUndefined();
    expect(normalized.torrentPeerSpeedLimit).toBeUndefined();
    expect(normalized.torrentCheckIntegrity).toBeUndefined();
    expect(normalized.torrentTrackers).toBeUndefined();
    expect(normalized.torrentExcludeTrackers).toBeUndefined();
    expect(normalized.torrentTrackerConnectTimeout).toBeUndefined();
    expect(normalized.torrentTrackerTimeout).toBeUndefined();
    expect(normalized.torrentTrackerInterval).toBeUndefined();
    expect(normalized.torrentStopTimeout).toBeUndefined();
    expect(normalized.torrentPrioritizePiece).toBeUndefined();
    expect(normalized.torrentRemoveUnselectedFile).toBeUndefined();
    expect(normalized.torrentEncryptionPolicy).toBeUndefined();
  });

  it('drops zero-based persisted Torrent web-seed indices', () => {
    const normalized = normalizePersistedDownloadProgress({
      id: 'torrent-web-seed-indexes',
      url: 'magnet:?xt=urn:btih:bad',
      fileName: 'payload',
      status: 'queued',
      category: 'Other',
      dateAdded: '',
      isTorrent: true,
      torrentWebSeeds: [
        { fileIndex: 0, uri: 'https://mirror.example/zero' },
        { fileIndex: 1, uri: 'https://mirror.example/one' },
      ],
      torrentWebSeedsNative: [
        { fileIndex: 0, uri: 'https://mirror.example/native-zero' },
        { fileIndex: 1, uri: 'https://mirror.example/native-one' },
      ],
    });

    expect(normalized.torrentWebSeeds).toEqual([
      { fileIndex: 1, uri: 'https://mirror.example/one' },
    ]);
    expect(normalized.torrentWebSeedsNative).toEqual([
      { fileIndex: 1, uri: 'https://mirror.example/native-one' },
    ]);
  });

  it('migrates legacy Torrent credential context before restart resume', () => {
    const normalized = normalizePersistedDownloadProgress({
      id: 'legacy-torrent-credentials',
      url: 'torrent:0123456789abcdef0123456789abcdef01234567',
      fileName: 'payload',
      status: 'paused',
      category: 'Other',
      dateAdded: '',
      isTorrent: true,
      torrentPath: '/managed/legacy-torrent.torrent',
      torrentInfoHash: '0123456789abcdef0123456789abcdef01234567',
      username: 'browser-user',
      password: 'secret',
      headers: 'User-Agent: browser',
      cookies: 'session=metadata-only',
      credentialsRequired: true,
    });

    expect(normalized).toMatchObject({
      isTorrent: true,
      torrentPath: '/managed/legacy-torrent.torrent',
      torrentInfoHash: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(normalized.username).toBeUndefined();
    expect(normalized.password).toBeUndefined();
    expect(normalized.headers).toBeUndefined();
    expect(normalized.cookies).toBeUndefined();
    expect(normalized.credentialsRequired).toBeUndefined();
  });

  it('recovers an interrupted Torrent move without discarding the native destination marker', () => {
    const normalized = normalizePersistedDownloadProgress({
      id: 'interrupted-torrent-move',
      url: 'magnet:?xt=urn:btih:bad',
      fileName: 'payload',
      status: 'moving',
      category: 'Other',
      dateAdded: '',
      destination: '/downloads/new',
      torrentMoveDestination: '/downloads/new',
      torrentMoveRestoreStatus: 'paused'
    });

    expect(normalized.status).toBe('paused');
    expect(normalized.torrentMoveDestination).toBe('/downloads/new');
    expect(normalized.torrentMoveRestoreStatus).toBe('paused');
  });

  it('normalizes proxy settings for download dispatch', async () => {
    expect(normalizeCustomProxy('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
    expect(normalizeCustomProxy('http://proxy.local:9000', 8080)).toBe('http://proxy.local:9000');
    expect(normalizeCustomProxy(' socks5://127.0.0.1 ', 1080)).toBeNull();
    expect(normalizeCustomProxy('https://proxy.local', 8443)).toBeNull();
    expect(normalizeCustomProxy('127.0.0.1', NaN)).toBeNull();
    expect(normalizeCustomProxy('127.0.0.1:9000', 8080)).toBeNull();
    expect(normalizeCustomProxy('127.0.0.1/path', 8080)).toBeNull();
    expect(normalizeCustomProxy('[::1]', 8080)).toBe('http://[::1]:8080');

    expect(await getProxyArgs({
      proxyMode: 'none',
      proxyHost: '',
      proxyPort: 8080
    } as ReturnType<typeof useSettingsStore.getState>)).toBe('none');

    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce(null);
    expect(await getProxyArgs({
      proxyMode: 'system',
      proxyHost: '',
      proxyPort: 8080
    } as ReturnType<typeof useSettingsStore.getState>)).toBe('none');

    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('system settings unavailable'));
    await expect(getProxyArgs({
      proxyMode: 'system',
      proxyHost: '',
      proxyPort: 8080
    } as ReturnType<typeof useSettingsStore.getState>)).rejects.toThrow(
      'System proxy configuration could not be read: system settings unavailable'
    );

    expect(await getProxyArgs({
      proxyMode: 'custom',
      proxyHost: 'http://127.0.0.1',
      proxyPort: 1080
    } as ReturnType<typeof useSettingsStore.getState>)).toBe('http://127.0.0.1:1080');
  });

  it('keeps an item queued when system proxy resolution fails closed', async () => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...useSettingsStore.getState(),
      proxyMode: 'system'
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'get_system_proxy') {
        throw new Error('system settings unavailable');
      }
      return undefined;
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'system-proxy-blocked',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }] as any[],
      backendRegisteredIds: new Set()
    });

    await expect(dispatchItem('system-proxy-blocked')).resolves.toBe(false);

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'queued',
      lastError: 'System proxy configuration could not be read: system settings unavailable. Choose No Proxy or try again.'
    });
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_download', expect.anything());
  });

  it('keeps destination permission failures retryable before backend admission', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'enqueue_download') {
        throw new Error('Internal error: destination access retryable: Firelink could not write to the selected folder; grant access and retry');
      }
      return undefined;
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'destination-permission',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'ready',
        category: 'Other',
        dateAdded: ''
      }] as any[],
      backendRegisteredIds: new Set()
    });

    await expect(dispatchItem('destination-permission')).resolves.toBe(false);

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'ready',
      lastError: 'Firelink could not write to the selected folder; grant access and retry',
      lastErrorKind: 'destinationAccess'
    });
  });

  it('matches site logins by host, wildcard host, path, and full URL patterns', () => {
    const settings = {
      siteLogins: [
        { id: 'host', urlPattern: 'example.com', username: 'host' },
        { id: 'wildcard', urlPattern: '*.cdn.example.com', username: 'wildcard' },
        { id: 'broad', urlPattern: '*.example.com', username: 'broad' },
        { id: 'path', urlPattern: 'secure.example.com/private/*', username: 'path' },
        { id: 'url', urlPattern: 'https://downloads.example.net/releases/*', username: 'url' }
      ]
    } as ReturnType<typeof useSettingsStore.getState>;

    expect(getSiteLogin('https://example.com/file.zip', settings)?.id).toBe('host');
    expect(getSiteLogin('https://assets.cdn.example.com/file.zip', settings)?.id).toBe('wildcard');
    expect(getSiteLogin('https://secure.example.com/private/file.zip', settings)?.id).toBe('path');
    expect(getSiteLogin('https://downloads.example.net/releases/app.zip', settings)?.id).toBe('url');
    expect(getSiteLogin('https://secure.example.com/public/file.zip', settings)?.id).toBe('broad');
    expect(getSiteLogin('https://unrelated.example.org/public/file.zip', settings)).toBeNull();
  });

  it('Start Queue dispatches exactly once for mixed dispatched/undispatched items', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: '1', url: 'http://test1', fileName: 'f1', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: true },
        { id: '2', url: 'http://test2', fileName: 'f2', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
      ] as any[],
      backendRegisteredIds: new Set(['1']), // 1 is already registered, so it skips dispatch
      pendingOrder: ['1'],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['1', '2'];
      return undefined;
    });

    const dispatched = await useDownloadStore.getState().startQueue('MAIN');
    expect(dispatched).toEqual(['1', '2']);

    const calls = vi.mocked(ipc.invokeCommand).mock.calls;
    const enqueues = calls.filter(c => c[0] === 'enqueue_download');
    expect(enqueues.length).toBe(1);
    expect((enqueues[0] as any)[1].item.id).toBe('2');
  });

  it('repairs stale queued backend registrations before accepting a queue start', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'stale', url: 'http://test', fileName: 'f', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: true },
      ] as any[],
      backendRegisteredIds: new Set(['stale']),
      pendingOrder: [],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'resume_download') return false;
      if (cmd === 'get_pending_order') return ['stale'];
      return undefined;
    });

    expect(await useDownloadStore.getState().startQueue('MAIN')).toEqual(['stale']);

    const calls = vi.mocked(ipc.invokeCommand).mock.calls;
    expect(calls.some(call => call[0] === 'resume_download')).toBe(true);
    expect(calls.some(call => call[0] === 'enqueue_download')).toBe(true);
  });

  it('does not overwrite a downloading event received while starting a queue', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: '1', url: 'http://test1', fileName: 'f1', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
      ] as any[],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'enqueue_download') {
        useDownloadStore.getState().updateDownload('1', {
          status: 'downloading',
          speed: '1 MB/s',
          eta: '10s'
        });
      }
      if (cmd === 'get_pending_order') return ['1'];
      return undefined;
    });

    expect(await useDownloadStore.getState().startQueue('MAIN')).toEqual(['1']);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      speed: '1 MB/s',
      eta: '10s',
      hasBeenDispatched: true
    });
  });

  it('dispatches normal reliability and adaptive mirror settings to the native queue', async () => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...useSettingsStore.getState(),
      minimumNormalDownloadSpeedKiB: 64,
      retryNotFoundErrors: true,
      adaptiveMirrorSelection: false,
    } as ReturnType<typeof useSettingsStore.getState>);
    useDownloadStore.setState({
      downloads: [
        { id: 'reliable', url: 'https://example.test/file', fileName: 'file.bin', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
      ] as any[],
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'enqueue_download') return { id: 'reliable', filename: 'file.bin' } as never;
      if (command === 'get_pending_order') return ['reliable'] as never;
      return undefined;
    });

    await useDownloadStore.getState().startQueue('MAIN');

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          minimum_normal_download_speed_kib: 64,
          retry_not_found_errors: true,
          adaptive_mirror_selection: false,
        })
      })
    );
  });

  it('does not resurrect a row removed while its backend enqueue is in flight', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'late', url: 'http://test', fileName: 'late.bin', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
      ] as any[],
    });

    let resolveEnqueue!: (value: { id: string; filename: string }) => void;
    const enqueue = new Promise<{ id: string; filename: string }>(resolve => {
      resolveEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'enqueue_download') return enqueue as never;
      if (command === 'get_pending_order') return Promise.resolve(['late']) as never;
      return Promise.resolve(undefined) as never;
    });

    const start = useDownloadStore.getState().startQueue('MAIN');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'enqueue_download',
        expect.objectContaining({ item: expect.objectContaining({ id: 'late' }) })
      );
    });

    const remove = useDownloadStore.getState().removeDownload('late');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'cancel_enqueue_generation',
        expect.objectContaining({ id: 'late' })
      );
    });
    resolveEnqueue({ id: 'late', filename: 'late.bin' });
    await remove;

    await expect(start).resolves.toEqual([]);
    expect(useDownloadStore.getState().downloads).toEqual([]);
    expect(useDownloadStore.getState().backendRegisteredIds.has('late')).toBe(false);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'remove_download')
    ).toHaveLength(2);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.some(([command, args]) =>
        command === 'remove_download'
        && (args as { expectedLifecycleGeneration?: string })?.expectedLifecycleGeneration === '0'
      )
    ).toBe(true);
  });

  it('does not expose allocation while admission is merely blocked', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'allocation-phase',
        url: 'https://example.test/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'queued',
        category: 'Other',
        dateAdded: '',
        queueId: 'MAIN',
      }] as any[],
      backendRegisteredIds: new Set(),
      allocationPendingIds: new Set(),
    });

    let resolveEnqueue!: (value: { id: string; filename: string }) => void;
    const enqueue = new Promise<{ id: string; filename: string }>(resolve => {
      resolveEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'enqueue_download') return enqueue as never;
      if (command === 'get_pending_order') return Promise.resolve(['allocation-phase']) as never;
      return Promise.resolve(undefined) as never;
    });

    const dispatch = dispatchItem('allocation-phase');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'enqueue_download',
        expect.objectContaining({ item: expect.objectContaining({ id: 'allocation-phase' }) })
      );
    });
    expect(useDownloadStore.getState().allocationPendingIds.has('allocation-phase')).toBe(false);

    resolveEnqueue({ id: 'allocation-phase', filename: 'file.bin' });
    await expect(dispatch).resolves.toBe(true);
    expect(useDownloadStore.getState().allocationPendingIds.has('allocation-phase')).toBe(false);
  });

  it('does not expose Torrent allocation while admission is merely blocked and strips metadata credentials', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'torrent-allocation-phase',
        url: 'torrent:0123456789abcdef0123456789abcdef01234567',
        fileName: 'payload',
        destination: '/tmp',
        status: 'queued',
        category: 'Other',
        dateAdded: '',
        queueId: 'MAIN',
        isTorrent: true,
        torrentFileAllocation: 'prealloc',
        username: 'browser-user',
        password: 'secret',
        headers: 'User-Agent: browser',
        cookies: 'session=metadata-only',
      }] as any[],
      backendRegisteredIds: new Set(),
      allocationPendingIds: new Set(),
    });

    let resolveEnqueue!: (value: { id: string; filename: string }) => void;
    const enqueue = new Promise<{ id: string; filename: string }>(resolve => {
      resolveEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string, args?: unknown) => {
      if (command === 'enqueue_download') {
        expect((args as { item: { username: string | null; password: string | null; headers: string | null; cookies: string | null } }).item)
          .toMatchObject({ username: null, password: null, headers: null, cookies: null });
        return enqueue as never;
      }
      if (command === 'get_pending_order') return Promise.resolve(['torrent-allocation-phase']) as never;
      return Promise.resolve(undefined) as never;
    });

    const dispatch = dispatchItem('torrent-allocation-phase');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'enqueue_download',
        expect.objectContaining({ item: expect.objectContaining({ id: 'torrent-allocation-phase' }) })
      );
    });
    expect(useDownloadStore.getState().allocationPendingIds.has('torrent-allocation-phase')).toBe(false);

    resolveEnqueue({ id: 'torrent-allocation-phase', filename: 'payload' });
    await expect(dispatch).resolves.toBe(true);
    expect(useDownloadStore.getState().allocationPendingIds.has('torrent-allocation-phase')).toBe(false);
  });

  it('clears allocation state when a terminal status wins the race', () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'allocation-terminal',
        url: 'https://example.test/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: '',
      }] as any[],
      allocationPendingIds: new Set(['allocation-terminal']),
    });

    useDownloadStore.getState().updateDownload('allocation-terminal', {
      status: 'failed',
      lastError: 'disk full',
    });

    expect(useDownloadStore.getState().allocationPendingIds.has('allocation-terminal')).toBe(false);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'failed',
      lastError: 'disk full',
    });
  });

  it('re-enqueues queued transfer edits only after an obsolete dispatch is removed', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'edited', url: 'http://test', fileName: 'old.bin', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false, speedLimit: '128K' },
      ] as any[],
    });

    let resolveFirstEnqueue!: (value: { id: string; filename: string }) => void;
    const firstEnqueue = new Promise<{ id: string; filename: string }>(resolve => {
      resolveFirstEnqueue = resolve;
    });
    let enqueueCount = 0;
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'enqueue_download') {
        enqueueCount += 1;
        return (enqueueCount === 1
          ? firstEnqueue
          : Promise.resolve({ id: 'edited', filename: 'old.bin' })) as never;
      }
      if (command === 'get_pending_order') return Promise.resolve(['edited']) as never;
      return Promise.resolve(undefined) as never;
    });

    const start = useDownloadStore.getState().startQueue('MAIN');
    await vi.waitFor(() => expect(enqueueCount).toBe(1));
    const update = useDownloadStore.getState().applyProperties('edited', { speedLimit: '512K' });
    resolveFirstEnqueue({ id: 'edited', filename: 'old.bin' });

    await expect(update).resolves.toBeUndefined();
    await expect(start).resolves.toEqual([]);
    expect(enqueueCount).toBe(2);
    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith(
      'get_pending_order',
      { queueId: 'MAIN' }
    );
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      fileName: 'old.bin',
      speedLimit: '512K',
      hasBeenDispatched: true,
    });
  });

  it('settles an in-flight dispatch before pausing so it cannot start after pause succeeds', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'paused', url: 'http://test', fileName: 'paused.bin', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
      ] as any[],
    });

    let resolveEnqueue!: (value: { id: string; filename: string }) => void;
    const enqueue = new Promise<{ id: string; filename: string }>(resolve => {
      resolveEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'enqueue_download') return enqueue as never;
      return Promise.resolve(undefined) as never;
    });

    const start = useDownloadStore.getState().startQueue('MAIN');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'enqueue_download',
        expect.objectContaining({ item: expect.objectContaining({ id: 'paused' }) })
      );
    });
    const pause = useDownloadStore.getState().pauseDownload('paused');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'cancel_enqueue_generation',
        expect.objectContaining({ id: 'paused' })
      );
    });
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.some(([command]) => command === 'pause_download')
    ).toBe(false);
    resolveEnqueue({ id: 'paused', filename: 'paused.bin' });

    await expect(pause).resolves.toBeUndefined();
    await expect(start).resolves.toEqual([]);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({ status: 'paused' });
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'remove_download')
    ).toHaveLength(1);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'pause_download')
    ).toHaveLength(1);
  });

  it('resumeDownload unregisters ID and re-dispatches if un-resumable', async () => {
    let enqueueGeneration: string | undefined;
    useDownloadStore.setState({
      downloads: [
        { id: 'resume-generation', url: 'http://test1', fileName: 'f1', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: true },
      ] as any[],
      backendRegisteredIds: new Set(['resume-generation']),
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'resume_download') return false; // Not resumable
      if (cmd === 'enqueue_download') {
        enqueueGeneration = (args as { item: { lifecycle_generation: string } }).item.lifecycle_generation;
        return { id: 'resume-generation', filename: 'f1' };
      }
      if (cmd === 'get_pending_order') return ['resume-generation'];
      return undefined;
    });

    await useDownloadStore.getState().resumeDownload('resume-generation');

    // It should have called resume_download, then unregistered, then enqueue_download
    const calls = vi.mocked(ipc.invokeCommand).mock.calls;
    expect(calls.some(c => c[0] === 'resume_download')).toBe(true);
    expect(calls.some(c => c[0] === 'enqueue_download')).toBe(true);
    expect(calls.find(c => c[0] === 'resume_download')?.[1]).toEqual({
      id: 'resume-generation',
      queueId: 'MAIN'
    });
    expect(enqueueGeneration).toBe('1');
    expect(useDownloadStore.getState().downloads[0].lastTry).toEqual(expect.any(String));
    expect(useDownloadStore.getState().backendRegisteredIds.has('resume-generation')).toBe(true); // Re-registered by dispatchItem
  });

  it('coalesces duplicate resume actions while the backend transition is in flight', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'resume-double-submit',
        url: 'http://test1',
        fileName: 'f1',
        destination: '/tmp',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        hasBeenDispatched: true
      }] as any[],
      backendRegisteredIds: new Set(['resume-double-submit'])
    });

    let releaseResume!: () => void;
    const resumeReleased = new Promise<void>(resolve => {
      releaseResume = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'resume_download') {
        await resumeReleased;
        return true;
      }
      return undefined;
    });

    const first = useDownloadStore.getState().resumeDownload('resume-double-submit');
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'resume_download'))
        .toHaveLength(1);
    });
    const second = useDownloadStore.getState().resumeDownload('resume-double-submit');

    expect(second).toBe(first);
    releaseResume();
    await Promise.all([first, second]);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'resume_download')
    ).toHaveLength(1);
  });

  it('does not re-enqueue when the existing resume RPC fails', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'resume-rpc-error', url: 'http://test1', fileName: 'f1', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: true },
      ] as any[],
      backendRegisteredIds: new Set(['resume-rpc-error']),
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'resume_download') throw new Error('aria2 RPC unavailable');
      return undefined;
    });

    await expect(useDownloadStore.getState().resumeDownload('resume-rpc-error')).resolves.toBe(false);

    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.some(([command]) => command === 'enqueue_download')
    ).toBe(false);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'paused',
      lastTry: expect.any(String),
    });
  });

  it('starts a selected queue block in selection order and moves pending rows to the front', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'other', url: 'http://other', fileName: 'other', destination: '/tmp', status: 'staged', category: 'Other', dateAdded: '', queueId: 'selection-queue', queuePosition: 0 },
        { id: 'selected-a', url: 'http://a', fileName: 'a', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'selection-queue', queuePosition: 1, hasBeenDispatched: true },
        { id: 'selected-b', url: 'http://b', fileName: 'b', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'selection-queue', queuePosition: 2, hasBeenDispatched: true },
      ] as any[],
      backendRegisteredIds: new Set(['selected-a', 'selected-b'])
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'enqueue_download') {
        const id = (args as { item: { id: string } }).item.id;
        return { id, filename: id };
      }
      if (command === 'get_pending_order') return ['selected-b', 'selected-a', 'other'];
      if (command === 'move_many_in_queue') return ['selected-b', 'selected-a', 'other'];
      return undefined;
    });

    await expect(useDownloadStore.getState().startSelected(['selected-b', 'selected-a'])).resolves.toBe(2);

    const enqueueIds = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'enqueue_download')
      .map(([, args]) => (args as { item: { id: string } }).item.id);
    expect(enqueueIds).toEqual(['selected-b', 'selected-a']);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('move_many_in_queue', {
      ids: ['selected-b', 'selected-a'],
      queueId: 'selection-queue',
      direction: 'up',
      targetIndex: 0,
    });
    expect(useDownloadStore.getState().downloads.map(item => item.id)).toEqual([
      'other',
      'selected-a',
      'selected-b',
    ]);
    expect(useDownloadStore.getState().downloads.find(item => item.id === 'selected-b')?.queuePosition).toBe(0);
    expect(useDownloadStore.getState().downloads.find(item => item.id === 'selected-a')?.queuePosition).toBe(1);
  });

  it('resumes a selected block whose paused rows were never dispatched', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'selected-undispatched-a', url: 'http://a', fileName: 'a', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'selection-undispatched', queuePosition: 0, hasBeenDispatched: false },
        { id: 'selected-undispatched-b', url: 'http://b', fileName: 'b', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'selection-undispatched', queuePosition: 1, hasBeenDispatched: false },
      ] as any[],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'enqueue_download') {
        const id = (args as { item: { id: string } }).item.id;
        return { id, filename: id };
      }
      if (command === 'get_pending_order') return ['selected-undispatched-a', 'selected-undispatched-b'];
      if (command === 'move_many_in_queue') return ['selected-undispatched-a', 'selected-undispatched-b'];
      return undefined;
    });

    await expect(useDownloadStore.getState().startSelected([
      'selected-undispatched-a',
      'selected-undispatched-b'
    ])).resolves.toBe(2);

    const enqueueIds = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'enqueue_download')
      .map(([, args]) => (args as { item: { id: string } }).item.id);
    expect(enqueueIds).toEqual(['selected-undispatched-a', 'selected-undispatched-b']);
  });

  it('limits credentialless selected resume to the explicitly approved rows', async () => {
    useDownloadStore.setState({
      downloads: [
        {
          id: 'selected-with-credentials',
          url: 'http://with-credentials',
          fileName: 'with-credentials',
          destination: '/tmp',
          status: 'paused',
          category: 'Other',
          dateAdded: '',
          queueId: 'selection-credential-scope',
          queuePosition: 0,
          password: 'secret',
        },
        {
          id: 'selected-without-credentials',
          url: 'http://without-credentials',
          fileName: 'without-credentials',
          destination: '/tmp',
          status: 'paused',
          category: 'Other',
          dateAdded: '',
          queueId: 'selection-credential-scope',
          queuePosition: 1,
          credentialsRequired: true,
        },
      ] as any[],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'enqueue_download') {
        const item = (args as { item: { id: string; password: string | null } }).item;
        return { id: item.id, filename: item.id };
      }
      if (command === 'get_pending_order') return [
        'selected-with-credentials',
        'selected-without-credentials',
      ];
      if (command === 'move_many_in_queue') return [
        'selected-with-credentials',
        'selected-without-credentials',
      ];
      return undefined;
    });

    await expect(useDownloadStore.getState().startSelected([
      'selected-with-credentials',
      'selected-without-credentials',
    ], {
      resumeWithoutCredentialsIds: ['selected-without-credentials'],
    })).resolves.toBe(2);

    const enqueues = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'enqueue_download')
      .map(([, args]) => (args as { item: { id: string; password: string | null } }).item);
    expect(enqueues).toEqual([
      expect.objectContaining({ id: 'selected-with-credentials', password: 'secret' }),
      expect.objectContaining({ id: 'selected-without-credentials', password: null }),
    ]);
  });

  it('pauses queued items through the global pause action', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'queued-one', url: 'http://one', fileName: 'one', status: 'queued', category: 'Other', dateAdded: '', queueId: 'pause-queue' },
        { id: 'queued-two', url: 'http://two', fileName: 'two', status: 'queued', category: 'Other', dateAdded: '', queueId: 'pause-queue' },
        { id: 'staged-one', url: 'http://staged', fileName: 'staged', status: 'staged', category: 'Other', dateAdded: '', queueId: 'pause-queue' },
      ] as any[],
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await expect(useDownloadStore.getState().pauseAll()).resolves.toBe(3);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'pause_download')
    ).toHaveLength(3);
    expect(useDownloadStore.getState().downloads.every(item => item.status === 'paused')).toBe(true);
  });

  it('moves a paused row behind the remaining runnable queue rows', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'active', status: 'downloading', queueId: 'ordered-pause', queuePosition: 0 },
        { id: 'queued-one', status: 'queued', queueId: 'ordered-pause', queuePosition: 1 },
        { id: 'pause-target', status: 'queued', queueId: 'ordered-pause', queuePosition: 2 },
        { id: 'queued-two', status: 'queued', queueId: 'ordered-pause', queuePosition: 3 }
      ] as any[],
      pendingOrder: ['queued-one', 'pause-target', 'queued-two']
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().pauseDownload('pause-target');

    const ordered = useDownloadStore.getState().downloads
      .filter(download => download.queueId === 'ordered-pause')
      .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
    expect(ordered.map(download => download.id)).toEqual([
      'active', 'queued-one', 'queued-two', 'pause-target'
    ]);
    expect(ordered.map(download => download.queuePosition)).toEqual([0, 1, 2, 3]);
    expect(useDownloadStore.getState().pendingOrder).toEqual(['queued-one', 'queued-two']);
    expect(useDownloadStore.getState().downloads.find(download => download.id === 'pause-target')?.status)
      .toBe('paused');
  });

  it('does not let a queue pause lose a selected start in flight', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'race-first', url: 'http://first', fileName: 'first', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'race-selected', queuePosition: 0 },
        { id: 'race-second', url: 'http://second', fileName: 'second', destination: '/tmp', status: 'paused', category: 'Other', dateAdded: '', queueId: 'race-selected', queuePosition: 1 },
      ] as any[],
    });

    let releaseEnqueue!: (value: { id: string; filename: string }) => void;
    const enqueue = new Promise<{ id: string; filename: string }>(resolve => {
      releaseEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'enqueue_download') return enqueue;
      if (command === 'get_pending_order') return [];
      return undefined;
    });

    const start = useDownloadStore.getState().startSelected(['race-first', 'race-second']);
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith(
        'enqueue_download',
        expect.objectContaining({ item: expect.objectContaining({ id: 'race-first' }) })
      );
    });

    const pause = useDownloadStore.getState().pauseQueue('race-selected');
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'cancel_enqueue_generation'))
        .toHaveLength(2);
    });
    releaseEnqueue({ id: 'race-first', filename: 'first' });

    await expect(start).resolves.toBe(0);
    await expect(pause).resolves.toBe(1);
    expect(useDownloadStore.getState().downloads.map(item => item.status)).toEqual(['paused', 'paused']);
    expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'pause_download'))
      .toHaveLength(1);
  });

  it('cleans an accepted backend enqueue when queue reconciliation fails', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'enqueue-reconcile-error', url: 'http://test1', fileName: 'f1', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
      ] as any[],
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'enqueue_download') return { id: 'enqueue-reconcile-error', filename: 'f1' };
      if (cmd === 'get_pending_order') throw new Error('queue state unavailable');
      return undefined;
    });

    await expect(useDownloadStore.getState().startQueue('MAIN')).resolves.toEqual([]);

    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.some(([command]) => command === 'remove_download')
    ).toBe(true);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'failed',
      lastError: 'queue state unavailable',
    });
  });


  it('adds to the selected queue without dispatching', async () => {
    useDownloadStore.setState({
      queues: [
        { id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true },
        { id: 'queue-b', name: 'Downloads', isMain: false }
      ]
    });
    await useDownloadStore.getState().addDownload({
      id: 'queue-1',
      url: 'https://example.com/queue.bin',
      fileName: 'queue.bin',
      category: 'Other',
      dateAdded: ''
    }, { type: 'add-to-queue', queueId: 'queue-b' });

    const item = useDownloadStore.getState().downloads[0];
    expect(item.status).toBe('staged');
    expect(item.queueId).toBe('queue-b');
    expect(item.queuePosition).toBe(0);
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_download', expect.anything());
  });

  it('rejects Add-to-Queue admission when the selected queue was deleted', async () => {
    useDownloadStore.setState({
      queues: [{ id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true }]
    });

    await expect(useDownloadStore.getState().addDownload({
      id: 'orphaned-queue-row',
      url: 'https://example.com/orphaned.bin',
      fileName: 'orphaned.bin',
      category: 'Other',
      dateAdded: ''
    }, { type: 'add-to-queue', queueId: 'deleted-queue' })).rejects.toThrow('Queue no longer exists.');

    expect(useDownloadStore.getState().downloads).toEqual([]);
    expect(vi.mocked(ipc.invokeCommand)).not.toHaveBeenCalledWith('db_commit_download_state', expect.anything());
  });

  it('waits for durable admission before dispatching a start-now download', async () => {
    const disposePersistence = initializeDownloadPersistence('main');
    const events: string[] = [];
    let releaseCommit!: () => void;
    let signalCommitStarted!: () => void;
    const commitStarted = new Promise<void>(resolve => {
      signalCommitStarted = resolve;
    });
    const commitGate = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'db_commit_download_state') {
        events.push('commit-start');
        signalCommitStarted();
        await commitGate;
        events.push('commit-complete');
        return undefined;
      }
      if (command === 'enqueue_download') {
        events.push('enqueue');
        return { id: 'durable-admission', filename: 'file.bin' };
      }
      if (command === 'get_pending_order') return [];
      return undefined;
    });

    try {
      const adding = useDownloadStore.getState().addDownload({
        id: 'durable-admission',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        category: 'Other',
        dateAdded: ''
      }, { type: 'start-now' });

      await commitStarted;
      expect(events).toEqual(['commit-start']);
      expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_download', expect.anything());

      releaseCommit();
      await expect(adding).resolves.toBe(true);
      const enqueueIndex = events.indexOf('enqueue');
      expect(enqueueIndex).toBeGreaterThan(0);
      expect(events.slice(0, enqueueIndex).filter(event => event === 'commit-start').length)
        .toBe(events.slice(0, enqueueIndex).filter(event => event === 'commit-complete').length);
    } finally {
      disposePersistence();
    }
  });

  it('does not dispatch when durable admission fails', async () => {
    const disposePersistence = initializeDownloadPersistence('main');
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'db_commit_download_state') {
        throw new Error('database unavailable');
      }
      if (command === 'enqueue_download') {
        throw new Error('enqueue must not run');
      }
      return undefined;
    });

    try {
      await expect(useDownloadStore.getState().addDownload({
        id: 'durable-admission-failure',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        category: 'Other',
        dateAdded: ''
      }, { type: 'start-now' })).resolves.toBe(false);
      expect(useDownloadStore.getState().downloads[0]).toMatchObject({
        id: 'durable-admission-failure',
        status: 'failed',
        lastError: 'database unavailable'
      });
      expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_download', expect.anything());
    } finally {
      disposePersistence();
    }
  });

  it('does not enqueue after a lifecycle is invalidated during durable admission', async () => {
    const disposePersistence = initializeDownloadPersistence('main');
    let releaseCommit!: () => void;
    let signalCommitStarted!: () => void;
    const commitStarted = new Promise<void>(resolve => {
      signalCommitStarted = resolve;
    });
    const commitGate = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'db_commit_download_state') {
        signalCommitStarted();
        await commitGate;
        return undefined;
      }
      if (command === 'enqueue_download') {
        throw new Error('stale dispatch must not enqueue');
      }
      return undefined;
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'admission-lifecycle-race',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }] as any[]
    });

    try {
      const dispatching = dispatchItem('admission-lifecycle-race');
      await commitStarted;
      const pausing = useDownloadStore.getState().pauseDownload('admission-lifecycle-race');
      releaseCommit();

      await expect(dispatching).resolves.toBe(false);
      await expect(pausing).resolves.toBeUndefined();
      expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_download', expect.anything());
      expect(useDownloadStore.getState().downloads[0].status).toBe('paused');
    } finally {
      disposePersistence();
    }
  });

  it('waits for the latest full snapshot when state changes during a durable commit', async () => {
    const disposePersistence = initializeDownloadPersistence('main');
    const persistedIds: string[] = [];
    let releaseFirstCommit!: () => void;
    let signalFirstCommit!: () => void;
    const firstCommitStarted = new Promise<void>(resolve => {
      signalFirstCommit = resolve;
    });
    const firstCommitGate = new Promise<void>(resolve => {
      releaseFirstCommit = resolve;
    });
    let commitCount = 0;
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: any) => {
      if (command === 'db_commit_download_state') {
        persistedIds.push((JSON.parse(args.downloadsData) as Array<{ id: string }>)[0]?.id || 'empty');
        commitCount += 1;
        if (commitCount === 1) {
          signalFirstCommit();
          await firstCommitGate;
        }
        return undefined;
      }
      return undefined;
    });
    const first = {
      id: 'commit-first',
      url: 'https://example.com/first',
      fileName: 'first.bin',
      status: 'ready' as const,
      category: 'Other' as const,
      dateAdded: ''
    };
    const second = { ...first, id: 'commit-second', fileName: 'second.bin' };

    try {
      useDownloadStore.setState({ downloads: [first] as any[] });
      await firstCommitStarted;
      const committing = commitDownloadState();
      useDownloadStore.setState({ downloads: [second] as any[] });
      releaseFirstCommit();

      await committing;
      expect(persistedIds).toEqual(['commit-first', 'commit-second']);
    } finally {
      disposePersistence();
    }
  });

  it('does not leave an older in-flight snapshot after state returns to the committed value', async () => {
    const disposePersistence = initializeDownloadPersistence('main');
    const persistedIds: string[] = [];
    let releaseFirstCommit!: () => void;
    let signalFirstCommit!: () => void;
    const firstCommitStarted = new Promise<void>(resolve => {
      signalFirstCommit = resolve;
    });
    const firstCommitGate = new Promise<void>(resolve => {
      releaseFirstCommit = resolve;
    });
    let commitCount = 0;
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: any) => {
      if (command === 'db_commit_download_state') {
        const records = JSON.parse(args.downloadsData) as Array<{ id: string }>;
        persistedIds.push(records[0]?.id || 'empty');
        commitCount += 1;
        if (commitCount === 1) {
          signalFirstCommit();
          await firstCommitGate;
        }
        return undefined;
      }
      return undefined;
    });

    try {
      const first = {
        id: 'snapshot-a',
        url: 'https://example.com/a',
        fileName: 'a.bin',
        status: 'ready' as const,
        category: 'Other' as const,
        dateAdded: ''
      };
      const second = { ...first, id: 'snapshot-b', fileName: 'b.bin' };
      useDownloadStore.setState({ downloads: [first] as any[] });
      await firstCommitStarted;
      useDownloadStore.setState({ downloads: [second] as any[] });
      useDownloadStore.setState({ downloads: [first] as any[] });

      releaseFirstCommit();
      await flushDownloadPersistence();

      expect(persistedIds).toEqual(['snapshot-a', 'snapshot-a']);
    } finally {
      disposePersistence();
    }
  });

  it('waits for durable queued state before resuming an existing lifecycle', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'durable-resume',
        url: 'https://example.com/resume.bin',
        fileName: 'resume.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        queueId: 'main'
      }] as any[]
    });
    const disposePersistence = initializeDownloadPersistence('main');
    let releaseCommit!: () => void;
    let signalCommitStarted!: () => void;
    const commitStarted = new Promise<void>(resolve => {
      signalCommitStarted = resolve;
    });
    const commitGate = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'db_commit_download_state') {
        signalCommitStarted();
        await commitGate;
        return undefined;
      }
      if (command === 'resume_download') return true;
      return undefined;
    });

    try {
      const resuming = useDownloadStore.getState().resumeDownload('durable-resume');
      await commitStarted;
      expect(ipc.invokeCommand).not.toHaveBeenCalledWith('resume_download', expect.anything());

      releaseCommit();
      await expect(resuming).resolves.toBe(true);
      expect(ipc.invokeCommand).toHaveBeenCalledWith('resume_download', {
        id: 'durable-resume',
        queueId: 'main'
      });
    } finally {
      disposePersistence();
    }
  });

  it('normalizes new Torrent rows before resolving their default destination', async () => {
    useDownloadStore.setState({
      queues: [
        { id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true },
        { id: 'queue-torrents', name: 'Torrents', isMain: false }
      ]
    });
    await useDownloadStore.getState().addDownload({
      id: 'torrent-default',
      url: 'magnet:?xt=urn:btih:default',
      fileName: 'metadata',
      category: 'Other',
      dateAdded: '',
      isTorrent: true
    }, { type: 'add-to-queue', queueId: 'queue-torrents' });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      category: 'Torrents',
      destination: '/Users/test/Downloads/Torrents',
      status: 'staged'
    });
  });

  it('inserts a newly staged queue item before paused rows', async () => {
    useDownloadStore.setState({
      queues: [
        { id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true },
        { id: 'queue-b', name: 'Downloads', isMain: false }
      ]
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'already-paused',
        url: 'https://example.com/paused.bin',
        fileName: 'paused.bin',
        category: 'Other',
        dateAdded: '',
        status: 'paused',
        queueId: 'queue-b',
        queuePosition: 0
      }] as any[]
    });

    await useDownloadStore.getState().addDownload({
      id: 'new-staged',
      url: 'https://example.com/new.bin',
      fileName: 'new.bin',
      category: 'Other',
      dateAdded: ''
    }, { type: 'add-to-queue', queueId: 'queue-b' });

    const ordered = useDownloadStore.getState().downloads
      .filter(item => item.queueId === 'queue-b')
      .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
    expect(ordered.map(item => item.id)).toEqual(['new-staged', 'already-paused']);
    expect(ordered.map(item => item.queuePosition)).toEqual([0, 1]);
  });

  it('carries a media format estimate into numeric progress state', async () => {
    useDownloadStore.setState({
      queues: [
        { id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true },
        { id: 'queue-b', name: 'Downloads', isMain: false }
      ]
    });
    await useDownloadStore.getState().addDownload({
      id: 'media-estimate',
      url: 'https://youtube.com/watch?v=estimate',
      fileName: 'video.mkv',
      category: 'Movies',
      dateAdded: '',
      isMedia: true,
      size: '~85.7 MB',
      sizeBytes: 89_817_907
    }, { type: 'add-to-queue', queueId: 'queue-b' });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      totalBytes: 89_817_907,
      totalIsEstimate: true
    });
    expect(useDownloadStore.getState().downloads[0]).not.toHaveProperty('sizeBytes');
  });

  it('starts immediately in the main queue', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['start-1'];
      return undefined;
    });

    await useDownloadStore.getState().addDownload({
      id: 'start-1',
      url: 'https://example.com/start.bin',
      fileName: 'start.bin',
      category: 'Other',
      dateAdded: '',
      isTorrent: true,
      torrentCheckIntegrity: true,
      torrentTrackers: 'https://tracker.example/announce',
      torrentExcludeTrackers: '*',
      torrentTrackerConnectTimeout: 11,
      torrentTrackerTimeout: 22,
      torrentTrackerInterval: 33,
      torrentStopTimeout: 300,
      torrentPrioritizePiece: 'head=1M,tail=1M',
      torrentEncryptionPolicy: 'force-encryption',
      torrentFileIndices: [1],
      torrentRemoveUnselectedFile: true
    }, { type: 'start-now' });

    const item = useDownloadStore.getState().downloads[0];
    expect(item.queueId).toBe('00000000-0000-0000-0000-000000000001');
    expect(item.hasBeenDispatched).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'start-1',
          torrent_check_integrity: true,
          torrent_trackers: 'https://tracker.example/announce',
          torrent_exclude_trackers: '*',
          torrent_tracker_connect_timeout: 11,
          torrent_tracker_timeout: 22,
          torrent_tracker_interval: 33,
          torrent_stop_timeout: 300,
          torrent_prioritize_piece: 'head=1M,tail=1M',
          torrent_encryption_policy: 'force-encryption',
          torrent_file_indices: [1],
          torrent_remove_unselected_file: true
        })
      })
    );
  });

  it('does not replace an explicit no-limit item speed with the global speed limit', async () => {
    const defaultSettings = useSettingsStore.getState();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...defaultSettings,
      globalSpeedLimit: '2M'
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['uncapped'];
      return undefined;
    });

    await useDownloadStore.getState().addDownload({
      id: 'uncapped',
      url: 'https://example.com/uncapped.bin',
      fileName: 'uncapped.bin',
      category: 'Other',
      dateAdded: '',
      speedLimit: '0'
    }, { type: 'start-now' });

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'uncapped',
          speed_limit: '0'
        })
      })
    );
  });

  it('does not copy the global speed limit into a normal download task', async () => {
    const defaultSettings = useSettingsStore.getState();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...defaultSettings,
      globalSpeedLimit: '2M'
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['inherits-global'];
      return undefined;
    });

    await useDownloadStore.getState().addDownload({
      id: 'inherits-global',
      url: 'https://example.com/inherits-global.bin',
      fileName: 'inherits-global.bin',
      category: 'Other',
      dateAdded: ''
    }, { type: 'start-now' });

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'inherits-global',
          speed_limit: null
        })
      })
    );
  });

  it('passes the global speed limit to a new media process when it has no item override', async () => {
    const defaultSettings = useSettingsStore.getState();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...defaultSettings,
      globalSpeedLimit: '2M'
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['inherits-global-media'];
      return undefined;
    });

    await useDownloadStore.getState().addDownload({
      id: 'inherits-global-media',
      url: 'https://www.youtube.com/watch?v=example',
      fileName: 'media.mp4',
      category: 'Movies',
      dateAdded: '',
      isMedia: true
    }, { type: 'start-now' });

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'inherits-global-media',
          speed_limit: '2M'
        })
      })
    );
  });

  it('treats the legacy media zero sentinel as inheriting the global limit', async () => {
    const defaultSettings = useSettingsStore.getState();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...defaultSettings,
      globalSpeedLimit: '2M'
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['legacy-media-limit'];
      return undefined;
    });

    await useDownloadStore.getState().addDownload({
      id: 'legacy-media-limit',
      url: 'https://www.youtube.com/watch?v=legacy',
      fileName: 'media.mp4',
      category: 'Movies',
      dateAdded: '',
      isMedia: true,
      speedLimit: '0'
    }, { type: 'start-now' });

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'legacy-media-limit',
          speed_limit: '2M'
        })
      })
    );
  });

  it('reports a rejected immediate start instead of claiming success', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'enqueue_download') {
        throw new Error('backend unavailable');
      }
      return undefined;
    });

    const added = await useDownloadStore.getState().addDownload({
      id: 'rejected-start',
      url: 'https://example.com/rejected.bin',
      fileName: 'rejected.bin',
      category: 'Other',
      dateAdded: ''
    }, { type: 'start-now' });

    expect(added).toBe(false);
    expect(useDownloadStore.getState().downloads[0].status).toBe('failed');
    expect(useDownloadStore.getState().downloads[0].lastError).toBe('backend unavailable');
  });

  it('blocks credential-backed dispatch until the custom access decision is made', async () => {
    const setShowKeychainModal = vi.fn();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...useSettingsStore.getState(),
      siteLogins: [{ id: 'dispatch-login', urlPattern: 'secure.example.com', username: 'user' }],
      keychainAccessReady: false,
      keychainPromptDismissed: false,
      setShowKeychainModal
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    useDownloadStore.setState({
      downloads: [{
        id: 'credential-gated-dispatch',
        url: 'https://secure.example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'ready',
        category: 'Other',
        dateAdded: ''
      }] as any[],
      backendRegisteredIds: new Set()
    });

    await expect(dispatchItem('credential-gated-dispatch')).resolves.toBe(false);

    expect(setShowKeychainModal).toHaveBeenCalledWith(true);
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('get_keychain_password', expect.anything());
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_download', expect.anything());
  });

  it('does not resume a paused backend lifecycle without restored credentials', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'credential-resume-gated',
        url: 'https://secure.example.com/file.bin',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        username: 'alice',
        headers: 'Referer: https://example.com/page',
        credentialsRequired: true
      }] as any[],
      backendRegisteredIds: new Set(['credential-resume-gated'])
    });

    await expect(useDownloadStore.getState().resumeDownload('credential-resume-gated'))
      .resolves.toBe(false);

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
      'resume_download',
      expect.anything()
    );
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');
  });

  it('explicitly requeues a credential-marked download without saved credentials', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'credentialless-resume',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        credentialsRequired: true,
        hasBeenDispatched: true,
      }] as any[],
      backendRegisteredIds: new Set(['credentialless-resume'])
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'get_pending_order') return ['credentialless-resume'];
      if (command === 'enqueue_download') return { id: 'credentialless-resume', filename: 'file.bin' };
      return undefined;
    });

    await expect(useDownloadStore.getState().resumeDownload('credentialless-resume', {
      resumeWithoutCredentials: true
    })).resolves.toBe(true);

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('resume_download', expect.anything());
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('get_keychain_password', expect.anything());
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          username: null,
          password: null,
          cookies: null,
          headers: null,
        })
      })
    );
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      credentialsRequired: false,
      status: 'queued',
    });
  });

  it('preserves backend rejection reasons while auto-resuming saved queued items', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-failed',
          url: 'https://example.com/file.bin',
          fileName: 'file.bin',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (cmd === 'enqueue_many') {
        return [{
          id: 'startup-failed',
          success: false,
          error: 'aria2 addUri failed: connection refused'
        }];
      }
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    await useDownloadStore.getState().resumePendingDownloads();

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'failed',
      lastError: 'aria2 addUri failed: connection refused'
    });
  });

  it('keeps startup destination permission failures retryable without backend registration', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-destination-access',
          url: 'https://example.com/file.bin',
          fileName: 'file.bin',
          destination: '/protected',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (cmd === 'enqueue_many') {
        return [{
          id: 'startup-destination-access',
          success: false,
          error: 'destination access retryable: grant Firelink access to the selected folder and retry'
        }];
      }
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    await useDownloadStore.getState().resumePendingDownloads();

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'ready',
      hasBeenDispatched: false,
      lastErrorKind: 'destinationAccess',
      lastError: 'grant Firelink access to the selected folder and retry'
    });
    expect(useDownloadStore.getState().backendRegisteredIds.has('startup-destination-access')).toBe(false);
  });

  it('does not show allocation for a startup Torrent batch while it is merely queued', async () => {
    let releaseEnqueue!: (value: Array<{ id: string; success: boolean; filename: string }>) => void;
    const enqueue = new Promise<Array<{ id: string; success: boolean; filename: string }>>(resolve => {
      releaseEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((cmd: string) => {
      if (cmd === 'db_get_all_queues') return Promise.resolve([]) as never;
      if (cmd === 'db_get_all_downloads') {
        return Promise.resolve([JSON.stringify({
          id: 'startup-torrent-allocation',
          url: 'torrent:0123456789abcdef0123456789abcdef01234567',
          fileName: 'payload',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true,
          isTorrent: true,
          torrentFileAllocation: 'prealloc',
          username: 'browser-user',
          password: 'secret',
          headers: 'User-Agent: browser',
          cookies: 'session=metadata-only',
          credentialsRequired: true,
        })]) as never;
      }
      if (cmd === 'enqueue_many') return enqueue as never;
      if (cmd === 'get_pending_order') return Promise.resolve([]) as never;
      return Promise.resolve(undefined) as never;
    });

    await useDownloadStore.getState().initDB();
    const resume = useDownloadStore.getState().resumePendingDownloads();

    await vi.waitFor(() => {
      expect(useDownloadStore.getState().allocationPendingIds.has('startup-torrent-allocation')).toBe(false);
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'enqueue_many',
        expect.objectContaining({
          items: [expect.objectContaining({
            username: null,
            password: null,
            headers: null,
            cookies: null,
          })]
        })
      );
    });

    releaseEnqueue([{ id: 'startup-torrent-allocation', success: true, filename: 'payload' }]);
    await resume;
    expect(useDownloadStore.getState().allocationPendingIds.has('startup-torrent-allocation')).toBe(false);
    expect(useDownloadStore.getState().downloads[0].credentialsRequired).toBeUndefined();
  });

  it('keeps all startup items retryable when system proxy resolution fails', async () => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...useSettingsStore.getState(),
      proxyMode: 'system'
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'db_get_all_queues') return [];
      if (command === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-proxy-blocked',
          url: 'https://example.com/file.bin',
          fileName: 'file.bin',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (command === 'get_system_proxy') {
        throw new Error('system settings unavailable');
      }
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    await useDownloadStore.getState().resumePendingDownloads();

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'queued',
      lastError: 'System proxy configuration could not be read: system settings unavailable. Choose No Proxy or try again.'
    });
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_many', expect.anything());
  });

  it('keeps accepted startup registrations when pending-order refresh fails', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-accepted',
          url: 'https://example.com/file.bin',
          fileName: 'file.bin',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (cmd === 'enqueue_many') {
        return [{ id: 'startup-accepted', success: true, filename: 'normalized.bin' }];
      }
      if (cmd === 'get_pending_order') throw new Error('queue state unavailable');
      if (cmd === 'resume_download') return true;
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    await useDownloadStore.getState().resumePendingDownloads();

    expect(useDownloadStore.getState().backendRegisteredIds.has('startup-accepted')).toBe(true);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      fileName: 'normalized.bin',
      status: 'queued',
      hasBeenDispatched: true
    });

    await expect(useDownloadStore.getState().startQueue('00000000-0000-0000-0000-000000000001'))
      .resolves.toEqual(['startup-accepted']);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(call => call[0] === 'enqueue_download')
    ).toHaveLength(0);
  });

  it('does not restore a registration after a fast startup terminal event', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-completed',
          url: 'https://example.com/file.bin',
          fileName: 'file.bin',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (cmd === 'enqueue_many') {
        useDownloadStore.setState(state => ({
          backendRegisteredIds: new Set(),
          downloads: state.downloads.map(download => download.id === 'startup-completed'
            ? { ...download, status: 'completed' as const }
            : download)
        }));
        return [{ id: 'startup-completed', success: true, filename: 'file.bin' }];
      }
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    await useDownloadStore.getState().resumePendingDownloads();

    expect(useDownloadStore.getState().downloads[0].status).toBe('completed');
    expect(useDownloadStore.getState().backendRegisteredIds.has('startup-completed')).toBe(false);
  });

  it('does not read saved credentials during database initialization', async () => {
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...useSettingsStore.getState(),
      siteLogins: [{ id: 'secure-login', urlPattern: 'secure.example.com', username: 'user' }],
      keychainAccessReady: false
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-credential-gated',
          url: 'https://secure.example.com/file.bin',
          fileName: 'file.bin',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (cmd === 'get_keychain_password') return 'secret';
      if (cmd === 'enqueue_many') return [{ id: 'startup-credential-gated', success: true }];
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
      'get_keychain_password',
      { id: 'secure-login' }
    );
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('enqueue_many', expect.anything());

    vi.mocked(useSettingsStore.getState).mockReturnValue({
      ...useSettingsStore.getState(),
      siteLogins: [{ id: 'secure-login', urlPattern: 'secure.example.com', username: 'user' }],
      keychainAccessReady: true
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    await useDownloadStore.getState().resumePendingDownloads();

    expect(ipc.invokeCommand).toHaveBeenCalledWith('get_keychain_password', { id: 'secure-login' });
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_many',
      expect.objectContaining({
        items: [expect.objectContaining({ password: 'secret' })]
      })
    );
  });

  it('shares one startup-resume operation when callers race', async () => {
    let releaseEnqueue!: () => void;
    const enqueueReleased = new Promise<void>(resolve => {
      releaseEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'startup-single-flight',
          url: 'https://example.com/file.bin',
          fileName: 'file.bin',
          status: 'queued',
          category: 'Other',
          dateAdded: '',
          queueId: '00000000-0000-0000-0000-000000000001',
          hasBeenDispatched: true
        })];
      }
      if (cmd === 'enqueue_many') {
        await enqueueReleased;
        return [{ id: 'startup-single-flight', success: true }];
      }
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    const first = useDownloadStore.getState().resumePendingDownloads();
    const second = useDownloadStore.getState().resumePendingDownloads();
    expect(second).toBe(first);
    await vi.waitFor(() => {
      expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(call => call[0] === 'enqueue_many')).toHaveLength(1);
    });

    releaseEnqueue();
    await Promise.all([first, second]);
  });

  it('redownloads fallback media without requiring a format selector', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'media-fallback',
        url: 'https://youtube.com/watch?v=test',
        fileName: 'watch',
        destination: '/tmp',
        status: 'completed',
        category: 'Other',
        dateAdded: '',
        isMedia: true
      }] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    await useDownloadStore.getState().redownload('media-fallback');

    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({
          is_media: true,
          format_selector: null
        })
      })
    );
  });

  it('does not claim a redownload when removing the old backend lifecycle fails', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'redownload-remove-failed',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'paused',
        category: 'Other',
        dateAdded: '2026-07-15T00:00:00.000Z',
        hasBeenDispatched: true
      }] as any[],
      backendRegisteredIds: new Set(['redownload-remove-failed'])
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'remove_download') throw new Error('aria2 did not stop');
      return undefined;
    });

    await expect(useDownloadStore.getState().redownload('redownload-remove-failed'))
      .rejects.toThrow('aria2 did not stop');
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'paused',
      dateAdded: '2026-07-15T00:00:00.000Z',
      hasBeenDispatched: true
    });
    expect(useDownloadStore.getState().backendRegisteredIds.has('redownload-remove-failed')).toBe(true);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.some(call => call[0] === 'enqueue_download')
    ).toBe(false);
  });

  it('coalesces duplicate redownloads and serializes a destructive removal behind them', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'redownload-double-submit',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        destination: '/tmp',
        status: 'paused',
        category: 'Other',
        dateAdded: ''
      }] as any[]
    });

    let releaseRedownloadRemoval!: () => void;
    const redownloadRemovalReleased = new Promise<void>(resolve => {
      releaseRedownloadRemoval = resolve;
    });
    let removeCallCount = 0;
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'remove_download') {
        removeCallCount += 1;
        if (removeCallCount === 1) await redownloadRemovalReleased;
        return undefined;
      }
      if (cmd === 'get_pending_order') return [];
      return undefined;
    });

    const first = useDownloadStore.getState().redownload('redownload-double-submit');
    await vi.waitFor(() => expect(removeCallCount).toBe(1));
    const second = useDownloadStore.getState().redownload('redownload-double-submit');
    const remove = useDownloadStore.getState().removeDownload('redownload-double-submit');

    expect(second).toBe(first);
    expect(removeCallCount).toBe(1);
    releaseRedownloadRemoval();
    await first;
    await remove;
    expect(removeCallCount).toBe(2);
    expect(useDownloadStore.getState().downloads).toEqual([]);
  });

  it('starts and pauses all items regardless of legacy missing queue ids', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'ready', url: 'http://ready', fileName: 'ready', status: 'ready', category: 'Other', dateAdded: '' },
        { id: 'active', url: 'http://active', fileName: 'active', status: 'processing', category: 'Other', dateAdded: '' },
      ] as any[],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['ready'];
      return undefined;
    });

    expect(await useDownloadStore.getState().startAll()).toBe(1);
    expect(await useDownloadStore.getState().pauseAll()).toBe(2);

    const calls = vi.mocked(ipc.invokeCommand).mock.calls;
    expect(calls.some(call => call[0] === 'enqueue_download')).toBe(true);
    expect(calls.some(call => call[0] === 'pause_download' && (call[1] as any).id === 'active')).toBe(true);
  });

  it('direct queue controls treat missing queue ids as the main queue', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'legacy-ready', url: 'http://ready', fileName: 'ready', status: 'ready', category: 'Other', dateAdded: '' },
        { id: 'legacy-active', url: 'http://active', fileName: 'active', status: 'processing', category: 'Other', dateAdded: '' },
      ] as any[],
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_order') return ['legacy-ready'];
      return undefined;
    });

    await expect(useDownloadStore.getState().startQueue('00000000-0000-0000-0000-000000000001'))
      .resolves.toEqual(['legacy-ready']);
    await expect(useDownloadStore.getState().pauseQueue('00000000-0000-0000-0000-000000000001'))
      .resolves.toBe(2);

    expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'pause_download'))
      .toHaveLength(2);
  });

  it('resumes paused items that were never dispatched through the master start action', async () => {
    useDownloadStore.setState({
      downloads: [
        {
          id: 'paused-before-dispatch',
          url: 'http://paused-before-dispatch',
          fileName: 'paused-before-dispatch',
          destination: '/tmp',
          status: 'paused',
          category: 'Other',
          dateAdded: '',
          queueId: 'MAIN',
          hasBeenDispatched: false
        }
      ] as any[]
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'resume_download') return false;
      if (cmd === 'enqueue_download') {
        const id = (args as { item: { id: string } }).item.id;
        return { id, filename: id };
      }
      if (cmd === 'get_pending_order') return ['paused-before-dispatch'];
      return undefined;
    });

    await expect(useDownloadStore.getState().startAll()).resolves.toBe(1);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('resume_download', {
      id: 'paused-before-dispatch',
      queueId: 'MAIN'
    });
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({ item: expect.objectContaining({ id: 'paused-before-dispatch' }) })
    );
    expect(useDownloadStore.getState().downloads[0].hasBeenDispatched).toBe(true);
  });

  it('resumes an individually paused item that has no backend registration', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'individual-paused-before-dispatch',
        url: 'http://individual-paused-before-dispatch',
        fileName: 'individual-paused-before-dispatch',
        destination: '/tmp',
        status: 'paused',
        category: 'Other',
        dateAdded: '',
        queueId: 'MAIN',
        hasBeenDispatched: false
      }] as any[]
    });

    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'resume_download') return false;
      if (cmd === 'enqueue_download') {
        const id = (args as { item: { id: string } }).item.id;
        return { id, filename: id };
      }
      if (cmd === 'get_pending_order') return ['individual-paused-before-dispatch'];
      return undefined;
    });

    await expect(useDownloadStore.getState().resumeDownload('individual-paused-before-dispatch'))
      .resolves.toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith('resume_download', {
      id: 'individual-paused-before-dispatch',
      queueId: 'MAIN'
    });
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({ item: expect.objectContaining({ id: 'individual-paused-before-dispatch' }) })
    );
    expect(useDownloadStore.getState().downloads[0].hasBeenDispatched).toBe(true);
  });

  it('migrates legacy downloads without queue ids into the main queue', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation(async (cmd: string) => {
      if (cmd === 'db_get_all_queues') return [];
      if (cmd === 'db_get_all_downloads') {
        return [JSON.stringify({
          id: 'legacy',
          url: 'https://example.com/legacy.bin',
          fileName: 'legacy.bin',
          status: 'ready',
          category: 'Other',
          dateAdded: ''
        })];
      }
      return undefined;
    });

    await useDownloadStore.getState().initDB();

    expect(useDownloadStore.getState().downloads[0].queueId)
      .toBe('00000000-0000-0000-0000-000000000001');
  });

  it('pauses queued, downloading, processing, and retrying queue items', async () => {
    useDownloadStore.setState({
      downloads: ['queued', 'downloading', 'processing', 'retrying'].map((status, index) => ({
        id: `${index}`,
        url: `https://example.com/${index}`,
        fileName: `${index}.bin`,
        status,
        category: 'Other',
        dateAdded: '',
        queueId: 'queue-a'
      })) as any[]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    expect(await useDownloadStore.getState().pauseQueue('queue-a')).toBe(4);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(call => call[0] === 'pause_download')
    ).toHaveLength(4);
  });

  it('assigns selected unfinished downloads to a queue without moving completed items', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'ready', status: 'ready', queueId: 'old' },
        { id: 'done', status: 'completed', queueId: 'old' },
        { id: 'paused', status: 'paused', queueId: 'new', queuePosition: 0 }
      ] as any[]
    });

    await useDownloadStore.getState().assignToQueue(['ready', 'done'], 'new');

    expect(useDownloadStore.getState().downloads.find(item => item.id === 'ready')?.queueId).toBe('new');
    expect(useDownloadStore.getState().downloads.find(item => item.id === 'done')?.queueId).toBe('old');
    expect(useDownloadStore.getState().downloads
      .filter(item => item.queueId === 'new')
      .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
      .map(item => item.id)
    ).toEqual(['ready', 'paused']);
  });

  it('does not reassign an item that completes while queue assignment is awaiting cancellation', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'race-ready', status: 'ready', queueId: 'old' },
        { id: 'race-done', status: 'completed', queueId: 'old' }
      ] as any[]
    });

    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>(resolve => {
      resolveCancellation = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'cancel_enqueue_generation') return cancellation as never;
      return Promise.resolve(undefined) as never;
    });

    const assignment = useDownloadStore.getState().assignToQueue(['race-ready', 'race-done'], 'new');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'cancel_enqueue_generation',
        expect.objectContaining({ id: 'race-ready' })
      );
    });
    useDownloadStore.getState().updateDownload('race-ready', { status: 'completed' });
    resolveCancellation();
    await assignment;

    expect(useDownloadStore.getState().downloads.find(item => item.id === 'race-ready')).toMatchObject({
      status: 'completed',
      queueId: 'old'
    });
  });

  it('cancels the rest of a queue start when pause is requested during dispatch', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'queue-first', url: 'http://test/first', fileName: 'first', destination: '/tmp', status: 'ready', category: 'Other', dateAdded: '', queueId: 'race-queue', queuePosition: 0 },
        { id: 'queue-second', url: 'http://test/second', fileName: 'second', destination: '/tmp', status: 'ready', category: 'Other', dateAdded: '', queueId: 'race-queue', queuePosition: 1 }
      ] as any[]
    });

    let resolveEnqueue!: (value: { id: string; filename: string }) => void;
    const enqueue = new Promise<{ id: string; filename: string }>(resolve => {
      resolveEnqueue = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'enqueue_download') return enqueue as never;
      return Promise.resolve(undefined) as never;
    });

    const start = useDownloadStore.getState().startQueue('race-queue');
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        'enqueue_download',
        expect.objectContaining({ item: expect.objectContaining({ id: 'queue-first' }) })
      );
    });
    const pause = useDownloadStore.getState().pauseQueue('race-queue');
    resolveEnqueue({ id: 'queue-first', filename: 'first' });

    await expect(pause).resolves.toBe(1);
    await expect(start).resolves.toEqual([]);
    expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command, args]) =>
        command === 'enqueue_download' && (args as any)?.item?.id === 'queue-second'
      )
    ).toHaveLength(0);
  });

  it('uses one atomic backend move and keeps queue positions unique around active transfers', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'active', status: 'downloading', queueId: 'move-queue', queuePosition: 0 },
        { id: 'one', status: 'queued', queueId: 'move-queue', queuePosition: 1 },
        { id: 'two', status: 'queued', queueId: 'move-queue', queuePosition: 2 },
        { id: 'three', status: 'queued', queueId: 'move-queue', queuePosition: 3 }
      ] as any[],
      backendRegisteredIds: new Set(['three']),
      pendingOrder: ['one', 'two', 'three']
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'move_many_in_queue') return ['one', 'three', 'two'];
      if (command === 'get_pending_order') return ['one', 'three', 'two'];
      return undefined;
    });

    await useDownloadStore.getState().moveInQueue('three', 'up');

    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith('move_many_in_queue', {
      ids: ['three'],
      queueId: 'move-queue',
      direction: 'up'
    });
    expect(vi.mocked(ipc.invokeCommand)).not.toHaveBeenCalledWith('move_in_queue', expect.anything());
    const positions = useDownloadStore.getState().downloads
      .filter(item => item.queueId === 'move-queue')
      .map(item => item.queuePosition);
    expect(new Set(positions).size).toBe(4);
  });

  it('rolls back and rejects a failed keyboard or header queue move', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'first', status: 'queued', queueId: 'move-failure-queue', queuePosition: 0 },
        { id: 'second', status: 'queued', queueId: 'move-failure-queue', queuePosition: 1 }
      ] as any[],
      backendRegisteredIds: new Set(['second'])
    });
    vi.mocked(ipc.invokeCommand).mockRejectedValue(new Error('backend unavailable'));

    await expect(
      useDownloadStore.getState().moveInQueue('second', 'up')
    ).rejects.toThrow('backend unavailable');
    expect(useDownloadStore.getState().downloads.map(item => item.queuePosition)).toEqual([0, 1]);
  });

  it('translates a drag target around staged rows before the atomic backend move', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'a', status: 'queued', queueId: 'drag-queue', queuePosition: 0 },
        { id: 'staged', status: 'staged', queueId: 'drag-queue', queuePosition: 1 },
        { id: 'b', status: 'queued', queueId: 'drag-queue', queuePosition: 2 },
        { id: 'c', status: 'queued', queueId: 'drag-queue', queuePosition: 3 }
      ] as any[],
      backendRegisteredIds: new Set(['a', 'b', 'c']),
      pendingOrder: ['a', 'b', 'c']
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'move_many_in_queue') return ['c', 'a', 'b'];
      if (command === 'get_pending_order') return ['c', 'a', 'b'];
      return undefined;
    });

    await useDownloadStore.getState().moveManyInQueueToPosition('c', 'drag-queue', 0);

    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith('move_many_in_queue', {
      ids: ['c'],
      queueId: 'drag-queue',
      direction: 'up',
      targetIndex: 0
    });
    expect(useDownloadStore.getState().downloads.map(item => item.id).sort()).toEqual(['a', 'b', 'c', 'staged']);
    expect(useDownloadStore.getState().downloads.find(item => item.id === 'c')?.queuePosition).toBe(0);
    expect(useDownloadStore.getState().downloads.find(item => item.id === 'staged')?.queuePosition).toBe(2);
  });

  it('keeps a drag anchored when the queue changes before its serialized operation runs', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'a', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 0 },
        { id: 'b', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 1 },
        { id: 'c', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 2 }
      ] as any[],
      backendRegisteredIds: new Set()
    });

    const operation = useDownloadStore.getState().moveManyInQueueToPosition(
      'b',
      'concurrent-drag-queue',
      2,
      'c'
    );
    useDownloadStore.setState({
      downloads: [
        { id: 'a', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 0 },
        { id: 'b', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 1 },
        { id: 'new', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 2 },
        { id: 'c', status: 'queued', queueId: 'concurrent-drag-queue', queuePosition: 3 }
      ] as any[]
    });

    await operation;

    expect(useDownloadStore.getState().downloads
      .filter(item => item.queueId === 'concurrent-drag-queue')
      .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
      .map(item => item.id)
    ).toEqual(['a', 'new', 'b', 'c']);
  });

  it('rolls back a failed drag move and rejects so the UI can report the failure', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'first', status: 'queued', queueId: 'rollback-queue', queuePosition: 0 },
        { id: 'second', status: 'queued', queueId: 'rollback-queue', queuePosition: 1 }
      ] as any[],
      backendRegisteredIds: new Set(['first', 'second'])
    });
    vi.mocked(ipc.invokeCommand).mockRejectedValue(new Error('backend unavailable'));

    await expect(
      useDownloadStore.getState().moveManyInQueueToPosition('second', 'rollback-queue', 0)
    ).rejects.toThrow('backend unavailable');
    expect(useDownloadStore.getState().downloads.map(item => item.queuePosition)).toEqual([0, 1]);
  });

  it('detaches a registered queued item through the backend before reassigning it', async () => {
    useDownloadStore.setState({
      downloads: [{
        id: 'registered-queued',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: '',
        queueId: 'old',
        queuePosition: 0
      }],
      backendRegisteredIds: new Set(['registered-queued']),
      pendingOrder: ['registered-queued']
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().assignToQueue(['registered-queued'], 'new');

    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith(
      'detach_download_for_reconfigure',
      { id: 'registered-queued' }
    );
    expect(useDownloadStore.getState().pendingOrder).not.toContain('registered-queued');
    expect(useDownloadStore.getState().downloads[0].status).toBe('staged');
  });

  it('disables scheduler when its last selected queue is deleted', async () => {
    const originalSettings = useSettingsStore.getState();
    const setScheduler = vi.fn();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      scheduler: {
        enabled: true,
        selectedQueueIds: ['queue-a']
      },
      setScheduler
    } as any);
    useDownloadStore.setState({
      queues: [
        { id: '00000000-0000-0000-0000-000000000001', name: 'Main Queue', isMain: true },
        { id: 'queue-a', name: 'Scheduled', isMain: false }
      ],
      downloads: []
    });

    await useDownloadStore.getState().removeQueue('queue-a');

    expect(setScheduler).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      selectedQueueIds: []
    }));
    vi.mocked(useSettingsStore.getState).mockReturnValue(originalSettings);
  });

  it('retains the UI item when backend removal fails', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'active', url: 'https://example.com/file', fileName: 'file', status: 'downloading', category: 'Other', dateAdded: '', queueId: 'main' }
      ] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'remove_download') {
        return Promise.reject(new Error('writer did not stop')) as never;
      }
      return Promise.resolve(undefined) as never;
    });

    await expect(useDownloadStore.getState().removeDownload('active', true))
      .rejects.toThrow('writer did not stop');
    expect(useDownloadStore.getState().downloads.map(download => download.id))
      .toEqual(['active']);
  });

  it('clears live progress when a download is removed', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'removed-progress', url: 'https://example.com/file', fileName: 'file', status: 'paused', category: 'Other', dateAdded: '' }
      ] as any[]
    });
    useDownloadProgressStore.getState().updateDownloadProgress('removed-progress', {
      id: 'removed-progress',
      fraction: 0.5,
      speed: '1 MB/s',
      eta: '10s',
      size: '2 MB',
      size_is_final: false
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().removeDownload('removed-progress');

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
  });

  it('asks the backend to preserve resumable assets during replacement removal', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'paused', url: 'https://example.com/file', fileName: 'file', status: 'paused', category: 'Other', dateAdded: '' }
      ] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined as never);

    await useDownloadStore.getState().removeDownload('paused', true, true);

    expect(ipc.invokeCommand).toHaveBeenCalledWith('remove_download', {
      id: 'paused',
      deleteAssets: true,
      preserveResumable: true
    });
  });

  it('starts staged queue items in their persisted queue order', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'later', url: 'https://example.com/later', fileName: 'later', status: 'staged', category: 'Other', dateAdded: '', queueId: 'queue-a', queuePosition: 1 },
        { id: 'first', url: 'https://example.com/first', fileName: 'first', status: 'staged', category: 'Other', dateAdded: '', queueId: 'queue-a', queuePosition: 0 }
      ] as any[]
    });
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'get_pending_order') {
        return [(args as { queueId: string }).queueId === 'queue-a' ? 'first' : 'later'];
      }
      return undefined;
    });

    expect(await useDownloadStore.getState().startQueue('queue-a')).toEqual(['first', 'later']);
    const enqueuedIds = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(call => call[0] === 'enqueue_download')
      .map(call => (call[1] as any).item.id);
    expect(enqueuedIds).toEqual(['first', 'later']);
    expect((vi.mocked(ipc.invokeCommand).mock.calls.find(call =>
      call[0] === 'enqueue_download'
    )?.[1] as any).item.queue_id).toBe('queue-a');
  });

  it('preserves extension request headers and cookies for the Add modal', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://example.com/file.bin'],
      referer: 'https://example.com/page',
      silent: false,
      filename: 'file.bin',
      headers: 'X-Test: value',
      cookies: 'session=secret',
      cookie_scopes: [
        { url: 'https://mail.google.com/', cookies: 'SID=mail-session' },
        { url: 'https://accounts.google.com/', cookies: 'SID=account-session' }
      ],
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });

    const state = useDownloadStore.getState();
    expect(state.isAddModalOpen).toBe(true);
    expect(state.pendingAddUrls).toBe('https://example.com/file.bin');
    expect(state.pendingAddReferer).toBe('https://example.com/page');
    expect(state.pendingAddFilename).toBe('file.bin');
	  expect(state.pendingAddHeaders).toBe('X-Test: value');
	  expect(state.pendingAddCookies).toBe('session=secret');
    expect(state.pendingAddRequestContexts['https://example.com/file.bin'].cookieScopes).toEqual([
      { url: 'https://mail.google.com/', cookies: 'SID=mail-session' },
      { url: 'https://accounts.google.com/', cookies: 'SID=account-session' }
    ]);
    expect(state.pendingAddMediaUrls).toEqual([]);
	 });

 it('does not reuse stale extension metadata for a later single-link handoff', async () => {
  useDownloadStore.setState({
   isAddModalOpen: true,
   pendingAddUrls: '',
   pendingAddReferer: 'https://old.example/page',
	   pendingAddFilename: '7aae36e6-00ec-4e7d-8dec-f14ace170bdb',
	   pendingAddHeaders: 'X-Old: value',
	   pendingAddCookies: 'old=session',
      pendingAddMediaUrls: []
	  });

  await useDownloadStore.getState().handleExtensionDownload({
   urls: ['https://github.com/center2055/OnionHop/releases/download/v3.5/OnionHop-3.5-macOS-arm64.dmg'],
   referer: 'https://github.com/center2055/OnionHop/releases/tag/v3.5',
   silent: false,
	   filename: null,
	   headers: 'User-Agent: Firefox Test',
	   cookies: null,
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
	  });

  const state = useDownloadStore.getState();
  expect(state.pendingAddUrls).toBe('https://github.com/center2055/OnionHop/releases/download/v3.5/OnionHop-3.5-macOS-arm64.dmg');
  expect(state.pendingAddReferer).toBe('https://github.com/center2055/OnionHop/releases/tag/v3.5');
  expect(state.pendingAddFilename).toBe('');
	  expect(state.pendingAddHeaders).toBe('User-Agent: Firefox Test');
	  expect(state.pendingAddCookies).toBe('');
    expect(state.pendingAddMediaUrls).toEqual([]);
	 });

  it('routes silent extension captures to the Add Modal instead of queuing immediately', async () => {
  await useDownloadStore.getState().handleExtensionDownload({
   urls: ['https://example.com/downloads/report.pdf'],
   referer: 'https://example.com/page',
   silent: true,
	   filename: 'report.pdf',
	   headers: 'User-Agent: Test',
	   cookies: 'session=secret',
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
	  });

  const state = useDownloadStore.getState();
  expect(state.isAddModalOpen).toBe(true);
  expect(state.pendingAddUrls).toBe('https://example.com/downloads/report.pdf');
  expect(state.pendingAddReferer).toBe('https://example.com/page');
  expect(state.pendingAddFilename).toBe('report.pdf');
	  expect(state.pendingAddHeaders).toBe('User-Agent: Test');
	  expect(state.pendingAddCookies).toBe('session=secret');
    expect(state.pendingAddMediaUrls).toEqual([]);
	 });

  it('tracks selected-link batch context without changing ordinary multi-link handoffs', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://example.com/one.zip', 'https://example.com/two.zip'],
      referer: 'https://example.com/gallery',
      silent: false,
      filename: null,
      headers: null,
      cookies: null,
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: true,
      batch_name: 'Example Gallery'
    });

    expect(useDownloadStore.getState().pendingAddBatch).toBe(true);
    expect(useDownloadStore.getState().pendingAddBatchName).toBe('Example Gallery');

    useDownloadStore.getState().toggleAddModal(false);
    useDownloadStore.getState().openAddModalWithUrls(
      'https://example.com/one.zip\nhttps://example.com/two.zip'
    );
    expect(useDownloadStore.getState().pendingAddBatch).toBe(false);
  });

  it('keeps each extension handoff context attached to its own URL while the Add Modal is open', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://first.example/file.zip'],
      referer: 'https://first.example/page',
      silent: true,
      filename: 'first.zip',
      headers: 'User-Agent: First Browser',
      cookies: 'first=session',
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://second.example/file.zip'],
      referer: 'https://second.example/page',
      silent: true,
      filename: 'second.zip',
      headers: 'User-Agent: Second Browser',
      cookies: 'second=session',
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });

    const state = useDownloadStore.getState();
    expect(state.pendingAddUrls).toBe(
      'https://first.example/file.zip\nhttps://second.example/file.zip'
    );
    expect(state.pendingAddRequestVersion).toBe(2);
    expect(state.pendingAddRequestContexts).toEqual({
      'https://first.example/file.zip': {
        version: 1,
        referer: 'https://first.example/page',
        filename: 'first.zip',
        headers: 'User-Agent: First Browser',
        cookies: 'first=session',
        media: false
      },
      'https://second.example/file.zip': {
        version: 2,
        referer: 'https://second.example/page',
        filename: 'second.zip',
        headers: 'User-Agent: Second Browser',
        cookies: 'second=session',
        media: false
      }
    });
  });

  it('preserves explicit extension media intent for non-allow-listed pages', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://adult.example/watch/123'],
      referer: 'https://adult.example/watch/123',
      silent: false,
      filename: null,
      headers: `Cookie: stale=${'x'.repeat(64 * 1024)}\nCookie2: stale=1\nAuthorization: Bearer stale\nProxy-Authorization: Basic stale\nSet-Cookie: stale=1\nSet-Cookie2: stale=1\nUser-Agent: Firefox Test`,
      cookies: `oversized=${'x'.repeat(64 * 1024)}`,
      cookie_scopes: null,
      media: true,
      torrent: false,
      batch: false,
      batch_name: null
    });

    const state = useDownloadStore.getState();
    expect(state.isAddModalOpen).toBe(true);
    expect(state.pendingAddUrls).toBe('https://adult.example/watch/123');
    expect(state.pendingAddMediaUrls).toEqual(['https://adult.example/watch/123']);
    expect(state.pendingAddCookies).toBe('');
    expect(state.pendingAddHeaders).toBe('User-Agent: Firefox Test');
  });

  it('preserves extension cookies for ordinary captured downloads', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://example.com/private.zip'],
      referer: 'https://example.com/downloads',
      silent: true,
      filename: 'private.zip',
      headers: null,
      cookies: 'session=secret',
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });

    expect(useDownloadStore.getState().pendingAddCookies).toBe('session=secret');
  });

  it('drops extension cookie scopes for explicit media captures', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://media.example/watch/123'],
      referer: 'https://media.example/watch/123',
      silent: true,
      filename: null,
      headers: null,
      cookies: null,
      cookie_scopes: [
        { url: 'https://media.example/', cookies: 'session=secret' }
      ],
      media: true,
      torrent: false,
      batch: false,
      batch_name: null
    });

    expect(useDownloadStore.getState().pendingAddRequestContexts['https://media.example/watch/123']?.cookieScopes)
      .toBeUndefined();
  });

  it('clears stale request context when the same URL is captured without it later', async () => {
    const url = 'https://example.com/file.zip';
    await useDownloadStore.getState().handleExtensionDownload({
      urls: [url],
      referer: 'https://example.com/private',
      silent: true,
      filename: 'private.zip',
      headers: 'Authorization: secret',
      cookies: 'session=secret',
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });
    await useDownloadStore.getState().handleExtensionDownload({
      urls: [url],
      referer: null,
      silent: true,
      filename: null,
      headers: null,
      cookies: null,
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });

    expect(useDownloadStore.getState().pendingAddRequestContexts[url]).toEqual({
      version: 2,
      referer: '',
      filename: '',
      headers: '',
      cookies: '',
      media: false
    });
  });

  it('deduplicates forced media URLs and drops stale media intent when opening fresh', async () => {
    useDownloadStore.setState({
      isAddModalOpen: true,
      pendingAddUrls: 'https://adult.example/watch/123',
      pendingAddMediaUrls: ['https://adult.example/watch/123']
    });

    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://adult.example/watch/123'],
      referer: 'https://adult.example/watch/123',
      silent: false,
      filename: null,
      headers: 'User-Agent: Firefox Test',
      cookies: 'session=secret',
      cookie_scopes: null,
      media: true,
      torrent: false,
      batch: false,
      batch_name: null
    });

    expect(useDownloadStore.getState().pendingAddMediaUrls).toEqual([
      'https://adult.example/watch/123'
    ]);

    useDownloadStore.setState({
      isAddModalOpen: false,
      pendingAddMediaUrls: ['https://stale.example/watch']
    });

    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://example.com/file.bin'],
      referer: 'https://example.com/page',
      silent: false,
      filename: 'file.bin',
      headers: 'User-Agent: Firefox Test',
      cookies: null,
      cookie_scopes: null,
      media: false,
      torrent: false,
      batch: false,
      batch_name: null
    });

    expect(useDownloadStore.getState().pendingAddMediaUrls).toEqual([]);
  });
});
