import { downloadLocationEquals } from './downloadLocations';

export type DuplicateDownloadIdentity = {
  url: string;
  fileName: string;
  destination: string;
  isMedia: boolean;
};

const comparableUrl = (value: string): string => {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
};

export const duplicateDownloadIdentityMatches = (
  current: DuplicateDownloadIdentity,
  expected: DuplicateDownloadIdentity,
  os: string
): boolean => comparableUrl(current.url) === comparableUrl(expected.url)
  && current.isMedia === expected.isMedia
  && downloadLocationEquals(
    current.destination,
    current.fileName,
    expected.destination,
    expected.fileName,
    os
  );

export const unmanagedReplacementFingerprintMatches = (
  targetKind: string | null,
  targetFingerprint: string | undefined,
  targetOwner: string | undefined,
  expectedFingerprint: string | undefined
): boolean => targetKind === 'regularFile'
  && !targetOwner
  && Boolean(targetFingerprint)
  && Boolean(expectedFingerprint)
  && targetFingerprint === expectedFingerprint;
