import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const getFocusableElements = (surface: HTMLElement): HTMLElement[] => {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(element => {
    const style = window.getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && !element.closest('[aria-hidden="true"], [inert]');
  });
};

const getTopmostModal = (): HTMLElement | null => {
  const surfaces = Array.from(document.querySelectorAll<HTMLElement>('[data-modal-surface="true"]'));
  let topmost: HTMLElement | null = null;
  let topmostZIndex = Number.NEGATIVE_INFINITY;

  for (const surface of surfaces) {
    // Modal stacking is applied to the backdrop, not the panel itself. This
    // matters when a child modal (for example duplicate resolution) is
    // rendered before its parent panel in the DOM.
    const stackingElement = surface.closest<HTMLElement>('.app-modal-backdrop') || surface;
    const parsedZIndex = Number.parseInt(window.getComputedStyle(stackingElement).zIndex, 10);
    const zIndex = Number.isFinite(parsedZIndex) ? parsedZIndex : 0;
    // Later DOM order wins ties, matching browser painting order for equal
    // z-index surfaces and keeping the stack deterministic.
    if (zIndex >= topmostZIndex) {
      topmost = surface;
      topmostZIndex = zIndex;
    }
  }

  return topmost;
};

export const isTopmostModal = (surface: HTMLElement | null): boolean =>
  surface !== null && getTopmostModal() === surface;

export const useModalFocus = (enabled = true) => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const surface = surfaceRef.current;
    if (!surface) return;

    const activeElement = document.activeElement;
    previousFocusRef.current = activeElement instanceof HTMLElement && !surface.contains(activeElement)
      ? activeElement
      : null;

    const focusInitialElement = () => {
      if (!isTopmostModal(surface)) return;
      const initialElement = surface.querySelector<HTMLElement>('[data-modal-autofocus="true"]')
        || getFocusableElements(surface)[0]
        || surface;
      initialElement.focus({ preventScroll: true });
    };

    const initialFocusFrame = window.requestAnimationFrame(focusInitialElement);
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopmostModal(surface) || surface.contains(event.target as Node)) return;
      focusInitialElement();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(surface) || event.key !== 'Tab') return;

      const focusableElements = getFocusableElements(surface);
      if (focusableElements.length === 0) {
        event.preventDefault();
        surface.focus({ preventScroll: true });
        return;
      }

      const currentIndex = focusableElements.indexOf(document.activeElement as HTMLElement);
      const isLeavingForward = !event.shiftKey && (currentIndex < 0 || currentIndex === focusableElements.length - 1);
      const isLeavingBackward = event.shiftKey && currentIndex <= 0;
      if (!isLeavingForward && !isLeavingBackward) return;

      event.preventDefault();
      const nextElement = event.shiftKey
        ? focusableElements[focusableElements.length - 1]
        : focusableElements[0];
      nextElement.focus({ preventScroll: true });
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(initialFocusFrame);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);

      const previousFocus = previousFocusRef.current;
      if (!previousFocus?.isConnected) return;
      window.requestAnimationFrame(() => {
        const topmostModal = getTopmostModal();
        if (!topmostModal || topmostModal.contains(previousFocus)) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [enabled]);

  return surfaceRef;
};
