import { describe, expect, it } from 'vitest';
import { APP_LOCALES } from './locales';
import { resources } from './resources';

type CatalogNode = string | { readonly [key: string]: CatalogNode };

const flattenCatalog = (
  node: CatalogNode,
  prefix = ''
): Map<string, string> => {
  const entries = new Map<string, string>();

  if (typeof node === 'string') {
    entries.set(prefix, node);
    return entries;
  }

  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (const [leafPath, leafValue] of flattenCatalog(value, path)) {
      entries.set(leafPath, leafValue);
    }
  }

  return entries;
};

const interpolationTokens = (value: string): string[] =>
  [...value.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)]
    .map((match) => match[1])
    .sort();

const catalogFor = (locale: keyof typeof resources): Map<string, string> =>
  flattenCatalog(resources[locale].common);

describe('translation catalogs', () => {
  it('registers a catalog for every supported locale', () => {
    expect(Object.keys(resources).sort()).toEqual([...APP_LOCALES].sort());
  });

  it('keeps the English catalog free of translated-script contamination', () => {
    const suspiciousValues = [...catalogFor('en').entries()]
      .filter(([, value]) => /[\u0590-\u05FF\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF]/u.test(value))
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

    expect(suspiciousValues).toEqual([]);
  });

  it('keeps every locale structurally identical to English', () => {
    const englishKeys = [...catalogFor('en').keys()].sort();

    for (const locale of APP_LOCALES) {
      const localeKeys = [...catalogFor(locale).keys()].sort();
      expect({ locale, missing: englishKeys.filter((key) => !localeKeys.includes(key)), extra: localeKeys.filter((key) => !englishKeys.includes(key)) }).toEqual({
        locale,
        missing: [],
        extra: [],
      });
    }
  });

  it('preserves interpolation tokens exactly in every translation', () => {
    const english = catalogFor('en');
    const allMismatches = APP_LOCALES.flatMap((locale) => {
      const catalog = catalogFor(locale);
      return [...english.entries()]
        .map(([key, englishValue]) => ({
          locale,
          key,
          expected: interpolationTokens(englishValue),
          actual: interpolationTokens(catalog.get(key) ?? ''),
        }))
        .filter(({ expected, actual }) => JSON.stringify(expected) !== JSON.stringify(actual));
    });

    expect(allMismatches).toEqual([]);
  });

  it('reports exact English duplicates for translation review', () => {
    const english = catalogFor('en');
    const duplicates = APP_LOCALES.filter((locale) => locale !== 'en').flatMap((locale) => {
      const catalog = catalogFor(locale);
      return [...english.entries()]
        .filter(([key, englishValue]) => englishValue.length >= 4 && catalog.get(key) === englishValue)
        .map(([key, value]) => ({ locale, key, value }));
    });

    const allowedExactKeys = new Set([
      'addDownloads.cookiePlaceholder',
      'downloadTable.interactionError',
      'keychain.stores.windows',
      'keychain.stores.macos',
      'settings.common.stderr',
      'settings.integrations.chromiumZip',
      'settings.lookAndFeel.dracula',
      'settings.lookAndFeel.nord',
      'settings.lookAndFeel.fontFamilyInter',
      'settings.lookAndFeel.fontFamilyOutfit',
      'settings.lookAndFeel.fontFamilyRoboto',
      'settings.lookAndFeel.windowControlStyleWindows',
      'settings.lookAndFeel.windowControlStyleGnome',
      'settings.network.chromeWindows',
      'settings.network.chromeMacos',
      'settings.network.edgeWindows',
      'settings.network.firefoxWindows',
      'settings.network.firefoxMacos',
      'settings.network.safariMacos',
    ]);

    const unexpectedDuplicates = duplicates
      .filter(({ key }) => !allowedExactKeys.has(key))
      .map(({ locale, key, value }) => `${locale}:${key} = ${JSON.stringify(value)}`);

    expect(unexpectedDuplicates).toEqual([]);
  });
});
