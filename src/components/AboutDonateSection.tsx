import { useId, useRef, useState } from 'react';
import { ChevronDown, Copy, Heart } from 'lucide-react';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { useTranslation } from 'react-i18next';
import type { ToastVariant } from '../contexts/ToastContext';

type DonateNetworkId = 'ethereum' | 'bitcoin' | 'tron' | 'base';

interface DonateAddressEntry {
  id: DonateNetworkId;
  address: string;
}

export const DONATE_ADDRESSES: readonly DonateAddressEntry[] = [
  {
    id: 'ethereum',
    address: '0x35C2985cC1Be1122E20817e87FCa49D8196f89B8',
  },
  {
    id: 'bitcoin',
    address: 'bc1qy7u658csk6ycza5ej5w0m4f3aqg677rtkvv2mx',
  },
  {
    id: 'tron',
    address: 'THAHkJXTsZPF9oTrq96khFJPsv6zLhPEb8',
  },
  {
    id: 'base',
    address: '0x35C2985cC1Be1122E20817e87FCa49D8196f89B8',
  },
] as const;

// Keep clipboard writes ordered even when the About panel is closed and reopened.
let clipboardWriteTail = Promise.resolve();

export function copyDonateAddress(address: string): Promise<void> {
  const write = clipboardWriteTail.then(() => writeClipboardText(address));
  clipboardWriteTail = write.catch(() => undefined);
  return write;
}

const NetworkMark = ({ network }: { network: DonateNetworkId }) => {
  switch (network) {
    case 'ethereum':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#627EEA" />
          <path d="M12 4.5L7.25 12.2L12 14.95L16.75 12.2L12 4.5Z" fill="#FFFFFF" fillOpacity="0.95" />
          <path d="M12 4.5V14.95L16.75 12.2L12 4.5Z" fill="#FFFFFF" fillOpacity="0.72" />
          <path d="M12 16.05L7.25 13.3L12 19.5L16.75 13.3L12 16.05Z" fill="#FFFFFF" fillOpacity="0.95" />
          <path d="M12 16.05V19.5L16.75 13.3L12 16.05Z" fill="#FFFFFF" fillOpacity="0.72" />
        </svg>
      );
    case 'bitcoin':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#F7931A" />
          <path
            d="M15.4 10.75C15.65 9.15 14.4 8.3 12.75 7.75L13.3 5.55L11.95 5.2L11.4 7.35C11.05 7.25 10.7 7.18 10.35 7.1L10.9 4.95L9.55 4.6L9 6.8C8.7 6.73 8.42 6.67 8.15 6.6L6.3 6.13L5.95 7.57C5.95 7.57 6.95 7.8 6.93 7.81C7.47 7.95 7.57 8.3 7.55 8.58L6.93 11.08L6.03 14.68C5.96 14.85 5.79 15.1 5.41 15.01C5.42 15.03 4.43 14.77 4.43 14.77L3.76 16.32L5.51 16.76C5.84 16.84 6.16 16.93 6.47 17.01L5.92 19.23L7.27 19.57L7.82 17.37C8.19 17.47 8.55 17.56 8.9 17.65L8.35 19.84L9.7 20.18L10.26 17.95C12.56 18.39 14.3 18.21 15.03 16.12C15.62 14.44 15 13.47 13.79 12.84C14.67 12.64 15.33 12.06 15.4 10.75ZM12.53 14.78C12.11 16.46 9.28 15.55 8.36 15.32L9.1 12.34C10.02 12.57 12.97 13.02 12.53 14.78ZM12.95 10.72C12.57 12.25 10.22 11.47 9.45 11.28L10.12 8.58C10.89 8.77 13.35 9.13 12.95 10.72Z"
            fill="#FFFFFF"
          />
        </svg>
      );
    case 'tron':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#EF0027" />
          <path
            d="M6.4 6.9L17.9 9.1L11.1 18.6L6.4 6.9ZM8.3 8.4L11.2 15.8L15.6 9.7L8.3 8.4Z"
            fill="#FFFFFF"
          />
          <path d="M11.4 10.7L17.9 9.1L14.5 11.7L11.1 18.6L11.4 10.7Z" fill="#FFFFFF" fillOpacity="0.82" />
        </svg>
      );
    case 'base':
      return (
        <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" aria-hidden="true">
          <circle cx="12" cy="12" r="11" fill="#0052FF" />
          <path
            d="M12 6.25C15.18 6.25 17.75 8.82 17.75 12C17.75 15.18 15.18 17.75 12 17.75C9.04 17.75 6.6 15.52 6.29 12.64H13.45V11.36H6.29C6.6 8.48 9.04 6.25 12 6.25Z"
            fill="#FFFFFF"
          />
        </svg>
      );
  }
};

interface AboutDonateSectionProps {
  showToast: (message: string, variant?: ToastVariant) => void;
}

export function AboutDonateSection({ showToast }: AboutDonateSectionProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const networkLabel = (id: DonateNetworkId): string => {
    switch (id) {
      case 'ethereum':
        return t($ => $.settings.about.networkEthereum);
      case 'bitcoin':
        return t($ => $.settings.about.networkBitcoin);
      case 'tron':
        return t($ => $.settings.about.networkTron);
      case 'base':
        return t($ => $.settings.about.networkBase);
    }
  };

  const handleCopy = async (address: string, network: string) => {
    try {
      await copyDonateAddress(address);
    } catch {
      showToast(t($ => $.settings.about.addressCopyFailed), 'error');
      return;
    }
    showToast(t($ => $.settings.about.addressCopied, { network }), 'success');
  };

  return (
    <div
      className="pt-2 border-t border-border-modal/40 space-y-2.5"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          setIsOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          onClick={() => setIsOpen(open => !open)}
          className="app-button px-2.5 py-1 text-[11px] inline-flex items-center gap-1.5 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Heart size={12} aria-hidden="true" />
          <span>{t($ => $.settings.about.donate)}</span>
          <ChevronDown
            size={12}
            aria-hidden="true"
            className={`motion-safe:transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {isOpen && (
        <div
          id={panelId}
          role="region"
          aria-label={t($ => $.settings.about.donate)}
          className="rounded-lg border border-border-modal/50 p-3 space-y-2.5"
        >
          <ul className="space-y-2">
            {DONATE_ADDRESSES.map((entry) => {
              const label = networkLabel(entry.id);
              return (
                <li
                  key={entry.id}
                  className="rounded-md border border-border-modal/40 bg-bg-modal/80 px-2.5 py-2 flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="flex items-start gap-2.5 min-w-0 flex-1 basis-[220px]">
                    <div className="pt-0.5">
                      <NetworkMark network={entry.id} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-[11px] font-semibold text-text-primary leading-tight">
                        {label}
                      </div>
                      <code
                        dir="ltr"
                        className="block select-text cursor-text break-all font-mono text-[11px] text-text-secondary leading-snug"
                      >
                        {entry.address}
                      </code>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy(entry.address, label)}
                    aria-label={t($ => $.settings.about.copyAddressLabel, { network: label })}
                    className="app-button px-2.5 py-1 text-[11px] shrink-0 inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <Copy size={11} aria-hidden="true" />
                    <span>{t($ => $.settings.about.copyAddress)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <p className="text-[10px] text-text-muted leading-relaxed">
            {t($ => $.settings.about.donateUsdtNote)}
          </p>
        </div>
      )}
    </div>
  );
}
