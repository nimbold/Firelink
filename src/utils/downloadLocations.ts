import { join, homeDir } from '@tauri-apps/api/path';
import type { DownloadCategory } from '../bindings/DownloadCategory';

export const expandTilde = async (path: string): Promise<string> => {
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    const home = await homeDir();
    return join(home, path.slice(2));
  }
  if (path === '~') {
    return homeDir();
  }
  return path;
};

export const DOWNLOAD_CATEGORIES: DownloadCategory[] = [
  'Musics',
  'Movies',
  'Compressed',
  'Documents',
  'Pictures',
  'Applications',
  'Torrents',
  'Other'
];

export const DEFAULT_CATEGORY_SUBFOLDERS: Record<DownloadCategory, string> = {
  Musics: 'Musics',
  Movies: 'Movies',
  Compressed: 'Compressed',
  Documents: 'Documents',
  Pictures: 'Pictures',
  Applications: 'Applications',
  Torrents: 'Torrents',
  Other: 'Other'
};

export interface DownloadLocationSettings {
  baseDownloadFolder: string;
  categorySubfoldersEnabled: boolean;
  categorySubfolders: Record<string, string>;
  categoryDirectoryOverrides: Record<string, string>;
}

interface LegacyDownloadLocationSettings {
  baseDownloadFolder?: unknown;
  categorySubfoldersEnabled?: unknown;
  categorySubfolders?: unknown;
  categoryDirectoryOverrides?: unknown;
  defaultDownloadPath?: unknown;
  downloadDirectories?: unknown;
}

export interface AddWindowLocationSuggestion {
  path: string;
  isManual: boolean;
}

const MAX_BATCH_FOLDER_NAME_LENGTH = 96;
const WEAK_BATCH_PAGE_TITLES = new Set(['new tab', 'untitled', 'about:blank']);

const truncateBatchFolderName = (value: string): string => Array.from(value)
  .filter(character => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 0xd800 || codePoint > 0xdfff;
  })
  .slice(0, MAX_BATCH_FOLDER_NAME_LENGTH)
  .join('');

export const sanitizeBatchFolderName = (value: string): string => {
  const sanitized = truncateBatchFolderName(
    value
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, '-')
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/-+/g, '-')
      .replace(/^[ .-]+|[ .-]+$/g, '')
  )
    .trim()
    .replace(/[ .-]+$/g, '');

  if (!sanitized || sanitized === '.' || sanitized === '..') return '';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(sanitized)) {
    return `batch-${sanitized}`;
  }
  return sanitized;
};

const batchFolderSlugFromReferer = (referer: string): string => {
  try {
    const url = new URL(referer);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '';
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    return sanitizeBatchFolderName(`${url.hostname}${path ? `-${path}` : ''}`);
  } catch {
    return '';
  }
};

const batchFolderNameFromFiles = (fileNames: string[]): string => {
  const stems = fileNames
    .map(fileName => fileName.replace(/\\/g, '/').split('/').pop() || '')
    .map(fileName => fileName.replace(/\.[^.]+$/, ''))
    .filter(Boolean);
  if (stems.length === 0) return '';

  const partStems = stems.map(stem => stem.replace(/[._ -]?part\s*\d+$/i, ''));
  const candidate = partStems.every(stem => stem && stem === partStems[0])
    ? partStems[0]
    : stems.length === 1 ? stems[0] : '';
  return candidate ? sanitizeBatchFolderName(candidate) : '';
};

export const deriveBatchFolderName = (
  pageTitle?: string | null,
  referer?: string | null,
  now = new Date(),
  fileNames: string[] = []
): string => {
  const title = pageTitle?.trim() || '';
  if (title && !WEAK_BATCH_PAGE_TITLES.has(title.toLocaleLowerCase())) {
    const safeTitle = sanitizeBatchFolderName(title);
    if (safeTitle) return safeTitle;
  }

  const fileNameSlug = batchFolderNameFromFiles(fileNames);
  if (fileNameSlug) return fileNameSlug;

  const refererSlug = batchFolderSlugFromReferer(referer?.trim() || '');
  if (refererSlug) return refererSlug;

  const timestamp = now.toISOString().replace(/[.:]/g, '-').replace('T', '-').replace('Z', '');
  return `firelink-batch-${timestamp}`;
};

export const resolveSubfolderDestination = async (
  destination: string,
  folderName: string
): Promise<string> => {
  const root = await expandTilde(destination.trim() || '~/Downloads');
  const safeFolderName = sanitizeBatchFolderName(folderName);
  return safeFolderName ? join(root, safeFolderName) : root;
};

export const resolveInitialAddWindowLocation = (
  baseDownloadFolder: string,
  rememberLastUsedDownloadDirectory: boolean,
  lastUsedDownloadDirectory: string | null
): AddWindowLocationSuggestion => {
  const rememberedPath = rememberLastUsedDownloadDirectory
    ? lastUsedDownloadDirectory?.trim()
    : undefined;
  const basePath = baseDownloadFolder.trim() || '~/Downloads';
  return {
    path: rememberedPath || basePath,
    isManual: Boolean(rememberedPath)
  };
};

const stringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, path]) => [key, path.trim()])
  );
};

