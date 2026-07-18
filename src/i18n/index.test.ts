import { describe, expect, it, vi } from 'vitest';
import i18n, { changeAppLocale, i18nReady, syncDocumentLocale } from './index';
import { APP_LOCALES, localeDirection, resolveAppLocale } from './locales';

describe('i18n runtime', () => {
  it('selects every bundled catalog instead of falling back to English', async () => {
    await i18nReady;
    const originalLanguage = i18n.language;

    try {
      const expectedLibraryLabels = {
        en: 'Library',
        'zh-CN': '库',
        he: 'ספרייה',
        fa: 'کتابخانه',
        uk: 'Бібліотека',
        ru: 'Библиотека',
      } as const;

      for (const locale of APP_LOCALES) {
        await changeAppLocale(locale);
        expect(i18n.language).toBe(locale);
        expect(i18n.t($ => $.navigation.library)).toBe(expectedLibraryLabels[locale]);
      }
    } finally {
      await changeAppLocale(resolveAppLocale(originalLanguage));
    }
  });

  it('syncs document language and direction for every supported locale', async () => {
    const documentElement = { lang: '', dir: '' };
    vi.stubGlobal('document', { documentElement });

    try {
      for (const locale of APP_LOCALES) {
        await changeAppLocale(locale);
        expect(documentElement).toEqual({ lang: locale, dir: localeDirection(locale) });
      }

      expect(syncDocumentLocale('de-DE')).toBe('en');
      expect(documentElement).toEqual({ lang: 'en', dir: 'ltr' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses English resources for an unknown i18next language', async () => {
    await i18nReady;
    const originalLanguage = i18n.language;

    try {
      await i18n.changeLanguage('de-DE');
      expect(i18n.t($ => $.navigation.library)).toBe('Library');
      expect(resolveAppLocale('de-DE')).toBe('en');
      expect(resolveAppLocale('ru-RU')).toBe('ru');
      expect(resolveAppLocale('fa-IR')).toBe('fa');
      expect(resolveAppLocale('he-IL')).toBe('he');
      expect(resolveAppLocale('uk-UA')).toBe('uk');
      expect(resolveAppLocale('zh-Hans-CN')).toBe('zh-CN');
    } finally {
      await changeAppLocale(resolveAppLocale(originalLanguage));
    }
  });
});
