import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readClipboardDownloadUrls, writeClipboardSecret } from './clipboard';
import { readText, writeSecret, writeText } from '@tauri-apps/plugin-clipboard-manager';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(),
  writeSecret: vi.fn(),
  writeText: vi.fn(),
}));

describe('clipboard utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads only supported, unique download URLs from clipboard text', async () => {
    vi.mocked(readText).mockResolvedValue(
      'https://example.com/file.zip\nhttps://example.com/file.zip ftp://example.com/file.bin sftp://example.com/file.iso magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567 mailto:user@example.com'
    );

    await expect(readClipboardDownloadUrls()).resolves.toEqual([
      'https://example.com/file.zip',
      'ftp://example.com/file.bin',
      'sftp://example.com/file.iso',
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
    ]);
  });

  it('ignores malformed magnet URLs at the clipboard boundary', async () => {
    vi.mocked(readText).mockResolvedValue('magnet: magnet:?invalid magnet://tracker/?xt=urn:btih:0123456789abcdef0123456789abcdef01234567');

    await expect(readClipboardDownloadUrls()).resolves.toEqual([]);
  });

  it('preserves clipboard read failures for the caller to handle', async () => {
    const error = new Error('clipboard unavailable');
    vi.mocked(readText).mockRejectedValue(error);

    await expect(readClipboardDownloadUrls()).rejects.toBe(error);
  });

  it('writes sensitive values through the secret clipboard API', async () => {
    const token = 'pairing-secret-token';
    vi.mocked(writeSecret).mockResolvedValue(undefined);

    await writeClipboardSecret(token);

    expect(writeSecret).toHaveBeenCalledOnce();
    expect(writeSecret).toHaveBeenCalledWith(token);
  });

  it('propagates write failures without falling back to an ordinary clipboard write', async () => {
    const failure = new Error('clipboard write failed');
    vi.mocked(writeSecret).mockRejectedValueOnce(failure);

    await expect(writeClipboardSecret('pairing-secret-token')).rejects.toBe(failure);
    expect(writeSecret).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
  });
});
