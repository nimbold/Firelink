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
        if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ftp:' || url.protocol === 'sftp:') {
          urls.push(url.toString());
        }
      } catch (e) {
        // Not a valid URL
      }
    }
  }
  
  return [...new Set(urls)];
}
