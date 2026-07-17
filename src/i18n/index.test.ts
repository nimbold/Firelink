import { describe, expect, it } from 'vitest';
import i18n, { i18nReady } from './index';

describe('i18n runtime', () => {
  it('falls back to bundled English while planned catalogs are untranslated', async () => {
    await i18nReady;
    const originalLanguage = i18n.language;

    try {
      await i18n.changeLanguage('fa');
      expect(i18n.t($ => $.navigation.library)).toBe('Library');
    } finally {
      await i18n.changeLanguage(originalLanguage);
    }
  });
});
