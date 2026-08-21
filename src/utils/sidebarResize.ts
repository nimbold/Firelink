type ResizeEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type ResizeBody = Pick<HTMLElement, 'classList'>;
type PointerCaptureTarget = Pick<HTMLElement, 'addEventListener' | 'removeEventListener' | 'hasPointerCapture' | 'releasePointerCapture'>;

export const createSidebarResizeSession = ({
  windowTarget,
  body,
  captureTarget,
  pointerId,
  startX,
  startWidth,
  isRight,
  onWidth,
}: {
  windowTarget: ResizeEventTarget;
  body: ResizeBody;
  captureTarget?: PointerCaptureTarget;
  pointerId: number;
  startX: number;
  startWidth: number;
  isRight: boolean;
  onWidth: (width: number) => void;
}): (() => void) => {
  let active = true;

  const handlePointerMove = (event: Event) => {
    const pointerEvent = event as PointerEvent;
    if (!active || pointerEvent.pointerId !== pointerId) return;
    const delta = isRight
      ? startX - pointerEvent.clientX
      : pointerEvent.clientX - startX;
    onWidth(Math.min(260, Math.max(190, startWidth + delta)));
  };

  const cleanup = () => {
    if (!active) return;
    active = false;
    windowTarget.removeEventListener('pointermove', handlePointerMove);
    windowTarget.removeEventListener('pointerup', handlePointerEnd);
    windowTarget.removeEventListener('pointercancel', handlePointerEnd);
    windowTarget.removeEventListener('blur', handleResizeInterrupted);
    windowTarget.removeEventListener('resize', handleResizeInterrupted);
    captureTarget?.removeEventListener('lostpointercapture', handleLostPointerCapture);
    try {
      if (captureTarget?.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
    } catch {
      // The handle may already be detached or have released the pointer.
    }
    body.classList.remove('is-resizing');
  };

  const handlePointerEnd = (event: Event) => {
    if ((event as PointerEvent).pointerId === pointerId) cleanup();
  };

  const handleResizeInterrupted = () => cleanup();
  const handleLostPointerCapture = () => cleanup();

  body.classList.add('is-resizing');
  windowTarget.addEventListener('pointermove', handlePointerMove);
  windowTarget.addEventListener('pointerup', handlePointerEnd);
  windowTarget.addEventListener('pointercancel', handlePointerEnd);
  windowTarget.addEventListener('blur', handleResizeInterrupted);
  windowTarget.addEventListener('resize', handleResizeInterrupted);
  captureTarget?.addEventListener('lostpointercapture', handleLostPointerCapture);

  return cleanup;
};
