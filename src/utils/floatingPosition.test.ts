import { describe, expect, it } from 'vitest';
import { clampFloatingPosition, isFloatingSubmenuCloseKey, positionFloatingSubmenu } from './floatingPosition';

describe('floating surface positioning', () => {
  it('uses the physical back arrow for submenu dismissal in each direction', () => {
    expect(isFloatingSubmenuCloseKey('ArrowLeft', false)).toBe(true);
    expect(isFloatingSubmenuCloseKey('ArrowRight', false)).toBe(false);
    expect(isFloatingSubmenuCloseKey('ArrowRight', true)).toBe(true);
    expect(isFloatingSubmenuCloseKey('ArrowLeft', true)).toBe(false);
    expect(isFloatingSubmenuCloseKey('Escape', true)).toBe(true);
  });

  it('keeps a variable-height menu inside the viewport', () => {
    expect(clampFloatingPosition(350, 580, 192, 220, 400, 640)).toEqual({
      x: 200,
      y: 412,
    });
  });

  it('keeps oversized surfaces anchored to the safe gutter', () => {
    expect(clampFloatingPosition(-20, -10, 700, 900, 400, 640)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it('opens a submenu to the right when there is room', () => {
    expect(positionFloatingSubmenu({ left: 200, right: 280, top: 120 }, 160, 180, 800, 600)).toEqual({
      x: 284,
      y: 120,
      side: 'right',
    });
  });

  it('flips a submenu to the left at the viewport edge', () => {
    expect(positionFloatingSubmenu({ left: 700, right: 780, top: 120 }, 160, 180, 800, 600)).toEqual({
      x: 536,
      y: 120,
      side: 'left',
    });
  });

  it('clamps a submenu vertically when its trigger is near the bottom', () => {
    expect(positionFloatingSubmenu({ left: 200, right: 280, top: 580 }, 160, 180, 800, 600)).toEqual({
      x: 284,
      y: 412,
      side: 'right',
    });
  });

  it('prefers the inline-start side in RTL when both sides fit', () => {
    expect(positionFloatingSubmenu({ left: 400, right: 480, top: 120 }, 160, 180, 800, 600, 8, 4, 'left')).toEqual({
      x: 236,
      y: 120,
      side: 'left',
    });
  });
});
