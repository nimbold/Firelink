export interface FloatingPosition {
  x: number;
  y: number;
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
