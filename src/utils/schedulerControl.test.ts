import { describe, expect, it } from 'vitest';
import { beginSchedulerControl, isSchedulerControlCurrent } from './schedulerControl';

describe('scheduler control generation', () => {
  it('invalidates an older asynchronous scheduler operation', () => {
    const first = beginSchedulerControl();
    expect(isSchedulerControlCurrent(first)).toBe(true);

    const second = beginSchedulerControl();
    expect(isSchedulerControlCurrent(first)).toBe(false);
    expect(isSchedulerControlCurrent(second)).toBe(true);
  });
});
