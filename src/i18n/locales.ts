export const APP_LOCALES = ['en', 'zh-CN', 'he', 'fa', 'uk'] as const;

export type AppLocale = typeof APP_LOCALES[number];
export type AppLocaleDirection = 'ltr' | 'rtl';

export const DEFAULT_LOCALE: AppLocale = 'en';

export const APP_LOCALE_METADATA: Record<AppLocale, {
  direction: AppLocaleDirection;
  isTranslated: boolean;
}> = {
  en: { direction: 'ltr', isTranslated: true },
  'zh-CN': { direction: 'ltr', isTranslated: false },
  he: { direction: 'rtl', isTranslated: false },
  fa: { direction: 'rtl', isTranslated: false },
  uk: { direction: 'ltr', isTranslated: false },
};

export const isAppLocale = (value: unknown): value is AppLocale =>
  typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);

/**
 * Resolve a system or persisted BCP 47 language tag to a planned Firelink
 * locale. Non-English locales intentionally fall back to English resources
 * until their translations are added.
 */
export const resolveAppLocale = (value: string | null | undefined): AppLocale => {
  const normalized = value?.trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;

  if (normalized === 'zh-cn' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'he' || normalized.startsWith('he-') || normalized === 'iw' || normalized.startsWith('iw-')) return 'he';
  if (normalized === 'fa' || normalized.startsWith('fa-')) return 'fa';
  if (normalized === 'uk' || normalized.startsWith('uk-')) return 'uk';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';

  return DEFAULT_LOCALE;
};

export const localeDirection = (locale: AppLocale): AppLocaleDirection =>
  APP_LOCALE_METADATA[locale].direction;
