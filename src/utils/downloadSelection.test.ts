import { describe, expect, it } from 'vitest';
import { updateDownloadSelection } from './downloadSelection';

const orderedIds = ['a', 'b', 'c', 'd'];

describe('download selection', () => {
  it('collapses select-all to the clicked row', () => {
    const result = updateDownloadSelection({
      orderedIds,
      selectedIds: new Set(orderedIds),
      lastSelectedId: 'd',
      targetId: 'b',
      extendRange: false,
      toggle: false,
    });

    expect([...result.selectedIds]).toEqual(['b']);
    expect(result.lastSelectedId).toBe('b');
  });

  it('toggles a row without losing the rest of the selection', () => {
    const result = updateDownloadSelection({
      orderedIds,
      selectedIds: new Set(['a', 'c']),
      lastSelectedId: 'a',
      targetId: 'c',
      extendRange: false,
      toggle: true,
    });

    expect([...result.selectedIds]).toEqual(['a']);
  });

  it('extends from the existing anchor for a range selection', () => {
    const result = updateDownloadSelection({
      orderedIds,
      selectedIds: new Set(['a']),
      lastSelectedId: 'a',
      targetId: 'c',
      extendRange: true,
      toggle: false,
    });

    expect([...result.selectedIds]).toEqual(['a', 'b', 'c']);
    expect(result.lastSelectedId).toBe('a');
  });
});
