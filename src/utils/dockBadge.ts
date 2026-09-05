import { invokeCommand } from '../ipc';

let dockBadgeGeneration = 0;
let dockBadgeSessionRequest: Promise<number> | null = null;

export const resetDockBadgeStateForTests = (): void => {
  dockBadgeGeneration = 0;
  dockBadgeSessionRequest = null;
};

const getDockBadgeSession = (): Promise<number> => {
  if (!dockBadgeSessionRequest) {
    const request = invokeCommand('begin_dock_badge_session');
    dockBadgeSessionRequest = request.catch(error => {
      dockBadgeSessionRequest = null;
      throw error;
    });
  }
  return dockBadgeSessionRequest;
};

/**
 * Attach the backend session and a per-session generation to every badge
 * update so stale main-thread callbacks cannot overwrite a newer session.
 */
export const updateDockBadge = async (count: number): Promise<void> => {
  const session = await getDockBadgeSession();
  const generation = ++dockBadgeGeneration;
  await invokeCommand('update_dock_badge', { count, generation, session });
};
