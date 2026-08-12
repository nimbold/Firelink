let schedulerControlGeneration = 0;

/**
 * Start a new scheduler control lifecycle. A later manual pause or scheduler
 * event invalidates earlier asynchronous queue operations before they can
 * publish stale running state.
 */
export const beginSchedulerControl = (): number => {
  schedulerControlGeneration += 1;
  return schedulerControlGeneration;
};

export const isSchedulerControlCurrent = (generation: number): boolean =>
  schedulerControlGeneration === generation;
