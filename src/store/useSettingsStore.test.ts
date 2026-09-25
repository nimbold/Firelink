import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runSettingsPersistenceTransaction,
  SettingsPersistenceError,
  subscribeToSettingsPersistenceErrors,
  waitForSettingsPersistence,
  useSettingsStore
} from './useSettingsStore';
import * as ipc from '../ipc';
import type { PairingTokenHydration } from '../bindings/PairingTokenHydration';
import {
  DEFAULT_TORRENT_MAX_OPEN_FILES,
  MAX_TORRENT_MAX_OPEN_FILES
} from '../utils/downloads';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(async (command: string) => command === 'db_load_settings' ? null : undefined)
}));

vi.mock('../utils/logger', () => ({
  info: vi.fn()
}));

describe('last used download directory preference', () => {
  it('is disabled by default', () => {
    expect(useSettingsStore.getState().rememberLastUsedDownloadDirectory).toBe(false);
  });
});

describe('start at login preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      showMenuBarIcon: false,
      startAtLogin: false,
      startAtLoginSupported: false,
      startAtLoginRequiresApproval: false,
      startAtLoginSyncState: 'idle'
    });
  });

  it('is off by default and remains transient', () => {
    expect(useSettingsStore.getState().startAtLogin).toBe(false);

    const partialize = useSettingsStore.persist.getOptions().partialize;
    const snapshot = partialize?.(useSettingsStore.getState());

    expect(snapshot).not.toHaveProperty('startAtLogin');
    expect(snapshot).not.toHaveProperty('startAtLoginSupported');
    expect(snapshot).not.toHaveProperty('startAtLoginRequiresApproval');
    expect(snapshot).not.toHaveProperty('startAtLoginSyncState');

    const merge = useSettingsStore.persist.getOptions().merge;
    const merged = merge?.({
      startAtLogin: true,
      startAtLoginRequiresApproval: true,
      startAtLoginSyncState: 'ready'
    }, useSettingsStore.getState());
    expect(merged).toMatchObject({
      startAtLogin: false,
      startAtLoginSupported: false,
      startAtLoginRequiresApproval: false,
      startAtLoginSyncState: 'idle'
    });
  });

  it('deduplicates concurrent OS status checks', async () => {
    let resolveRequest!: (status: { supported: boolean; enabled: boolean; requiresApproval: boolean }) => void;
    const request = new Promise<{ supported: boolean; enabled: boolean; requiresApproval: boolean }>(resolve => {
      resolveRequest = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'get_start_at_login') return request as never;
      return Promise.resolve(undefined) as never;
    });

    const first = useSettingsStore.getState().syncStartAtLogin();
    const second = useSettingsStore.getState().syncStartAtLogin();

    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith('get_start_at_login');
      expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'get_start_at_login')).toHaveLength(1);
      expect(useSettingsStore.getState().startAtLoginSyncState).toBe('syncing');
    });

    resolveRequest({ supported: true, enabled: true, requiresApproval: false });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { supported: true, enabled: true, requiresApproval: false },
      { supported: true, enabled: true, requiresApproval: false }
    ]);
    expect(useSettingsStore.getState()).toMatchObject({
      startAtLogin: true,
      startAtLoginSupported: true,
      startAtLoginRequiresApproval: false,
      startAtLoginSyncState: 'ready'
    });
  });

  it('does not expose unsupported native startup as enabled', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'get_start_at_login') {
        return Promise.resolve({ supported: false, enabled: true, requiresApproval: false }) as never;
      }
      return Promise.resolve(undefined) as never;
    });

    await useSettingsStore.getState().syncStartAtLogin();

    expect(useSettingsStore.getState()).toMatchObject({
      startAtLogin: false,
      startAtLoginSupported: false,
      startAtLoginRequiresApproval: false,
      startAtLoginSyncState: 'ready'
    });
  });

  it('updates the OS before changing state and preserves the underlying tray preference', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string, args?: unknown) => {
      if (command === 'set_start_at_login') {
        const enabled = (args as { enabled: boolean }).enabled;
        return Promise.resolve(
          enabled
            ? { supported: true, enabled: true, requiresApproval: false }
            : { supported: true, enabled: false, requiresApproval: false }
        ) as never;
      }
      return Promise.resolve(undefined) as never;
    });

    await useSettingsStore.getState().setStartAtLogin(true);
    expect(useSettingsStore.getState()).toMatchObject({
      startAtLogin: true,
      showMenuBarIcon: false
    });

    await useSettingsStore.getState().setStartAtLogin(false);
    expect(useSettingsStore.getState()).toMatchObject({
      startAtLogin: false,
      showMenuBarIcon: false
    });
    const startupCalls = vi.mocked(ipc.invokeCommand).mock.calls.filter(
      ([command]) => command === 'set_start_at_login'
    );
    expect(startupCalls).toEqual([
      ['set_start_at_login', { enabled: true }],
      ['set_start_at_login', { enabled: false }]
    ]);
  });

  it('does not claim startup was changed when the native command fails', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'set_start_at_login') return Promise.reject(new Error('registration failed')) as never;
      return Promise.resolve(undefined) as never;
    });

    await expect(useSettingsStore.getState().setStartAtLogin(true))
      .rejects.toThrow('registration failed');
    expect(useSettingsStore.getState()).toMatchObject({
      startAtLogin: false,
      startAtLoginSyncState: 'error'
    });
  });

  it('retains pending approval status returned by the OS', async () => {
    vi.mocked(ipc.invokeCommand).mockImplementation((command: string) => {
      if (command === 'set_start_at_login') {
        return Promise.resolve({ supported: true, enabled: true, requiresApproval: true }) as never;
      }
      return Promise.resolve(undefined) as never;
    });

    await useSettingsStore.getState().setStartAtLogin(true);

    expect(useSettingsStore.getState()).toMatchObject({
      startAtLogin: true,
      startAtLoginSupported: true,
      startAtLoginRequiresApproval: true,
      startAtLoginSyncState: 'ready'
    });
  });
});

