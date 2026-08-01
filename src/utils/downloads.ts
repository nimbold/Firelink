import type { DownloadCategory } from '../bindings/DownloadCategory';
import type { DownloadStatus } from '../bindings/DownloadStatus';
import type { DownloadItem } from '../bindings/DownloadItem';
export type { DownloadCategory } from '../bindings/DownloadCategory';

import { invokeCommand as invoke } from '../ipc';

let MEDIA_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'twitch.tv',
  'vimeo.com',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'v.redd.it',
  'soundcloud.com',
  'facebook.com',
  'fb.watch',
  'pornhub.com',
  'redtube.com',
  'xhamster.com',
  'xnxx.com',
  'xvideos.com'
];

const ACTIVE_DOWNLOAD_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'queued',
  'downloading',
  'processing',
  'seeding',
  'retrying',
]);

export const isActiveDownloadStatus = (status: DownloadStatus): boolean =>
  ACTIVE_DOWNLOAD_STATUSES.has(status);

/** Transfer states that consume a worker/permit. Queued is intentionally excluded. */
export const isTransferActiveStatus = (status: DownloadStatus): boolean =>
  status === 'downloading' || status === 'processing' || status === 'seeding' || status === 'retrying';

export const DOWNLOAD_CONNECTIONS_MIN = 1;
export const DOWNLOAD_CONNECTIONS_MAX = 16;

// Keep every filename component within the common cross-platform filesystem
// limit. Count UTF-8 bytes because POSIX filesystems enforce bytes, while this
// bound is also conservative for Windows filename components.
export const MAX_DOWNLOAD_FILENAME_BYTES = 255;
const FILENAME_TRUNCATION_MARKER = '…';
const WINDOWS_RESERVED_FILENAME_STEMS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CLOCK$',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
]);

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

const truncateUtf8ToBytes = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
};

/**
 * Resolve persisted/user-entered connection values before they cross into the
 * backend. Older rows may omit the value, while malformed rows can contain
 * zero, NaN, or an out-of-range number.
 */
export const resolveDownloadConnections = (value: unknown, fallback: unknown): number => {
  const toFiniteInteger = (candidate: unknown): number | undefined => {
    if (typeof candidate === 'number') {
      return Number.isFinite(candidate) ? Math.trunc(candidate) : undefined;
    }
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const parsed = Number(candidate);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
    }
    return undefined;
  };
  const normalizedFallback = toFiniteInteger(fallback) ?? DOWNLOAD_CONNECTIONS_MAX;
  const safeFallback = Math.min(
    DOWNLOAD_CONNECTIONS_MAX,
    Math.max(DOWNLOAD_CONNECTIONS_MIN, normalizedFallback)
  );
  const candidate = toFiniteInteger(value) ?? safeFallback;
  return Math.min(
    DOWNLOAD_CONNECTIONS_MAX,
    Math.max(DOWNLOAD_CONNECTIONS_MIN, candidate)
  );
};

export const normalizeSpeedLimitForBackend = (value?: string | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?(?:\/s)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2].toUpperCase();
  return unit ? `${amount}${unit}` : `${amount}K`;
};

const MAX_TORRENT_TRACKERS = 64;
const MAX_TORRENT_TRACKER_BYTES = 16 * 1024;
export const MAX_TORRENT_STOP_TIMEOUT = 7 * 24 * 60 * 60;

/**
 * Performs the same user-facing safety checks as the native tracker boundary.
 * The Rust validator remains authoritative because persisted data can bypass
 * this helper and the browser URL parser is not the native URL parser.
 */
