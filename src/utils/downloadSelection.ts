export interface DownloadSelectionResult {
  selectedIds: Set<string>;
  lastSelectedId: string | null;
}

interface DownloadSelectionOptions {
  orderedIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  lastSelectedId: string | null;
  targetId: string;
  extendRange: boolean;
  toggle: boolean;
}

/** Apply the table's click-selection rules without depending on React state timing. */
export const updateDownloadSelection = ({
  orderedIds,
  selectedIds,
  lastSelectedId,
  targetId,
  extendRange,
  toggle,
}: DownloadSelectionOptions): DownloadSelectionResult => {
  const targetIndex = orderedIds.indexOf(targetId);
  if (targetIndex === -1) {
    return { selectedIds: new Set(selectedIds), lastSelectedId };
  }

  if (extendRange && lastSelectedId) {
    const anchorIndex = orderedIds.indexOf(lastSelectedId);
    if (anchorIndex !== -1) {
      const nextSelectedIds = toggle ? new Set(selectedIds) : new Set<string>();
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      for (let index = start; index <= end; index += 1) {
        nextSelectedIds.add(orderedIds[index]);
      }
      return { selectedIds: nextSelectedIds, lastSelectedId };
    }
  }

  if (toggle) {
    const nextSelectedIds = new Set(selectedIds);
    if (nextSelectedIds.has(targetId)) {
      nextSelectedIds.delete(targetId);
    } else {
      nextSelectedIds.add(targetId);
    }
    return { selectedIds: nextSelectedIds, lastSelectedId: targetId };
  }

  return { selectedIds: new Set([targetId]), lastSelectedId: targetId };
};
