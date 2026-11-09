import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import i18n, { changeAppLocale, i18nReady, syncDocumentLocale } from './index';
import { APP_LOCALES, DEFAULT_LOCALE, localeDirection, resolveAppLocale } from './locales';

let observedTranslationI18n: { language: string } | undefined;

const TranslationInstanceProbe = () => {
  observedTranslationI18n = useTranslation().i18n;
  return createElement('span', null, observedTranslationI18n.language);
};

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

  it('preserves empty-string translations under i18next 27', async () => {
    await i18nReady;
    const probe = i18n.cloneInstance({ forkResourceStore: true, lng: DEFAULT_LOCALE });
    const probeKey = '__firelink_empty_translation_contract';
    probe.addResource(DEFAULT_LOCALE, 'common', probeKey, '');

    expect(probe.options.returnEmptyString).toBe(true);
    expect((probe.t as (key: string) => string)(probeKey)).toBe('');
  });

  it('keeps a useTranslation i18n handle live across async locale changes', async () => {
    await i18nReady;
    const originalLocale = resolveAppLocale(i18n.language);

    try {
      await changeAppLocale(DEFAULT_LOCALE);
      renderToStaticMarkup(createElement(TranslationInstanceProbe));
      const capturedI18n = observedTranslationI18n;

      expect(capturedI18n?.language).toBe(DEFAULT_LOCALE);

      await changeAppLocale('fa');

      expect(capturedI18n?.language).toBe('fa');
    } finally {
      await changeAppLocale(originalLocale);
      observedTranslationI18n = undefined;
    }
  });

  it('uses English resources for an unknown i18next language', async () => {
    await i18nReady;
    const originalLanguage = i18n.language;

    try {
      await changeAppLocale('ru');
      await i18n.changeLanguage('ru-RU');
      expect(i18n.resolvedLanguage).toBe('ru');
      expect(i18n.t($ => $.navigation.library)).toBe('Библиотека');

      await i18n.changeLanguage('de-DE');
      expect(i18n.resolvedLanguage).toBe('en');
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
