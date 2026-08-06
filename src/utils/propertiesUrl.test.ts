import { describe, expect, it } from 'vitest';
import {
  PROPERTIES_URL_PREVIEW_MAX_LENGTH,
  shouldOfferPropertiesUrlExpansion,
  shouldResetPropertiesUrlExpansion,
} from './propertiesUrl';

describe('Properties URL disclosure', () => {
  it('offers expansion only for URLs longer than the preview budget', () => {
    expect(shouldOfferPropertiesUrlExpansion('x'.repeat(PROPERTIES_URL_PREVIEW_MAX_LENGTH))).toBe(false);
    expect(shouldOfferPropertiesUrlExpansion('x'.repeat(PROPERTIES_URL_PREVIEW_MAX_LENGTH + 1))).toBe(true);
  });

  it('resets expansion when the displayed download changes', () => {
    expect(shouldResetPropertiesUrlExpansion('download-1', 'download-1')).toBe(false);
    expect(shouldResetPropertiesUrlExpansion('download-1', 'download-2')).toBe(true);
    expect(shouldResetPropertiesUrlExpansion(null, 'download-1')).toBe(true);
  });

  it('resets expansion when the displayed address changes', () => {
    expect(shouldResetPropertiesUrlExpansion('download-1', 'download-1', 'magnet:?xt=old', 'magnet:?xt=old')).toBe(false);
    expect(shouldResetPropertiesUrlExpansion('download-1', 'download-1', 'magnet:?xt=old', 'magnet:?xt=new')).toBe(true);
  });
});
