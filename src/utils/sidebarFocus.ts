/**
 * Helpers for accessible focus preservation during sidebar collapse/reveal
 * and active filter recovery when queues are deleted.
 */

export type FocusableTarget = {
  contains?: (other: any) => boolean;
  closest?: (selector: string) => any;
} | null;

export const shouldRestoreSidebarRevealFocus = (
  activeElement: FocusableTarget,
  sidebarShell: FocusableTarget,
): boolean => {
  if (!activeElement || !sidebarShell) return false;
  if (typeof activeElement.closest === 'function') {
    return Boolean(activeElement.closest('.app-sidebar-shell'));
  }
  return Boolean(sidebarShell.contains?.(activeElement));
};

export const shouldRestoreSidebarToggleFocus = (
  activeElement: FocusableTarget,
  revealButton: FocusableTarget,
): boolean => {
  if (!activeElement || !revealButton) return false;
  if (activeElement === revealButton) return true;
  if (typeof activeElement.closest === 'function') {
    return Boolean(activeElement.closest('.app-sidebar-reveal-button'));
  }
  return Boolean(revealButton.contains?.(activeElement));
};

export const resolveFallbackFilter = (
  filter: string,
  availableQueueIds: Iterable<string>,
  queuesHydrated: boolean,
): string => {
  if (!filter.startsWith('queue:') || !queuesHydrated) return filter;
  const queueId = filter.slice(6);
  const queueSet = availableQueueIds instanceof Set
    ? availableQueueIds
    : new Set(availableQueueIds);
  return queueSet.has(queueId) ? filter : 'all';
};
