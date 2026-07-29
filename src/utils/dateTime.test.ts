import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALENDAR_PREFERENCE,
  formatDateTime,
  isCalendarPreference
} from './dateTime';

describe('date/time formatting', () => {
  const instant = new Date('2026-03-21T14:30:00.000Z');

  it('uses Gregorian explicitly by default, including in localized UI languages', () => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
    expect(formatDateTime(instant, { locale: 'fa', options })).toBe(
      new Intl.DateTimeFormat('fa-u-ca-gregory', options).format(instant)
    );
    expect(DEFAULT_CALENDAR_PREFERENCE).toBe('gregorian');
  });

  it('supports the opt-in Persian and Hebrew calendars', () => {
    const hebrewOptions: Intl.DateTimeFormatOptions = { dateStyle: 'long' };
    expect(formatDateTime(instant, { locale: 'fa', calendar: 'persian' })).toBe('۱۴۰۵/۰۱/۰۱');
    expect(formatDateTime(instant, {
      locale: 'fa',
      calendar: 'persian',
      options: { dateStyle: 'medium', timeStyle: 'short' }
    })).toContain('۱۴۰۵/۰۱/۰۱');
    expect(formatDateTime(instant, { locale: 'he', calendar: 'hebrew', options: hebrewOptions })).toBe(
      new Intl.DateTimeFormat('he-u-ca-hebrew', hebrewOptions).format(instant)
    );
  });

  it('keeps Persian dates zero-padded when the caller requests weekday or time', () => {
    const formatted = formatDateTime(instant, {
      locale: 'fa',
      calendar: 'persian',
      options: {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }
    });

    expect(formatted).toContain('۱۴۰۵/۰۱/۰۱');
  });

  it('does not drop Persian time-only Intl fields', () => {
    const formatted = formatDateTime(
      new Date('2026-03-21T14:30:00.123Z'),
      {
        locale: 'en',
        calendar: 'persian',
        options: { fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions
      }
    );

    expect(formatted).toContain('123');
  });

  it('returns a safe placeholder for malformed timestamps and rejects unknown preferences', () => {
    expect(formatDateTime('not-a-timestamp', { locale: 'en' })).toBe('-');
    expect(isCalendarPreference('gregorian')).toBe(true);
    expect(isCalendarPreference('lunar')).toBe(false);
    expect(isCalendarPreference(null)).toBe(false);
  });
});
