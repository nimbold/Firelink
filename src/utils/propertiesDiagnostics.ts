import type { TorrentPeerDiagnostics } from '../bindings/TorrentPeerDiagnostics';
import type { TorrentAvailabilitySnapshot } from '../bindings/TorrentAvailabilitySnapshot';
import type { PropertiesDiagnosticPhase } from '../propertiesBridge';

export type PropertiesDiagnosticValueState = 'live' | 'loading' | 'stale' | 'error' | 'unavailable';

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
