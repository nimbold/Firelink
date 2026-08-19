import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (selector: (catalog: { properties: Record<string, string> }) => string) => selector({
      properties: {
        torrentWebSeedsFile: 'File',
        torrentWebSeedsUri: 'URI',
        torrentWebSeedsRemove: 'Remove',
        torrentWebSeedsAdd: 'Add',
        torrentWebSeedsInvalid: 'Invalid',
        torrentWebSeedsEmpty: 'Empty',
      },
    }),
  }),
}));

import { TorrentWebSeedEditor } from './TorrentWebSeedEditor';

describe('TorrentWebSeedEditor file indices', () => {
  it('renders the native one-based file indices without adding an offset', () => {
    const markup = renderToStaticMarkup(
      <TorrentWebSeedEditor
        files={[
          { index: 1, path: 'first.bin' },
          { index: 2, path: 'second.bin' },
        ]}
        rows={[{ fileIndex: 2, uri: 'https://mirror.example/torrent/' }]}
        onChange={() => undefined}
        idPrefix="test"
      />,
    );

    expect(markup).toContain('1: first.bin');
    expect(markup).toContain('2: second.bin');
    expect(markup).not.toContain('3: second.bin');
  });
});
