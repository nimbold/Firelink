export function extractValidDownloadUrls(text: string): string[] {
  const lines = text.split('\n');
  const urls: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Split by whitespace in case multiple URLs are on one line
    const parts = trimmed.split(/\s+/);
    for (const part of parts) {
      try {
        const url = new URL(part);
        const isValidMagnet = url.protocol !== 'magnet:' || (
          !url.username
          && !url.password
          && !url.hostname
          && !url.port
          && !url.hash
          && url.searchParams.getAll('xt').some(value => /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(value))
        );
        if ((url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ftp:' || url.protocol === 'sftp:' || url.protocol === 'magnet:') && isValidMagnet) {
          urls.push(url.toString());
        }
      } catch (e) {
        // Not a valid URL
      }
    }
  }
  
  return [...new Set(urls)];
}

/**
 * Validates newline-separated mirror URLs for normal (non-torrent, non-media)
 * downloads, returning a deduplicated newline-joined string or `undefined`.
 */
export function normalizeAndValidateMirrors(raw: string): string | undefined {
  const normalizedLines: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: URL;
    try {
      parsed = new URL(line);
    } catch {
      throw new Error('Enter valid mirror URLs.');
    }
    if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol)) {
      throw new Error('Mirror URLs must use http, https, ftp, or sftp.');
    }
    if (!seen.has(line)) {
      seen.add(line);
      normalizedLines.push(line);
    }
  }
  return normalizedLines.length > 0 ? normalizedLines.join('\n') : undefined;
}
