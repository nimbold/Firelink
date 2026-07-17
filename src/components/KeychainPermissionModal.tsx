import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { invokeCommand as invoke } from '../ipc';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { usePlatformInfo } from '../utils/platform';
import { getKeychainConsentVersion } from '../utils/keychainStartup';
import { getVersion } from '@tauri-apps/api/app';
import type { PairingTokenHydration } from '../bindings/PairingTokenHydration';
import { useTranslation } from 'react-i18next';

const KEYCHAIN_GRANT_TIMEOUT_MS = 30_000;

type KeychainPermissionModalProps = {
  consentVersion: string;
};

export const KeychainPermissionModal: React.FC<KeychainPermissionModalProps> = ({ consentVersion }) => {
  const { t } = useTranslation();
  const showKeychainModal = useSettingsStore(state => state.showKeychainModal);
  const dismissKeychainPrompt = useSettingsStore(state => state.dismissKeychainPrompt);
  const platform = usePlatformInfo();
  const [isGranting, setIsGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!showKeychainModal || isGranting) return;
    const handleEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') dismissKeychainPrompt(consentVersion);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [consentVersion, dismissKeychainPrompt, isGranting, showKeychainModal]);

  if (!showKeychainModal) {
    return null;
  }

  const isMac = platform.os === 'macos';
  const pairingStoreName =
    platform.portable
      ? t($ => $.keychain.stores.portable)
      : platform.os === 'windows'
      ? t($ => $.keychain.stores.windows)
      : platform.os === 'linux'
        ? t($ => $.keychain.stores.linux)
        : platform.os === 'macos'
          ? t($ => $.keychain.stores.macos)
          : t($ => $.keychain.stores.system);
  const siteCredentialStoreName = platform.portable
    ? t($ => $.keychain.stores.siteCredentials)
    : pairingStoreName;
  const grantLabel = platform.portable
    ? t($ => $.keychain.grantLabelPortable)
    : isMac
      ? t($ => $.keychain.grantLabelMacos)
      : t($ => $.keychain.grantLabelDefault);

  const handleGrant = async () => {
    setIsGranting(true);
    setError(null);

    let timeoutId: number | undefined;
    let persistentGrantApplied = false;
    const applyPersistentGrant = async (result: PairingTokenHydration): Promise<boolean> => {
      if (!result.persistent || persistentGrantApplied) return result.persistent;
      persistentGrantApplied = true;
      const grantedVersion = consentVersion || getKeychainConsentVersion(await getVersion().catch(() => ''));
      // Keep state in sync with the grant result instead of rehydrating
      // before Zustand has persisted keychainAccessGranted.
      useSettingsStore.setState({
        keychainAccessGranted: true,
        keychainAccessVersion: grantedVersion,
        keychainAccessReady: true,
        extensionPairingToken: result.token,
        isPairingTokenPersistent: true,
        keychainPromptDismissed: false,
        showKeychainModal: false
      });
      return true;
    };
    const grantRequest = invoke('grant_keychain_access');
    // A native credential-store call cannot be cancelled by the webview. Keep
    // a late successful result useful even if the UI timeout has already
    // restored the Later/retry controls.
    grantRequest.then(applyPersistentGrant).catch(() => undefined);

    try {
      const result = await Promise.race([
        grantRequest,
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => reject(new Error(t($ => $.keychain.timeout))),
            KEYCHAIN_GRANT_TIMEOUT_MS
          );
        })
      ]);
      if (!(await applyPersistentGrant(result))) {
        setError(result.error || t($ => $.keychain.unavailable, { store: siteCredentialStoreName }));
      }
    } catch (e: any) {
      setError(e.toString());
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      setIsGranting(false);
    }
  };

  const handleLater = () => {
    dismissKeychainPrompt(consentVersion);
  };

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isGranting) handleLater();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="window-safe-modal bg-bg-modal rounded-xl w-full max-w-md overflow-hidden flex flex-col shadow-2xl border border-border-modal scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border-modal flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-full items-center justify-center">
            <KeyRound size={20} className="text-blue-500" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary m-0">{t($ => $.keychain.title)}</h2>
        </div>

        <div className="px-5 py-6 flex-1 min-h-0 overflow-y-auto text-sm text-text-secondary leading-relaxed space-y-4">
          <p>
            {t($ => $.keychain.description, { pairingStore: pairingStoreName, siteCredentialStore: siteCredentialStoreName })}
          </p>

          <p>
            {platform.portable
              ? t($ => $.keychain.portableExplanation)
              : isMac
              ? t($ => $.keychain.macosExplanation)
              : t($ => $.keychain.defaultExplanation)}
          </p>

          <p>
            <strong>{t($ => $.keychain.note)}</strong>{' '}
            {platform.portable
              ? t($ => $.keychain.portableNote)
              : t($ => $.keychain.defaultNote)}
          </p>

          {error && (
            <div className="flex items-start gap-2 text-red-400 bg-red-400/10 p-3 rounded-lg border border-red-400/20 text-xs">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="bg-bg-modal-accent p-3 rounded-lg border border-border-modal text-xs">
            <strong>{t($ => $.keychain.hint)}</strong>{' '}
            {platform.portable
              ? t($ => $.keychain.portableHint)
              : t($ => $.keychain.defaultHint)}{' '}
            {t($ => $.keychain.enableFromSettings)}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border-modal flex justify-end gap-3 bg-bg-modal-accent">
          <button
            onClick={handleLater}
            disabled={isGranting}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors text-text-secondary hover:bg-item-hover hover:text-text-primary disabled:opacity-50"
          >
            {t($ => $.keychain.later)}
          </button>
          <button
            onClick={handleGrant}
            disabled={isGranting}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {isGranting ? t($ => $.keychain.enabling) : grantLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
