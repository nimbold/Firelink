import { describe, expect, it } from 'vitest';
import {
  formatPropertiesAvailability,
  formatPropertiesDiagnosticCount,
  getPropertiesAvailabilityDiagnosticState,
  getPropertiesPeerDiagnosticState,
} from './propertiesDiagnostics';

const emptyPeerDiagnostics = {
  totalPeers: 0,
  totalSeeders: 0,
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
});
