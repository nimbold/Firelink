import { describe, expect, it } from 'vitest';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  isAppLocale,
  localeDirection,
  resolveAppLocale,
} from './locales';

describe('app locale metadata', () => {
  it('keeps the planned locale set stable', () => {
    expect(APP_LOCALES).toEqual(['en', 'zh-CN', 'he', 'fa', 'uk']);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('normalizes common system language tags', () => {
    expect(resolveAppLocale('en-US')).toBe('en');
    expect(resolveAppLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveAppLocale('iw-IL')).toBe('he');
    expect(resolveAppLocale('fa-IR')).toBe('fa');
    expect(resolveAppLocale('uk-UA')).toBe('uk');
    expect(resolveAppLocale('de-DE')).toBe('en');
  });

  it('marks the planned RTL locales correctly', () => {
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('zh-CN')).toBe('ltr');
    expect(localeDirection('he')).toBe('rtl');
    expect(localeDirection('fa')).toBe('rtl');
    expect(localeDirection('uk')).toBe('ltr');
  });

  it('guards locale values before they reach i18next', () => {
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('fa')).toBe(true);
    expect(isAppLocale('de')).toBe(false);
    expect(isAppLocale(null)).toBe(false);
  });
});
