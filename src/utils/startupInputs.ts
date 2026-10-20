export type StartupInput = { type: string };

/**
 * Deep links wait for the OS-backed start-at-login read to finish, but must
 * remain queued while it is in flight. A failed read is still settled: it
 * must not strand an OS-delivered link until another window-focus retry.
 * Extension inputs do not depend on that state and can be drained when no
 * earlier deep link would be overtaken.
 */
export const takeSettledStartupInputs = <T extends StartupInput>(
  pendingInputs: T[],
  startAtLoginSettled: boolean
): T[] | null => {
  if (!startAtLoginSettled && pendingInputs.some(input => input.type === 'deep-link')) {
    return null;
  }
  return pendingInputs.splice(0);
};
