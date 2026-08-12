import { describe, expect, it } from 'vitest';
import { createSerialTaskQueue } from './serialTaskQueue';

describe('createSerialTaskQueue', () => {
  it('runs tasks in enqueue order and waits for each previous task', async () => {
    const queue = createSerialTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = queue(async () => {
      events.push('first-start');
      await firstReleased;
      events.push('first-end');
    });
    const second = queue(async () => {
      events.push('second');
    });

    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('continues with later tasks after a failed task', async () => {
    const queue = createSerialTaskQueue();
    const events: string[] = [];

    const failed = queue(async () => {
      events.push('failed');
      throw new Error('expected failure');
    });
    const continued = queue(async () => {
      events.push('continued');
    });

    await expect(failed).rejects.toThrow('expected failure');
    await expect(continued).resolves.toBeUndefined();
    expect(events).toEqual(['failed', 'continued']);
  });
});