describe('durable main-window and sidebar preferences', () => {
  it('uses safe defaults and persists the current values', async () => {
    vi.clearAllMocks();
    useSettingsStore.setState({ isFoldersCollapsed: false, mainWindowSize: null });

    expect(useSettingsStore.getState()).toMatchObject({
      isFoldersCollapsed: false,
      mainWindowSize: null
    });

    useSettingsStore.getState().setFoldersCollapsed(true);
    useSettingsStore.getState().setMainWindowSize({ width: 1280, height: 800 });

    await vi.waitFor(() => {
      const save = vi.mocked(ipc.invokeCommand).mock.calls
        .filter(([command]) => command === 'db_save_settings')
        .slice(-1)[0];
      expect(save).toBeDefined();
      expect(JSON.parse((save?.[1] as { data: string }).data).state).toMatchObject({
        isFoldersCollapsed: true,
        mainWindowSize: { width: 1280, height: 800 }
      });
    });
  });

  it('rejects malformed, undersized, and oversized geometry during hydration', () => {
    const merge = useSettingsStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf('function');
    const current = useSettingsStore.getState();

    expect(merge?.({ mainWindowSize: { width: 959, height: 800 } }, current).mainWindowSize)
      .toBe(current.mainWindowSize);
    expect(merge?.({ mainWindowSize: { width: 1280, height: 16_385 } }, current).mainWindowSize)
      .toBe(current.mainWindowSize);
    expect(merge?.({ mainWindowSize: { width: '1280', height: 800 } }, current).mainWindowSize)
      .toBe(current.mainWindowSize);
    expect(merge?.({ mainWindowSize: { width: 1440, height: 900 } }, current).mainWindowSize)
      .toEqual({ width: 1440, height: 900 });
  });

  it('rejects malformed consumer values during hydration', () => {
    const merge = useSettingsStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf('function');
    const current = useSettingsStore.getState();

    expect(merge?.({
      proxyMode: 'custom',
      proxyHost: 123,
      proxyPort: 70000,
      customUserAgent: ['not-a-string'],
      isSidebarVisible: 'yes',
      lastCustomSpeedLimitKiB: Number.POSITIVE_INFINITY,
      approvedDownloadRoots: ['/safe', 42],
      speedLimitPresetValues: [1, '5', Number.NaN]
    }, current)).toMatchObject({
      proxyMode: 'custom',
      proxyHost: current.proxyHost,
      proxyPort: current.proxyPort,
      customUserAgent: current.customUserAgent,
      isSidebarVisible: current.isSidebarVisible,
      lastCustomSpeedLimitKiB: current.lastCustomSpeedLimitKiB,
      approvedDownloadRoots: ['/safe'],
      speedLimitPresetValues: [1]
    });
  });

  it('pins volatile navigation and sanitizes scheduler and cookie source during hydration', () => {
    const merge = useSettingsStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf('function');
    const current = useSettingsStore.getState();

    const result = merge?.({
      activeView: 'logs' as any,
      showKeychainModal: true as any,
      mediaCookieSource: 'internet-explorer' as any,
      lastCustomSpeedLimitUnit: 'GB/s',
      scheduler: {
        enabled: 'yes' as any,
        postQueueAction: 'self-destruct' as any,
        selectedDays: [10, -1, 3],
        selectedQueueIds: ['   ', 'queue-1']
      },
      schedulerRunning: 'running' as any,
      schedulerActiveDownloadIds: 'all' as any
    }, current);

    expect(result?.activeView).toBe(current.activeView);
    expect(result?.showKeychainModal).toBe(false);
    expect(result?.mediaCookieSource).toBe('none');
    expect(result?.lastCustomSpeedLimitUnit).toBe(current.lastCustomSpeedLimitUnit);
    expect(result?.scheduler.enabled).toBe(current.scheduler.enabled);
    expect(result?.scheduler.postQueueAction).toBe('none');
    expect(result?.scheduler.selectedDays).toEqual([3]);
    expect(result?.scheduler.selectedQueueIds).toEqual(['queue-1']);
    expect(result?.schedulerRunning).toBe(current.schedulerRunning);
    expect(result?.schedulerActiveDownloadIds).toEqual(current.schedulerActiveDownloadIds);

    const fallbackResult = merge?.({
      scheduler: {
        selectedDays: [-5, 99] as any,
        selectedQueueIds: ['   ', ''] as any
      }
    }, current);
    expect(fallbackResult?.scheduler.selectedDays).toEqual(current.scheduler.selectedDays);
    expect(fallbackResult?.scheduler.selectedQueueIds).toEqual(current.scheduler.selectedQueueIds);
  });

  it('filters empty scheduler active download IDs during hydration', () => {
    const merge = useSettingsStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf('function');
    const current = useSettingsStore.getState();

    const result = merge?.({
      schedulerActiveDownloadIds: ['', '  ', 'download-1', 42] as any
    }, current);

    expect(result?.schedulerActiveDownloadIds).toEqual(['download-1']);
  });

  it('does not restore a running scheduler without active download IDs', () => {
    const merge = useSettingsStore.persist.getOptions().merge;
    expect(merge).toBeTypeOf('function');
    const current = useSettingsStore.getState();

    const result = merge?.({
      schedulerRunning: true,
      schedulerActiveDownloadIds: ['', '  ', 42] as any
    }, current);

    expect(result?.schedulerRunning).toBe(false);
    expect(result?.schedulerActiveDownloadIds).toEqual([]);
  });

  it('does not persist a running scheduler without active download IDs', () => {
    const partialize = useSettingsStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf('function');
    const current = useSettingsStore.getState();

    const snapshot = partialize?.({
      ...current,
      schedulerRunning: true,
      schedulerActiveDownloadIds: []
    });

    expect(snapshot).toMatchObject({
      schedulerRunning: false,
      schedulerActiveDownloadIds: []
    });
  });

  it('sanitizes setter calls for enum and numeric settings', () => {
    useSettingsStore.getState().setMediaCookieSource('invalid-browser' as any);
    expect(useSettingsStore.getState().mediaCookieSource).toBe('none');

    useSettingsStore.getState().setTheme('invalid-theme' as any);
    expect(useSettingsStore.getState().theme).toBe('system');

    useSettingsStore.getState().setLastCustomSpeedLimitKiB(-500);
    expect(useSettingsStore.getState().lastCustomSpeedLimitKiB).toBe(1);

    useSettingsStore.getState().setLastCustomSpeedLimitKiB(20_000_000);
    expect(useSettingsStore.getState().lastCustomSpeedLimitKiB).toBe(10_485_760);

    useSettingsStore.getState().setLastCustomSpeedLimitUnit('PB/s' as any);
    expect(useSettingsStore.getState().lastCustomSpeedLimitUnit).toBe('MB/s');
  });

  it('uses the legacy localStorage value only when durable state is absent', () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => 'true' } }
    });
    try {
      const merge = useSettingsStore.persist.getOptions().merge;
      const current = { ...useSettingsStore.getState(), isFoldersCollapsed: false };
      expect(merge?.({}, current).isFoldersCollapsed).toBe(true);
      expect(merge?.({ isFoldersCollapsed: false }, current).isFoldersCollapsed).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow
      });
    }
  });
});

