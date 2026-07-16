import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { invokeCommand as invoke } from '../ipc';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { usePlatformInfo } from '../utils/platform';
import { getKeychainConsentVersion } from '../utils/keychainStartup';
import { getVersion } from '@tauri-apps/api/app';
import type { PairingTokenHydration } from '../bindings/PairingTokenHydration';

const KEYCHAIN_GRANT_TIMEOUT_MS = 30_000;

type KeychainPermissionModalProps = {
  consentVersion: string;
};

export const KeychainPermissionModal: React.FC<KeychainPermissionModalProps> = ({ consentVersion }) => {
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
      ? 'the portable Firelink data folder'
      : platform.os === 'windows'
      ? 'Windows Credential Manager'
      : platform.os === 'linux'
        ? 'your Linux credential store'
        : platform.os === 'macos'
          ? 'macOS Keychain'
          : "this system's credential store";
  const siteCredentialStoreName = platform.portable
    ? "the system's credential store"
    : pairingStoreName;
  const grantLabel = platform.portable
    ? 'Continue'
    : isMac
      ? 'Grant Access'
      : 'Enable Secure Storage';

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
            () => reject(new Error('Credential storage request timed out. You can select Later and try again.')),
            KEYCHAIN_GRANT_TIMEOUT_MS
          );
        })
      ]);
      if (!(await applyPersistentGrant(result))) {
        setError(result.error || `${siteCredentialStoreName} is unavailable.`);
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
          <h2 className="text-lg font-semibold text-text-primary m-0">Credential Storage Access Needed</h2>
        </div>

        <div className="px-5 py-6 flex-1 min-h-0 overflow-y-auto text-sm text-text-secondary leading-relaxed space-y-4">
          <p>
            Firelink uses the browser extension to capture downloads. To keep the extension paired after restarts,
            Firelink stores its pairing token in {pairingStoreName}. Optional site credentials are stored in {siteCredentialStoreName}.
          </p>

          <p>
            {platform.portable
              ? 'The pairing token is portable with this folder. Site credentials remain in the system credential store; a system prompt may appear after you grant access.'
              : isMac
              ? 'macOS may show a Keychain prompt after you grant access.'
              : 'This usually completes silently. If the credential service is unavailable, Firelink will show the error here and the extension will stay paired for this session only.'}
          </p>

          <p>
            <strong>Note:</strong>{' '}
            {platform.portable
              ? 'Portable mode stores only the pairing token in this folder. It does not copy site passwords or browser credentials.'
              : 'Firelink only writes its own dedicated credential entry. It cannot access other saved passwords or credential items on your system.'}
          </p>

          {error && (
            <div className="flex items-start gap-2 text-red-400 bg-red-400/10 p-3 rounded-lg border border-red-400/20 text-xs">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="bg-bg-modal-accent p-3 rounded-lg border border-border-modal text-xs">
            <strong>Hint:</strong>{' '}
            {platform.portable
              ? 'The portable pairing token is already stored with this folder; you can enable it here or select Later.'
              : 'If you select Later, the extension will only work for this session.'}
            You can enable storage anytime from <strong>Settings &gt; Integrations</strong>.
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border-modal flex justify-end gap-3 bg-bg-modal-accent">
          <button
            onClick={handleLater}
            disabled={isGranting}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors text-text-secondary hover:bg-item-hover hover:text-text-primary disabled:opacity-50"
          >
            Later
          </button>
          <button
            onClick={handleGrant}
            disabled={isGranting}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {isGranting ? 'Enabling...' : grantLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
