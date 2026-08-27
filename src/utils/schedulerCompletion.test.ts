import { describe, expect, it } from 'vitest';
import type { DownloadItem } from '../bindings/DownloadItem';
import { schedulerCompletionState } from './schedulerCompletion';

const download = (id: string, status: DownloadItem['status']): DownloadItem => ({
  id,
  url: `https://example.com/${id}`,
  fileName: `${id}.bin`,
  status,
  size: '0 B',
  category: 'Other',
  dateAdded: new Date().toISOString(),
  destination: '/tmp',
  queueId: 'queue',
});

describe('schedulerCompletionState', () => {
  it('stays active while any tracked scheduler download can still progress', () => {
    expect(schedulerCompletionState([
      download('a', 'completed'),
      download('b', 'retrying'),
    ], ['a', 'b'])).toBe('active');
  });

  it('completes only when every tracked scheduler download completed', () => {
    expect(schedulerCompletionState([
      download('a', 'completed'),
      download('b', 'completed'),
    ], ['a', 'b'])).toBe('completed');
  });

  it('treats failed or missing tracked downloads as incomplete', () => {
    expect(schedulerCompletionState([
      download('a', 'completed'),
      download('b', 'failed'),
    ], ['a', 'b'])).toBe('incomplete');

    expect(schedulerCompletionState([
      download('a', 'completed'),
    ], ['a', 'missing'])).toBe('incomplete');
  });
});
