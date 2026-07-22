import { describe, expect, it } from 'vitest';
import {
  moveSelectedBlockToIndex,
  targetIndexForBoundary,
  targetIndexForDesiredOrder
} from './queueOrdering';

const items = ['a', 'b', 'c', 'd'].map(id => ({ id }));

describe('queue ordering', () => {
  it('moves discontiguous selection as one block', () => {
    expect(moveSelectedBlockToIndex(items, ['b', 'd'], 1).map(item => item.id))
      .toEqual(['a', 'b', 'd', 'c']);
  });

  it('translates pointer boundaries after selected rows are removed', () => {
    expect(targetIndexForBoundary(items, ['b', 'd'], 2)).toBe(1);
    expect(targetIndexForBoundary(items, ['b', 'd'], 3)).toBe(2);
  });

  it('computes a registered-only backend target from the desired local order', () => {
    const current = [{ id: 'a' }, { id: 'staged' }, { id: 'b' }, { id: 'c' }];
    const desired = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'staged' }];
    expect(targetIndexForDesiredOrder(current, ['c'], desired)).toBe(2);

    expect(targetIndexForDesiredOrder(
      [{ id: 'a' }, { id: 'c' }],
      ['c'],
      [{ id: 'a' }, { id: 'staged' }, { id: 'c' }]
    )).toBe(1);
  });
});
