type ResizeEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type ResizeDocumentTarget = Pick<Document, 'addEventListener' | 'removeEventListener'>;
type ResizeBody = Pick<HTMLElement, 'classList'>;

/** Own the global listeners for one table-column resize gesture. */
export const createColumnResizeSession = ({
  windowTarget,
  documentTarget,
  body,
  pointerId,
  startX,
  startWidth,
  minWidth,
  onWidth,
  onEnd,
}: {
  windowTarget: ResizeEventTarget;
  documentTarget: ResizeDocumentTarget;
  body: ResizeBody;
  pointerId: number;
  startX: number;
  startWidth: number;
  minWidth: number;
  onWidth: (width: number) => void;
  onEnd?: () => void;
}): (() => void) => {
  let active = true;

  const handlePointerMove = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (!active || pointerEvent.pointerId !== pointerId) return;
    onWidth(Math.max(minWidth, startWidth + pointerEvent.clientX - startX));
  };

  const cleanup = () => {
    if (!active) return;
    active = false;
    windowTarget.removeEventListener('pointermove', handlePointerMove);
    windowTarget.removeEventListener('pointerup', handlePointerEnd);
    windowTarget.removeEventListener('pointercancel', handlePointerEnd);
    windowTarget.removeEventListener('blur', handleInterrupted);
    documentTarget.removeEventListener('visibilitychange', handleInterrupted);
    body.classList.remove('is-column-resizing');
    onEnd?.();
  };

  const handlePointerEnd = (event: Event) => {
    if ((event as PointerEvent).pointerId === pointerId) cleanup();
  };

  const handleInterrupted = () => cleanup();

  body.classList.add('is-column-resizing');
  windowTarget.addEventListener('pointermove', handlePointerMove);
  windowTarget.addEventListener('pointerup', handlePointerEnd);
  windowTarget.addEventListener('pointercancel', handlePointerEnd);
  windowTarget.addEventListener('blur', handleInterrupted);
  documentTarget.addEventListener('visibilitychange', handleInterrupted);

  return cleanup;
};