describe('normal download reliability preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      minimumNormalDownloadSpeedKiB: 0,
      retryNotFoundErrors: false,
      adaptiveMirrorSelection: true,
    });
  });

  it('uses migration-safe defaults and persists bounded changes', async () => {
    expect(useSettingsStore.getState()).toMatchObject({
      minimumNormalDownloadSpeedKiB: 0,
      retryNotFoundErrors: false,
      adaptiveMirrorSelection: true,
    });

    useSettingsStore.getState().setMinimumNormalDownloadSpeedKiB(64);
    useSettingsStore.getState().setRetryNotFoundErrors(true);
    useSettingsStore.getState().setAdaptiveMirrorSelection(false);
    await vi.waitFor(() => {
      const save = vi.mocked(ipc.invokeCommand).mock.calls
        .filter(([command]) => command === 'db_save_settings')
        .slice(-1)[0];
      expect(save).toBeDefined();
      expect(JSON.parse((save?.[1] as { data: string }).data).state).toMatchObject({
        minimumNormalDownloadSpeedKiB: 64,
        retryNotFoundErrors: true,
        adaptiveMirrorSelection: false,
      });
    });

    useSettingsStore.getState().setMinimumNormalDownloadSpeedKiB(2_000_000);
    expect(useSettingsStore.getState().minimumNormalDownloadSpeedKiB).toBe(1_048_576);
  });
});

