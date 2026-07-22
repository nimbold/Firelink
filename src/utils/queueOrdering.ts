export interface QueueOrderItem {
  id: string;
}

/**
 * Move the selected rows as one block into an insertion position among the
 * unselected rows. The position is intentionally defined after selection is
 * removed so callers can use the same semantics for UI and backend queues.
 */
export const moveSelectedBlockToIndex = <T extends QueueOrderItem>(
  items: T[],
  selectedIds: ReadonlySet<string> | readonly string[],
  targetIndex: number
): T[] => {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const selectedItems = items.filter(item => selected.has(item.id));
  const unselectedItems = items.filter(item => !selected.has(item.id));
  const insertionIndex = Math.max(0, Math.min(targetIndex, unselectedItems.length));

  return [
    ...unselectedItems.slice(0, insertionIndex),
    ...selectedItems,
    ...unselectedItems.slice(insertionIndex)
  ];
};

/**
 * Convert a pointer boundary in the original list to the insertion index
 * used by moveSelectedBlockToIndex. A boundary is between rows and ranges
 * from 0 (before the first row) through items.length (after the last row).
 */
export const targetIndexForBoundary = <T extends QueueOrderItem>(
  items: T[],
  selectedIds: ReadonlySet<string> | readonly string[],
  boundaryIndex: number
): number => {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const boundary = Math.max(0, Math.min(boundaryIndex, items.length));
  return items
    .slice(0, boundary)
    .reduce((count, item) => count + (selected.has(item.id) ? 0 : 1), 0);
};

/**
 * Translate a desired local order to the backend's registered-only queue.
 * Staged rows are not registered with the backend, so they must not affect
 * the target index sent over IPC.
 */
export const targetIndexForDesiredOrder = <T extends QueueOrderItem>(
  currentItems: T[],
  selectedIds: ReadonlySet<string> | readonly string[],
  desiredItems: T[]
): number => {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const currentIds = new Set(currentItems.map(item => item.id));
  const firstSelectedIndex = desiredItems.findIndex(item => selected.has(item.id));
  if (firstSelectedIndex === -1) return currentItems.filter(item => !selected.has(item.id)).length;
  return desiredItems
    .slice(0, firstSelectedIndex)
    .reduce((count, item) => count + (selected.has(item.id) || !currentIds.has(item.id) ? 0 : 1), 0);
};