export const isValidTorrentTrackerList = (value: string): boolean => {
  const raw = value.trim();
  if (!raw) return true;
  if (utf8ByteLength(raw) > MAX_TORRENT_TRACKER_BYTES) return false;

  const normalized = new Set<string>();
  let serializedBytes = 0;
  for (const line of raw.split(/[\r\n]/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    for (const part of trimmedLine.split(',')) {
      const token = part.trim();
      if (!token || [...token].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
        return false;
      }
      let parsed: URL;
      try {
        parsed = new URL(token);
      } catch {
        return false;
      }
      if (!['http:', 'https:', 'udp:'].includes(parsed.protocol) || !parsed.hostname) {
        return false;
      }
      if (parsed.username || parsed.password || parsed.hash) {
        return false;
      }
      const canonical = parsed.toString();
      if (normalized.has(canonical)) continue;
      normalized.add(canonical);
      if (normalized.size > MAX_TORRENT_TRACKERS) return false;
      serializedBytes += utf8ByteLength(canonical) + (normalized.size > 1 ? 1 : 0);
      if (serializedBytes > MAX_TORRENT_TRACKER_BYTES) return false;
    }
  }
  return normalized.size > 0;
};

export const initMediaDomains = async () => {
  try {
    const domains = await invoke('get_supported_media_domains');
    if (domains && domains.length > 0) {
      MEDIA_DOMAINS = domains;
    }
  } catch (e) {
    console.error('Failed to init media domains:', e);
  }
};

export const categoryForFileName = (fileName: string): DownloadCategory => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp', 'ts', 'vob'].includes(ext)) return 'Movies';
  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'alac', 'ape', 'mid', 'midi'].includes(ext)) return 'Musics';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'md', 'epub', 'mobi', 'azw3'].includes(ext)) return 'Documents';
  if (['exe', 'msi', 'bat', 'cmd', 'app', 'dmg', 'pkg', 'apk', 'appx', 'deb', 'rpm', 'appimage', 'run', 'sh', 'bin', 'jar'].includes(ext)) return 'Applications';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico', 'heic', 'raw', 'psd', 'ai'].includes(ext)) return 'Pictures';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'lz', 'lzma', 'zst', 'iso', 'cab', 'tgz', 'tbz', 'z', 'sit', 'sitx'].includes(ext)) return 'Compressed';
  return 'Other';
};

export const fileNameFromUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const pathName = url.pathname.split('/').filter(Boolean).pop();
    if (pathName) {
      const decoded = decodeURIComponent(pathName).trim();
      if (decoded && decoded !== '.' && decoded !== '..') {
        return decoded.replace(/[\/\\?%*:|"<>]/g, '-');
      }
    }
  } catch {
    // Fall through to the stable generic name.
  }
  return 'download';
};

export const canonicalizeDownloadFileName = (fileName: string): string => {
  const leaf = fileName.replace(/\\/g, '/').split('/').pop() || 'download';
  const sanitized = leaf
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g, '-')
    .trim()
    .replace(/[. ]+$/g, '');
  let canonical = sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'download';
  const reservedStem = canonical.split('.')[0]?.trimEnd().toUpperCase();
  if (reservedStem && WINDOWS_RESERVED_FILENAME_STEMS.has(reservedStem)) {
    const extensionStart = canonical.lastIndexOf('.');
    const base = extensionStart > 0 ? canonical.slice(0, extensionStart) : canonical;
    const extension = extensionStart > 0 ? canonical.slice(extensionStart) : '';
    canonical = `${base}-${extension}`;
  }
  if (utf8ByteLength(canonical) <= MAX_DOWNLOAD_FILENAME_BYTES) return canonical;

  const extensionStart = canonical.lastIndexOf('.');
  const hasExtension = extensionStart > 0;
  const base = hasExtension ? canonical.slice(0, extensionStart) : canonical;
  const extension = hasExtension ? canonical.slice(extensionStart) : '';
  const baseBudget = MAX_DOWNLOAD_FILENAME_BYTES
    - utf8ByteLength(extension)
    - utf8ByteLength(FILENAME_TRUNCATION_MARKER);

  if (baseBudget <= 0) {
    return truncateUtf8ToBytes(canonical, MAX_DOWNLOAD_FILENAME_BYTES);
  }

  return `${truncateUtf8ToBytes(base, baseBudget)}${FILENAME_TRUNCATION_MARKER}${extension}`;
};

