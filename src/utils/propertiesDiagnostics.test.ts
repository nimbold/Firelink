import { describe, expect, it } from 'vitest';
import {
  formatPropertiesAvailability,
  formatPropertiesDiagnosticCount,
  getPropertiesAvailabilityDiagnosticState,
  getPropertiesPeerDiagnosticState,
  hasTorrentPeerCountDifference,
  hasLiveTorrentPeerWithoutDetails,
} from './propertiesDiagnostics';

const emptyPeerDiagnostics = {
  listedPeers: 0,
  listedSeeders: 0,
  peers: [],
  truncated: false,
};

describe('Properties peer diagnostics presentation state', () => {
  it('formats swarm availability without exposing floating-point noise', () => {
    expect(formatPropertiesAvailability(6.05186170212766, 'en-US')).toBe('6.05');
    expect(formatPropertiesAvailability(1.5, 'en-US')).toBe('1.5');
    expect(formatPropertiesAvailability(1.5, '')).toBe('1.5');
    expect(formatPropertiesAvailability(Number.NaN, 'en-US')).toBe('—');
  });

  it('formats diagnostic counts with the same locale as availability', () => {
    expect(formatPropertiesDiagnosticCount(1234, 'en-US')).toBe('1,234');
    expect(formatPropertiesDiagnosticCount(1234, 'fa')).toBe(new Intl.NumberFormat('fa').format(1234));
    expect(formatPropertiesDiagnosticCount(-1, 'en-US')).toBe('—');
    expect(formatPropertiesDiagnosticCount(Number.MAX_SAFE_INTEGER + 1, 'en-US')).toBe('—');
  });

  it('identifies when the connected telemetry differs from the listed peer response', () => {
    expect(hasTorrentPeerCountDifference(38, 2, 5, 2)).toBe(true);
    expect(hasTorrentPeerCountDifference(5, 2, 5, 2)).toBe(false);
    expect(hasTorrentPeerCountDifference(undefined, 2, 5, 2)).toBe(false);
    expect(hasTorrentPeerCountDifference(38, 2, 5, 1)).toBe(true);
    expect(hasTorrentPeerCountDifference(Number.NaN, 2, 5, 2)).toBe(false);
    expect(hasTorrentPeerCountDifference(38, 2, Number.POSITIVE_INFINITY, 2)).toBe(false);
  });

  it('keeps a genuine empty response live instead of treating it as unavailable', () => {
    expect(getPropertiesPeerDiagnosticState(emptyPeerDiagnostics, false, 'idle')).toBe('live');
  });

  it('distinguishes loading and unavailable before a response exists', () => {
    expect(getPropertiesPeerDiagnosticState(null, true, 'initial')).toBe('loading');
    expect(getPropertiesPeerDiagnosticState(null, false, 'unavailable')).toBe('unavailable');
  });

  it('marks cached diagnostics as stale after an expected lifecycle miss', () => {
    expect(getPropertiesPeerDiagnosticState(emptyPeerDiagnostics, false, 'stale')).toBe('stale');
  });

  it('marks cached peer diagnostics as errored after an unexpected refresh failure', () => {
    expect(getPropertiesPeerDiagnosticState(emptyPeerDiagnostics, false, 'error')).toBe('error');
  });

  it('does not reuse peer state for unavailable availability data', () => {
    expect(getPropertiesAvailabilityDiagnosticState(null, false, 'idle')).toBe('unavailable');
    expect(getPropertiesAvailabilityDiagnosticState(null, false, 'error')).toBe('error');
  });

  it('distinguishes a live connection from an empty peer-detail snapshot', () => {
    expect(hasLiveTorrentPeerWithoutDetails(1, 0)).toBe(true);
    expect(hasLiveTorrentPeerWithoutDetails(0, 0)).toBe(false);
    expect(hasLiveTorrentPeerWithoutDetails(undefined, 0)).toBe(false);
    expect(hasLiveTorrentPeerWithoutDetails(2, 1)).toBe(false);
  });
});
