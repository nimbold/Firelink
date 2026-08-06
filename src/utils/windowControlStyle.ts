import type { WindowControlStyle } from '../bindings/WindowControlStyle';

export type ResolvedWindowControlStyle = Exclude<WindowControlStyle, 'auto'>;
export type WindowControlSide = 'left' | 'right';
export type SidebarPosition = 'auto' | WindowControlSide;

// The reveal button sits after the complete custom-control hit area. Keep this
// derived from the resolved style so a sidebar toggle can never overlap a
// platform-specific control footprint.
const WINDOW_CONTROL_REVEAL_OFFSETS: Record<ResolvedWindowControlStyle, number> = {
  macos: 88,
  windows: 168,
  gnome: 134,
  minimal: 104,
};

const WINDOW_CONTROL_RAIL_WIDTHS: Record<ResolvedWindowControlStyle, number> = {
  macos: 60,
  windows: 138,
  gnome: 104,
  minimal: 74,
};

export const getWindowControlRevealOffset = (style: ResolvedWindowControlStyle): number =>
  WINDOW_CONTROL_REVEAL_OFFSETS[style];

export const getWindowControlRailWidth = (style: ResolvedWindowControlStyle): number =>
  WINDOW_CONTROL_RAIL_WIDTHS[style];

export const resolveWindowControlSide = (
  sidebarPosition: SidebarPosition,
  direction: 'ltr' | 'rtl',
): WindowControlSide => sidebarPosition === 'right'
  || (sidebarPosition === 'auto' && direction === 'rtl')
  ? 'right'
  : 'left';

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
