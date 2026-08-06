export const PROPERTIES_URL_PREVIEW_MAX_LENGTH = 180;

export const shouldOfferPropertiesUrlExpansion = (url: string): boolean =>
  url.length > PROPERTIES_URL_PREVIEW_MAX_LENGTH;

export const shouldResetPropertiesUrlExpansion = (
  previousDownloadId: string | null,
  nextDownloadId: string | null,
  previousUrl?: string | null,
  nextUrl?: string | null,
): boolean => previousDownloadId !== nextDownloadId || previousUrl !== nextUrl;
