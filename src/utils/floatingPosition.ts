export interface FloatingPosition {
  x: number;
  y: number;
}

export type FloatingSubmenuSide = 'left' | 'right';

export interface FloatingSubmenuPosition extends FloatingPosition {
  side: FloatingSubmenuSide;
}

/** Keep a fixed-position surface inside the viewport with a small safe gutter. */
export const clampFloatingPosition = (
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  gutter = 8
): FloatingPosition => {
  const maxX = Math.max(gutter, viewportWidth - width - gutter);
  const maxY = Math.max(gutter, viewportHeight - height - gutter);

  return {
    x: Math.min(Math.max(gutter, x), maxX),
    y: Math.min(Math.max(gutter, y), maxY),
  };
};

/** Place a submenu beside its trigger, flipping sides before clamping to the viewport. */
export const positionFloatingSubmenu = (
  trigger: Pick<DOMRect, 'left' | 'right' | 'top'>,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  gutter = 8,
  gap = 4,
  preferredSide: FloatingSubmenuSide = 'right'
): FloatingSubmenuPosition => {
  const rightX = trigger.right + gap;
  const leftX = trigger.left - width - gap;
  const rightFits = rightX + width <= viewportWidth - gutter;
  const leftFits = leftX >= gutter;
  const preferredFits = preferredSide === 'right' ? rightFits : leftFits;
  const alternateFits = preferredSide === 'right' ? leftFits : rightFits;
  const side = preferredFits || !alternateFits
    ? preferredSide
    : preferredSide === 'right' ? 'left' : 'right';
  const preferredX = side === 'right' ? rightX : leftX;
  const position = clampFloatingPosition(
    preferredX,
    trigger.top,
    width,
    height,
    viewportWidth,
    viewportHeight,
    gutter
  );

  return { ...position, side };
};
