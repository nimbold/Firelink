import type { DownloadCategory } from '../bindings/DownloadCategory';
import type { DownloadStatus } from '../bindings/DownloadStatus';
import type { DownloadItem } from '../bindings/DownloadItem';
import type { TorrentWebSeed } from '../bindings/TorrentWebSeed';
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
  'verifying',
  'seeding',
  'waitingToSeed',
  'retrying',
  'moving',
]);

const DOWNLOAD_STATUSES: ReadonlySet<string> = new Set([
  'ready',
  'staged',
  'downloading',
  'processing',
  'seeding',
  'waitingToSeed',
  'paused',
  'completed',
  'failed',
  'queued',
  'retrying',
  'verifying',
  'moving',
]);

/** Runtime guard for values arriving from the untyped Tauri event channel. */
export const isDownloadStatus = (status: unknown): status is DownloadStatus =>
  typeof status === 'string' && DOWNLOAD_STATUSES.has(status);

export const isActiveDownloadStatus = (status: DownloadStatus): boolean =>
  ACTIVE_DOWNLOAD_STATUSES.has(status);

/** Transfer states that consume a worker/permit. Queued is intentionally excluded. */
export const isTransferActiveStatus = (status: DownloadStatus): boolean =>
  status === 'downloading' || status === 'processing' || status === 'verifying' || status === 'seeding' || status === 'retrying';

/**
 * A transient allocation flag must never replace a terminal or user-paused
 * status in the UI. Failed rows remain eligible because retry admission can
 * begin from the failed state before the backend accepts the new lifecycle.
 */
export const isAllocationPhaseVisible = (
  allocationPending: boolean,
  status: DownloadStatus,
): boolean => allocationPending && status !== 'completed' && status !== 'paused';

/**
 * Allocation is a transient admission phase. Normal downloads retain the
 * existing preallocation behavior; Torrent rows use Aria2's Torrent-specific
 * allocation setting without exposing the normal-download hint, including
 * for verification-only work.
 */
export const isAllocationPhaseEligible = (
  download: Pick<DownloadItem, 'isMedia' | 'isTorrent' | 'torrentFileAllocation' | 'torrentVerifyOnly'>,
): boolean => {
  // Torrent rows retain their native file-allocation option, but Aria2's
  // BitTorrent lifecycle must not be represented as Firelink's transient
  // normal-download allocation phase. A zero-byte Torrent can be waiting for
  // peers indefinitely, so the UI must not claim that files are being
  // allocated until bytes appear.
  return download.isMedia !== true && download.isTorrent !== true;
};

export const DOWNLOAD_CONNECTIONS_MIN = 1;
export const DOWNLOAD_CONNECTIONS_MAX = 16;

export const TORRENT_ENCRYPTION_POLICY_DISABLED = 'disabled' as const;
export const TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO = 'require-crypto' as const;
export const TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION = 'force-encryption' as const;
export type TorrentEncryptionPolicy =
  | typeof TORRENT_ENCRYPTION_POLICY_DISABLED
  | typeof TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO
  | typeof TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION;

export const normalizeTorrentEncryptionPolicy = (
  value: unknown
): TorrentEncryptionPolicy | undefined => {
  if (
    value === TORRENT_ENCRYPTION_POLICY_DISABLED ||
    value === TORRENT_ENCRYPTION_POLICY_REQUIRE_CRYPTO ||
    value === TORRENT_ENCRYPTION_POLICY_FORCE_ENCRYPTION
  ) {
    return value;
  }
  return undefined;
};

export type TorrentFileAllocation = 'prealloc' | 'none';

export const normalizeTorrentFileAllocation = (value: unknown): TorrentFileAllocation | undefined =>
  value === 'prealloc' || value === 'none' ? value : undefined;

