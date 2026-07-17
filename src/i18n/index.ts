import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  localeDirection,
  resolveAppLocale,
  type AppLocale,
} from './locales';
import { defaultNS, resources } from './resources';

export { APP_LOCALES, APP_LOCALE_METADATA, DEFAULT_LOCALE, isAppLocale, localeDirection, resolveAppLocale } from './locales';
export type { AppLocale, AppLocaleDirection } from './locales';

const initialLocale = resolveAppLocale(
  typeof navigator === 'undefined' ? undefined : navigator.language
);

export const i18nReady = i18n
  .use(initReactI18next)
  .init({
    defaultNS,
    fallbackLng: DEFAULT_LOCALE,
    initAsync: false,
    lng: initialLocale,
    interpolation: {
      escapeValue: false,
    },
    ns: [defaultNS],
    resources,
    returnNull: false,
    supportedLngs: APP_LOCALES,
  });

void i18nReady.then(() => syncDocumentLocale(initialLocale));

export const changeAppLocale = async (locale: AppLocale): Promise<void> => {
  await i18n.changeLanguage(locale);
  syncDocumentLocale(locale);
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
