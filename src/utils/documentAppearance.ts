import type { AppFontSize } from '../bindings/AppFontSize';
import type { FontFamily } from '../bindings/FontFamily';
import type { ListRowDensity } from '../bindings/ListRowDensity';
import type { Theme } from '../bindings/Theme';
import { localeDirection, resolveAppLocale, type AppLocale } from '../i18n/locales';

export type DocumentAppearance = {
  theme: Theme;
  fontFamily: FontFamily;
  appFontSize: AppFontSize;
  listRowDensity: ListRowDensity;
  locale: AppLocale;
};

const DARK_THEMES: ReadonlySet<Theme> = new Set(['dark', 'dracula', 'nord']);
const THEME_CLASSES = ['theme-dark', 'theme-light', 'theme-dracula', 'theme-nord', 'dark'] as const;

export const applyDocumentAppearance = (
  document: Document,
  appearance: DocumentAppearance,
  systemDark: boolean,
): void => {
  const root = document.documentElement;
  const resolvedTheme = appearance.theme === 'system'
    ? (systemDark ? 'dark' : 'light')
    : (DARK_THEMES.has(appearance.theme) ? 'dark' : 'light');
  const themeClass = appearance.theme === 'system'
    ? `theme-${resolvedTheme}`
    : `theme-${appearance.theme}`;

  root.classList.remove(...THEME_CLASSES);
  root.classList.add(themeClass);
  if (resolvedTheme === 'dark') root.classList.add('dark');
  root.dataset.resolvedTheme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
  root.dataset.fontFamily = appearance.fontFamily;
  root.dataset.fontSize = appearance.appFontSize;
  root.dataset.listDensity = appearance.listRowDensity;

  const locale = resolveAppLocale(appearance.locale);
  root.lang = locale;
  root.dir = localeDirection(locale);
};

export const synchronizeDocumentAppearance = (
  window: Window,
  appearance: DocumentAppearance,
): (() => void) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => applyDocumentAppearance(window.document, appearance, media.matches);
  apply();
  if (appearance.theme !== 'system') return () => undefined;
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
};
