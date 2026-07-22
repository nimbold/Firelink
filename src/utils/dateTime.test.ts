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
    const options: Intl.DateTimeFormatOptions = { dateStyle: 'long' };
    expect(formatDateTime(instant, { locale: 'fa', calendar: 'persian', options })).toBe(
      new Intl.DateTimeFormat('fa-u-ca-persian', options).format(instant)
    );
    expect(formatDateTime(instant, { locale: 'he', calendar: 'hebrew', options })).toBe(
      new Intl.DateTimeFormat('he-u-ca-hebrew', options).format(instant)
    );
  });

  it('returns a safe placeholder for malformed timestamps and rejects unknown preferences', () => {
    expect(formatDateTime('not-a-timestamp', { locale: 'en' })).toBe('-');
    expect(isCalendarPreference('gregorian')).toBe(true);
    expect(isCalendarPreference('lunar')).toBe(false);
    expect(isCalendarPreference(null)).toBe(false);
  });
});
