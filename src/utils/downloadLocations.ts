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
  'Other'
];

export const DEFAULT_CATEGORY_SUBFOLDERS: Record<DownloadCategory, string> = {
  Musics: 'Musics',
  Movies: 'Movies',
  Compressed: 'Compressed',
  Documents: 'Documents',
  Pictures: 'Pictures',
  Applications: 'Applications',
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
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return os === 'windows'
      ? normalized.toLocaleLowerCase()
      : normalized;
  };
  return normalize(`${leftDirectory}/${leftFileName}`)
    === normalize(`${rightDirectory}/${rightFileName}`);
};
