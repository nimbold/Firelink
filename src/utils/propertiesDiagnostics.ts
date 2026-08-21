import type { TorrentPeerDiagnostics } from '../bindings/TorrentPeerDiagnostics';
import type { TorrentAvailabilitySnapshot } from '../bindings/TorrentAvailabilitySnapshot';
import { resolveAppLocale } from '../i18n/locales';
import type { PropertiesDiagnosticPhase } from '../propertiesBridge';

export type PropertiesDiagnosticValueState = 'live' | 'loading' | 'stale' | 'error' | 'unavailable';

const isValidDiagnosticCount = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const formatPropertiesDiagnosticCount = (value: number, locale: string): string => {
  if (!isValidDiagnosticCount(value)) return '—';
  return new Intl.NumberFormat(resolveAppLocale(locale)).format(value);
};

export const hasTorrentPeerCountDifference = (
  connectedPeers: number | undefined,
  connectedSeeders: number | undefined,
  listedPeers: number,
  listedSeeders: number,
): boolean => (
  isValidDiagnosticCount(connectedPeers)
  && isValidDiagnosticCount(listedPeers)
  && connectedPeers !== listedPeers
) || (
  isValidDiagnosticCount(connectedSeeders)
  && isValidDiagnosticCount(listedSeeders)
  && connectedSeeders !== listedSeeders
);

export const hasLiveTorrentPeerWithoutDetails = (
  connectedPeers: number | undefined,
  detailedPeers: number,
): boolean => Number.isSafeInteger(connectedPeers)
  && (connectedPeers ?? 0) > 0
  && Number.isSafeInteger(detailedPeers)
  && detailedPeers === 0;

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
