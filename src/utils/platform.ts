import { useEffect, useState } from 'react';
import type { PlatformInfo } from '../bindings/PlatformInfo';
import { invokeCommand as invoke } from '../ipc';

const fallback: PlatformInfo = {
  os: 'unknown',
  arch: 'unknown',
  targetTriple: 'unknown',
  portable: false
};

export const shouldUseCustomWindowControls = (os: string, userAgent: string): boolean => {
  if (os === 'windows' || os === 'linux' || os === 'macos') return true;
  if (os !== 'unknown') return false;

  // Keep the custom titlebar visible while the native platform query is
  // resolving. Mobile user agents are the only unknown targets that must not
  // receive desktop window controls.
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
};

let cached: PlatformInfo | null = null;
let pending: Promise<PlatformInfo> | null = null;

type TargetDocument = {
  documentElement: {
    dataset: Record<string, string | undefined>;
  };
};

export const syncPlatformDataset = (
  os: string,
  targetDocument: TargetDocument | undefined = typeof document !== 'undefined' ? document : undefined,
): void => {
  if (!targetDocument) return;
  if (os === 'macos' || os === 'windows' || os === 'linux') {
    targetDocument.documentElement.dataset.platform = os;
  }
};

if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) {
    syncPlatformDataset('macos');
  } else if (/Windows/i.test(navigator.userAgent)) {
    syncPlatformDataset('windows');
  } else if (/Linux/i.test(navigator.userAgent)) {
    syncPlatformDataset('linux');
  }
}

export const getPlatformInfo = (): Promise<PlatformInfo> => {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = invoke('get_platform_info')
      .then(info => {
        cached = info;
        syncPlatformDataset(info.os);
        return info;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
};

export const usePlatformInfo = () => {
  const [platform, setPlatform] = useState<PlatformInfo>(cached ?? fallback);

  useEffect(() => {
    let active = true;
    void getPlatformInfo()
      .then(info => {
        if (active) setPlatform(info);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  return platform;
};
