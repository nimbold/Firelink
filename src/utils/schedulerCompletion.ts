import type { DownloadItem } from '../bindings/DownloadItem';
import { isActiveDownloadStatus } from './downloads';

export type SchedulerCompletionState = 'active' | 'completed' | 'incomplete';

export const schedulerCompletionState = (
  downloads: DownloadItem[],
  schedulerActiveDownloadIds: string[],
): SchedulerCompletionState => {
  const scheduledItems = schedulerActiveDownloadIds.map(id =>
    downloads.find(download => download.id === id)
  );

  if (scheduledItems.some(item => item && isActiveDownloadStatus(item.status))) {
    return 'active';
  }

  return scheduledItems.every(item => item?.status === 'completed')
    ? 'completed'
    : 'incomplete';
};
