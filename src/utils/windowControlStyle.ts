import type { WindowControlStyle } from '../bindings/WindowControlStyle';

export type ResolvedWindowControlStyle = Exclude<WindowControlStyle, 'auto'>;

// The reveal button sits after the complete custom-control hit area. Keep this
// derived from the resolved style so a sidebar toggle can never overlap a
// platform-specific control footprint.
const WINDOW_CONTROL_REVEAL_OFFSETS: Record<ResolvedWindowControlStyle, number> = {
  macos: 88,
  windows: 168,
  gnome: 134,
  minimal: 104,
};

export const getWindowControlRevealOffset = (style: ResolvedWindowControlStyle): number =>
  WINDOW_CONTROL_REVEAL_OFFSETS[style];

export const resolveWindowControlStyle = (
  style: WindowControlStyle,
  os: string,
  userAgent = ''
): ResolvedWindowControlStyle => {
  if (style !== 'auto') return style;
  if (os === 'windows') return 'windows';
  if (os === 'linux') return 'gnome';
  if (os === 'unknown' && /Windows/i.test(userAgent)) return 'windows';
  if (os === 'unknown' && /Linux/i.test(userAgent) && !/Android/i.test(userAgent)) return 'gnome';
  return 'macos';
};
