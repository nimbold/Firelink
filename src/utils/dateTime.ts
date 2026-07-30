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

const DATE_OPTION_KEYS = new Set([
  'dateStyle',
  'era',
  'month',
  'day',
  'year',
  'weekday'
]);

const TIME_OPTION_KEYS = [
  'hour',
  'hour12',
  'hourCycle',
  'minute',
  'second',
  'timeZoneName',
  'dayPeriod',
  'fractionalSecondDigits'
] as const;

const persianDateParts = (
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string => {
  const formatter = new Intl.DateTimeFormat(locale, {
    calendar: 'persian',
    numberingSystem: options.numberingSystem,
    timeZone: options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const values = new Map(formatter.formatToParts(date)
    .filter(part => part.type === 'year' || part.type === 'month' || part.type === 'day')
    .map(part => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) return formatter.format(date);
  return `${year}/${month}/${day}`;
};

const formatPersianDateTime = (
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string => {
  const hasDateOptions = Object.keys(options).some(key => DATE_OPTION_KEYS.has(key));
  const hasTimeOptions = options.timeStyle !== undefined ||
    TIME_OPTION_KEYS.some(key => (options as unknown as Record<string, unknown>)[key] !== undefined);
  // Locale and timezone options do not select a date or time field by
  // themselves. Match Intl's default date behavior for those option-only
  // calls instead of returning an empty string.
  const includeDate = hasDateOptions || !hasTimeOptions;
  const parts: string[] = [];

  if (includeDate) {
    let dateText = persianDateParts(date, locale, options);
    if (options.weekday) {
      const weekday = new Intl.DateTimeFormat(locale, {
        calendar: 'persian',
        numberingSystem: options.numberingSystem,
        timeZone: options.timeZone,
        weekday: options.weekday
      }).format(date);
      dateText = `${weekday}, ${dateText}`;
    }
    parts.push(dateText);
  }

  if (hasTimeOptions) {
    const timeOptions: Intl.DateTimeFormatOptions = {
      calendar: 'persian',
      numberingSystem: options.numberingSystem,
      timeZone: options.timeZone
    };
    for (const key of TIME_OPTION_KEYS) {
      const value = (options as unknown as Record<string, unknown>)[key];
      if (value !== undefined) Object.assign(timeOptions, { [key]: value });
    }
    if (options.timeStyle) {
      timeOptions.hour = 'numeric';
      timeOptions.minute = '2-digit';
      if (options.timeStyle === 'medium' || options.timeStyle === 'long' || options.timeStyle === 'full') {
        timeOptions.second = '2-digit';
      }
      if (options.timeStyle === 'long' || options.timeStyle === 'full') {
        timeOptions.timeZoneName = options.timeStyle === 'full' ? 'long' : 'short';
      }
    }
    parts.push(new Intl.DateTimeFormat(locale, timeOptions).format(date));
  }

  return parts.join(', ');
};

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
    if (calendar === 'persian') {
      return formatPersianDateTime(
        date,
        localeWithCalendar(config.locale, calendar),
        options
      );
    }
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
