export const shouldApplySchedulerTriggerToRun = (
  action: 'start' | 'stop',
  key: string,
  runKey: string,
  activeRunKey: string | null,
  latestRunKey: string | null = activeRunKey,
): boolean => {
  if (action === 'start') {
    return key === runKey && (
      activeRunKey === runKey
      || (activeRunKey !== null && runKey > activeRunKey)
      || (activeRunKey === null && (latestRunKey === null || runKey > latestRunKey))
    );
  }
  return runKey === activeRunKey;
};