describe('Torrent peer discovery preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      torrentEnableDht: true,
      torrentEnableDht6: false,
      torrentEnablePex: true,
      torrentEnableLpd: false
    });
  });

  it('clears an IPv6 bind address when IPv6 transport is disabled', () => {
    useSettingsStore.setState({
      torrentIpv6Enabled: true,
      torrentBindAddress: '2001:db8::10'
    });

    useSettingsStore.getState().setTorrentIpv6Enabled(false);

    expect(useSettingsStore.getState()).toMatchObject({
      torrentIpv6Enabled: false,
      torrentBindAddress: ''
    });
  });

  it('rejects an IPv6 bind address entered after IPv6 transport is disabled', () => {
    useSettingsStore.setState({
      torrentIpv6Enabled: false,
      torrentBindAddress: ''
    });

    expect(useSettingsStore.getState().setTorrentBindAddress('2001:db8::10')).toBe(false);
    expect(useSettingsStore.getState().torrentBindAddress).toBe('');

    expect(useSettingsStore.getState().setTorrentBindAddress('192.0.2.10')).toBe(true);
    expect(useSettingsStore.getState().torrentBindAddress).toBe('192.0.2.10');
  });

  it('matches Aria2 defaults and persists explicit changes', async () => {
    expect(useSettingsStore.getState().torrentEnableDht).toBe(true);
    expect(useSettingsStore.getState().torrentEnableDht6).toBe(false);
    expect(useSettingsStore.getState().torrentEnablePex).toBe(true);
    expect(useSettingsStore.getState().torrentEnableLpd).toBe(false);

    useSettingsStore.getState().setTorrentEnableDht(false);
    useSettingsStore.getState().setTorrentEnableDht6(true);
    useSettingsStore.getState().setTorrentEnablePex(false);
    useSettingsStore.getState().setTorrentEnableLpd(true);
    await vi.waitFor(() => {
      const save = vi.mocked(ipc.invokeCommand).mock.calls
        .filter(([command]) => command === 'db_save_settings')
        .slice(-1)[0];
      expect(save).toBeDefined();
      expect(JSON.parse((save?.[1] as { data: string }).data).state).toMatchObject({
        torrentEnableDht: false,
        torrentEnableDht6: true,
        torrentEnablePex: false,
        torrentEnableLpd: true
      });
    });
  });
});

