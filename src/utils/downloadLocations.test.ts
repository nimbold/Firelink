import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/path', () => ({
  join: vi.fn(async (...parts: string[]) =>
    parts
      .map((part, index) => index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, ''))
      .join('/')
  )
}));

import {
  downloadLocationEquals,
  DEFAULT_CATEGORY_SUBFOLDERS,
  formatDerivedCategoryPath,
  normalizeCategorySubfolder,
  normalizeDownloadLocationSettings,
  resolveInitialAddWindowLocation,
  resolveCategoryDestination,
  subfolderFromDerivedCategoryPath
} from './downloadLocations';

describe('download locations', () => {
  it('matches backend platform path case semantics', () => {
    expect(downloadLocationEquals('D:\\Downloads', 'Movie.MP4', 'd:/downloads', 'movie.mp4', 'windows')).toBe(true);
    expect(downloadLocationEquals('/Users/Test', 'Movie.MP4', '/users/test', 'movie.mp4', 'macos')).toBe(false);
    expect(downloadLocationEquals('/home/Test', 'Movie.MP4', '/home/test', 'movie.mp4', 'linux')).toBe(false);
  });

  it('uses a remembered Add-window directory only when the setting is enabled', () => {
    expect(resolveInitialAddWindowLocation(
      'D:\\Downloads',
      true,
      'D:\\Course_Videos'
    )).toEqual({ path: 'D:\\Course_Videos', isManual: true });

    expect(resolveInitialAddWindowLocation(
      'D:\\Downloads',
      false,
      'D:\\Course_Videos'
    )).toEqual({ path: 'D:\\Downloads', isManual: false });
  });

  it('falls back to the normalized base folder when no directory was remembered', () => {
    expect(resolveInitialAddWindowLocation('  ', true, null))
      .toEqual({ path: '~/Downloads', isManual: false });
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates legacy derived directories without creating overrides', () => {
    const settings = normalizeDownloadLocationSettings({
      defaultDownloadPath: '/Users/test/Downloads',
      downloadDirectories: {
        Movies: '/Users/test/Downloads/Movies',
        Documents: '/Users/test/Downloads/Documents'
      }
    });

    expect(settings.baseDownloadFolder).toBe('/Users/test/Downloads');
    expect(settings.categorySubfolders).toEqual(DEFAULT_CATEGORY_SUBFOLDERS);
    expect(settings.categoryDirectoryOverrides).toEqual({});
  });

  it('preserves legacy custom category directories as overrides', () => {
    const settings = normalizeDownloadLocationSettings({
      defaultDownloadPath: '/Users/test/Downloads',
      downloadDirectories: {
        Video: '/Volumes/Media/Movies'
      }
    });

    expect(settings.categoryDirectoryOverrides.Movies).toBe('/Volumes/Media/Movies');
  });

  it('resolves automatic and overridden category destinations', async () => {
    const automatic = normalizeDownloadLocationSettings({
      baseDownloadFolder: '/Users/test/Downloads',
      categorySubfolders: { Movies: 'Video Files' }
    });
    expect(await resolveCategoryDestination(automatic, 'Movies'))
      .toBe('/Users/test/Downloads/Video Files');

    automatic.categoryDirectoryOverrides.Movies = '/Volumes/Media';
    expect(await resolveCategoryDestination(automatic, 'Movies')).toBe('/Volumes/Media');
  });

  it('defaults category subfolders on and sends every category to the base folder when disabled', async () => {
    const automatic = normalizeDownloadLocationSettings({
      baseDownloadFolder: '/Users/test/Downloads'
    });
    expect(automatic.categorySubfoldersEnabled).toBe(true);

    const disabled = normalizeDownloadLocationSettings({
      baseDownloadFolder: '/Users/test/Downloads',
      categorySubfoldersEnabled: false,
      categorySubfolders: { Movies: 'Video Files' },
      categoryDirectoryOverrides: { Movies: '/Volumes/Media' }
    });

    expect(disabled.categorySubfoldersEnabled).toBe(false);
    expect(await resolveCategoryDestination(disabled, 'Movies'))
      .toBe('/Users/test/Downloads');
    expect(await resolveCategoryDestination(disabled, 'Documents'))
      .toBe('/Users/test/Downloads');
  });

  it('keeps an explicit empty category subfolder as the base folder', async () => {
    const settings = normalizeDownloadLocationSettings({
      baseDownloadFolder: '/Users/test/Downloads',
      categorySubfolders: { Movies: '' }
    });

    expect(settings.categorySubfolders.Movies).toBe('');
    expect(settings.categorySubfolders.Documents).toBe('Documents');
    expect(formatDerivedCategoryPath('/Users/test/Downloads', '')).toBe('/Users/test/Downloads');
    expect(await resolveCategoryDestination(settings, 'Movies')).toBe('/Users/test/Downloads');
  });

  it('keeps category subfolders relative and permits nested folders', () => {
    expect(normalizeCategorySubfolder('../Media/./Movies', 'Movies')).toBe('Media/Movies');
    expect(normalizeCategorySubfolder('C:\\Media\\Movies', 'Movies')).toBe('Media/Movies');
    expect(normalizeCategorySubfolder('../../', 'Movies')).toBe('Movies');
  });

  it('formats and parses derived category paths with platform path separators', () => {
    expect(formatDerivedCategoryPath('/Users/test/Downloads', 'Video Files'))
      .toBe('/Users/test/Downloads/Video Files');
    expect(formatDerivedCategoryPath('D:\\Downloads', 'Video Files'))
      .toBe('D:\\Downloads\\Video Files');
    expect(subfolderFromDerivedCategoryPath(
      'D:\\Downloads\\Video Files',
      'd:\\downloads'
    )).toBe('Video Files');
    expect(subfolderFromDerivedCategoryPath(
      '/Users/test/Downloads/Video Files',
      '/Users/test/Downloads'
    )).toBe('Video Files');
    expect(subfolderFromDerivedCategoryPath('/Volumes/Media', '/Users/test/Downloads'))
      .toBeNull();
  });
});
