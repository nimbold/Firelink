import { describe, expect, it } from 'vitest';
import {
  getKeychainAccessReady,
  getKeychainConsentVersion,
  getKeychainStartupDecision
} from './keychainStartup';

describe('getKeychainStartupDecision', () => {
  it('keeps portable site credentials gated until system-store access is granted', () => {
    expect(getKeychainAccessReady({
      portable: true,
      accessGranted: false,
      persistent: true
    })).toBe(false);
    expect(getKeychainAccessReady({
      portable: true,
      accessGranted: true,
      persistent: true
    })).toBe(true);
  });

  it('uses persistent pairing state for standard-mode readiness', () => {
    expect(getKeychainAccessReady({
      portable: false,
      accessGranted: false,
      persistent: true
    })).toBe(true);
  });

  it('changes the consent identity when the credential-access policy changes', () => {
    expect(getKeychainConsentVersion('1.1.0')).toMatch(
      /^1\.1\.0\|(build-.+|keychain-policy-2)$/
    );
    expect(getKeychainConsentVersion('')).toBe('');
  });

  it('re-prompts when the app build keeps the same semantic version', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: getKeychainConsentVersion('1.1.0'),
      approvedVersion: '1.1.0',
      accessGranted: true,
      promptDismissed: true
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: true
    });
  });

  it('defers persistent hydration and shows the explanation after an update', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '1.0.5',
      approvedVersion: '1.0.4',
      accessGranted: true,
      promptDismissed: false
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: true
    });
  });

  it('hydrates automatically after the current version was explicitly approved', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '1.0.5',
      approvedVersion: '1.0.5',
      accessGranted: true,
      promptDismissed: false
    })).toEqual({
      deferKeychainHydration: false,
      showKeychainPrompt: false
    });
  });

  it('shows the explanation on first run without touching the credential store', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '1.0.5',
      approvedVersion: '',
      accessGranted: false,
      promptDismissed: false
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: true
    });
  });

  it('keeps a deliberately deferred session quiet on later launches', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '1.0.5',
      approvedVersion: '1.0.5',
      accessGranted: false,
      promptDismissed: true
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: false
    });
  });

  it('reoffers the explanation after a later update even if the previous one was deferred', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '1.0.6',
      approvedVersion: '1.0.5',
      accessGranted: false,
      promptDismissed: true
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: true
    });
  });

  it('does not repeat a deferred prompt when the version API is unavailable', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '',
      approvedVersion: '',
      accessGranted: false,
      promptDismissed: true
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: false
    });
  });

  it('keeps persistent access deferred without prompting when the version API is unavailable', () => {
    expect(getKeychainStartupDecision({
      portable: false,
      appVersion: '',
      approvedVersion: '1.0.5',
      accessGranted: true,
      promptDismissed: false
    })).toEqual({
      deferKeychainHydration: true,
      showKeychainPrompt: false
    });
  });

  it('never gates portable pairing on credential-store access', () => {
    expect(getKeychainStartupDecision({
      portable: true,
      appVersion: '1.0.5',
      approvedVersion: '',
      accessGranted: false,
      promptDismissed: false
    })).toEqual({
      deferKeychainHydration: false,
      showKeychainPrompt: false
    });
  });
});