describe('Torrent open-file limit preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ torrentMaxOpenFiles: DEFAULT_TORRENT_MAX_OPEN_FILES });
  });

  it('applies a bounded global limit before persisting it', async () => {
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined);

    await useSettingsStore.getState().setTorrentMaxOpenFiles(256);

    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_torrent_max_open_files', {
      max_open_files: 256
    });
    expect(useSettingsStore.getState().torrentMaxOpenFiles).toBe(256);
  });

  it('rejects unsafe values without changing the saved limit', async () => {
    await expect(useSettingsStore.getState().setTorrentMaxOpenFiles(0)).rejects.toThrow();
    await expect(
      useSettingsStore.getState().setTorrentMaxOpenFiles(MAX_TORRENT_MAX_OPEN_FILES + 1)
    ).rejects.toThrow();

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
      'set_torrent_max_open_files',
      expect.anything()
    );
    expect(useSettingsStore.getState().torrentMaxOpenFiles)
      .toBe(DEFAULT_TORRENT_MAX_OPEN_FILES);
  });

  it('serializes rapid updates so the native global option cannot reorder', async () => {
    let releaseFirst!: () => void;
    const firstUpdate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command !== 'set_torrent_max_open_files') return undefined;
      const value = (args as { max_open_files: number }).max_open_files;
      events.push(`start:${value}`);
      if (value === 256) await firstUpdate;
      events.push(`finish:${value}`);
      return undefined;
    });

    const first = useSettingsStore.getState().setTorrentMaxOpenFiles(256);
    const second = useSettingsStore.getState().setTorrentMaxOpenFiles(512);
    await vi.waitFor(() => expect(events).toEqual(['start:256']));
    expect(useSettingsStore.getState().torrentMaxOpenFiles)
      .toBe(DEFAULT_TORRENT_MAX_OPEN_FILES);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['start:256', 'finish:256', 'start:512', 'finish:512']);
    expect(useSettingsStore.getState().torrentMaxOpenFiles).toBe(512);
  });
});

describe('calendar preference', () => {
  it('keeps Gregorian as the default and persists explicit calendar choices', async () => {
    vi.clearAllMocks();
    useSettingsStore.setState({ calendarPreference: 'gregorian' });
    expect(useSettingsStore.getState().calendarPreference).toBe('gregorian');

    useSettingsStore.getState().setCalendarPreference('persian');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(useSettingsStore.getState().calendarPreference).toBe('persian');
    const save = vi.mocked(ipc.invokeCommand).mock.calls
      .filter(([command]) => command === 'db_save_settings')
      .slice(-1)[0];
    expect(save).toBeDefined();
    expect(JSON.parse((save?.[1] as { data: string }).data).state.calendarPreference).toBe('persian');
  });
});