/**
 * Create a deterministic alternate filename without exceeding the same
 * component limit as canonicalizeDownloadFileName. The suffix is intended for
 * trusted generated values such as " (1)".
 */
export const downloadFileNameWithSuffix = (fileName: string, suffix: string): string => {
  const canonical = canonicalizeDownloadFileName(fileName);
  const safeSuffix = suffix
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/g, '');
  if (!safeSuffix.trim()) return canonical;

  const extensionStart = canonical.lastIndexOf('.');
  const hasExtension = extensionStart > 0;
  const base = hasExtension ? canonical.slice(0, extensionStart) : canonical;
  const extension = hasExtension ? canonical.slice(extensionStart) : '';
  const baseBudget = MAX_DOWNLOAD_FILENAME_BYTES
    - utf8ByteLength(safeSuffix)
    - utf8ByteLength(extension);

  if (baseBudget <= 0) {
    return truncateUtf8ToBytes(`${base}${safeSuffix}${extension}`, MAX_DOWNLOAD_FILENAME_BYTES);
  }

  return `${truncateUtf8ToBytes(base, baseBudget)}${safeSuffix}${extension}`;
};

/**
 * Compare metadata-derived names without allowing path spelling or case to
 * turn the same download into a second queue entry. Keep the extension and
 * the rest of the name intact: URL query strings are not part of this value.
 */
export const normalizeDownloadFileNameForMatch = (fileName: string): string =>
  canonicalizeDownloadFileName(fileName).normalize('NFKC').toLowerCase();

export const downloadMediaKindsMatch = (
  left: boolean | undefined,
  right: boolean | undefined
): boolean => Boolean(left) === Boolean(right);

const WEAK_DOWNLOAD_FILE_NAMES = new Set(['download', 'identifier', 'view', 'uc']);

export const downloadFileNamesMatch = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeDownloadFileNameForMatch(left);
  const normalizedRight = normalizeDownloadFileNameForMatch(right);
  return !WEAK_DOWNLOAD_FILE_NAMES.has(normalizedLeft)
    && !WEAK_DOWNLOAD_FILE_NAMES.has(normalizedRight)
    && normalizedLeft === normalizedRight;
};

export const isMediaUrl = (rawUrl: string): boolean => {
  try {
    const url = new URL(rawUrl);
    return MEDIA_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
};

/**
 * Fields that may carry secrets and therefore must never reach the persisted
 * `download_queue` document. These are supplied in-memory for the active
 * session (see `enqueue_download` payloads) but are stripped at the
 * persistence boundary so the user-data database contains no plaintext credentials.
 */
const DOWNLOAD_SECRET_FIELDS = ['password', 'cookies', 'headers'] as const;
const VOLATILE_PROGRESS_STATUSES = new Set([
  'downloading',
  'seeding'
]);

/**
 * Returns a shallow copy of `item` with secret fields removed. Volatile
 * progress fields (`fraction`, `speed`, `eta`) are also dropped as in the
 * existing persistence path. Numeric byte totals remain for paused, failed,
 * and completed rows so those snapshots keep their accurate Size-column
 * display after restart; counters for the actively ticking `downloading`
 * state stay in memory to avoid a database write for every progress tick.
 * Non-ticking states retain counters so paused, queued, staged, retrying, and
 * processing snapshots remain useful across restart and reconfiguration.
 *
 * Note: standard persistence intentionally retains `url` because it is the
 * download source. The backend applies a stricter portable-mode policy: URL
 * userinfo, query, and fragment components are removed before portable data
 * is written, and affected active records are not auto-resumed.
 */
export const redactDownloadForPersistence = (item: DownloadItem): DownloadItem => {
  const copy: DownloadItem = { ...item };
  delete copy.fraction;
  delete copy.speed;
  delete copy.eta;
  if (VOLATILE_PROGRESS_STATUSES.has(item.status)) {
    delete copy.downloadedBytes;
    delete copy.totalBytes;
    delete copy.totalIsEstimate;
  }
  for (const field of DOWNLOAD_SECRET_FIELDS) {
    delete copy[field];
  }
  return copy;
};
