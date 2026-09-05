import { describe, expect, it } from 'vitest';
import { shouldUseCustomWindowControls, syncPlatformDataset } from './platform';

describe('shouldUseCustomWindowControls', () => {
  it('keeps custom controls present while Windows/Linux detection is unresolved', () => {
    expect(shouldUseCustomWindowControls('unknown', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(shouldUseCustomWindowControls('unknown', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(true);
  });

  it('keeps custom controls present for macOS while platform detection is unresolved', () => {
    expect(shouldUseCustomWindowControls('unknown', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(true);
    expect(shouldUseCustomWindowControls('macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(true);
  });

  it('only opts into the supported desktop platforms', () => {
    expect(shouldUseCustomWindowControls('windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(shouldUseCustomWindowControls('linux', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(true);
    expect(shouldUseCustomWindowControls('macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(true);
    expect(shouldUseCustomWindowControls('android', 'Mozilla/5.0 (Linux; Android 14)')).toBe(false);
    expect(shouldUseCustomWindowControls('unknown', 'Mozilla/5.0 (Linux; Android 14; Mobile)')).toBe(false);
  });
});

describe('syncPlatformDataset', () => {
  it('synchronizes known desktop platforms to document dataset', () => {
    const mockDocument = { documentElement: { dataset: {} as Record<string, string | undefined> } };

    syncPlatformDataset('macos', mockDocument);
    expect(mockDocument.documentElement.dataset.platform).toBe('macos');

    syncPlatformDataset('windows', mockDocument);
    expect(mockDocument.documentElement.dataset.platform).toBe('windows');

    syncPlatformDataset('linux', mockDocument);
    expect(mockDocument.documentElement.dataset.platform).toBe('linux');
  });

  it('ignores unknown or unsupported platforms', () => {
    const mockDocument = { documentElement: { dataset: { platform: 'macos' } } };

    syncPlatformDataset('unknown', mockDocument);
    expect(mockDocument.documentElement.dataset.platform).toBe('macos');

    syncPlatformDataset('android', mockDocument);
    expect(mockDocument.documentElement.dataset.platform).toBe('macos');
  });

  it('safely handles missing document in headless environments', () => {
    expect(() => syncPlatformDataset('macos', undefined)).not.toThrow();
  });
});
