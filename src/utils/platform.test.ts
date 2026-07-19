import { describe, expect, it } from 'vitest';
import { shouldUseCustomWindowControls } from './platform';

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
