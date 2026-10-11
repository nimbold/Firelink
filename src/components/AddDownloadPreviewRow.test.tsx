import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddDownloadPreviewRow } from './AddDownloadPreviewRow';

describe('AddDownloadPreviewRow accessibility', () => {
  it('keeps details, download selection, and media mode as separate native controls', () => {
    const markup = renderToStaticMarkup(
      <div role="list" aria-label="Download preview">
        <AddDownloadPreviewRow
          file="episode.mkv"
          selected={false}
          detailsSelected
          selectionLabel="Select episode.mkv"
          onToggleSelection={() => undefined}
          onSelectDetails={() => undefined}
          details={<span>episode.mkv 1080p ready</span>}
          mediaControl={(
            <button type="button" aria-label="Treat as media" aria-pressed="false">
              Media
            </button>
          )}
        />
      </div>
    );

    expect(markup).toContain('role="listitem"');
    expect(markup).not.toMatch(/role="(?:listbox|option)"/);
    expect(markup).toContain('<input type="checkbox"');
    expect(markup).toContain('<button type="button" aria-pressed="true"');
    expect(markup).toContain('aria-label="Select episode.mkv"');
    expect(markup).toContain('aria-label="Treat as media"');

    const listItem = markup.slice(markup.indexOf('role="listitem"'));
    expect(listItem.indexOf('<input')).toBeLessThan(listItem.indexOf('<button'));
    expect(listItem.indexOf('</button>')).toBeLessThan(listItem.lastIndexOf('<button'));
    expect(listItem).not.toMatch(/<button\b[^>]*>[^]*?<div\b/);
  });
});
