let schedulerControlGeneration = 0;
let latestRunQueueIds: ReadonlySet<string> | null = null;
const schedulerHandoffs = new Map<number, Set<string>>();

/**
 * Start a new scheduler control lifecycle. A later manual pause or scheduler
 * event invalidates earlier asynchronous queue operations before they can
 * publish stale running state.
 */
export const beginSchedulerControl = (runQueueIds?: readonly string[]): number => {
  schedulerControlGeneration += 1;
  latestRunQueueIds = runQueueIds ? new Set(runQueueIds) : null;
  schedulerHandoffs.clear();
  if (runQueueIds) schedulerHandoffs.set(schedulerControlGeneration, new Set());
  return schedulerControlGeneration;
};

export const isSchedulerControlCurrent = (generation: number): boolean =>
  schedulerControlGeneration === generation;

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
