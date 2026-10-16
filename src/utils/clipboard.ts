import { readText, writeSecret } from '@tauri-apps/plugin-clipboard-manager';
import { extractValidDownloadUrls } from './url';

export const readClipboardDownloadUrls = async (): Promise<string[]> => {
  const clipboardText = await readText();
  return extractValidDownloadUrls(clipboardText);
};

export const writeClipboardSecret = async (text: string): Promise<void> => {
  await writeSecret(text);
};