describe('useSettingsStore global speed limit persistence', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      globalSpeedLimit: '2M',
      lastCustomSpeedLimitKiB: 2048,
      lastCustomSpeedLimitUnit: 'MB/s'
    });
    await waitForSettingsPersistence();
    vi.clearAllMocks();
  });

  it('keeps the saved value when the backend rejects a limit change', async () => {
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('aria2 unavailable'));

    await expect(useSettingsStore.getState().setGlobalSpeedLimit('3M')).rejects.toThrow('aria2 unavailable');

    expect(useSettingsStore.getState().globalSpeedLimit).toBe('2M');
    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_global_speed_limit', { limit: '3M' });
  });

  it('rejects malformed limits before changing native or local state', async () => {
    await expect(useSettingsStore.getState().setGlobalSpeedLimit('not-a-rate'))
      .rejects.toThrow('Global speed limit is invalid');

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
      'set_global_speed_limit',
      expect.anything()
    );
    expect(useSettingsStore.getState().globalSpeedLimit).toBe('2M');
  });

  it('persists the active limit and last-used value in one settings write', async () => {
    const commands: string[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      commands.push(command);
      return undefined as never;
    });

    await useSettingsStore.getState().saveGlobalSpeedLimitSettings('3M', 1536, 'KB/s');
    await vi.waitFor(() => {
      expect(commands).toEqual(['set_global_speed_limit', 'db_save_settings']);
    });

    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '3M',
      lastCustomSpeedLimitKiB: 1536,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
    const save = vi.mocked(ipc.invokeCommand).mock.calls.find(([command]) => command === 'db_save_settings');
    expect(save).toBeDefined();
    expect(JSON.parse((save?.[1] as { data: string }).data).state).toMatchObject({
      globalSpeedLimit: '3M',
      lastCustomSpeedLimitKiB: 1536,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
  });

  it('persists a disabled limit as a single atomic settings write', async () => {
    const commands: string[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      commands.push(command);
      return undefined as never;
    });

    await useSettingsStore.getState().saveGlobalSpeedLimitSettings('', 1, 'KB/s');
    await vi.waitFor(() => {
      expect(commands).toEqual(['set_global_speed_limit', 'db_save_settings']);
    });

    expect(vi.mocked(ipc.invokeCommand)).toHaveBeenCalledWith('set_global_speed_limit', { limit: null });
    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '',
      lastCustomSpeedLimitKiB: 1,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
  });

  it('rejects malformed values before invoking native code or persisting state', async () => {
    await expect(useSettingsStore.getState().saveGlobalSpeedLimitSettings('not-a-rate', 1536, 'KB/s'))
      .rejects.toThrow('Global speed limit is invalid');

    expect(ipc.invokeCommand).not.toHaveBeenCalled();
    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '2M',
      lastCustomSpeedLimitKiB: 2048,
      lastCustomSpeedLimitUnit: 'MB/s'
    });
  });

  it('keeps all saved speed settings unchanged when Aria2 rejects the change', async () => {
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('aria2 unavailable'));

    await expect(useSettingsStore.getState().saveGlobalSpeedLimitSettings('3M', 1536, 'KB/s'))
      .rejects.toThrow('aria2 unavailable');

    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '2M',
      lastCustomSpeedLimitKiB: 2048,
      lastCustomSpeedLimitUnit: 'MB/s'
    });
    expect(vi.mocked(ipc.invokeCommand).mock.calls.filter(([command]) => command === 'db_save_settings'))
      .toHaveLength(0);
  });

  it('waits for the settings database write before resolving Save', async () => {
    let releaseDatabaseWrite!: () => void;
    const databaseWrite = new Promise<void>(resolve => {
      releaseDatabaseWrite = resolve;
    });
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce(undefined as never);
    vi.mocked(ipc.invokeCommand).mockImplementationOnce(async (command: string) => {
      if (command === 'db_save_settings') await databaseWrite;
      return undefined as never;
    });

    let saveResolved = false;
    const save = useSettingsStore.getState()
      .saveGlobalSpeedLimitSettings('3M', 1536, 'KB/s')
      .then(() => { saveResolved = true; });
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith('db_save_settings', expect.anything());
    });

    expect(saveResolved).toBe(false);
    releaseDatabaseWrite();
    await save;
    expect(saveResolved).toBe(true);
  });

  it('surfaces a settings database failure instead of reporting a successful Save', async () => {
    const onPersistenceError = vi.fn();
    const unsubscribe = subscribeToSettingsPersistenceErrors(onPersistenceError);
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce(undefined as never);
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('disk full'));

    await expect(useSettingsStore.getState().saveGlobalSpeedLimitSettings('3M', 1536, 'KB/s'))
      .rejects.toBeInstanceOf(SettingsPersistenceError);

    expect(onPersistenceError).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '3M',
      lastCustomSpeedLimitKiB: 1536,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
    expect(vi.mocked(ipc.invokeCommand).mock.calls.map(([command]) => command))
      .toEqual(['set_global_speed_limit', 'db_save_settings']);
    unsubscribe();
  });

  it('waits for settings hydration before applying and persisting a limit', async () => {
    let releaseSettingsRead!: (value: string | null) => void;
    const settingsRead = new Promise<string | null>(resolve => {
      releaseSettingsRead = resolve;
    });
    let persistedSnapshot: string | undefined;
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'db_load_settings') return settingsRead as never;
      if (command === 'db_save_settings') {
        persistedSnapshot = (args as { data: string }).data;
      }
      return undefined as never;
    });

    const hydration = useSettingsStore.persist.rehydrate();
    await vi.waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith('db_load_settings');
    });
    const save = useSettingsStore.getState().saveGlobalSpeedLimitSettings('3M', 1536, 'KB/s');
    releaseSettingsRead(JSON.stringify({
      state: {
        globalSpeedLimit: '1M',
        lastCustomSpeedLimitKiB: 1024,
        lastCustomSpeedLimitUnit: 'MB/s'
      },
      version: 6
    }));

    await Promise.all([hydration, save]);
    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '3M',
      lastCustomSpeedLimitKiB: 1536,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
    expect(JSON.parse(persistedSnapshot ?? '').state).toMatchObject({
      globalSpeedLimit: '3M',
      lastCustomSpeedLimitKiB: 1536,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
  });

  it('serializes repeated saves so the latest requested limit wins', async () => {
    let releaseFirstLimit!: () => void;
    const firstLimit = new Promise<void>(resolve => {
      releaseFirstLimit = resolve;
    });
    const appliedLimits: string[] = [];
    const persistedLimits: string[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'set_global_speed_limit') {
        const limit = (args as { limit: string | null }).limit;
        if (limit) appliedLimits.push(limit);
        if (appliedLimits.length === 1) await firstLimit;
      }
      if (command === 'db_save_settings') {
        persistedLimits.push(JSON.parse((args as { data: string }).data).state.globalSpeedLimit);
      }
      return undefined as never;
    });

    const firstSave = useSettingsStore.getState().saveGlobalSpeedLimitSettings('3M', 3072, 'KB/s');
    const secondSave = useSettingsStore.getState().saveGlobalSpeedLimitSettings('4M', 4096, 'KB/s');
    await vi.waitFor(() => expect(appliedLimits).toEqual(['3M']));

    releaseFirstLimit();
    await Promise.all([firstSave, secondSave]);
    expect(appliedLimits).toEqual(['3M', '4M']);
    expect(persistedLimits).toEqual(['3M', '4M']);
    expect(useSettingsStore.getState()).toMatchObject({
      globalSpeedLimit: '4M',
      lastCustomSpeedLimitKiB: 4096,
      lastCustomSpeedLimitUnit: 'KB/s'
    });
  });
});

