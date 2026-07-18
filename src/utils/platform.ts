import { useEffect, useState } from 'react';
import type { PlatformInfo } from '../bindings/PlatformInfo';
import { invokeCommand as invoke } from '../ipc';

const fallback: PlatformInfo = {
  os: 'unknown',
  arch: 'unknown',
  targetTriple: 'unknown',
  portable: false
};

export const shouldUseCustomWindowControls = (os: string, userAgent: string): boolean =>
  !userAgent.includes('Mac') && (os === 'windows' || os === 'linux' || os === 'unknown');

let cached: PlatformInfo | null = null;
let pending: Promise<PlatformInfo> | null = null;

export const getPlatformInfo = (): Promise<PlatformInfo> => {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = invoke('get_platform_info')
      .then(info => {
        cached = info;
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
