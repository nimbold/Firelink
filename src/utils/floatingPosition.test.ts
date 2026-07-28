import { describe, expect, it } from 'vitest';
import { clampFloatingPosition } from './floatingPosition';

describe('floating surface positioning', () => {
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
});
