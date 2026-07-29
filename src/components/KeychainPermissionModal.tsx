import React, { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { invokeCommand as invoke } from '../ipc';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { usePlatformInfo } from '../utils/platform';
import type { PairingTokenHydration } from '../bindings/PairingTokenHydration';
import { useTranslation } from 'react-i18next';
import { isTopmostModal, useModalFocus } from '../hooks/useModalFocus';

const KEYCHAIN_GRANT_TIMEOUT_MS = 30_000;
const KEYCHAIN_GRANT_STATUS_POLL_MS = 100;

type KeychainPermissionModalProps = {
  consentVersion: string;
};

export const KeychainPermissionModal: React.FC<KeychainPermissionModalProps> = ({ consentVersion }) => {
  const { t } = useTranslation();
  const showKeychainModal = useSettingsStore(state => state.showKeychainModal);
  const dismissKeychainPrompt = useSettingsStore(state => state.dismissKeychainPrompt);
  const platform = usePlatformInfo();
  const [isGranting, setIsGranting] = useState(false);
  const [grantRequestPending, setGrantRequestPending] = useState(false);
  const [grantRequestWaiting, setGrantRequestWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const grantRequestRef = useRef<Promise<PairingTokenHydration> | null>(null);
  const grantRequestIdRef = useRef<string | null>(null);
  const grantAttemptRef = useRef(0);
  const consentVersionRef = useRef(consentVersion);
  consentVersionRef.current = consentVersion;
  const modalRef = useModalFocus(showKeychainModal);

  const applyPersistentGrantToStore = (result: PairingTokenHydration) => {
    if (!result.persistent) return;
    const grantedVersion = consentVersionRef.current.trim() || useSettingsStore.getState().keychainAccessVersion;
    useSettingsStore.setState({
      keychainAccessGranted: true,
      keychainAccessVersion: grantedVersion,
      keychainAccessReady: true,
      extensionPairingToken: result.token,
      isPairingTokenPersistent: true,
      keychainPromptDismissed: false,
      showKeychainModal: false
    });
  };

  useEffect(() => {
    // React Strict Mode replays effects in development. Reset the guard in
    // setup so the replay cleanup cannot leave a live modal permanently
    // unable to receive the native grant completion.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      grantAttemptRef.current += 1;
      const requestId = grantRequestIdRef.current;
      if (requestId) {
        void invoke('abandon_keychain_grant', { requestId })
          .then(result => {
            // If native acceptance won the same-lock race during unmount,
            // keep the global store aligned even though this component is
            // no longer mounted.
            if (result?.persistent) applyPersistentGrantToStore(result);
          })
          .catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!showKeychainModal) return;
    const handleEscape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !isTopmostModal(modalRef.current)) return;
        event.preventDefault();
        void handleLater();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [consentVersion, dismissKeychainPrompt, showKeychainModal]);

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
    // A native credential-store call cannot be cancelled from the webview.
    // Keep the request identity until it settles so a UI timeout cannot
    // launch a second OS prompt while the first one is still outstanding.
    // The native command owns the process-wide guard, so a remounted dialog
    // receives an explicit in-progress error instead of silently doing
    // nothing while an earlier native request is still outstanding.
    if (grantRequestRef.current) return;
    const grantAttempt = ++grantAttemptRef.current;
    const grantRequestId = crypto.randomUUID();
    setIsGranting(true);
    setGrantRequestWaiting(false);
    setError(null);

    let timeoutId: number | undefined;
    let persistentGrantApplied = false;
    const applyPersistentGrant = async (result: PairingTokenHydration): Promise<boolean> => {
      if (!result.persistent || persistentGrantApplied) return result.persistent;
      // A native prompt cannot be cancelled by the webview. If the user
      // dismisses this dialog after a timeout, a late result must not turn
      // that explicit choice into a silent authorization.
      if (!isMountedRef.current || grantAttemptRef.current !== grantAttempt) return false;
      persistentGrantApplied = true;
      applyPersistentGrantToStore(result);
      return true;
    };
    let grantRequest: Promise<PairingTokenHydration>;
    try {
      grantRequest = (async () => {
        // Do not await this IPC request. The native command starts a worker
        // and the worker can complete while the original WebView response
        // remains unsettled around the OS credential dialog. Completion is
        // observed only through the status command below.
        let grantStartError: unknown = null;
        let grantStartSettled = false;
        const grantStart = invoke('grant_keychain_access', { requestId: grantRequestId });
        void grantStart.then(
          () => {
            grantStartSettled = true;
          },
          (error: unknown) => {
            grantStartError = error;
            grantStartSettled = true;
          },
        );
        if (isMountedRef.current) {
          // The native request has been launched. Do not keep presenting the
          // button as if the click itself were still running; the request
          // remains pending until the worker reports completion.
          setIsGranting(false);
          setGrantRequestWaiting(true);
        }
        while (true) {
          if (grantStartError) throw grantStartError;
          const status = await invoke('get_keychain_grant_status', { requestId: grantRequestId });
          const result = status.result;
          if (result?.persistent) {
            if (!isMountedRef.current || grantAttemptRef.current !== grantAttempt) {
              return (await invoke('abandon_keychain_grant', { requestId: grantRequestId }).catch(() => null)) || {
                token: '',
                tokenChanged: false,
                persistent: false,
                error: null
              };
            }
            return await invoke('accept_keychain_grant', { requestId: grantRequestId });
          }
          if (result?.error) return result;
          if (grantStartSettled && !status.started && !status.inProgress) {
            return {
              token: '',
              tokenChanged: false,
              persistent: false,
              error: t($ => $.keychain.unavailable, { store: siteCredentialStoreName })
            };
          }
          await new Promise<void>(resolve => {
            window.setTimeout(resolve, KEYCHAIN_GRANT_STATUS_POLL_MS);
          });
        }
      })();
    } catch (error) {
      if (isMountedRef.current) {
        setIsGranting(false);
        setError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    grantRequestRef.current = grantRequest;
    grantRequestIdRef.current = grantRequestId;
    setGrantRequestPending(true);
    void grantRequest.then(
      () => {
        if (grantRequestRef.current === grantRequest) {
          grantRequestRef.current = null;
          grantRequestIdRef.current = null;
        }
        if (isMountedRef.current) {
          setGrantRequestPending(false);
          setGrantRequestWaiting(false);
        }
      },
      () => {
        if (grantRequestRef.current === grantRequest) {
          grantRequestRef.current = null;
          grantRequestIdRef.current = null;
        }
        if (isMountedRef.current) {
          setGrantRequestPending(false);
          setGrantRequestWaiting(false);
        }
      }
    );
    // A native credential-store call cannot be cancelled by the webview. Keep
    // a late successful result useful even if the UI timeout has already
    // returned control to the explanation.
    grantRequest.then(applyPersistentGrant).catch(() => undefined);

    try {
      const result = await Promise.race([
        grantRequest,
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () => {
              if (isMountedRef.current) {
                // The native request remains in flight and cannot be
                // cancelled, but the webview must stop presenting the
                // operation as an endlessly active click. Keep the request
                // identity so a second OS prompt cannot be started, while
                // allowing the user to dismiss this explanation.
                setGrantRequestWaiting(true);
                setIsGranting(false);
              }
              reject(new Error(t($ => $.keychain.timeout)));
            },
            KEYCHAIN_GRANT_TIMEOUT_MS
          );
        })
      ]);
      if (!(await applyPersistentGrant(result))) {
        if (isMountedRef.current) {
          setError(result.error || t($ => $.keychain.unavailable, { store: siteCredentialStoreName }));
        }
      }
    } catch (e: any) {
      if (isMountedRef.current) setError(e.toString());
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (isMountedRef.current) setIsGranting(false);
    }
  };

  const handleLater = async () => {
    const requestId = grantRequestIdRef.current;
    grantAttemptRef.current += 1;
    if (requestId) {
      const accepted = await invoke('abandon_keychain_grant', { requestId }).catch(() => null);
      if (accepted?.persistent) {
        applyPersistentGrantToStore(accepted);
        return;
      }
    }
    if (consentVersion.trim()) {
      dismissKeychainPrompt(consentVersion);
    } else {
      // A modal opened by an early user action can render before the async
      // app-version lookup completes. Do not persist a dismissal for an
      // unknown build; startup must make the final consent decision once the
      // identity is known.
      useSettingsStore.getState().setShowKeychainModal(false);
    }
  };

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[80] flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget && isTopmostModal(modalRef.current)) void handleLater();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="keychain-permission-title"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        data-modal-surface="true"
        className="app-modal keychain-modal flex w-full max-w-md flex-col overflow-hidden text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border-modal flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-full items-center justify-center">
            <KeyRound size={20} className="text-blue-500" />
          </div>
          <h2 id="keychain-permission-title" className="text-lg font-semibold text-text-primary m-0">{t($ => $.keychain.title)}</h2>
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
            type="button"
            onClick={handleLater}
            className="keychain-modal-action px-4 py-2 rounded-lg text-sm font-medium text-text-secondary hover:bg-item-hover hover:text-text-primary disabled:opacity-50"
          >
            {t($ => $.keychain.later)}
          </button>
          <button
            type="button"
            onClick={handleGrant}
            disabled={isGranting || grantRequestPending}
            className="keychain-modal-action px-4 py-2 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
          >
            {isGranting
              ? t($ => $.keychain.enabling)
              : grantRequestWaiting && grantRequestPending
                ? t($ => $.keychain.waitingForPrompt)
                : grantLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
