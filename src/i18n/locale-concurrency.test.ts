import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n, { changeAppLocale, i18nReady } from './index';

const localeGates = vi.hoisted(() => {
  let signalHebrewStart!: () => void;
  let releaseHebrew!: () => void;
  const hebrewStarted = new Promise<void>(resolve => {
    signalHebrewStart = resolve;
  });
  const hebrewGate = new Promise<void>(resolve => {
    releaseHebrew = resolve;
  });

  let signalRussianStart!: () => void;
  let failRussian!: (error: Error) => void;
  const russianStarted = new Promise<void>(resolve => {
    signalRussianStart = resolve;
  });
  const russianGate = new Promise<void>((_resolve, reject) => {
    failRussian = reject;
  });

  return {
    failRussian,
    hebrewGate,
    hebrewStarted,
    markHebrewStarted: signalHebrewStart,
    markRussianStarted: signalRussianStart,
    releaseHebrew,
    russianGate,
    russianStarted,
  };
});

vi.mock('./catalogs/he', async importOriginal => {
  localeGates.markHebrewStarted();
  await localeGates.hebrewGate;
  return importOriginal();
});

vi.mock('./catalogs/ru', async () => {
  localeGates.markRussianStarted();
  await localeGates.russianGate;
  throw new Error('simulated stale Russian catalog failure');
});

vi.mock('./catalogs/zh-CN', async () => {
  throw new Error('simulated current Chinese catalog failure');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('concurrent lazy locale changes', () => {
  it('keeps the newest RTL locale when an older catalog finishes loading later', async () => {
    await i18nReady;
    const documentElement = { lang: '', dir: '' };
    vi.stubGlobal('document', { documentElement });

    const staleHebrewChange = changeAppLocale('he');
    await localeGates.hebrewStarted;

    await changeAppLocale('fa');
    expect(i18n.language).toBe('fa');
    expect(i18n.t($ => $.navigation.library)).toBe('کتابخانه');
    expect(documentElement).toEqual({ lang: 'fa', dir: 'rtl' });

    localeGates.releaseHebrew();
    await staleHebrewChange;

    expect(i18n.language).toBe('fa');
    expect(i18n.t($ => $.navigation.library)).toBe('کتابخانه');
    expect(documentElement).toEqual({ lang: 'fa', dir: 'rtl' });
  });

  it('ignores a stale lazy catalog failure without replacing the active RTL locale', async () => {
    await i18nReady;
    const documentElement = { lang: '', dir: '' };
    vi.stubGlobal('document', { documentElement });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const staleRussianChange = changeAppLocale('ru');
    await localeGates.russianStarted;

    await changeAppLocale('fa');
    expect(documentElement).toEqual({ lang: 'fa', dir: 'rtl' });

    localeGates.failRussian(new Error('simulated stale Russian catalog failure'));
    await staleRussianChange;

    expect(i18n.language).toBe('fa');
    expect(i18n.t($ => $.navigation.library)).toBe('کتابخانه');
    expect(documentElement).toEqual({ lang: 'fa', dir: 'rtl' });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('falls back to English and synchronizes LTR direction when the current catalog fails', async () => {
    await i18nReady;
    const documentElement = { lang: '', dir: '' };
    vi.stubGlobal('document', { documentElement });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await changeAppLocale('zh-CN');

    expect(i18n.language).toBe('en');
    expect(i18n.t($ => $.navigation.library)).toBe('Library');
    expect(documentElement).toEqual({ lang: 'en', dir: 'ltr' });
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load locale "zh-CN"; falling back to English.',
      expect.any(Error)
    );
  });

  it('does not let a stale fallback overwrite a newer locale direction', async () => {
    await i18nReady;
    const documentElement = { lang: '', dir: '' };
    vi.stubGlobal('document', { documentElement });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let signalFallbackStarted!: () => void;
    const fallbackStarted = new Promise<void>(resolve => {
      signalFallbackStarted = resolve;
    });
    let releaseFallback!: () => void;
    const fallbackGate = new Promise<void>(resolve => {
      releaseFallback = resolve;
    });
    const changeLanguage = i18n.changeLanguage.bind(i18n);
    vi.spyOn(i18n, 'changeLanguage').mockImplementation(locale => {
      const transition = changeLanguage(locale);
      if (locale !== 'en') return transition;
      return transition.then(async result => {
        signalFallbackStarted();
        await fallbackGate;
        return result;
      });
    });

    const staleFailedChange = changeAppLocale('zh-CN');
    await fallbackStarted;
    await changeAppLocale('fa');
    expect(documentElement).toEqual({ lang: 'fa', dir: 'rtl' });

    releaseFallback();
    await staleFailedChange;

    expect(i18n.language).toBe('fa');
    expect(documentElement).toEqual({ lang: 'fa', dir: 'rtl' });
  });
});