describe('useSettingsStore Torrent overall upload limit persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ torrentOverallUploadLimit: '2M' });
  });

  it('applies a normalized limit before updating local state', async () => {
    await useSettingsStore.getState().setTorrentOverallUploadLimit('1.5 MB/s');

    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_torrent_overall_upload_limit', {
      limit: '1.5M'
    });
    expect(useSettingsStore.getState().torrentOverallUploadLimit).toBe('1.5M');
  });

  it('keeps the saved value when the native global option rejects an update', async () => {
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('aria2 unavailable'));

    await expect(
      useSettingsStore.getState().setTorrentOverallUploadLimit('3M')
    ).rejects.toThrow('aria2 unavailable');

    expect(useSettingsStore.getState().torrentOverallUploadLimit).toBe('2M');
  });

  it('uses null to restore Aria2 unlimited upload', async () => {
    await useSettingsStore.getState().setTorrentOverallUploadLimit('');

    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_torrent_overall_upload_limit', {
      limit: null
    });
    expect(useSettingsStore.getState().torrentOverallUploadLimit).toBe('');
  });

  it('rejects malformed limits without clearing the saved value', async () => {
    await expect(
      useSettingsStore.getState().setTorrentOverallUploadLimit('not-a-rate')
    ).rejects.toThrow('Torrent overall upload limit is invalid');

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith(
      'set_torrent_overall_upload_limit',
      expect.anything()
    );
    expect(useSettingsStore.getState().torrentOverallUploadLimit).toBe('2M');
  });
});

describe('useSettingsStore dock badge synchronization', () => {
  it('increments the badge sync version for every toggle without issuing out-of-band clears', () => {
    vi.clearAllMocks();
    const initialVersion = useSettingsStore.getState().dockBadgeSyncVersion;

    useSettingsStore.getState().setShowDockBadge(false);
    useSettingsStore.getState().setShowDockBadge(true);

    expect(useSettingsStore.getState().dockBadgeSyncVersion).toBe(initialVersion + 2);
    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('update_dock_badge', { count: 0 });
  });
});

