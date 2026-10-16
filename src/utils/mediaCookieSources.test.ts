import { describe, expect, it } from 'vitest';
import {
  getBrowserCookieSourceOptions,
  isMediaCookieSourceSupported
} from './mediaCookieSources';

describe('media browser cookie source platform support', () => {
  it('offers Safari only on macOS', () => {
    expect(isMediaCookieSourceSupported('safari', 'macos')).toBe(true);
    expect(isMediaCookieSourceSupported('safari', 'windows')).toBe(false);
    expect(isMediaCookieSourceSupported('safari', 'linux')).toBe(false);
    expect(isMediaCookieSourceSupported('firefox', 'windows')).toBe(true);
  });

  it('keeps a stale Safari setting visible but disabled on unsupported platforms', () => {
    const options = getBrowserCookieSourceOptions('windows', 'safari');

    expect(options[1]).toEqual({
      value: 'safari',
      label: 'safariUnsupported',
      disabled: true
    });
    expect(options.some(option => option.value === 'safari' && !option.disabled)).toBe(false);
    expect(getBrowserCookieSourceOptions('linux', 'chrome').some(
      option => option.value === 'safari'
    )).toBe(false);
  });

  it('keeps Safari selectable on macOS', () => {
    const options = getBrowserCookieSourceOptions('macos', 'safari');
    expect(options.find(option => option.value === 'safari')).toEqual({
      value: 'safari',
      label: 'safariMacos'
    });
  });
});
