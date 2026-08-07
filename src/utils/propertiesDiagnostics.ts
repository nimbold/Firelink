import type { TorrentPeerDiagnostics } from '../bindings/TorrentPeerDiagnostics';
import type { TorrentAvailabilitySnapshot } from '../bindings/TorrentAvailabilitySnapshot';
import { resolveAppLocale } from '../i18n/locales';
import type { PropertiesDiagnosticPhase } from '../propertiesBridge';

export type PropertiesDiagnosticValueState = 'live' | 'loading' | 'stale' | 'error' | 'unavailable';

export const formatPropertiesDiagnosticCount = (value: number, locale: string): string => {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  return new Intl.NumberFormat(resolveAppLocale(locale)).format(value);
};

export const formatPropertiesAvailability = (availability: number, locale: string): string => {
  if (!Number.isFinite(availability) || availability < 0) return '—';
  return new Intl.NumberFormat(resolveAppLocale(locale), { maximumFractionDigits: 2 }).format(availability);
};

const getPropertiesDiagnosticValueState = (
  hasValue: boolean,
  diagnosticsLoading: boolean,
  diagnosticPhase: PropertiesDiagnosticPhase,
): PropertiesDiagnosticValueState => {
  if (hasValue) {
    if (diagnosticPhase === 'error') return 'error';
    if (diagnosticPhase === 'stale') return 'stale';
    return 'live';
  }
  if (diagnosticsLoading) return 'loading';
  if (diagnosticPhase === 'error') return 'error';
  if (diagnosticPhase === 'stale') return 'stale';
  return 'unavailable';
};

export type PropertiesPeerDiagnosticState = PropertiesDiagnosticValueState;

export const getPropertiesPeerDiagnosticState = (
  peers: TorrentPeerDiagnostics | null,
  diagnosticsLoading: boolean,
  diagnosticPhase: PropertiesDiagnosticPhase,
): PropertiesPeerDiagnosticState => {
  return getPropertiesDiagnosticValueState(peers !== null, diagnosticsLoading, diagnosticPhase);
};

export const getPropertiesAvailabilityDiagnosticState = (
  availability: TorrentAvailabilitySnapshot | null,
  diagnosticsLoading: boolean,
  diagnosticPhase: PropertiesDiagnosticPhase,
): PropertiesDiagnosticValueState => getPropertiesDiagnosticValueState(
  availability !== null,
  diagnosticsLoading,
  diagnosticPhase,
);
