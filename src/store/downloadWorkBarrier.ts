type WorkWaiter = () => void;

const activeWork = new Set<symbol>();
const idleWaiters = new Set<WorkWaiter>();
let admissionOpen = true;

const notifyIfIdle = (): void => {
  if (activeWork.size !== 0) return;
  const waiters = [...idleWaiters];
  idleWaiters.clear();
  waiters.forEach(resolve => resolve());
};

/** Begin an async operation that can create or replace a durable download row. */
export const beginDownloadWork = (): (() => void) | null => {
  if (!admissionOpen) return null;
  const token = Symbol('download-work');
  activeWork.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWork.delete(token);
    notifyIfIdle();
  };
};

/** Stop new Add-window transactions while the app is preparing to exit. */
export const closeDownloadWorkAdmission = (): void => {
  admissionOpen = false;
};

export const reopenDownloadWorkAdmission = (): void => {
  admissionOpen = true;
};

export const waitForPendingDownloadWork = async (): Promise<void> => {
  while (activeWork.size > 0) {
    await new Promise<void>(resolve => idleWaiters.add(resolve));
  }
};

export const resetDownloadWorkBarrierForTests = (): void => {
  activeWork.clear();
  admissionOpen = true;
  notifyIfIdle();
};