export const MAX_TORRENT_TRACKER_TIMEOUT = 604800;
export const MAX_TORRENT_TRACKER_INTERVAL = 604800;
export const DEFAULT_TORRENT_MAX_OPEN_FILES = 100;
export const MIN_TORRENT_MAX_OPEN_FILES = 1;
export const MAX_TORRENT_MAX_OPEN_FILES = 4096;
export const DEFAULT_TORRENT_DHT_MESSAGE_TIMEOUT = 10;
export const MIN_TORRENT_DHT_MESSAGE_TIMEOUT = 1;
// Aria2 1.37.0 accepts DHT message timeouts only from 1 through 60 seconds.
export const MAX_TORRENT_DHT_MESSAGE_TIMEOUT = 60;
export const DEFAULT_TORRENT_MAX_CONCURRENT_SEEDS = 2;
export const MIN_TORRENT_MAX_CONCURRENT_SEEDS = 1;
export const MAX_TORRENT_MAX_CONCURRENT_SEEDS = 64;

const parseIntegerOption = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const normalizeTorrentTrackerTimeout = (value: unknown): number | undefined => {
  const parsed = parseIntegerOption(value);
  return parsed !== undefined && parsed >= 1 && parsed <= MAX_TORRENT_TRACKER_TIMEOUT
    ? parsed
    : undefined;
};

export const normalizeTorrentTrackerInterval = (value: unknown): number | undefined => {
  const parsed = parseIntegerOption(value);
  return parsed !== undefined && parsed >= 0 && parsed <= MAX_TORRENT_TRACKER_INTERVAL
    ? parsed
    : undefined;
};

export const normalizeTorrentMaxOpenFiles = (value: unknown): number | undefined => {
  const parsed = parseIntegerOption(value);
  return parsed !== undefined
    && parsed >= MIN_TORRENT_MAX_OPEN_FILES
    && parsed <= MAX_TORRENT_MAX_OPEN_FILES
    ? parsed
    : undefined;
};

export const normalizeTorrentDhtMessageTimeout = (value: unknown): number | undefined => {
  const parsed = parseIntegerOption(value);
  return parsed !== undefined
    && parsed >= MIN_TORRENT_DHT_MESSAGE_TIMEOUT
    && parsed <= MAX_TORRENT_DHT_MESSAGE_TIMEOUT
    ? parsed
    : undefined;
};

export const normalizeTorrentMaxConcurrentSeeds = (value: unknown): number | undefined => {
  const parsed = parseIntegerOption(value);
  return parsed !== undefined
    && parsed >= MIN_TORRENT_MAX_CONCURRENT_SEEDS
    && parsed <= MAX_TORRENT_MAX_CONCURRENT_SEEDS
    ? parsed
    : undefined;
};

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
const MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB = 1024;
const MAX_TORRENT_WEB_SEEDS = 64;
const MAX_TORRENT_WEB_SEED_URI_BYTES = 2048;

const normalizeTorrentPiecePrioritySize = (value: string): string | null => {
  const match = value.trim().match(/^(\d+)\s*([km])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const maximum = unit === 'M'
    ? MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB
    : MAX_TORRENT_PIECE_PRIORITY_SIZE_MIB * 1024;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > maximum) return null;
  return `${amount}${unit}`;
};

/**
 * Normalize the constrained subset of Aria2's bt-prioritize-piece syntax
 * that Firelink persists. The native validator remains authoritative because
 * persisted state and older clients can bypass this helper.
 */
