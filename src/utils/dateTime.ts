import type { CalendarPreference } from '../bindings/CalendarPreference';
import { resolveAppLocale } from '../i18n/locales';

export type { CalendarPreference } from '../bindings/CalendarPreference';

export const CALENDAR_PREFERENCES = ['gregorian', 'persian', 'hebrew'] as const satisfies readonly CalendarPreference[];
export const DEFAULT_CALENDAR_PREFERENCE: CalendarPreference = 'gregorian';

export const isCalendarPreference = (value: unknown): value is CalendarPreference =>
  typeof value === 'string' && (CALENDAR_PREFERENCES as readonly string[]).includes(value);

type DateTimeInput = Date | string | number;

interface DateTimeFormatConfig {
  locale?: string | null;
  calendar?: CalendarPreference;
  options?: Intl.DateTimeFormatOptions;
}

const calendarIdentifier = (calendar: CalendarPreference): string =>
  calendar === 'gregorian' ? 'gregory' : calendar;

const localeWithCalendar = (locale: string | null | undefined, calendar: CalendarPreference): string => {
  const resolvedLocale = resolveAppLocale(locale);
  return `${resolvedLocale}-u-ca-${calendarIdentifier(calendar)}`;
};

const dateFromInput = (value: DateTimeInput): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

/**
 * Format a user-facing timestamp with an explicit calendar. Gregorian is
 * passed explicitly because some localized browser defaults use a regional
 * calendar even when the user has not opted into one.
 */
export const formatDateTime = (
  value: DateTimeInput,
  config: DateTimeFormatConfig = {}
): string => {
  const date = dateFromInput(value);
  if (Number.isNaN(date.getTime())) return '-';

  const calendar = config.calendar && isCalendarPreference(config.calendar)
    ? config.calendar
    : DEFAULT_CALENDAR_PREFERENCE;
  const options = config.options ?? {};

  try {
    return new Intl.DateTimeFormat(
      localeWithCalendar(config.locale, calendar),
      options
    ).format(date);
  } catch {
    // WebViews can have incomplete ICU calendar data. Keep the display useful
    // and deterministic rather than exposing a RangeError to the UI.
    try {
      return new Intl.DateTimeFormat(
        localeWithCalendar(config.locale, DEFAULT_CALENDAR_PREFERENCE),
        options
      ).format(date);
    } catch {
      return '-';
    }
  }
};
