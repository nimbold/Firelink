import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import englishCommon from './catalogs/en';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  localeDirection,
  resolveAppLocale,
  type AppLocale,
} from './locales';

export { APP_LOCALES, APP_LOCALE_METADATA, APP_LOCALE_PREFERENCES, DEFAULT_LOCALE, isAppLocale, isAppLocalePreference, localeDirection, localePluralVariant, resolveAppLocale } from './locales';
export type { AppLocale, AppLocaleDirection, AppLocalePreference, AppPluralVariant } from './locales';

const defaultNS = 'common' as const;
const initialLocale = resolveAppLocale(
  typeof navigator === 'undefined' ? undefined : navigator.language
);

type CommonCatalog = Parameters<typeof i18n.addResourceBundle>[2];
type LocaleLoader = () => Promise<CommonCatalog>;

const localeLoaders: Record<AppLocale, LocaleLoader> = {
  en: async () => englishCommon,
  'zh-CN': async () => (await import('./catalogs/zh-CN')).default,
  he: async () => (await import('./catalogs/he')).default,
  fa: async () => (await import('./catalogs/fa')).default,
  uk: async () => (await import('./catalogs/uk')).default,
  ru: async () => (await import('./catalogs/ru')).default,
};

const loadedLocales = new Set<AppLocale>([DEFAULT_LOCALE]);
const localeLoadPromises = new Map<AppLocale, Promise<void>>();
let localeChangeRequest = 0;

const loadLocale = (locale: AppLocale): Promise<void> => {
  if (loadedLocales.has(locale)) return Promise.resolve();

  const existingLoad = localeLoadPromises.get(locale);
  if (existingLoad) return existingLoad;

  const load = localeLoaders[locale]().then(catalog => {
    i18n.addResourceBundle(locale, defaultNS, catalog, true, true);
    loadedLocales.add(locale);
    localeLoadPromises.delete(locale);
  }).catch(error => {
    localeLoadPromises.delete(locale);
    throw error;
  });

  localeLoadPromises.set(locale, load);
  return load;
};

const fallbackToEnglish = async (requestedLocale: AppLocale, error: unknown): Promise<void> => {
  console.error(`Failed to load locale "${requestedLocale}"; falling back to English.`, error);
  await i18n.changeLanguage(DEFAULT_LOCALE);
  syncDocumentLocale(DEFAULT_LOCALE);
};

export const i18nReady = i18n
  .use(initReactI18next)
  .init({
    defaultNS,
    fallbackLng: DEFAULT_LOCALE,
    initAsync: false,
    lng: DEFAULT_LOCALE,
    interpolation: {
      escapeValue: false,
    },
    ns: [defaultNS],
    resources: {
      [DEFAULT_LOCALE]: { [defaultNS]: englishCommon },
    },
    returnNull: false,
    supportedLngs: APP_LOCALES,
  })
  .then(async () => {
    try {
      await loadLocale(initialLocale);
      await i18n.changeLanguage(initialLocale);
      syncDocumentLocale(initialLocale);
    } catch (error) {
      await fallbackToEnglish(initialLocale, error);
    }
  });


export const changeAppLocale = async (locale: AppLocale): Promise<void> => {
  const request = ++localeChangeRequest;
  await i18nReady;
  if (request !== localeChangeRequest) return;

  try {
    await loadLocale(locale);
    if (request !== localeChangeRequest) return;
    await i18n.changeLanguage(locale);
    if (request === localeChangeRequest) syncDocumentLocale(locale);
  } catch (error) {
    if (request === localeChangeRequest) {
      await fallbackToEnglish(locale, error);
    }
  }
};

export const syncDocumentLocale = (value: string | null | undefined): AppLocale => {
  const locale = resolveAppLocale(value);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
  }
  return locale;
};

export default i18n;
