let schedulerControlGeneration = 0;
let latestRunQueueIds: ReadonlySet<string> | null = null;
const schedulerHandoffs = new Map<number, Set<string>>();

let postActionCanceller: (() => void) | null = null;

export const registerPostActionCanceller = (canceller: () => void): (() => void) => {
  postActionCanceller = canceller;
  return () => {
    if (postActionCanceller === canceller) {
      postActionCanceller = null;
    }
  };
};

export const cancelPendingPostAction = (): void => {
  postActionCanceller?.();
};

/**
 * Start a new scheduler control lifecycle. A later manual pause or scheduler
 * event invalidates earlier asynchronous queue operations before they can
 * publish stale running state, and cancels any pending post-queue action.
 */
export const beginSchedulerControl = (runQueueIds?: readonly string[]): number => {
  schedulerControlGeneration += 1;
  latestRunQueueIds = runQueueIds ? new Set(runQueueIds) : null;
  schedulerHandoffs.clear();
  if (runQueueIds) schedulerHandoffs.set(schedulerControlGeneration, new Set());
  postActionCanceller?.();
  return schedulerControlGeneration;
};

export const isSchedulerControlCurrent = (generation: number): boolean =>
  schedulerControlGeneration === generation;

export const resolveSchedulerStopOutcome = (input: {
  controlCurrent: boolean;
  attemptedIds: readonly string[];
  failedIds: ReadonlySet<string>;
  activeIds: ReadonlySet<string>;
  currentTrackedIds: readonly string[];
}): { trackedIds: string[]; retryIds: string[]; acknowledge: boolean } => {
  if (!input.controlCurrent) {
    return {
      trackedIds: [...new Set(input.currentTrackedIds)],
      retryIds: [],
      acknowledge: true
    };
  }

  // A rejected pause is not safe to drop just because React already shows a
  // paused/terminal state: pauseDownload can reject after changing the
  // in-memory row when its durable download-state commit fails. Keep every
  // rejected target tracked so the native stop trigger remains retryable
  // until a later pause commits successfully. Also retain any target that is
  // still active even if its pause promise resolved without taking ownership
  // of a newer lifecycle.
  const trackedIds = [...new Set(input.attemptedIds.filter(id =>
    input.failedIds.has(id) || input.activeIds.has(id)
  ))];
  return {
    trackedIds,
    retryIds: trackedIds,
    acknowledge: trackedIds.length === 0
  };
};

/**
 * A superseded start may have admitted work before a newer start reached the
 * same queue. Hand the IDs to that newer start instead of pausing its work.
 * A stop/manual control has no run intent and therefore receives no handoff.
 */
export const handoffSupersededSchedulerIds = (
  ids: readonly string[],
  queueIdForId: (id: string) => string | undefined,
): ReadonlySet<string> => {
  if (!latestRunQueueIds || schedulerControlGeneration === 0) return new Set();
  const handoff = schedulerHandoffs.get(schedulerControlGeneration);
  if (!handoff) return new Set();

  for (const id of ids) {
    const queueId = queueIdForId(id);
    if (queueId && latestRunQueueIds.has(queueId)) handoff.add(id);
  }
  return new Set(handoff);
};

export const consumeSchedulerHandoffIds = (generation: number): ReadonlySet<string> => {
  if (!isSchedulerControlCurrent(generation)) return new Set();
  const handoff = schedulerHandoffs.get(generation) ?? new Set<string>();
  schedulerHandoffs.delete(generation);
  return new Set(handoff);
};
