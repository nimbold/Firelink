import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import type { Queue } from '../store/useDownloadStore';
import { isFloatingSubmenuCloseKey, positionFloatingSubmenu, type FloatingSubmenuPosition } from '../utils/floatingPosition';

interface FloatingQueueSubmenuProps {
  label: React.ReactNode;
  queues: Queue[];
  onSelect: (queue: Queue) => void;
}

const CLOSE_DELAY = 140;

export const FloatingQueueSubmenu: React.FC<FloatingQueueSubmenuProps> = ({ label, queues, onSelect }) => {
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<FloatingSubmenuPosition | null>(null);
  const isRtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const openKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
  const closeKey = isRtl ? 'ArrowRight' : 'ArrowLeft';

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeMenu = useCallback(() => {
    clearCloseTimer();
    setIsOpen(false);
    setPosition(null);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (
        triggerRef.current?.contains(activeElement) ||
        menuRef.current?.contains(activeElement)
      ) {
        closeTimerRef.current = null;
        return;
      }
      closeTimerRef.current = null;
      setIsOpen(false);
      setPosition(null);
    }, CLOSE_DELAY);
  }, [clearCloseTimer]);

  const openMenu = useCallback(() => {
    clearCloseTimer();
    setIsOpen(true);
  }, [clearCloseTimer]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const nextPosition = positionFloatingSubmenu(
        triggerRect,
        menu.offsetWidth || menuRect.width,
        menu.offsetHeight || menuRect.height,
        window.innerWidth,
        window.innerHeight,
        8,
        4,
        isRtl ? 'left' : 'right'
      );
      setPosition(current => (
        current?.x === nextPosition.x &&
        current.y === nextPosition.y &&
        current.side === nextPosition.side
          ? current
          : nextPosition
      ));
    };

    updatePosition();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updatePosition);
    if (menuRef.current) resizeObserver?.observe(menuRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, isRtl]);

  useLayoutEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  return (
    <div
      ref={triggerRef}
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
      onFocus={openMenu}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          scheduleClose();
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="w-full text-start px-3 py-2 hover:bg-item-hover transition-colors flex justify-between items-center"
        onClick={event => {
          event.stopPropagation();
          if (isOpen) closeMenu();
          else openMenu();
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            event.currentTarget.focus();
          }
          if (event.key === openKey) {
            event.preventDefault();
            openMenu();
            window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
          }
          if (event.key === closeKey && isOpen) {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            event.currentTarget.focus();
          }
        }}
      >
        {label}
        <ChevronRight size={14} aria-hidden="true" className="download-context-menu-chevron" />
      </button>

      {isOpen && createPortal(
        <div
          ref={menuRef}
          role="menu"
          data-side={position?.side}
          className={`download-context-submenu fixed min-w-[150px] max-w-[min(280px,calc(100vw-16px))] max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden bg-bg-modal border border-border-modal rounded-lg shadow-lg py-1.5 z-[80] ${position ? 'is-open' : ''}`}
          style={{
            top: position?.y ?? 8,
            left: position?.x ?? 8,
          }}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
          onFocus={clearCloseTimer}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              scheduleClose();
            }
          }}
          onKeyDown={event => {
            if (!isFloatingSubmenuCloseKey(event.key, isRtl)) return;
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            triggerRef.current?.querySelector<HTMLElement>('button')?.focus();
          }}
          onClick={event => event.stopPropagation()}
        >
          {queues.map(queue => (
            <button
              key={queue.id}
              type="button"
              role="menuitem"
              title={queue.name}
              className="w-full min-w-0 text-start px-3 py-2 hover:bg-item-hover transition-colors text-[12px] truncate"
              onClick={() => onSelect(queue)}
            >
              {queue.name}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
};
