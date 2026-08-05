import { describe, expect, it } from 'vitest';
import {
  getWindowControlRevealOffset,
  resolveWindowControlSide,
  resolveWindowControlStyle,
} from './windowControlStyle';

describe('resolveWindowControlStyle', () => {
  it('uses the platform convention for automatic style', () => {
    expect(resolveWindowControlStyle('auto', 'macos')).toBe('macos');
    expect(resolveWindowControlStyle('auto', 'windows')).toBe('windows');
    expect(resolveWindowControlStyle('auto', 'linux')).toBe('gnome');
  });

  it('falls back to macOS styling while an unsupported platform is unresolved', () => {
    expect(resolveWindowControlStyle('auto', 'unknown')).toBe('macos');
    expect(resolveWindowControlStyle('auto', 'android')).toBe('macos');
  });

  it('uses the desktop user agent while native platform detection is unresolved', () => {
    expect(resolveWindowControlStyle('auto', 'unknown', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(resolveWindowControlStyle('auto', 'unknown', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('gnome');
    expect(resolveWindowControlStyle('auto', 'unknown', 'Mozilla/5.0 (Linux; Android 14)')).toBe('macos');
  });

  it('preserves an explicit style across platforms', () => {
    expect(resolveWindowControlStyle('macos', 'windows')).toBe('macos');
    expect(resolveWindowControlStyle('windows', 'linux')).toBe('windows');
    expect(resolveWindowControlStyle('gnome', 'macos')).toBe('gnome');
    expect(resolveWindowControlStyle('minimal', 'windows')).toBe('minimal');
  });

  it('reserves space after the complete custom-control footprint', () => {
    expect(getWindowControlRevealOffset('macos')).toBe(88);
    expect(getWindowControlRevealOffset('windows')).toBe(168);
    expect(getWindowControlRevealOffset('gnome')).toBe(134);
    expect(getWindowControlRevealOffset('minimal')).toBe(104);
  });

  it('resolves automatic control placement from the effective document direction', () => {
    expect(resolveWindowControlSide('auto', 'ltr')).toBe('left');
    expect(resolveWindowControlSide('auto', 'rtl')).toBe('right');
    expect(resolveWindowControlSide('left', 'rtl')).toBe('left');
    expect(resolveWindowControlSide('right', 'ltr')).toBe('right');
  });
});
