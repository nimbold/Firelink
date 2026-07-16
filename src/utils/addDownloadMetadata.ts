import {
  canonicalizeDownloadFileName,
  fileNameFromUrl,
  isMediaUrl
} from './downloads';
import type { MediaPlaylistMetadata } from '../bindings/MediaPlaylistMetadata';

export type MetadataStatus = 'loading' | 'ready' | 'metadata-error' | 'invalid';

export interface AddMediaFormat {
  name: string;
  selector: string;
  ext: string;
  formatLabel: string;
  detail: string;
  type: string;
  bytes: number;
  isApproximate?: boolean;
}

export interface AddDownloadDraftRow {
  id: string;
  sourceUrl: string;
  downloadUrl: string;
  file: string;
  size?: string;
  sizeBytes?: number;
  status: MetadataStatus;
  generation: number;
  requestContextVersion?: number;
  isMedia: boolean;
  resumable?: boolean;
  formats?: AddMediaFormat[];
  selectedFormat?: number;
  isPlaylist?: boolean;
  playlistSourceUrl?: string;
  playlistTitle?: string;
  playlistIndex?: number;
  playlistCount?: number;
  playlistEntryTitle?: string;
  playlistError?: string;
  metadataBlockedReason?: 'unsafe-url';
  selected?: boolean;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ftp:', 'sftp:']);

type ParsedInput = {
  identity: string;
  sourceUrl: string;
  valid: boolean;
  isPlaylist?: boolean;
  playlistSourceUrl?: string;
  playlistTitle?: string;
  playlistIndex?: number;
  playlistCount?: number;
  playlistEntryTitle?: string;
  requestContextVersion?: number;
  selected?: boolean;
};

export const isYouTubePlaylistUrl = (rawUrl: string): boolean => {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const isYouTube = hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return isYouTube && pathname === '/playlist' && Boolean(url.searchParams.get('list'));
  } catch {
    return false;
  }
};

export const playlistFilePrefix = (
  playlistIndex: number | undefined,
  playlistCount: number | undefined
): string => {
  if (!playlistIndex || playlistIndex < 1) return '';
  const width = Math.max(3, String(playlistCount || playlistIndex).length);
  return `${String(playlistIndex).padStart(width, '0')} - `;
};

type PlaylistExpansions = Readonly<Record<string, MediaPlaylistMetadata>>;

