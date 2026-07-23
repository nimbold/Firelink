import type { WindowControlStyle } from '../bindings/WindowControlStyle';

export type ResolvedWindowControlStyle = Exclude<WindowControlStyle, 'auto'>;

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
