export type ClipboardWriter = (text: string) => Promise<void>;

/** Copy the exact Torrent-relative path without normalizing or truncating it. */
export const copyTorrentFilePath = async (
  path: string,
  writeText: ClipboardWriter,
): Promise<void> => {
  await writeText(path);
};