const parseInputLines = (
  rawText: string,
  playlistExpansions: PlaylistExpansions,
  requestContextVersions: Readonly<Record<string, number>>,
  selectedBySourceUrl: Readonly<Record<string, boolean>>
): ParsedInput[] => {
  const seen = new Set<string>();
  const parsed: ParsedInput[] = [];

  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let sourceUrl = line;
    let valid = false;
    try {
      const url = new URL(line);
      valid = ALLOWED_SCHEMES.has(url.protocol);
      if (valid) sourceUrl = url.href;
    } catch {
      valid = false;
    }

    const identity = valid ? sourceUrl : `invalid:${line}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (valid && isYouTubePlaylistUrl(sourceUrl)) {
      const expansion = playlistExpansions[sourceUrl];
      if (expansion) {
        const playlistSelected = selectedBySourceUrl[sourceUrl] !== false;
        for (const [position, entry] of expansion.entries.entries()) {
          let entryUrl: string;
          try {
            const parsedEntryUrl = new URL(entry.url);
            if (!ALLOWED_SCHEMES.has(parsedEntryUrl.protocol)) continue;
            entryUrl = parsedEntryUrl.href;
          } catch {
            continue;
          }
          if (seen.has(entryUrl)) continue;
          seen.add(entryUrl);
          parsed.push({
            identity: entryUrl,
            sourceUrl: entryUrl,
            valid: true,
            playlistSourceUrl: sourceUrl,
            playlistTitle: expansion.title,
            playlistIndex: entry.playlist_index || position + 1,
            playlistCount: expansion.entry_count || expansion.entries.length,
            playlistEntryTitle: entry.title,
            requestContextVersion: requestContextVersions[sourceUrl],
            selected: selectedBySourceUrl[entryUrl] ?? playlistSelected
          });
        }
        // The playlist has been successfully discovered even when every
        // entry was already represented by another input row. Do not put the
        // source playlist back into loading state in that case.
        continue;
      }
    }

    parsed.push({
      identity,
      sourceUrl,
      valid,
      isPlaylist: valid && isYouTubePlaylistUrl(sourceUrl),
      requestContextVersion: valid ? requestContextVersions[sourceUrl] : undefined,
      selected: selectedBySourceUrl[sourceUrl] !== false
    });
  }

  return parsed;
};

export const reconcileDownloadRows = (
  rawText: string,
  currentRows: AddDownloadDraftRow[],
  pendingFilename?: string,
  forceMediaUrls: ReadonlySet<string> = new Set(),
  createId: () => string = () => crypto.randomUUID(),
  requestFilenames: Readonly<Record<string, string>> = {},
  requestContextVersions: Readonly<Record<string, number>> = {},
  playlistExpansions: PlaylistExpansions = {},
  selectedBySourceUrl: Readonly<Record<string, boolean>> = {}
): AddDownloadDraftRow[] => {
  const inputs = parseInputLines(
    rawText,
    playlistExpansions,
    requestContextVersions,
    selectedBySourceUrl
  );
  const existing = new Map(currentRows.map(row => [row.sourceUrl, row]));

  return inputs.map(input => {
    const preserved = existing.get(input.sourceUrl);
    if (preserved) {
      const forcedMedia = input.valid && forceMediaUrls.has(input.sourceUrl);
      const requestContextVersion = input.requestContextVersion;
      const contextChanged = requestContextVersion !== undefined
        && requestContextVersion !== preserved.requestContextVersion;
      const playlistContextChanged = preserved.playlistSourceUrl !== input.playlistSourceUrl
        || preserved.playlistTitle !== input.playlistTitle
        || preserved.playlistIndex !== input.playlistIndex
        || preserved.playlistCount !== input.playlistCount
        || preserved.playlistEntryTitle !== input.playlistEntryTitle;
      if ((forcedMedia && !preserved.isMedia) || contextChanged || playlistContextChanged) {
        const requestedFilename = input.playlistSourceUrl
          ? `${playlistFilePrefix(input.playlistIndex, input.playlistCount)}${input.playlistEntryTitle || 'video'}`
          : requestFilenames[input.sourceUrl];
        return {
          ...preserved,
          file: contextChanged || playlistContextChanged
            ? canonicalizeDownloadFileName(requestedFilename || fileNameFromUrl(input.sourceUrl))
            : preserved.file,
          status: 'loading',
          generation: preserved.generation + 1,
          requestContextVersion,
          isMedia: preserved.isMedia || forcedMedia || Boolean(input.playlistSourceUrl),
          size: undefined,
          sizeBytes: undefined,
          resumable: undefined,
          formats: preserved.isMedia || forcedMedia || Boolean(input.playlistSourceUrl)
            ? undefined
            : preserved.formats,
          selectedFormat: preserved.isMedia || forcedMedia || Boolean(input.playlistSourceUrl)
            ? undefined
            : preserved.selectedFormat,
          isPlaylist: input.isPlaylist,
          playlistSourceUrl: input.playlistSourceUrl,
          playlistTitle: input.playlistTitle,
          playlistIndex: input.playlistIndex,
          playlistCount: input.playlistCount,
          playlistEntryTitle: input.playlistEntryTitle,
          playlistError: undefined,
          metadataBlockedReason: undefined
        };
      }
      return preserved;
    }

    const requestedFilename = input.playlistSourceUrl
      ? `${playlistFilePrefix(input.playlistIndex, input.playlistCount)}${input.playlistEntryTitle || 'video'}`
      : requestFilenames[input.sourceUrl]
      || (inputs.length === 1 ? pendingFilename : undefined);
    const fallback = canonicalizeDownloadFileName(
      requestedFilename || fileNameFromUrl(input.sourceUrl)
    );

    return {
      id: createId(),
      sourceUrl: input.sourceUrl,
      downloadUrl: input.sourceUrl,
      file: fallback,
      status: input.valid ? 'loading' : 'invalid',
      generation: input.valid ? 1 : 0,
      requestContextVersion: input.requestContextVersion,
      isMedia: input.valid && (
        Boolean(input.isPlaylist)
        || Boolean(input.playlistSourceUrl)
        || forceMediaUrls.has(input.sourceUrl)
        || isMediaUrl(input.sourceUrl)
      ),
      isPlaylist: input.isPlaylist,
      playlistSourceUrl: input.playlistSourceUrl,
      playlistTitle: input.playlistTitle,
      playlistIndex: input.playlistIndex,
      playlistCount: input.playlistCount,
      playlistEntryTitle: input.playlistEntryTitle,
      metadataBlockedReason: undefined,
      selected: input.selected !== false
    };
  });
};

const comparableUrl = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).href;
  } catch {
    return rawUrl.trim();
  }
};

export const appendRequestUrlsAfterVersion = (
  rawText: string,
  requestContexts: Readonly<Record<string, { version: number }>>,
  observedVersion: number
): string => {
  const lines = rawText.split('\n').map(line => line.trim()).filter(Boolean);
  const seen = new Set(lines.map(comparableUrl));
  const additions = Object.entries(requestContexts)
    .filter(([, context]) => context.version > observedVersion)
    .sort(([, left], [, right]) => left.version - right.version);

  for (const [url] of additions) {
    const identity = comparableUrl(url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    lines.push(url);
  }

  return lines.join('\n');
};

export const updateRowIfCurrent = (
  rows: AddDownloadDraftRow[],
  id: string,
  sourceUrl: string,
  generation: number,
  update: (row: AddDownloadDraftRow) => AddDownloadDraftRow
): AddDownloadDraftRow[] => rows.map(row =>
  row.id === id && row.sourceUrl === sourceUrl && row.generation === generation
    ? update(row)
    : row
);

export const refreshFailedMetadataRows = (
  rows: AddDownloadDraftRow[]
): AddDownloadDraftRow[] => rows.map(row =>
  row.status === 'metadata-error'
    ? {
        ...row,
        status: 'loading',
        generation: row.generation + 1,
        metadataBlockedReason: undefined
      }
    : row
);

export const canSubmitMetadataRows = (rows: AddDownloadDraftRow[]): boolean => {
  const selectedRows = rows.filter(row => row.selected !== false);
  return selectedRows.length > 0
  && selectedRows.every(row =>
    row.status === 'ready'
    || (!row.isMedia && row.status === 'metadata-error' && !row.metadataBlockedReason)
  );
};

export const mediaFormatSelectorForRow = (
  row: AddDownloadDraftRow
): string | undefined => {
  if (!row.isMedia || row.status !== 'ready' || row.selectedFormat === undefined) {
    return undefined;
  }
  return row.formats?.[row.selectedFormat]?.selector;
};

export const mediaFileNameForSelectedFormat = (
  fileName: string,
  row: Pick<AddDownloadDraftRow, 'formats' | 'selectedFormat'>
): string => {
  const selectedFormat = row.selectedFormat === undefined
    ? undefined
    : row.formats?.[row.selectedFormat];
  if (!selectedFormat) return canonicalizeDownloadFileName(fileName);

  const cleanFileName = canonicalizeDownloadFileName(fileName);
  const selectedExt = selectedFormat.ext.replace(/^\.+/, '');
  if (!selectedExt) return cleanFileName;

  const lowerFileName = cleanFileName.toLowerCase();
  if (lowerFileName.endsWith(`.${selectedExt.toLowerCase()}`)) {
    return cleanFileName;
  }

  const lastDot = cleanFileName.lastIndexOf('.');
  const currentExt = lastDot > 0 ? cleanFileName.slice(lastDot + 1).toLowerCase() : '';
  const knownFormatExts = new Set(
    (row.formats || [])
      .map(format => format.ext.replace(/^\.+/, '').toLowerCase())
      .filter(Boolean)
  );
  const baseName = currentExt && knownFormatExts.has(currentExt)
    ? cleanFileName.slice(0, lastDot)
    : cleanFileName;

  return canonicalizeDownloadFileName(`${baseName}.${selectedExt}`);
};

export const metadataSummaryMessage = (rows: AddDownloadDraftRow[]): string => {
  if (rows.length === 0) return 'Paste one or more links.';

  const selectedRows = rows.filter(row => row.selected !== false);
  if (selectedRows.length === 0) return 'Select at least one download.';

  const invalid = selectedRows.filter(row => row.status === 'invalid').length;
  if (invalid > 0) {
    return `Correct or remove ${invalid} invalid URL${invalid === 1 ? '' : 's'} before continuing.`;
  }

  const loading = selectedRows.filter(row => row.status === 'loading').length;
  if (loading > 0) {
    return `Waiting for metadata for ${loading} download${loading === 1 ? '' : 's'}.`;
  }

  const failed = selectedRows.filter(row => row.status === 'metadata-error').length;
  const failedMedia = selectedRows.filter(row => row.status === 'metadata-error' && row.isMedia).length;
  const blocked = selectedRows.filter(row => row.metadataBlockedReason === 'unsafe-url').length;
  const ready = selectedRows.filter(row => row.status === 'ready').length;
  if (blocked > 0) {
    return `Remove ${blocked} unsafe URL${blocked === 1 ? '' : 's'} before continuing.`;
  }
  if (failedMedia > 0) {
    return `Media metadata is unavailable for ${failedMedia} item${failedMedia === 1 ? '' : 's'}. Refresh metadata before adding.`;
  }
  if (failed === selectedRows.length) {
    return 'Metadata is unavailable. Downloads can still be added using fallback details.';
  }
  if (failed > 0) {
    return `${ready} download${ready === 1 ? '' : 's'} ready; ${failed} will use fallback filename and unknown size.`;
  }
  return `Ready to add ${ready} download${ready === 1 ? '' : 's'}.`;
};
