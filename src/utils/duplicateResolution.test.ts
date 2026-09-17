import { describe, expect, it } from 'vitest';
import {
  duplicateDownloadIdentityMatches,
  unmanagedReplacementFingerprintMatches
} from './duplicateResolution';

const identity = (overrides: Partial<Parameters<typeof duplicateDownloadIdentityMatches>[0]> = {}) => ({
  url: 'https://example.com/file',
  fileName: 'file.bin',
  destination: '/downloads/Other',
  isMedia: false,
  ...overrides
});

describe('duplicate resolution identity', () => {
  it('accepts the same URL and target across equivalent path spellings', () => {
    expect(duplicateDownloadIdentityMatches(
      identity({ destination: '/downloads/Other/' }),
      identity(),
      'linux'
    )).toBe(true);
  });

  it.each([
    ['url', { url: 'https://example.com/other' }],
    ['filename', { fileName: 'other.bin' }],
    ['destination', { destination: '/downloads/Movies' }],
    ['media route', { isMedia: true }]
  ] as const)('rejects a changed %s identity', (_label, change) => {
    expect(duplicateDownloadIdentityMatches(identity(), identity(change), 'linux')).toBe(false);
  });

  it('uses case-insensitive target comparison on Windows', () => {
    expect(duplicateDownloadIdentityMatches(
      identity({ destination: 'C:\\Downloads\\Other' }),
      identity({ destination: 'c:/downloads/other' }),
      'windows'
    )).toBe(true);
  });
});

describe('unmanaged replacement fingerprint', () => {
  it('requires the captured fingerprint and a regular unowned file', () => {
    expect(unmanagedReplacementFingerprintMatches(
      'regularFile',
      'same',
      undefined,
      'same'
    )).toBe(true);
    expect(unmanagedReplacementFingerprintMatches(
      'regularFile',
      'changed',
      undefined,
      'same'
    )).toBe(false);
    expect(unmanagedReplacementFingerprintMatches(
      'regularFile',
      'same',
      'download-1',
      'same'
    )).toBe(false);
    expect(unmanagedReplacementFingerprintMatches(
      'directory',
      'same',
      undefined,
      'same'
    )).toBe(false);
  });
});
