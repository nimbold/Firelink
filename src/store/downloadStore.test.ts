import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainPendingTrayActionsAfterHydration,
  initDownloadListener,
  resetTrayActionDrainStateForTests,
  useDownloadProgressStore
} from './downloadStore';
import {
  clearDownloadControlIntents,
  currentDownloadLifecycleGeneration,
  flushDownloadPersistence,
  initializeDownloadPersistence,
  MAIN_QUEUE_ID,
  resetDownloadStoreModuleStateForTests,
  downloadControlIntentFor,
  setDownloadControlIntent,
  useDownloadStore
} from './useDownloadStore';
import * as ipc from '../ipc';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(),
  listenEvent: vi.fn(),
}));

type DownloadEventHandlers = Record<string, (event: any) => void>;

const aria2Owner = (
  id: string,
  controlEpoch = '1',
  lifecycleGeneration = '0',
  ownerRevision = controlEpoch,
) => ({
  gid: `gid-${id}`,
  controlEpoch,
  lifecycleGeneration,
  ownerRevision
});

const emitAria2OwnerState = (
  handlers: DownloadEventHandlers,
  id: string,
  status: string = 'downloading',
  owner = aria2Owner(id),
) => handlers['download-state']({ payload: { id, status, ...owner } });

const aria2ProgressOwnerFields = (owner: ReturnType<typeof aria2Owner>) => ({
  gid: owner.gid,
  control_epoch: owner.controlEpoch,
  owner_revision: owner.ownerRevision,
  lifecycle_generation: owner.lifecycleGeneration
});

