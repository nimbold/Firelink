import { describe, expect, it, vi } from 'vitest';
import { copyTorrentFilePath } from './torrentFilePath';

describe('Torrent file paths', () => {
  it('copies the complete long path without changing its separators or characters', async () => {
    const path = 'Season 03/Scenes/This-is-a-deliberately-long-file-name-with-unicode-字幕.mkv';
    const writeText = vi.fn(async () => undefined);

    await copyTorrentFilePath(path, writeText);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(path);
  });
});
