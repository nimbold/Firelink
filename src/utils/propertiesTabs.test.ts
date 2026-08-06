import { describe, expect, it } from 'vitest';
import {
  getPropertiesTabIndex,
  getPropertiesTabs,
  PROPERTIES_TABS_OVERFLOW_BREAKPOINT,
  shouldUsePropertiesTabOverflow,
} from './propertiesTabs';

describe('Properties tabs', () => {
  it('keeps torrent and normal-download sections concise and stable', () => {
    expect(getPropertiesTabs(false)).toEqual(['overview', 'transfer', 'advanced']);
    expect(getPropertiesTabs(true)).toEqual(['overview', 'files', 'trackers', 'peers', 'options']);
  });

  it('uses the responsive overflow control at narrow widths', () => {
    expect(shouldUsePropertiesTabOverflow(PROPERTIES_TABS_OVERFLOW_BREAKPOINT)).toBe(true);
    expect(shouldUsePropertiesTabOverflow(PROPERTIES_TABS_OVERFLOW_BREAKPOINT + 1)).toBe(false);
    expect(shouldUsePropertiesTabOverflow(Number.NaN)).toBe(false);
  });

  it('moves through tabs according to physical direction', () => {
    const tabs = getPropertiesTabs(true);
    expect(getPropertiesTabIndex(tabs, 0, 'ArrowRight', 'ltr')).toBe(1);
    expect(getPropertiesTabIndex(tabs, 0, 'ArrowLeft', 'ltr')).toBe(tabs.length - 1);
    expect(getPropertiesTabIndex(tabs, 0, 'ArrowRight', 'rtl')).toBe(tabs.length - 1);
    expect(getPropertiesTabIndex(tabs, 0, 'ArrowLeft', 'rtl')).toBe(1);
    expect(getPropertiesTabIndex(tabs, 2, 'Home', 'ltr')).toBe(0);
    expect(getPropertiesTabIndex(tabs, 2, 'End', 'ltr')).toBe(tabs.length - 1);
  });
});
