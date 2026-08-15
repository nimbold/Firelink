import type { DownloadErrorKind } from '../bindings/DownloadErrorKind';

/**
 * Keep the renderer's presentation classification aligned with the native
 * Aria2 boundary. This is intentionally narrow: only Aria2's resolver error
 * or its distinctive DNS-server wording receives DNS-specific guidance.
 */
export const classifyDownloadError = (message: unknown): DownloadErrorKind | undefined => {
  if (typeof message !== 'string') return undefined;
  const lower = message.toLowerCase();
  if (
    lower.includes('destination access retryable')
    || lower.includes('could not write to the selected folder')
    || lower.includes('selected folder could not be verified')
  ) {
    return 'destinationAccess';
  }
  if (
    lower.includes('aria2 error code 19')
    || (
      lower.includes('name resolution')
      && lower.includes('failed')
      && lower.includes('could not contact dns')
    )
    || lower.includes('could not contact dns server')
  ) {
    return 'nameResolution';
  }
  return undefined;
};