const hasOwn = (value: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const normalizedForComparison = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

const legacyDerivedPath = (base: string, subfolder: string): string =>
  [normalizedForComparison(base), subfolder.replace(/^[\\/]+|[\\/]+$/g, '')]
    .filter(Boolean)
    .join('/');

const isWindowsLikePath = (value: string): boolean =>
  /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || value.includes('\\');

export const formatDerivedCategoryPath = (base: string, subfolder: string): string => {
  const trimmedBase = base.trim() || '~/Downloads';
  const relative = subfolder.replace(/^[\\/]+|[\\/]+$/g, '');
  if (!relative) return trimmedBase.replace(/[\\/]+$/, '');
  const separator = isWindowsLikePath(trimmedBase) ? '\\' : '/';
  return `${trimmedBase.replace(/[\\/]+$/, '')}${separator}${relative}`;
};

export const subfolderFromDerivedCategoryPath = (
  value: string,
  base: string
): string | null => {
  const normalizedValue = normalizedForComparison(value.trim());
  const normalizedBase = normalizedForComparison((base.trim() || '~/Downloads'));
  const isWindows = isWindowsLikePath(base);
  const comparableValue = isWindows ? normalizedValue.toLocaleLowerCase() : normalizedValue;
  const comparableBase = isWindows ? normalizedBase.toLocaleLowerCase() : normalizedBase;

  if (comparableValue === comparableBase) return '';
  if (!comparableValue.startsWith(`${comparableBase}/`)) return null;
  return normalizedValue.slice(normalizedBase.length + 1);
};

export const normalizeCategorySubfolder = (
  value: string,
  fallback: string
): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const parts = value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..' && !part.endsWith(':'));
  return parts.join('/') || fallback;
};

export const normalizeDownloadLocationSettings = (
  value: LegacyDownloadLocationSettings
): DownloadLocationSettings => {
  const baseDownloadFolder =
    (typeof value.baseDownloadFolder === 'string' && value.baseDownloadFolder.trim()) ||
    (typeof value.defaultDownloadPath === 'string' && value.defaultDownloadPath.trim()) ||
    '~/Downloads';
  const categorySubfoldersEnabled = value.categorySubfoldersEnabled !== false;
  const persistedSubfolders = stringRecord(value.categorySubfolders);
  const categorySubfolders = Object.fromEntries(
    DOWNLOAD_CATEGORIES.map(category => {
      const persistedValue = hasOwn(persistedSubfolders, category)
        ? persistedSubfolders[category]
        : DEFAULT_CATEGORY_SUBFOLDERS[category];
      return [
        category,
        normalizeCategorySubfolder(persistedValue, DEFAULT_CATEGORY_SUBFOLDERS[category])
      ];
    })
  );
  const categoryDirectoryOverrides = stringRecord(value.categoryDirectoryOverrides);
  const legacyDirectories = stringRecord(value.downloadDirectories);
  const legacyAliases: Record<DownloadCategory, string> = {
    Musics: 'Audio',
    Movies: 'Video',
    Compressed: 'Archives',
    Documents: 'Documents',
    Pictures: 'Images',
    Applications: 'Apps',
    Torrents: 'Torrents',
    Other: 'Other'
  };

  for (const category of DOWNLOAD_CATEGORIES) {
    const legacyDirectory =
      legacyDirectories[category] || legacyDirectories[legacyAliases[category]];
    if (categoryDirectoryOverrides[category] || !legacyDirectory) continue;
    const expected = legacyDerivedPath(baseDownloadFolder, categorySubfolders[category]);
    if (normalizedForComparison(legacyDirectory) !== expected) {
      categoryDirectoryOverrides[category] = legacyDirectory;
    }
  }

  return {
    baseDownloadFolder,
    categorySubfoldersEnabled,
    categorySubfolders,
    categoryDirectoryOverrides
  };
};

export const resolveCategoryDestination = async (
  settings: DownloadLocationSettings,
  category: DownloadCategory
): Promise<string> => {
  const base = settings.baseDownloadFolder.trim() || '~/Downloads';
  const expandedBase = await expandTilde(base);
  if (!settings.categorySubfoldersEnabled) return expandedBase;

  const override = settings.categoryDirectoryOverrides[category]?.trim();
  if (override) return expandTilde(override);

  const persistedValue = hasOwn(settings.categorySubfolders, category)
    ? settings.categorySubfolders[category]
    : DEFAULT_CATEGORY_SUBFOLDERS[category];
  const subfolder = normalizeCategorySubfolder(
    persistedValue,
    DEFAULT_CATEGORY_SUBFOLDERS[category]
  );
  if (!subfolder) return expandedBase;
  return join(expandedBase, subfolder);
};

export const resolveDownloadFilePath = async (
  destination: string,
  fileName: string
): Promise<string> => {
  const expandedDest = await expandTilde(destination);
  return join(expandedDest, fileName);
};

export const downloadLocationEquals = (
  leftDirectory: string,
  leftFileName: string,
  rightDirectory: string,
  rightFileName: string,
  os: string
): boolean => {
  const normalize = (value: string) => {
    const slashPath = value.replace(/\\/g, '/');
    // Collapse redundant separators without destroying a Windows UNC prefix.
    // Destination strings can come from legacy settings as well as the folder
    // picker, so lexical equality must not miss the same filesystem target.
    const leadingSeparators = slashPath.match(/^\/+/);
    const leadingCount = leadingSeparators ? leadingSeparators[0].length : 0;
    const prefix = os === 'windows' && leadingCount >= 2 ? '//' : leadingCount > 0 ? '/' : '';
    const normalized = `${prefix}${slashPath.slice(leadingCount).replace(/\/{2,}/g, '/')}`.replace(/\/+$/, '');
    return os === 'windows'
      ? normalized.toLocaleLowerCase()
      : normalized;
  };
  return normalize(`${leftDirectory}/${leftFileName}`)
    === normalize(`${rightDirectory}/${rightFileName}`);
};
