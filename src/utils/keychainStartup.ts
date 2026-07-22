export type KeychainStartupState = {
  portable: boolean;
  appVersion: string;
  approvedVersion: string;
  accessGranted: boolean;
  promptDismissed: boolean;
};

export type KeychainStartupDecision = {
  deferKeychainHydration: boolean;
  showKeychainPrompt: boolean;
};

export type KeychainAccessReadiness = {
  portable: boolean;
  accessGranted: boolean;
  persistent: boolean;
};

// The semantic app version can remain unchanged across release-candidate and
// packaging rebuilds. The Tauri packaging hook appends a fresh artifact nonce
// to the build identity, so replacing the binary cannot skip Firelink's
// explanation and invoke the OS prompt directly. The policy epoch remains
// only as a safe fallback for builds created outside the Git checkout.
const KEYCHAIN_CONSENT_POLICY_VERSION = '2';
const buildId = typeof import.meta.env.VITE_BUILD_ID === 'string'
  ? import.meta.env.VITE_BUILD_ID.trim()
  : '';

export const getKeychainConsentVersion = (appVersion: string): string => {
  const normalizedVersion = appVersion.trim();
  const consentIdentity = buildId && buildId !== 'unknown'
    ? `build-${buildId}`
    : `keychain-policy-${KEYCHAIN_CONSENT_POLICY_VERSION}`;
  return normalizedVersion
    ? `${normalizedVersion}|${consentIdentity}`
    : '';
};

export const getKeychainAccessReady = ({
  portable,
  accessGranted,
  persistent
}: KeychainAccessReadiness): boolean =>
  portable ? accessGranted : persistent;

export const getKeychainStartupDecision = ({
  portable,
  appVersion,
  approvedVersion,
  accessGranted,
  promptDismissed
}: KeychainStartupState): KeychainStartupDecision => {
  if (portable) {
    return {
      deferKeychainHydration: false,
      showKeychainPrompt: false
    };
  }

  const versionKnown = Boolean(appVersion.trim());
  const versionChanged = versionKnown && approvedVersion !== appVersion;
  const mustDeferAccess = !accessGranted || !versionKnown || versionChanged;
  return {
    deferKeychainHydration: mustDeferAccess,
    showKeychainPrompt: versionChanged || (!accessGranted && !promptDismissed)
  };
};
