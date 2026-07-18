export const APP_LOCALES = ['en', 'zh-CN', 'he', 'fa', 'uk', 'ru'] as const;
export const APP_LOCALE_PREFERENCES = ['system', ...APP_LOCALES] as const;

export type AppLocale = typeof APP_LOCALES[number];
export type AppLocalePreference = typeof APP_LOCALE_PREFERENCES[number];
export type AppLocaleDirection = 'ltr' | 'rtl';
export type AppPluralVariant = 'one' | 'few' | 'many';

export const DEFAULT_LOCALE: AppLocale = 'en';

export const APP_LOCALE_METADATA: Record<AppLocale, {
  direction: AppLocaleDirection;
  isTranslated: boolean;
}> = {
  en: { direction: 'ltr', isTranslated: true },
  'zh-CN': { direction: 'ltr', isTranslated: true },
  he: { direction: 'rtl', isTranslated: true },
  fa: { direction: 'rtl', isTranslated: true },
  uk: { direction: 'ltr', isTranslated: true },
  ru: { direction: 'ltr', isTranslated: true },
};

export const isAppLocale = (value: unknown): value is AppLocale =>
  typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);

export const isAppLocalePreference = (value: unknown): value is AppLocalePreference =>
  typeof value === 'string' && (APP_LOCALE_PREFERENCES as readonly string[]).includes(value);

/**
 * Resolve a system or persisted BCP 47 language tag to a bundled Firelink
 * locale. Unknown languages fall back to English.
 */
export const resolveAppLocale = (value: string | null | undefined): AppLocale => {
  const normalized = value?.trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;

  if (normalized === 'zh-cn' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'he' || normalized.startsWith('he-') || normalized === 'iw' || normalized.startsWith('iw-')) return 'he';
  if (normalized === 'fa' || normalized.startsWith('fa-')) return 'fa';
  if (normalized === 'uk' || normalized.startsWith('uk-')) return 'uk';
  if (normalized === 'ru' || normalized.startsWith('ru-')) return 'ru';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';

  return DEFAULT_LOCALE;
};

export const localePluralVariant = (
  value: string | null | undefined,
  count: number
): AppPluralVariant => {
  const category = new Intl.PluralRules(resolveAppLocale(value)).select(Math.abs(count));
  if (category === 'one') return 'one';
  if (category === 'few') return 'few';
  return 'many';
};

export const localeDirection = (locale: AppLocale): AppLocaleDirection =>
  APP_LOCALE_METADATA[locale].direction;
