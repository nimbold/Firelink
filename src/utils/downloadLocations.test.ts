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
  deriveBatchFolderName,
  formatDerivedCategoryPath,
  normalizeCategorySubfolder,
  normalizeDownloadLocationSettings,
  resolveInitialAddWindowLocation,
  resolveAddWindowPromptOptions,
  resolveAddWindowPromptRoot,
  resolveCategoryDestination,
  resolveSubfolderDestination,
  sanitizeBatchFolderName,
  subfolderFromDerivedCategoryPath
} from './downloadLocations';

describe('download locations', () => {
  it('matches backend platform path case semantics', () => {
    expect(downloadLocationEquals('D:\\Downloads', 'Movie.MP4', 'd:/downloads', 'movie.mp4', 'windows')).toBe(true);
    expect(downloadLocationEquals('/Users/Test', 'Movie.MP4', '/users/test', 'movie.mp4', 'macos')).toBe(false);
    expect(downloadLocationEquals('/home/Test', 'Movie.MP4', '/home/test', 'movie.mp4', 'linux')).toBe(false);
  });

  it('matches destinations with redundant separators without changing platform case rules', () => {
    expect(downloadLocationEquals('/Users/test//Downloads/', 'file.zip', '/Users/test/Downloads', 'file.zip', 'macos')).toBe(true);
    expect(downloadLocationEquals('//Users/test/Downloads', 'file.zip', '/Users/test/Downloads', 'file.zip', 'macos')).toBe(true);
    expect(downloadLocationEquals('\\\\server\\share\\downloads', 'file.zip', '//server//share/downloads/', 'file.zip', 'windows')).toBe(true);
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

  it('derives safe batch folder names from title, referer, and timestamp fallback', () => {
    expect(deriveBatchFolderName(
      'Gallery / Chapter: 1',
      'https://example.com/gallery'
    )).toBe('Gallery - Chapter- 1');
    expect(deriveBatchFolderName(
      'New Tab',
      'https://example.com/gallery/part-1?token=secret'
    )).toBe('example.com-gallery-part-1');
    expect(deriveBatchFolderName(
      'New Tab',
      'https://example.com/gallery',
      new Date('2026-07-20T12:34:56.789Z'),
      ['example.part1.rar', 'example.part2.rar']
    )).toBe('example');
    expect(deriveBatchFolderName(
      'CON',
      null,
      new Date('2026-07-20T12:34:56.789Z')
    )).toBe('batch-CON');
    expect(deriveBatchFolderName(
      '',
      null,
      new Date('2026-07-20T12:34:56.789Z')
    )).toBe('firelink-batch-2026-07-20-12-34-56-789');
    expect(deriveBatchFolderName(
      '',
      null,
      new Date('2026-07-20T12:34:56.789Z'),
      ['example.part1.rar', 'example.part2.rar']
    )).toBe('example');
    expect(sanitizeBatchFolderName('../Example: Parts')).toBe('Example- Parts');
    expect(sanitizeBatchFolderName('😀'.repeat(100))).toBe('😀'.repeat(96));
  });

  it('places the optional folder below an existing category destination', async () => {
    expect(await resolveSubfolderDestination(
      '/Users/test/Downloads/Compressed',
      'Example: Parts'
    )).toBe('/Users/test/Downloads/Compressed/Example- Parts');
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

  it('defaults Torrent downloads to the Torrents folder and respects overrides', async () => {
    const settings = normalizeDownloadLocationSettings({
      baseDownloadFolder: '/Users/test/Downloads'
    });

    expect(settings.categorySubfolders.Torrents).toBe('Torrents');
    expect(await resolveCategoryDestination(settings, 'Torrents'))
      .toBe('/Users/test/Downloads/Torrents');

    settings.categoryDirectoryOverrides.Torrents = '/Volumes/Archive/Torrents';
    expect(await resolveCategoryDestination(settings, 'Torrents'))
      .toBe('/Volumes/Archive/Torrents');

    settings.categorySubfoldersEnabled = false;
    expect(await resolveCategoryDestination(settings, 'Torrents'))
      .toBe('/Users/test/Downloads');
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

  describe('resolveAddWindowPromptOptions', () => {
    it('uses a specific file title when a single item is present and selected', () => {
      const options = resolveAddWindowPromptOptions([{ file: 'archive.tar.gz' }]);
      expect(options.title).toBe('Choose a folder for archive.tar.gz');
    });

    it('uses generic folder title when multiple active items are present', () => {
      const options = resolveAddWindowPromptOptions([
        { file: 'video1.mp4' },
        { file: 'video2.mp4' },
      ]);
      expect(options.title).toBe('Choose download folder');
    });

    it('uses specific file title when only one item remains selected among multiple items', () => {
      const options = resolveAddWindowPromptOptions([
        { file: 'video1.mp4', selected: false },
        { file: 'video2.mp4', selected: true },
        { file: 'video3.mp4', selected: false },
      ]);
      expect(options.title).toBe('Choose a folder for video2.mp4');
    });

    it('falls back cleanly to generic folder title when no items are active', () => {
      const options = resolveAddWindowPromptOptions([]);
      expect(options.title).toBe('Choose download folder');
    });

    it('falls back to generic folder title when active item file name is empty or whitespace', () => {
      const options = resolveAddWindowPromptOptions([{ file: '   ' }]);
      expect(options.title).toBe('Choose download folder');
    });
  });

  describe('resolveAddWindowPromptRoot', () => {
    it('returns saveLocation directly when save location is marked manual', async () => {
      const resolveCategory = vi.fn().mockResolvedValue('/Users/test/Downloads/Video');
      const root = await resolveAddWindowPromptRoot({
        items: [{ file: 'clip.mp4' }],
        saveLocation: '/Users/test/CustomFolder',
        isSaveLocationManual: true,
        resolveCategoryPath: resolveCategory
      });
      expect(root).toBe('/Users/test/CustomFolder');
      expect(resolveCategory).not.toHaveBeenCalled();
    });

    it('resolves category path for single active item when not manual', async () => {
      const resolveCategory = vi.fn().mockResolvedValue('/Users/test/Downloads/Video');
      const root = await resolveAddWindowPromptRoot({
        items: [{ file: 'clip.mp4', isTorrent: false }],
        saveLocation: '/Users/test/Downloads',
        isSaveLocationManual: false,
        resolveCategoryPath: resolveCategory
      });
      expect(root).toBe('/Users/test/Downloads/Video');
      expect(resolveCategory).toHaveBeenCalledWith('clip.mp4', false);
    });

    it('resolves category path for single selected item among multiple parsed items', async () => {
      const resolveCategory = vi.fn().mockResolvedValue('/Users/test/Downloads/Torrents');
      const root = await resolveAddWindowPromptRoot({
        items: [
          { file: 'ignored.mp4', selected: false },
          { file: 'archive.torrent', selected: true, isTorrent: true }
        ],
        saveLocation: '/Users/test/Downloads',
        isSaveLocationManual: false,
        resolveCategoryPath: resolveCategory
      });
      expect(root).toBe('/Users/test/Downloads/Torrents');
      expect(resolveCategory).toHaveBeenCalledWith('archive.torrent', true);
    });

    it('returns base saveLocation when multiple items are active to prevent category scatter', async () => {
      const resolveCategory = vi.fn().mockResolvedValue('/Users/test/Downloads/Video');
      const root = await resolveAddWindowPromptRoot({
        items: [{ file: 'video1.mp4' }, { file: 'video2.mp4' }],
        saveLocation: '/Users/test/Downloads',
        isSaveLocationManual: false,
        resolveCategoryPath: resolveCategory
      });
      expect(root).toBe('/Users/test/Downloads');
      expect(resolveCategory).not.toHaveBeenCalled();
    });

    it('falls back to saveLocation when single item has empty file name', async () => {
      const resolveCategory = vi.fn().mockResolvedValue('/Users/test/Downloads/Other');
      const root = await resolveAddWindowPromptRoot({
        items: [{ file: '   ' }],
        saveLocation: '/Users/test/Downloads',
        isSaveLocationManual: false,
        resolveCategoryPath: resolveCategory
      });
      expect(root).toBe('/Users/test/Downloads');
      expect(resolveCategory).not.toHaveBeenCalled();
    });
  });
});
