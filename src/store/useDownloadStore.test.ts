import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchItem, getProxyArgs, getSiteLogin, hasStaleTemporaryMediaEstimate, normalizeCustomProxy, normalizePersistedDownloadProgress, normalizePersistedQueueState, normalizePersistedQueues, useDownloadStore } from './useDownloadStore';
import { useDownloadProgressStore } from './downloadProgressStore';
import { useSettingsStore } from './useSettingsStore';
import * as ipc from '../ipc';

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
      pendingOrder: [],
      isAddModalOpen: false,
      pendingAddUrls: '',
      pendingAddReferer: '',
      pendingAddFilename: '',
      pendingAddHeaders: '',
      pendingAddCookies: '',
      pendingAddMediaUrls: [],
      pendingAddRequestContexts: {},
      pendingAddRequestVersion: 0,
    });
    useDownloadProgressStore.setState({ progressMap: {} });
  });

  it('invalidates in-flight Add-modal handoffs when the modal is toggled', () => {
    const initialVersion = useDownloadStore.getState().pendingAddRequestVersion;

    useDownloadStore.getState().toggleAddModal(true);
    expect(useDownloadStore.getState().pendingAddRequestVersion).toBe(initialVersion + 1);

    useDownloadStore.getState().toggleAddModal(false);
    expect(useDownloadStore.getState().pendingAddRequestVersion).toBe(initialVersion + 2);
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
  });

  it('re-enqueues the edited values only after an obsolete queued dispatch is removed', async () => {
    useDownloadStore.setState({
      downloads: [
        { id: 'edited', url: 'http://test', fileName: 'old.bin', destination: '/tmp', status: 'queued', category: 'Other', dateAdded: '', queueId: 'MAIN', hasBeenDispatched: false },
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
          : Promise.resolve({ id: 'edited', filename: 'new.bin' })) as never;
      }
      if (command === 'get_pending_order') return Promise.resolve(['edited']) as never;
      return Promise.resolve(undefined) as never;
    });

    const start = useDownloadStore.getState().startQueue('MAIN');
    await vi.waitFor(() => expect(enqueueCount).toBe(1));
    const update = useDownloadStore.getState().applyProperties('edited', { fileName: 'new.bin' });
    resolveFirstEnqueue({ id: 'edited', filename: 'old.bin' });

    await expect(update).resolves.toBeUndefined();
    await expect(start).resolves.toEqual([]);
    expect(enqueueCount).toBe(2);
    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith(
      'get_pending_order',
      { queueId: 'MAIN' }
    );
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      fileName: 'new.bin',
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

  it('carries a media format estimate into numeric progress state', async () => {
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
      dateAdded: ''
    }, { type: 'start-now' });

    const item = useDownloadStore.getState().downloads[0];
    expect(item.queueId).toBe('00000000-0000-0000-0000-000000000001');
    expect(item.hasBeenDispatched).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'enqueue_download',
      expect.objectContaining({
        item: expect.objectContaining({ id: 'start-1' })
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
        return [{ id: 'startup-accepted', success: true, filename: 'file.bin' }];
      }
      if (cmd === 'get_pending_order') throw new Error('queue state unavailable');
      if (cmd === 'resume_download') return true;
      return undefined;
    });

    await useDownloadStore.getState().initDB();
    await useDownloadStore.getState().resumePendingDownloads();

    expect(useDownloadStore.getState().backendRegisteredIds.has('startup-accepted')).toBe(true);
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
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
        { id: 'done', status: 'completed', queueId: 'old' }
      ] as any[]
    });

    await useDownloadStore.getState().assignToQueue(['ready', 'done'], 'new');

    expect(useDownloadStore.getState().downloads.find(item => item.id === 'ready')?.queueId).toBe('new');
    expect(useDownloadStore.getState().downloads.find(item => item.id === 'done')?.queueId).toBe('old');
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
      media: false
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
      media: false
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
      media: false
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

  it('keeps each extension handoff context attached to its own URL while the Add Modal is open', async () => {
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://first.example/file.zip'],
      referer: 'https://first.example/page',
      silent: true,
      filename: 'first.zip',
      headers: 'User-Agent: First Browser',
      cookies: 'first=session',
      cookie_scopes: null,
      media: false
    });
    await useDownloadStore.getState().handleExtensionDownload({
      urls: ['https://second.example/file.zip'],
      referer: 'https://second.example/page',
      silent: true,
      filename: 'second.zip',
      headers: 'User-Agent: Second Browser',
      cookies: 'second=session',
      cookie_scopes: null,
      media: false
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
      headers: `Cookie: stale=${'x'.repeat(64 * 1024)}\nUser-Agent: Firefox Test`,
      cookies: `oversized=${'x'.repeat(64 * 1024)}`,
      cookie_scopes: null,
      media: true
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
      media: false
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
      media: true
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
      media: false
    });
    await useDownloadStore.getState().handleExtensionDownload({
      urls: [url],
      referer: null,
      silent: true,
      filename: null,
      headers: null,
      cookies: null,
      cookie_scopes: null,
      media: false
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
      media: true
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
      media: false
    });

    expect(useDownloadStore.getState().pendingAddMediaUrls).toEqual([]);
  });
});