describe('useSettingsStore credential-store startup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      extensionPairingToken: '',
      isPairingTokenPersistent: false,
      keychainAccessGranted: false,
      keychainAccessVersion: '',
      keychainAccessReady: false,
      keychainPromptDismissed: false,
      showKeychainModal: false
    });
  });

  it('loads the session pairing token without invoking the credential store', async () => {
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce({
      token: 'session-token',
      tokenChanged: false,
      persistent: false,
      error: null
    });

    await useSettingsStore.getState().hydrateSessionPairingToken();

    expect(ipc.invokeCommand).toHaveBeenCalledWith('get_session_pairing_token');
    expect(useSettingsStore.getState().extensionPairingToken).toBe('session-token');
    expect(useSettingsStore.getState().isPairingTokenPersistent).toBe(false);
  });

  it('clears the approved startup state when the user defers credential access', () => {
    useSettingsStore.setState({ keychainAccessGranted: true });

    useSettingsStore.getState().dismissKeychainPrompt('1.0.5');

    expect(useSettingsStore.getState().keychainAccessGranted).toBe(false);
    expect(useSettingsStore.getState().keychainAccessReady).toBe(false);
    expect(useSettingsStore.getState().keychainAccessVersion).toBe('1.0.5');
    expect(useSettingsStore.getState().keychainPromptDismissed).toBe(true);
  });

  it('opens the consent modal instead of regenerating through the credential store', async () => {
    await expect(useSettingsStore.getState().regeneratePairingToken())
      .rejects.toThrow('Grant credential-store access before regenerating the pairing token.');

    expect(ipc.invokeCommand).not.toHaveBeenCalledWith('regenerate_pairing_token');
    expect(useSettingsStore.getState().showKeychainModal).toBe(true);
  });

  it('does not apply pairing hydration after startup becomes inactive', async () => {
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce({
      token: 'stale-token',
      tokenChanged: true,
      persistent: true,
      error: null
    });

    await expect(useSettingsStore.getState().hydratePairingToken(() => false)).resolves.toBe(false);

    expect(ipc.invokeCommand).toHaveBeenCalledWith('hydrate_extension_pairing_token');
    expect(useSettingsStore.getState().extensionPairingToken).toBe('');
    expect(useSettingsStore.getState().isPairingTokenPersistent).toBe(false);
  });

  it('does not apply session hydration after startup becomes inactive', async () => {
    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce({
      token: 'stale-session-token',
      tokenChanged: false,
      persistent: false,
      error: null
    });

    await useSettingsStore.getState().hydrateSessionPairingToken(() => false);

    expect(ipc.invokeCommand).toHaveBeenCalledWith('get_session_pairing_token');
    expect(useSettingsStore.getState().extensionPairingToken).toBe('');
    expect(useSettingsStore.getState().isPairingTokenPersistent).toBe(false);
  });

  it('shares a concurrent pairing hydration request', async () => {
    let resolveRequest!: (value: PairingTokenHydration) => void;
    const request = new Promise<PairingTokenHydration>(resolve => {
      resolveRequest = resolve;
    });
    let hydrationRequestCount = 0;
    vi.mocked(ipc.invokeCommand).mockImplementation(async (command: string) => {
      if (command === 'hydrate_extension_pairing_token') {
        hydrationRequestCount += 1;
        return request;
      }
      return undefined;
    });

    const first = useSettingsStore.getState().hydratePairingToken();
    const second = useSettingsStore.getState().hydratePairingToken();

    expect(hydrationRequestCount).toBe(1);
    resolveRequest({
      token: 'shared-token',
      tokenChanged: false,
      persistent: true,
      error: null
    });
    await Promise.all([first, second]);

    expect(useSettingsStore.getState().extensionPairingToken).toBe('shared-token');
    expect(useSettingsStore.getState().isPairingTokenPersistent).toBe(true);
  });
});

describe('useSettingsStore persistence failures', () => {
  it('keeps settings writes queued behind a credential transaction', async () => {
    const events: string[] = [];
    vi.mocked(ipc.invokeCommand).mockImplementation(async command => {
      if (command === 'db_save_settings') events.push('settings-write');
      return undefined;
    });

    await runSettingsPersistenceTransaction(async () => {
      events.push('transaction-start');
      useSettingsStore.setState({ theme: 'dark' });
      events.push('transaction-end');
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(events.slice(0, 2)).toEqual(['transaction-start', 'transaction-end']);
    expect(events).toContain('settings-write');
  });

  it('reports a database save failure and retries the next settings update', async () => {
    vi.clearAllMocks();
    await new Promise(resolve => setTimeout(resolve, 0));

    const onPersistenceError = vi.fn();
    const unsubscribe = subscribeToSettingsPersistenceErrors(onPersistenceError);
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('database unavailable'));

    useSettingsStore.setState({ theme: 'dark' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onPersistenceError).toHaveBeenCalledTimes(1);

    vi.mocked(ipc.invokeCommand).mockResolvedValueOnce(undefined);
    useSettingsStore.setState({ theme: 'light' });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onPersistenceError).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
