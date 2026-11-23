import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import readme from '../../README.md?raw';
import enCatalog from '../i18n/catalogs/en';
import faCatalog from '../i18n/catalogs/fa';

let activeCatalog: typeof enCatalog | typeof faCatalog = enCatalog;

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      selector: (catalog: typeof enCatalog | typeof faCatalog) => string,
      vars?: Record<string, string>,
    ) => {
      let text = selector(activeCatalog);
      if (vars) {
        for (const [key, value] of Object.entries(vars)) {
          text = text.replace(`{{${key}}}`, value);
        }
      }
      return text;
    },
  }),
}));

import { AboutDonateSection, copyDonateAddress, DONATE_ADDRESSES } from './AboutDonateSection';

describe('AboutDonateSection', () => {
  it('preserves the exact checksummed and canonical receive addresses', () => {
    expect(DONATE_ADDRESSES).toEqual([
      { id: 'ethereum', address: '0x35C2985cC1Be1122E20817e87FCa49D8196f89B8' },
      { id: 'bitcoin', address: 'bc1qy7u658csk6ycza5ej5w0m4f3aqg677rtkvv2mx' },
      { id: 'tron', address: 'THAHkJXTsZPF9oTrq96khFJPsv6zLhPEb8' },
      { id: 'base', address: '0x35C2985cC1Be1122E20817e87FCa49D8196f89B8' },
    ]);
  });

  it('keeps the bottom README disclosure in sync with the app', () => {
    const disclosure = readme.match(/(?:^|\n)<details>\s*\n<summary>Donate<\/summary>([\s\S]*?)<\/details>\s*$/);
    expect(disclosure).not.toBeNull();

    const addresses = [...(disclosure?.[1] ?? '').matchAll(/`([a-zA-Z0-9]+)`/g)];
    expect(addresses.map(([, address]) => address)).toEqual(DONATE_ADDRESSES.map(({ address }) => address));
    expect(disclosure?.[1]).toContain(enCatalog.settings.about.donateUsdtNote);
  });

  it('orders rapid clipboard requests and continues after a native write fails', async () => {
    const [ethereum, bitcoin, tron] = DONATE_ADDRESSES;
    const mockWrite = vi.mocked(writeText);
    const clipboardError = new Error('clipboard unavailable');
    let reportFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>(resolve => { reportFirstWriteStarted = resolve; });
    let finishFirstWrite!: () => void;
    const pendingFirstWrite = new Promise<void>(resolve => { finishFirstWrite = resolve; });
    mockWrite
      .mockImplementationOnce(() => {
        reportFirstWriteStarted();
        return pendingFirstWrite;
      })
      .mockRejectedValueOnce(clipboardError);

    const first = copyDonateAddress(ethereum.address);
    const failed = expect(copyDonateAddress(bitcoin.address)).rejects.toBe(clipboardError);
    const last = copyDonateAddress(tron.address);
    await firstWriteStarted;
    expect(mockWrite.mock.calls).toEqual([[ethereum.address]]);

    finishFirstWrite();
    await Promise.all([first, failed, last]);
    expect(mockWrite.mock.calls).toEqual([[ethereum.address], [bitcoin.address], [tron.address]]);
  });

  it('renders a closed-by-default Donate button without exposing addresses initially', () => {
    activeCatalog = enCatalog;
    const markup = renderToStaticMarkup(<AboutDonateSection showToast={() => undefined} />);

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('Donate');
    expect(markup).not.toContain('0x35C2985cC1Be1122E20817e87FCa49D8196f89B8');
    expect(markup).not.toContain('bc1qy7u658csk6ycza5ej5w0m4f3aqg677rtkvv2mx');
    expect(markup).not.toContain('THAHkJXTsZPF9oTrq96khFJPsv6zLhPEb8');
  });

  it('includes the USDT network note scoped strictly to Ethereum (ERC-20) and TRON (TRC-20)', () => {
    const note = enCatalog.settings.about.donateUsdtNote;
    expect(note).toContain('Tether (USDT)');
    expect(note).toContain('Ethereum (ERC-20)');
    expect(note).toContain('TRON (TRC-20)');
    expect(note).not.toContain('Bitcoin');
    expect(note).not.toContain('Base');
  });

  it('renders RTL copy cleanly when using a Persian catalog', () => {
    activeCatalog = faCatalog;
    const markup = renderToStaticMarkup(<AboutDonateSection showToast={() => undefined} />);

    expect(markup).toContain(faCatalog.settings.about.donate);
    expect(markup).toContain('aria-expanded="false"');
  });
});