export const normalizeTorrentPrioritizePiece = (value?: string | null): string | null => {
  const raw = value?.trim();
  if (!raw) return null;
  if (utf8ByteLength(raw) > 64) return null;

  let head: string | undefined;
  let tail: string | undefined;
  for (const rawToken of raw.split(',')) {
    const token = rawToken.trim();
    if (!token) return null;
    const separator = token.indexOf('=');
    const keyword = (separator === -1 ? token : token.slice(0, separator)).trim().toLowerCase();
    const size = separator === -1 ? undefined : token.slice(separator + 1);
    if (!['head', 'tail'].includes(keyword) || (separator !== -1 && token.indexOf('=', separator + 1) !== -1)) {
      return null;
    }
    const normalized = size === undefined
      ? keyword
      : (() => {
          const normalizedSize = normalizeTorrentPiecePrioritySize(size);
          return normalizedSize ? `${keyword}=${normalizedSize}` : null;
        })();
    if (!normalized) return null;
    if (keyword === 'head') {
      if (head) return null;
      head = normalized;
    } else {
      if (tail) return null;
      tail = normalized;
    }
  }

  return [head, tail].filter((part): part is string => Boolean(part)).join(',') || null;
};

export type TorrentPreviewPriority = {
  head: string;
  tail: string;
};

export const parseTorrentPreviewPriority = (value?: string | null): TorrentPreviewPriority => {
  const normalized = normalizeTorrentPrioritizePiece(value);
  const result: TorrentPreviewPriority = { head: '', tail: '' };
  for (const token of normalized?.split(',') ?? []) {
    const [keyword, size] = token.split('=', 2);
    result[keyword as 'head' | 'tail'] = size || '1M';
  }
  return result;
};

export const serializeTorrentPreviewPriority = (
  headEnabled: boolean,
  headSize: string,
  tailEnabled: boolean,
  tailSize: string
): string | null => normalizeTorrentPrioritizePiece([
  headEnabled ? `head=${headSize.trim() || '1M'}` : '',
  tailEnabled ? `tail=${tailSize.trim() || '1M'}` : ''
].filter(Boolean).join(','));

export type TorrentWebSeedDraft = {
  fileIndex: number | null;
  uri: string;
};

export const torrentWebSeedDraftsFromSeeds = (
  seeds: readonly TorrentWebSeed[] | undefined
): TorrentWebSeedDraft[] => (seeds ?? []).map(seed => ({
  fileIndex: seed.fileIndex,
  uri: seed.uri
}));

type TorrentWebSeedFile = { index: number };

