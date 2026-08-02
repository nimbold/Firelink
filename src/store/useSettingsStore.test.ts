import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runSettingsPersistenceTransaction,
  subscribeToSettingsPersistenceErrors,
  useSettingsStore
} from './useSettingsStore';
import * as ipc from '../ipc';
import type { PairingTokenHydration } from '../bindings/PairingTokenHydration';
import {
  DEFAULT_TORRENT_MAX_OPEN_FILES,
  MAX_TORRENT_MAX_OPEN_FILES
} from '../utils/downloads';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn()
}));

vi.mock('../utils/logger', () => ({
  info: vi.fn()
}));

describe('last used download directory preference', () => {
  it('is disabled by default', () => {
    expect(useSettingsStore.getState().rememberLastUsedDownloadDirectory).toBe(false);
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
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ globalSpeedLimit: '2M' });
  });

  it('keeps the saved value when the backend rejects a limit change', async () => {
    vi.mocked(ipc.invokeCommand).mockRejectedValueOnce(new Error('aria2 unavailable'));

    await expect(useSettingsStore.getState().setGlobalSpeedLimit('3M')).rejects.toThrow('aria2 unavailable');

    expect(useSettingsStore.getState().globalSpeedLimit).toBe('2M');
    expect(ipc.invokeCommand).toHaveBeenCalledWith('set_global_speed_limit', { limit: '3M' });
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
