import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToSettingsPersistenceErrors, useSettingsStore } from './useSettingsStore';
import * as ipc from '../ipc';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn()
}));

vi.mock('../utils/logger', () => ({
  info: vi.fn()
}));

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
});

describe('useSettingsStore persistence failures', () => {
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