export const normalizeTorrentWebSeedDrafts = (
  drafts: readonly TorrentWebSeedDraft[],
  files: readonly TorrentWebSeedFile[]
): TorrentWebSeed[] | null => {
  if (drafts.length > MAX_TORRENT_WEB_SEEDS) return null;
  const fileIndices = new Set(files.map(file => file.index));
  const normalized: TorrentWebSeed[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    const fileIndex = files.length === 1 ? files[0].index : draft.fileIndex;
    const uri = draft.uri.trim();
    if (
      fileIndex === null
      || !fileIndices.has(fileIndex)
      || !uri
      || new TextEncoder().encode(uri).length > MAX_TORRENT_WEB_SEED_URI_BYTES
    ) return null;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return null;
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.hash
      || /[\u0000-\u001f\u007f]/u.test(uri)
    ) return null;
    const normalizedUri = parsed.toString();
    const key = `${fileIndex}\u0000${normalizedUri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ fileIndex, uri: normalizedUri });
  }
  return normalized;
};

/**
 * Performs the same user-facing safety checks as the native tracker boundary.
 * The Rust validator remains authoritative because persisted data can bypass
 * this helper and the browser URL parser is not the native URL parser.
 */
const isValidTorrentTrackerListInternal = (value: string, allowWildcard: boolean): boolean => {
  const raw = value.trim();
  if (!raw) return true;
  if (utf8ByteLength(raw) > MAX_TORRENT_TRACKER_BYTES) return false;

  const normalized = new Set<string>();
  let wildcard = false;
  let serializedBytes = 0;
  for (const line of raw.split(/[\r\n]/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    for (const part of trimmedLine.split(',')) {
      const token = part.trim();
      if (!token || [...token].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
        return false;
      }
      if (allowWildcard && token === '*') {
        if (normalized.size > 0) return false;
        wildcard = true;
        continue;
      }
      if (wildcard) return false;
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
  return normalized.size > 0 || wildcard;
};

export const isValidTorrentTrackerList = (value: string): boolean =>
  isValidTorrentTrackerListInternal(value, false);

export const isValidTorrentExcludeTrackerList = (value: string): boolean =>
  isValidTorrentTrackerListInternal(value, true);

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

export const categoryForFileName = (
  fileName: string,
  isTorrent = false
): DownloadCategory => {
  if (isTorrent || fileName.trim().toLowerCase().endsWith('.torrent')) return 'Torrents';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp', 'ts', 'vob'].includes(ext)) return 'Movies';
  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma', 'alac', 'ape', 'mid', 'midi'].includes(ext)) return 'Musics';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'md', 'epub', 'mobi', 'azw3'].includes(ext)) return 'Documents';
  if (['exe', 'msi', 'bat', 'cmd', 'app', 'dmg', 'pkg', 'apk', 'appx', 'deb', 'rpm', 'appimage', 'run', 'sh', 'bin', 'jar'].includes(ext)) return 'Applications';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'ico', 'heic', 'raw', 'psd', 'ai'].includes(ext)) return 'Pictures';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'lz', 'lzma', 'zst', 'iso', 'cab', 'tgz', 'tbz', 'z', 'sit', 'sitx'].includes(ext)) return 'Compressed';
  return 'Other';
};

export const categoryForDownload = (
  fileName: string,
  isTorrent: boolean,
  existingCategory?: DownloadCategory
): DownloadCategory => {
  if (isTorrent && existingCategory === 'Other') return existingCategory;
  return categoryForFileName(fileName, isTorrent);
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
const DOWNLOAD_SECRET_FIELDS = ['password', 'cookies'] as const;
// Browser captures commonly include request context such as Referer and
// User-Agent. Keep this an explicit allowlist so those known non-credential
// headers do not gate a restart, while an unknown custom header fails closed
// and remains eligible for a credential-confirmation retry.
const NON_CREDENTIAL_REQUEST_HEADERS = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'dnt',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'origin',
  'pragma',
  'priority',
  'range',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'sec-gpc',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'warning',
]);

const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
]);
const CREDENTIAL_HEADER_MARKERS = [
  'auth',
  'credential',
  'key',
  'password',
  'passwd',
  'secret',
  'session',
  'signature',
  'token',
] as const;

/** Header-name classifier shared by extension handoff defenses. */
export const headerNameHasCredentialMaterial = (rawName: string): boolean => {
  const name = rawName.trim().toLowerCase();
  return name.length === 0
    || CREDENTIAL_HEADER_NAMES.has(name)
    || CREDENTIAL_HEADER_MARKERS.some(marker => name.includes(marker));
};
// Only stable request context is safe to carry into a later lifecycle. Range,
// conditional, hop-by-hop, and routing headers describe the old HTTP request
// and can conflict with Aria2's own resume negotiation.
const PERSISTABLE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'dnt',
  'origin',
  'pragma',
  'priority',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'sec-gpc',
  'user-agent',
]);
const VOLATILE_PROGRESS_STATUSES = new Set([
  'downloading',
  'verifying',
  'seeding'
]);

const hasCredentialMaterial = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;

const headerValueRequiresRecovery = (name: string, value: string): boolean => {
  if (!value.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return true;

  if (name === 'referer' || name === 'origin') {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return true;
      // Origin must not carry a path that would be silently discarded by the
      // persistence sanitizer.
      return name === 'origin' && parsed.pathname !== '/' && parsed.pathname !== '';
    } catch {
      return true;
    }
  }

  return false;
};

export const hasCredentialBearingHeaders = (headers: string | null | undefined): boolean => {
  if (!hasCredentialMaterial(headers)) return false;
  return headers!.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return true;
    const name = trimmed.slice(0, separator).trim().toLowerCase();
    // An unknown header is sensitive even when its value is empty: the
    // redacted value cannot tell us whether it was a placeholder for a token
    // or an intentionally empty request field.
    return !NON_CREDENTIAL_REQUEST_HEADERS.has(name)
      || headerValueRequiresRecovery(name, trimmed.slice(separator + 1).trim());
  });
};

const persistableHeaderValue = (name: string, value: string): string | undefined => {
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;

  if (name === 'referer') {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      parsed.username = '';
      parsed.password = '';
      // A Referer query or fragment can carry a signed URL or user token.
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  if (name === 'origin') {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
      return parsed.origin;
    } catch {
      return undefined;
    }
  }

  return value;
};

const persistableRequestHeaders = (headers: string | null | undefined): string | undefined => {
  if (!hasCredentialMaterial(headers)) return undefined;

  const lines = headers!.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return [];
    const name = trimmed.slice(0, separator).trim().toLowerCase();
    if (!PERSISTABLE_REQUEST_HEADERS.has(name)) return [];
    const value = persistableHeaderValue(name, trimmed.slice(separator + 1).trim());
    return value === undefined ? [] : [`${trimmed.slice(0, separator).trim()}: ${value}`];
  });

  return lines.length > 0 ? lines.join('\n') : undefined;
};

/**
 * Preserve only stable, non-credential request context for an explicit
 * credentialless retry. This uses the same allow-list and URL sanitization as
 * persistence so a retry cannot accidentally reuse a signed Referer or an
 * unknown token-bearing header.
 */
export const headersWithoutCredentialMaterial = (
  headers: string | null | undefined
): string | undefined => persistableRequestHeaders(headers);

/**
 * Returns a shallow copy of `item` with secret fields removed. Volatile
 * progress fields (`fraction`, `speed`, `eta`) are also dropped as in the
 * existing persistence path. Numeric byte totals remain for paused, failed,
 * and completed rows so those snapshots keep their accurate Size-column
 * display after restart; counters for the actively ticking `downloading`
 * state stay in memory to avoid a database write for every progress tick.
 * Non-ticking states retain counters so paused, queued, staged, retrying, and
 * processing snapshots remain useful across restart and reconfiguration.
 * The credential marker is narrower than the redacted field set: ordinary
 * browser request context such as Referer does not require a credentialed
 * restart, while passwords, cookies, usernames, and unknown custom headers
 * do. A sanitized subset of stable browser context is retained so a resumed
 * download keeps anti-hotlink and content-negotiation context without
 * persisting credentials or stale range state.
 *
 * Note: standard persistence intentionally retains `url` because it is the
 * download source. The backend applies a stricter portable-mode policy: URL
 * userinfo, query, and fragment components are removed before portable data
 * is written, and affected active records are not auto-resumed.
 */
export const redactDownloadForPersistence = (item: DownloadItem): DownloadItem => {
  const copy: DownloadItem = { ...item };
  if (item.isTorrent === true) {
    // Torrent request credentials belong only to metadata acquisition. A
    // legacy row may still carry the marker or username in memory, but neither
    // may turn a cached-metadata Torrent into a credential-gated restart.
    delete copy.credentialsRequired;
    delete copy.username;
  } else if (item.credentialsRequired === true
    || hasCredentialMaterial(item.username)
    || hasCredentialMaterial(item.password)
    || hasCredentialMaterial(item.cookies)
    || hasCredentialBearingHeaders(item.headers)) {
    copy.credentialsRequired = true;
  }
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
  if (item.isTorrent === true) {
    delete copy.headers;
  } else {
    const savedHeaders = persistableRequestHeaders(item.headers);
    if (savedHeaders) copy.headers = savedHeaders;
    else delete copy.headers;
  }
  // Error classification is derived from the live native state and must not
  // become a persistence field or influence a new lifecycle after restart.
  delete copy.lastErrorKind;
  delete copy.lastResolverFallback;
  return copy;
};
