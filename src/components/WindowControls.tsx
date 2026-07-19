import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';
import type { PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

const appWindow = getCurrentWindow();

const stopTitlebarDrag = (event: PointerEvent<HTMLButtonElement>) => {
  event.stopPropagation();
};

interface WindowControlsProps {
  side: 'left' | 'right';
}

export function WindowControls({ side }: WindowControlsProps) {
  const { t } = useTranslation();

  return (
    <div
      className={`window-controls window-controls--${side}`}
      aria-label={t($ => $.window.controls)}
    >
      <button
        type="button"
        className="window-control close"
        title={t($ => $.window.close)}
        aria-label={t($ => $.window.close)}
        onPointerDown={stopTitlebarDrag}
        onClick={(event) => {
          event.stopPropagation();
          void appWindow.close();
        }}
      >
        <X size={10} strokeWidth={3} />
      </button>
      <button
        type="button"
        className="window-control minimize"
        title={t($ => $.window.minimize)}
        aria-label={t($ => $.window.minimize)}
        onPointerDown={stopTitlebarDrag}
        onClick={(event) => {
          event.stopPropagation();
          void appWindow.minimize();
        }}
      >
        <Minus size={10} strokeWidth={3} />
      </button>
      <button
        type="button"
        className="window-control maximize"
        title={t($ => $.window.maximize)}
        aria-label={t($ => $.window.maximize)}
        onPointerDown={stopTitlebarDrag}
        onClick={(event) => {
          event.stopPropagation();
          void appWindow.toggleMaximize();
        }}
      >
        <Square size={8} strokeWidth={3} />
      </button>
    </div>
  );
}
