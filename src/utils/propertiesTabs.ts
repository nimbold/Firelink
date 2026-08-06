export type PropertiesTab = 'overview' | 'files' | 'trackers' | 'peers' | 'options' | 'transfer' | 'advanced';

const TORRENT_PROPERTIES_TABS: readonly PropertiesTab[] = [
  'overview',
  'files',
  'trackers',
  'peers',
  'options',
];

const DOWNLOAD_PROPERTIES_TABS: readonly PropertiesTab[] = [
  'overview',
  'transfer',
  'advanced',
];

export const PROPERTIES_TABS_OVERFLOW_BREAKPOINT = 620;

export const getPropertiesTabs = (isTorrent: boolean): readonly PropertiesTab[] =>
  isTorrent ? TORRENT_PROPERTIES_TABS : DOWNLOAD_PROPERTIES_TABS;

export const shouldUsePropertiesTabOverflow = (width: number): boolean =>
  Number.isFinite(width) && width <= PROPERTIES_TABS_OVERFLOW_BREAKPOINT;

export const getPropertiesTabIndex = (
  tabs: readonly PropertiesTab[],
  currentIndex: number,
  key: string,
  direction: 'ltr' | 'rtl',
): number => {
  if (tabs.length === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return tabs.length - 1;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return -1;

  const step = key === 'ArrowRight'
    ? (direction === 'rtl' ? -1 : 1)
    : (direction === 'rtl' ? 1 : -1);
  return (currentIndex + step + tabs.length) % tabs.length;
};
