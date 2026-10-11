import { describe, expect, it } from 'vitest';
import { isInvalidMediaCookieBrowserProfileError } from './downloadErrors';

describe('browser cookie profile errors', () => {
  it('recognizes the stable native error code', () => {
    expect(isInvalidMediaCookieBrowserProfileError(
      'MEDIA_COOKIE_PROFILE_INVALID: browser profile folder is missing or inaccessible'
    )).toBe(true);
  });

  it('does not classify unrelated or non-string errors', () => {
    expect(isInvalidMediaCookieBrowserProfileError('yt-dlp failed')).toBe(false);
    expect(isInvalidMediaCookieBrowserProfileError(undefined)).toBe(false);
  });
});