describe('useDownloadProgressStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTrayActionDrainStateForTests();
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined);
    useDownloadProgressStore.setState({
      progressMap: {},
      retainedProgressMap: {},
      moveProgressMap: {},
      aria2ProgressOwnerMap: {},
      aria2ProgressOwnerWatermarkMap: {},
      aria2LifecycleGenerationMap: {}
    });
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

    expect(ipc.listenEvent).toHaveBeenCalledTimes(6);

    const releaseFirst = await first;
    const releaseSecond = await second;
    releaseFirst();
    expect(unlisten).not.toHaveBeenCalled();

    releaseSecond();
    expect(unlisten).toHaveBeenCalledTimes(6);
  });

  it('acknowledges a failed tray action attempt and reports the unfinished target', async () => {
    vi.mocked(ipc.listenEvent).mockImplementation(() => Promise.resolve(vi.fn()));
    const pauseAll = vi.spyOn(useDownloadStore.getState(), 'pauseAll')
      .mockRejectedValue(new Error('temporary pause failure'));
    useDownloadStore.setState({
      isInitialized: true,
      downloads: [{
        id: 'pause-failed',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });
    const action = { id: 'tray-action-1', action: 'pause-all' };
    let actionPending = true;
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') {
        return (actionPending ? action : null) as any;
      }
      if (command === 'claim_pending_tray_action') {
        return { shouldExecute: true, execution: null } as any;
      }
      if (command === 'record_tray_action_result') return undefined as any;
      if (command === 'acknowledge_tray_action' && args?.id === action.id) {
        actionPending = false;
      }
      return undefined as any;
    }) as any);
    const release = await initDownloadListener();
    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'acknowledge_tray_action',
      {
        id: action.id,
        failedCount: 1,
        operationFailed: true,
        persistenceFailed: false
      }
    ));

    expect(actionPending).toBe(false);
    expect(pauseAll).toHaveBeenCalledTimes(1);
    release();
    pauseAll.mockRestore();
  });

  it('does not report a completed tray pause as failed when the paused Aria2 GID stays registered', async () => {
    vi.mocked(ipc.listenEvent).mockImplementation(() => Promise.resolve(vi.fn()));
    const action = { id: 'tray-pause-registered-gid', action: 'pause-all' };
    let actionPending = true;
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') return (actionPending ? action : null) as any;
      if (command === 'claim_pending_tray_action') {
        return { shouldExecute: true, execution: null } as any;
      }
      if (command === 'record_tray_action_result') return undefined as any;
      if (command === 'acknowledge_tray_action' && args?.id === action.id) actionPending = false;
      return undefined as any;
    }) as any);
    useDownloadStore.setState({
      isInitialized: true,
      downloads: [{
        id: 'paused-gid',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }],
      backendRegisteredIds: new Set(['paused-gid'])
    });
    const pauseAll = vi.spyOn(useDownloadStore.getState(), 'pauseAll').mockImplementation(async () => {
      useDownloadStore.getState().updateDownload('paused-gid', { status: 'paused' });
      // A paused Aria2 GID can remain registered for an in-place resume.
      return 1;
    });

    const release = await initDownloadListener();
    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'acknowledge_tray_action',
      {
        id: action.id,
        failedCount: 0,
        operationFailed: false,
        persistenceFailed: false
      }
    ));
    expect(useDownloadStore.getState().downloads[0]?.status).toBe('paused');
    expect(useDownloadStore.getState().backendRegisteredIds.has('paused-gid')).toBe(true);
    expect(pauseAll).toHaveBeenCalledTimes(1);

    release();
    pauseAll.mockRestore();
  });

  it('consumes a tray command after persistence failure so reload cannot replay stale intent', async () => {
    resetDownloadStoreModuleStateForTests();
    vi.mocked(ipc.listenEvent).mockImplementation(() => Promise.resolve(vi.fn()));
    const action = { id: 'tray-pause-persistence-retry', action: 'pause-all' };
    let actionPending = true;
    let failWrites = true;
    const acknowledgements: unknown[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') return (actionPending ? action : null) as any;
      if (command === 'claim_pending_tray_action') {
        return { shouldExecute: true, execution: null } as any;
      }
      if (command === 'record_tray_action_result') return undefined as any;
      if (command === 'acknowledge_tray_action' && args?.id === action.id) {
        acknowledgements.push(args);
        actionPending = false;
      }
      if (command === 'db_commit_download_state') {
        if (failWrites) throw new Error('database unavailable');
      }
      return undefined as any;
    }) as any);
    useDownloadStore.setState({
      isInitialized: false,
      downloads: [{
        id: 'manual-resume-after-tray-pause',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }],
      backendRegisteredIds: new Set(['manual-resume-after-tray-pause'])
    });
    const pauseAll = vi.spyOn(useDownloadStore.getState(), 'pauseAll').mockImplementation(async () => {
      useDownloadStore.getState().updateDownload('manual-resume-after-tray-pause', { status: 'paused' });
      return 1;
    });

    const release = await initDownloadListener();
    const disposePersistence = initializeDownloadPersistence('main');
    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'acknowledge_tray_action',
      {
        id: action.id,
        failedCount: 0,
        operationFailed: false,
        persistenceFailed: true
      }
    ));
    expect(actionPending).toBe(false);
    expect(acknowledgements).toEqual([{
      id: action.id,
      failedCount: 0,
      operationFailed: false,
      persistenceFailed: true
    }]);
    expect(pauseAll).toHaveBeenCalledTimes(1);

    failWrites = false;
    useDownloadStore.getState().updateDownload('manual-resume-after-tray-pause', { status: 'downloading' });
    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'db_commit_download_state',
      expect.any(Object)
    ));
    expect(useDownloadStore.getState().downloads[0]?.status).toBe('downloading');

    disposePersistence();
    release();

    // A renderer reload loses all module-local caches. The native queue has
    // already consumed the command, so a new listener must not repeat Pause All.
    resetDownloadStoreModuleStateForTests();
    const readsBeforeReload = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'take_pending_tray_action').length;
    const reloadedRelease = await initDownloadListener();
    const reloadedDisposePersistence = initializeDownloadPersistence('main');
    await vi.waitFor(() => expect(
      vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'take_pending_tray_action').length
    ).toBeGreaterThan(readsBeforeReload));
    await Promise.resolve();
    expect(actionPending).toBe(false);
    expect(pauseAll).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().downloads[0]?.status).toBe('downloading');

    reloadedDisposePersistence();
    reloadedRelease();
    pauseAll.mockRestore();
  });

  it('reuses a recorded tray action result after a successful flush and lost ACK on renderer reload', async () => {
    resetDownloadStoreModuleStateForTests();
    resetTrayActionDrainStateForTests();
    vi.mocked(ipc.listenEvent).mockImplementation(() => Promise.resolve(vi.fn()));
    useDownloadStore.setState({
      isInitialized: false,
      downloads: [{
        id: 'reload-safe-tray-pause',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });
    useDownloadStore.setState({ isInitialized: true });
    await drainPendingTrayActionsAfterHydration();

    const action = { id: 'tray-pause-lost-ack', action: 'pause-all' } as const;
    const expectedExecution = {
      failedCount: 0,
      operationFailed: false,
      persistenceFailed: false
    };
    let actionPending = true;
    let executionClaimed = false;
    let recordedExecution: typeof expectedExecution | null = null;
    const acknowledgements: unknown[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') {
        return (actionPending ? action : null) as any;
      }
      if (command === 'claim_pending_tray_action' && args?.id === action.id) {
        if (recordedExecution) {
          return { shouldExecute: false, execution: recordedExecution } as any;
        }
        if (!executionClaimed) {
          executionClaimed = true;
          return { shouldExecute: true, execution: null } as any;
        }
        return { shouldExecute: false, execution: null } as any;
      }
      if (command === 'record_tray_action_result' && args?.id === action.id) {
        recordedExecution = {
          failedCount: args.failedCount,
          operationFailed: args.operationFailed,
          persistenceFailed: args.persistenceFailed
        };
      }
      if (command === 'acknowledge_tray_action' && args?.id === action.id) {
        acknowledgements.push(args);
        if (acknowledgements.length === 1) {
          // Simulate the webview losing the IPC response before native dequeue.
          throw new Error('webview reloaded before the tray action ACK completed');
        }
        actionPending = false;
      }
      return undefined as any;
    }) as any);

    const pauseAll = vi.spyOn(useDownloadStore.getState(), 'pauseAll').mockImplementation(async () => {
      useDownloadStore.getState().updateDownload('reload-safe-tray-pause', { status: 'paused' });
      return 1;
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const disposePersistence = initializeDownloadPersistence('main');
    const release = await initDownloadListener();
    await vi.waitFor(() => {
      expect(recordedExecution).toEqual(expectedExecution);
      expect(acknowledgements).toHaveLength(1);
    });
    expect(actionPending).toBe(true);
    expect(pauseAll).toHaveBeenCalledTimes(1);

    disposePersistence();
    release();
    resetDownloadStoreModuleStateForTests();
    resetTrayActionDrainStateForTests();
    useDownloadStore.setState({
      isInitialized: true,
      downloads: [{
        id: 'reload-safe-tray-pause',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const reloadedDisposePersistence = initializeDownloadPersistence('main');
    const reloadedRelease = await initDownloadListener();
    await vi.waitFor(() => expect(acknowledgements).toHaveLength(2));

    expect(pauseAll).toHaveBeenCalledTimes(1);
    expect(acknowledgements[1]).toEqual({
      id: action.id,
      ...expectedExecution
    });
    expect(actionPending).toBe(false);
    expect(useDownloadStore.getState().downloads[0]?.status).toBe('paused');
    expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) =>
      command === 'record_tray_action_result'
    )).toHaveLength(1);

    reloadedDisposePersistence();
    reloadedRelease();
    pauseAll.mockRestore();
    consoleError.mockRestore();
  });

  it('counts a queued but accepted resume as a successful tray action', async () => {
    vi.mocked(ipc.listenEvent).mockImplementation(() => Promise.resolve(vi.fn()));
    const action = { id: 'tray-resume-queued', action: 'resume-all' };
    let actionPending = true;
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') return (actionPending ? action : null) as any;
      if (command === 'claim_pending_tray_action') {
        return { shouldExecute: true, execution: null } as any;
      }
      if (command === 'record_tray_action_result') return undefined as any;
      if (command === 'acknowledge_tray_action' && args?.id === action.id) actionPending = false;
      return undefined as any;
    }) as any);
    useDownloadStore.setState({
      isInitialized: true,
      downloads: [{
        id: 'accepted-waiting-for-capacity',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }],
      backendRegisteredIds: new Set(['accepted-waiting-for-capacity']),
      pendingOrder: ['accepted-waiting-for-capacity']
    });
    const startAll = vi.spyOn(useDownloadStore.getState(), 'startAllWithOutcomes')
      .mockResolvedValue(['accepted-waiting-for-capacity']);

    const release = await initDownloadListener();
    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'acknowledge_tray_action',
      {
        id: action.id,
        failedCount: 0,
        operationFailed: false,
        persistenceFailed: false
      }
    ));
    expect(startAll).toHaveBeenCalledTimes(1);
    expect(actionPending).toBe(false);

    release();
    startAll.mockRestore();
  });

  it('waits for persisted downloads to hydrate before applying a queued tray action', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    const action = { id: 'startup-tray-pause', action: 'pause-all' };
    let actionPending = true;
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') return (actionPending ? action : null) as any;
      if (command === 'claim_pending_tray_action') {
        return { shouldExecute: true, execution: null } as any;
      }
      if (command === 'record_tray_action_result') return undefined as any;
      if (command === 'acknowledge_tray_action' && args?.id === action.id) actionPending = false;
      return undefined as any;
    }) as any);
    const pauseAll = vi.spyOn(useDownloadStore.getState(), 'pauseAll').mockImplementation(async () => {
      expect(useDownloadStore.getState().downloads.map(download => download.id)).toContain('restored-row');
      useDownloadStore.getState().updateDownload('restored-row', { status: 'paused' });
      return 1;
    });

    useDownloadStore.setState({ isInitialized: false, downloads: [] });
    const release = await initDownloadListener();
    await Promise.resolve();
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('take_pending_tray_action', undefined);
    expect(pauseAll).not.toHaveBeenCalled();

    useDownloadStore.setState({
      isInitialized: true,
      downloads: [{
        id: 'restored-row',
        url: 'https://example.com/restored.bin',
        fileName: 'restored.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });
    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'acknowledge_tray_action',
      {
        id: action.id,
        failedCount: 0,
        operationFailed: false,
        persistenceFailed: false
      }
    ));
    expect(pauseAll).toHaveBeenCalledTimes(1);
    const startupTrayDrain = await drainPendingTrayActionsAfterHydration();
    expect(startupTrayDrain).toEqual({
      pending: null,
      startupPauseAllSeen: true,
      startupActionStateUnknown: false
    });

    release();
    pauseAll.mockRestore();
  });

  it('blocks automatic startup resume when the native tray queue cannot be read', async () => {
    vi.mocked(ipc.listenEvent).mockResolvedValue(vi.fn());
    vi.mocked(ipc.invokeCommand).mockRejectedValue(new Error('tray queue unavailable'));
    useDownloadStore.setState({ isInitialized: true, downloads: [] });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const release = await initDownloadListener();

    const result = await drainPendingTrayActionsAfterHydration();
    expect(result).toEqual({
      pending: null,
      startupPauseAllSeen: false,
      startupActionStateUnknown: true
    });

    release();
    consoleError.mockRestore();
  });

  it('consumes an availability signal received while an empty queue read is in flight', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    let releaseFirstRead!: (value: null) => void;
    let takeCalls = 0;
    let actionPending = false;
    const action = { id: 'tray-action-raced-signal', action: 'resume-all' };
    vi.mocked(ipc.invokeCommand).mockImplementation((async (command: string, args?: any) => {
      if (command === 'take_pending_tray_action') {
        takeCalls += 1;
        if (takeCalls === 1) return new Promise(resolve => { releaseFirstRead = resolve; });
        return (actionPending ? action : null) as any;
      }
      if (command === 'claim_pending_tray_action') {
        return { shouldExecute: true, execution: null } as any;
      }
      if (command === 'record_tray_action_result') return undefined as any;
      if (command === 'acknowledge_tray_action' && args?.id === action.id) actionPending = false;
      return undefined as any;
    }) as any);
    useDownloadStore.setState({ isInitialized: true, downloads: [] });
    const startAll = vi.spyOn(useDownloadStore.getState(), 'startAllWithOutcomes').mockResolvedValue([]);

    const release = await initDownloadListener();
    await vi.waitFor(() => expect(takeCalls).toBe(1));
    actionPending = true;
    handlers['tray-action-available']({ payload: null });
    releaseFirstRead(null);

    await vi.waitFor(() => expect(ipc.invokeCommand).toHaveBeenCalledWith(
      'acknowledge_tray_action',
      {
        id: action.id,
        failedCount: 0,
        operationFailed: false,
        persistenceFailed: false
      }
    ));
    expect(takeCalls).toBeGreaterThanOrEqual(3);
    expect(startAll).toHaveBeenCalledTimes(1);

    release();
    startAll.mockRestore();
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

  it('invalidates media checkpoints only for the current lifecycle after cleanup', async () => {
    resetDownloadStoreModuleStateForTests();
    const persistedSnapshots: Array<Array<Record<string, unknown>>> = [];
    let pauseStatusAtInvalidation: string | undefined;
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command, args) => {
      if (command === 'db_commit_download_state') {
        const downloadsData = (args as { downloadsData?: string } | undefined)?.downloadsData;
        if (typeof downloadsData === 'string') {
          persistedSnapshots.push(JSON.parse(downloadsData) as Array<Record<string, unknown>>);
        }
      }
      if (command === 'pause_download') {
        pauseStatusAtInvalidation = useDownloadStore.getState().downloads[0]?.status;
        handlers['download-progress-invalidated']({ payload: {
          id: 'media-cleanup',
          lifecycleGeneration: '0',
          progressCheckpointEpoch: '1'
        } });
        return true as never;
      }
      return undefined as never;
    });
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'media-cleanup',
        url: 'https://example.com/watch',
        fileName: 'video.mkv',
        status: 'downloading',
        category: 'Movies',
        dateAdded: '',
        isMedia: true,
        fraction: 0.8,
        downloadedBytes: 800,
        totalBytes: 1000,
        totalIsEstimate: true,
        size: '~1 KB'
      }]
    });
    useDownloadProgressStore.getState().updateDownloadProgress('media-cleanup', {
      id: 'media-cleanup',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '1s',
      size: '~1 KB',
      size_is_final: false,
      downloaded_bytes: 800,
      total_bytes: 1000,
      total_is_estimate: true
    });

    const disposePersistence = initializeDownloadPersistence('main');
    await flushDownloadPersistence();
    const release = await initDownloadListener();
    handlers['download-progress-invalidated']({ payload: {
      id: 'media-cleanup',
      lifecycleGeneration: '1',
      progressCheckpointEpoch: '1'
    } });
    expect(useDownloadStore.getState().downloads[0].downloadedBytes).toBe(800);
    expect(useDownloadProgressStore.getState().retainedProgressMap['media-cleanup']).toBeDefined();

    await useDownloadStore.getState().pauseDownload('media-cleanup');
    expect(pauseStatusAtInvalidation).toBe('downloading');
    expect(currentDownloadLifecycleGeneration('media-cleanup')).toBe('1');
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      id: 'media-cleanup',
      status: 'paused',
      progressCheckpointEpoch: '1',
      fraction: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      totalIsEstimate: undefined,
      size: undefined
    });
    expect(useDownloadProgressStore.getState().progressMap['media-cleanup']).toBeUndefined();
    expect(useDownloadProgressStore.getState().retainedProgressMap['media-cleanup']).toBeUndefined();
    await flushDownloadPersistence();
    expect(persistedSnapshots[persistedSnapshots.length - 1]?.[0]).not.toHaveProperty('downloadedBytes');
    expect(persistedSnapshots[persistedSnapshots.length - 1]?.[0]).not.toHaveProperty('fraction');
    release();
    disposePersistence();
  });

  it('recovers a missed media checkpoint invalidation from the next native progress frame', async () => {
    resetDownloadStoreModuleStateForTests();
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'media-epoch-recovery',
        url: 'https://example.com/watch',
        fileName: 'video.mkv',
        status: 'downloading',
        category: 'Movies',
        dateAdded: '',
        isMedia: true,
        progressCheckpointEpoch: '0',
        fraction: 0.8,
        downloadedBytes: 800,
        totalBytes: 1000,
        totalIsEstimate: false
      }]
    });
    const release = await initDownloadListener();

    await useDownloadStore.getState().pauseDownload('media-epoch-recovery');
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');
    const resumedLifecycle = currentDownloadLifecycleGeneration('media-epoch-recovery');
    expect(resumedLifecycle).toBe('1');
    useDownloadStore.setState(state => ({
      downloads: state.downloads.map(download => download.id === 'media-epoch-recovery'
        ? { ...download, status: 'downloading', fraction: undefined, downloadedBytes: undefined }
        : download)
    }));

    handlers['download-progress']({ payload: {
      id: 'media-epoch-recovery',
      fraction: 0.9,
      speed: '1 MB/s',
      eta: '1s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: 900,
      total_bytes: 1000,
      total_is_estimate: false,
      progress_checkpoint_epoch: '0',
      lifecycle_generation: '0'
    } });
    expect(useDownloadStore.getState().downloads[0].fraction).toBeUndefined();
    expect(useDownloadProgressStore.getState().progressMap['media-epoch-recovery']).toBeUndefined();

    // The durable DB epoch advanced while the invalidation event was missed.
    // A new native worker carries that epoch on its first progress frame.
    handlers['download-progress']({ payload: {
      id: 'media-epoch-recovery',
      fraction: 0.2,
      speed: '2 MB/s',
      eta: '40s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: 200,
      total_bytes: 1000,
      total_is_estimate: false,
      progress_checkpoint_epoch: '1',
      lifecycle_generation: resumedLifecycle
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      progressCheckpointEpoch: '1',
      fraction: 0.2,
      downloadedBytes: 200
    });
    release();
  });

  it('ignores unfenced media progress without clearing the current lifecycle snapshot', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'media-progress-fence',
        url: 'https://example.com/watch',
        fileName: 'video.mkv',
        status: 'downloading',
        category: 'Movies',
        dateAdded: '',
        isMedia: true,
        progressCheckpointEpoch: '1',
        fraction: 0.25,
        downloadedBytes: 250,
        totalBytes: 1000,
        totalIsEstimate: false
      }]
    });
    const release = await initDownloadListener();

    const currentFrame = {
      id: 'media-progress-fence',
      fraction: 0.25,
      speed: '1 MB/s',
      eta: '1s',
      size: '1 KB',
      size_is_final: false,
      downloaded_bytes: 250,
      total_bytes: 1000,
      total_is_estimate: false,
      progress_checkpoint_epoch: '1',
      lifecycle_generation: '0'
    };
    handlers['download-progress']({ payload: currentFrame });
    handlers['download-progress']({ payload: {
      ...currentFrame,
      fraction: 0.9,
      downloaded_bytes: 900,
      progress_checkpoint_epoch: '0'
    } });
    handlers['download-progress']({ payload: {
      ...currentFrame,
      fraction: 0.95,
      downloaded_bytes: 950,
      progress_checkpoint_epoch: undefined
    } });
    handlers['download-progress']({ payload: {
      ...currentFrame,
      fraction: 0.99,
      downloaded_bytes: 990,
      lifecycle_generation: undefined
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      fraction: 0.25,
      downloadedBytes: 250,
      progressCheckpointEpoch: '1'
    });
    expect(useDownloadProgressStore.getState().progressMap['media-progress-fence']).toMatchObject({
      fraction: 0.25,
      downloaded_bytes: 250,
      progress_checkpoint_epoch: '1',
      lifecycle_generation: '0'
    });
    release();
  });

  it('ignores a delayed prior-lifecycle media state after the new lifecycle starts', async () => {
    resetDownloadStoreModuleStateForTests();
    const id = 'media-state-lifecycle-fence';
    useDownloadStore.setState({
      downloads: [],
      queues: [{ id: MAIN_QUEUE_ID, name: 'Main Queue', isMain: true }],
      backendRegisteredIds: new Set(),
      pendingOrder: []
    });
    await useDownloadStore.getState().addDownload({
      id,
      url: 'https://example.com/watch',
      fileName: 'video.mkv',
      destination: '/tmp',
      category: 'Movies',
      dateAdded: '',
      isMedia: true
    }, { type: 'add-to-queue', queueId: MAIN_QUEUE_ID });
    const activeGeneration = currentDownloadLifecycleGeneration(id);
    expect(activeGeneration).not.toBe('0');
    useDownloadStore.getState().updateDownload(id, { status: 'downloading' });

    const handlers: DownloadEventHandlers = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id,
      status: 'downloading',
      lifecycleGeneration: activeGeneration
    } });
    handlers['download-state']({ payload: {
      id,
      status: 'failed',
      error: 'old media attempt failed',
      lifecycleGeneration: (BigInt(activeGeneration) - 1n).toString()
    } });
    handlers['download-state']({ payload: {
      id,
      status: 'processing'
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      lastError: undefined
    });
    expect(useDownloadStore.getState().backendRegisteredIds.has(id)).toBe(true);
    expect(useDownloadProgressStore.getState().aria2LifecycleGenerationMap[id]).toBe(activeGeneration);
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
    expect(useDownloadStore.getState().downloads[0].status).toBe('queued');
    expect(useDownloadStore.getState().pendingOrder).toEqual(['pending-transition']);
    const owner = aria2Owner('pending-transition');
    handlers['download-state']({ payload: {
      id: 'pending-transition',
      status: 'downloading',
      ...owner
    } });
    expect(useDownloadStore.getState().pendingOrder).toEqual([]);

    useDownloadStore.getState().updateDownload('pending-transition', { status: 'downloading' });
    useDownloadStore.setState({ pendingOrder: ['pending-transition'] });
    handlers['download-state']({ payload: {
      id: 'pending-transition',
      status: 'retrying',
      error: 'network dropped',
      ...owner
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
    const owner = aria2Owner('malformed-progress');
    emitAria2OwnerState(handlers, 'malformed-progress', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'malformed-progress',
      fraction: 0.5,
      speed: '1 MB/s',
      eta: '1s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: -1,
      total_bytes: Number.NaN,
      active_connections: -2,
      ...aria2ProgressOwnerFields(owner)
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
    const owner = aria2Owner('omitted-size');
    emitAria2OwnerState(handlers, 'omitted-size', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'omitted-size',
      fraction: 0.25,
      speed: '1 MB/s',
      eta: '1s',
      size_is_final: false,
      ...aria2ProgressOwnerFields(owner)
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
    const owner = aria2Owner('invalid-fraction');
    emitAria2OwnerState(handlers, 'invalid-fraction', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'invalid-fraction',
      fraction: 0.4,
      speed: '1 MB/s',
      eta: '1s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: 400,
      ...aria2ProgressOwnerFields(owner)
    } });
    handlers['download-progress']({ payload: {
      id: 'invalid-fraction',
      fraction: 2,
      speed: '2 MB/s',
      eta: '0s',
      size: '1 MB',
      size_is_final: false,
      downloaded_bytes: 2000,
      ...aria2ProgressOwnerFields(owner)
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
    const owner = aria2Owner('connection-telemetry');
    emitAria2OwnerState(handlers, 'connection-telemetry', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'connection-telemetry',
      fraction: 0.2,
      speed: '3 MB/s',
      eta: '10s',
      size: '38 MB',
      size_is_final: false,
      active_connections: 16,
      requested_connections: 16,
      ...aria2ProgressOwnerFields(owner)
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
      ...aria2Owner('resolver-error', '2')
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
    const owner = aria2Owner('torrent-seeding');
    handlers['download-state']({ payload: {
      id: 'torrent-seeding',
      status: 'seeding',
      ...owner
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
      requested_connections: 8,
      ...aria2ProgressOwnerFields(owner)
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
    const owner = aria2Owner('torrent-seeding-verification');
    handlers['download-state']({ payload: {
      id: 'torrent-seeding-verification',
      status: 'verifying',
      ...owner
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
    const owner = aria2Owner('reused');
    emitAria2OwnerState(handlers, 'reused', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'reused',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false,
      ...aria2ProgressOwnerFields(owner)
    } });
    handlers['download-state']({ payload: {
      id: 'reused',
      status: 'queued',
      lifecycleGeneration: '1'
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
    const owner = aria2Owner('snapshot');
    emitAria2OwnerState(handlers, 'snapshot', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'snapshot',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false,
      downloaded_bytes: 8192,
      total_bytes: 10240,
      total_is_estimate: true,
      ...aria2ProgressOwnerFields(owner)
    } });
    handlers['download-state']({ payload: {
      id: 'snapshot',
      status: 'paused',
      ...owner
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
    const owner = aria2Owner('terminal-progress');
    emitAria2OwnerState(handlers, 'terminal-progress', 'downloading', owner);
    handlers['download-progress']({ payload: {
      id: 'terminal-progress',
      fraction: 0.7,
      speed: '1 MB/s',
      eta: '2s',
      size: '10 MB',
      size_is_final: false,
      downloaded_bytes: 7000,
      total_bytes: 10000,
      total_is_estimate: false,
      ...aria2ProgressOwnerFields(owner)
    } });
    handlers['download-state']({ payload: {
      id: 'terminal-progress',
      status: 'paused',
      ...owner
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
    const previousOwner = {
      gid: 'same-gid-resume-gid',
      controlEpoch: '1',
      lifecycleGeneration: '0',
      ownerRevision: '1'
    };
    const resumedOwner = {
      ...previousOwner,
      controlEpoch: '2',
      ownerRevision: '2'
    };
    emitAria2OwnerState(handlers, 'same-gid-resume', 'downloading', previousOwner);
    handlers['download-progress']({ payload: {
      id: 'same-gid-resume',
      fraction: 0.6,
      speed: '1 MB/s',
      eta: '4s',
      size: '10 KB',
      size_is_final: false,
      downloaded_bytes: 6000,
      total_bytes: 10000,
      total_is_estimate: false,
      ...aria2ProgressOwnerFields(previousOwner)
    } });
    useDownloadStore.setState(state => ({
      downloads: state.downloads.map(download => ({
        ...download,
        status: 'queued' as const
      }))
    }));
    handlers['download-state']({ payload: {
      id: 'same-gid-resume',
      status: 'queued',
      ...resumedOwner
    } });

    expect(useDownloadProgressStore.getState().progressMap['same-gid-resume']).toBeUndefined();
    expect(useDownloadProgressStore.getState().retainedProgressMap['same-gid-resume']).toMatchObject({
      downloaded_bytes: 6000,
      total_bytes: 10000
    });
    release();
  });

  it('rejects a delayed pre-resume Aria2 frame after the same GID is downloading again', async () => {
    const handlers: DownloadEventHandlers = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'same-gid-owner-fence',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    const previousOwner = {
      gid: 'same-gid',
      controlEpoch: '41',
      lifecycleGeneration: '12',
      ownerRevision: '90'
    };
    const resumedOwner = {
      ...previousOwner,
      controlEpoch: '42',
      ownerRevision: '91'
    };
    emitAria2OwnerState(handlers, 'same-gid-owner-fence', 'downloading', previousOwner);
    const progress = (owner: typeof previousOwner, fraction: number, downloadedBytes: number) =>
      handlers['download-progress']({ payload: {
        id: 'same-gid-owner-fence',
        fraction,
        speed: '1 MB/s',
        eta: '4s',
        size: '10 KB',
        size_is_final: false,
        downloaded_bytes: downloadedBytes,
        total_bytes: 10000,
        total_is_estimate: false,
        ...aria2ProgressOwnerFields(owner)
      } });

    progress(previousOwner, 0.4, 4000);
    handlers['download-state']({ payload: {
      id: 'same-gid-owner-fence',
      status: 'paused'
    } });
    useDownloadStore.getState().updateDownload('same-gid-owner-fence', { status: 'queued' });
    emitAria2OwnerState(handlers, 'same-gid-owner-fence', 'queued', resumedOwner);
    emitAria2OwnerState(handlers, 'same-gid-owner-fence', 'downloading', resumedOwner);
    progress(resumedOwner, 0.61, 6100);

    // The old worker's frame is delivered after the row is active under the
    // resumed control epoch. Its same GID and download ID are insufficient.
    progress(previousOwner, 0.99, 9900);

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      fraction: 0.61,
      downloadedBytes: 6100,
      totalBytes: 10000
    });
    expect(useDownloadProgressStore.getState().progressMap['same-gid-owner-fence']).toMatchObject({
      fraction: 0.61,
      downloaded_bytes: 6100,
      gid: 'same-gid',
      control_epoch: '42',
      owner_revision: '91',
      lifecycle_generation: '12'
    });
    expect(useDownloadProgressStore.getState().retainedProgressMap['same-gid-owner-fence'])
      .toMatchObject({ downloaded_bytes: 6100 });
    release();
  });

  it('fences a same-epoch GID replacement by its owner revision', async () => {
    const handlers: DownloadEventHandlers = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'same-epoch-gid-replacement',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    const oldOwner = {
      gid: 'old-gid',
      controlEpoch: '71',
      lifecycleGeneration: '18',
      ownerRevision: '140'
    };
    const replacementOwner = {
      ...oldOwner,
      gid: 'replacement-gid',
      ownerRevision: '141'
    };
    const progress = (owner: typeof oldOwner, fraction: number, downloadedBytes: number) =>
      handlers['download-progress']({ payload: {
        id: 'same-epoch-gid-replacement',
        fraction,
        speed: '1 MB/s',
        eta: '4s',
        size: '10 KB',
        size_is_final: false,
        downloaded_bytes: downloadedBytes,
        total_bytes: 10000,
        total_is_estimate: false,
        ...aria2ProgressOwnerFields(owner)
      } });

    emitAria2OwnerState(handlers, 'same-epoch-gid-replacement', 'downloading', oldOwner);
    progress(oldOwner, 0.4, 4000);
    emitAria2OwnerState(handlers, 'same-epoch-gid-replacement', 'downloading', replacementOwner);
    progress(replacementOwner, 0.6, 6000);

    emitAria2OwnerState(handlers, 'same-epoch-gid-replacement', 'paused', oldOwner);
    emitAria2OwnerState(handlers, 'same-epoch-gid-replacement', 'retrying', oldOwner);
    progress(oldOwner, 0.99, 9900);

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      fraction: 0.6,
      downloadedBytes: 6000,
      totalBytes: 10000
    });
    expect(useDownloadProgressStore.getState().aria2ProgressOwnerMap['same-epoch-gid-replacement'])
      .toEqual(replacementOwner);
    expect(useDownloadProgressStore.getState().progressMap['same-epoch-gid-replacement']).toMatchObject({
      fraction: 0.6,
      downloaded_bytes: 6000,
      gid: 'replacement-gid',
      control_epoch: '71',
      owner_revision: '141'
    });
    release();
  });

  it('rejects delayed Aria2 paused and retrying states after a same-GID resume', async () => {
    const handlers: DownloadEventHandlers = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'same-gid-state-fence',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    const previousOwner = {
      gid: 'same-gid',
      controlEpoch: '51',
      lifecycleGeneration: '14',
      ownerRevision: '103'
    };
    const resumedOwner = {
      ...previousOwner,
      controlEpoch: '52',
      ownerRevision: '104'
    };
    emitAria2OwnerState(handlers, 'same-gid-state-fence', 'downloading', previousOwner);
    handlers['download-progress']({ payload: {
      id: 'same-gid-state-fence',
      fraction: 0.62,
      speed: '1 MB/s',
      eta: '4s',
      size: '10 KB',
      size_is_final: false,
      downloaded_bytes: 6200,
      total_bytes: 10000,
      total_is_estimate: false,
      ...aria2ProgressOwnerFields(previousOwner)
    } });

    useDownloadStore.getState().updateDownload('same-gid-state-fence', { status: 'queued' });
    emitAria2OwnerState(handlers, 'same-gid-state-fence', 'queued', resumedOwner);
    emitAria2OwnerState(handlers, 'same-gid-state-fence', 'downloading', resumedOwner);
    handlers['download-progress']({ payload: {
      id: 'same-gid-state-fence',
      fraction: 0.68,
      speed: '2 MB/s',
      eta: '3s',
      size: '10 KB',
      size_is_final: false,
      downloaded_bytes: 6800,
      total_bytes: 10000,
      total_is_estimate: false,
      ...aria2ProgressOwnerFields(resumedOwner)
    } });

    emitAria2OwnerState(handlers, 'same-gid-state-fence', 'paused', previousOwner);
    emitAria2OwnerState(handlers, 'same-gid-state-fence', 'retrying', previousOwner);
    handlers['download-state']({ payload: {
      id: 'same-gid-state-fence',
      status: 'paused'
    } });
    handlers['download-state']({ payload: {
      id: 'same-gid-state-fence',
      status: 'retrying',
      error: 'old retry worker'
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      fraction: 0.68,
      downloadedBytes: 6800,
      totalBytes: 10000
    });
    expect(useDownloadProgressStore.getState().aria2ProgressOwnerMap['same-gid-state-fence'])
      .toEqual(resumedOwner);
    expect(useDownloadProgressStore.getState().progressMap['same-gid-state-fence']).toMatchObject({
      fraction: 0.68,
      downloaded_bytes: 6800,
      owner_revision: '104'
    });
    release();
  });

  it('rejects an older Aria2 add failure after a newer lifecycle becomes active', async () => {
    const handlers: DownloadEventHandlers = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'stale-add-failure',
        url: 'https://example.com/file.bin',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    const activeOwner = aria2Owner('stale-add-failure', '9', '5', '12');
    emitAria2OwnerState(handlers, 'stale-add-failure', 'downloading', activeOwner);
    handlers['download-state']({ payload: {
      id: 'stale-add-failure',
      status: 'failed',
      error: 'older addUri attempt failed',
      lifecycleGeneration: '4'
    } });

    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'downloading',
      lastError: undefined
    });
    expect(useDownloadProgressStore.getState().aria2LifecycleGenerationMap['stale-add-failure'])
      .toBe('5');
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
    let owner = aria2Owner('retry-progress');
    emitAria2OwnerState(handlers, 'retry-progress', 'downloading', owner);
    const progress = (fraction: number, downloadedBytes: number) => handlers['download-progress']({ payload: {
      id: 'retry-progress',
      fraction,
      speed: '1 MB/s',
      eta: '2s',
      size: '10 KB',
      size_is_final: false,
      downloaded_bytes: downloadedBytes,
      total_bytes: 10000,
      total_is_estimate: false,
      ...aria2ProgressOwnerFields(owner)
    } });
    progress(0.8, 8000);
    handlers['download-state']({ payload: {
      id: 'retry-progress',
      status: 'retrying',
      error: 'network dropped',
      ...owner
    } });
    expect(useDownloadStore.getState().downloads[0]).toMatchObject({
      status: 'retrying',
      fraction: 0.8,
      downloadedBytes: 8000,
      totalBytes: 10000,
      totalIsEstimate: false
    });
    useDownloadStore.getState().updateDownload('retry-progress', { status: 'downloading' });
    owner = aria2Owner('retry-progress', '2');
    emitAria2OwnerState(handlers, 'retry-progress', 'downloading', owner);
    progress(0.1, 1000);
    handlers['download-state']({ payload: {
      id: 'retry-progress',
      status: 'failed',
      error: 'retry exhausted',
      ...owner
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
      total_is_estimate: null,
      progress_checkpoint_epoch: '0',
      lifecycle_generation: '0'
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
      total_is_estimate: null,
      progress_checkpoint_epoch: '0',
      lifecycle_generation: '0'
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
    const owner = aria2Owner('resume-race', '2', '1');
    handlers['download-state']({ payload: {
      id: 'resume-race',
      status: 'queued',
      ...owner
    } });
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
      status: 'downloading',
      ...owner
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
