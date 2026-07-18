import { describe, expect, it } from 'vitest';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  isAppLocalePreference,
  isAppLocale,
  localeDirection,
  localePluralVariant,
  resolveAppLocale,
} from './locales';

describe('app locale metadata', () => {
  it('keeps the planned locale set stable', () => {
    expect(APP_LOCALES).toEqual(['en', 'zh-CN', 'he', 'fa', 'uk', 'ru']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('normalizes common system language tags', () => {
    expect(resolveAppLocale('en-US')).toBe('en');
    expect(resolveAppLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveAppLocale('iw-IL')).toBe('he');
    expect(resolveAppLocale('fa-IR')).toBe('fa');
    expect(resolveAppLocale('uk-UA')).toBe('uk');
    expect(resolveAppLocale('ru-RU')).toBe('ru');
    expect(resolveAppLocale('de-DE')).toBe('en');
  });

  it('marks the planned RTL locales correctly', () => {
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('zh-CN')).toBe('ltr');
    expect(localeDirection('he')).toBe('rtl');
    expect(localeDirection('fa')).toBe('rtl');
    expect(localeDirection('uk')).toBe('ltr');
    expect(localeDirection('ru')).toBe('ltr');
  });

  it('selects locale-aware plural categories', () => {
    expect(localePluralVariant('en', 1)).toBe('one');
    expect(localePluralVariant('en', 2)).toBe('many');
    expect(localePluralVariant('ru-RU', 1)).toBe('one');
    expect(localePluralVariant('ru-RU', 2)).toBe('few');
    expect(localePluralVariant('ru-RU', 5)).toBe('many');
    expect(localePluralVariant('uk-UA', 2)).toBe('few');
  });

  it('guards locale values before they reach i18next', () => {
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('fa')).toBe(true);
    expect(isAppLocale('ru')).toBe(true);
    expect(isAppLocale('de')).toBe(false);
    expect(isAppLocale(null)).toBe(false);
    expect(isAppLocalePreference('system')).toBe(true);
    expect(isAppLocalePreference('fa')).toBe(true);
    expect(isAppLocalePreference('de')).toBe(false);
  });
});
