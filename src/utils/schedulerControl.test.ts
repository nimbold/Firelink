import { describe, expect, it } from 'vitest';
import {
  beginSchedulerControl,
  consumeSchedulerHandoffIds,
  handoffSupersededSchedulerIds,
  isSchedulerControlCurrent
} from './schedulerControl';

describe('scheduler control generation', () => {
  it('invalidates an older asynchronous scheduler operation', () => {
    const first = beginSchedulerControl();
    expect(isSchedulerControlCurrent(first)).toBe(true);

    const second = beginSchedulerControl();
    expect(isSchedulerControlCurrent(first)).toBe(false);
    expect(isSchedulerControlCurrent(second)).toBe(true);
  });

  it('hands superseded starts to a newer run for the same queue', () => {
    const first = beginSchedulerControl(['queue-a']);
    const second = beginSchedulerControl(['queue-a']);

    expect(handoffSupersededSchedulerIds(['download-a', 'download-b'], id => (
      id === 'download-a' ? 'queue-a' : 'queue-b'
    ))).toEqual(new Set(['download-a']));
    expect(consumeSchedulerHandoffIds(second)).toEqual(new Set(['download-a']));
    expect(consumeSchedulerHandoffIds(first)).toEqual(new Set());
  });

  it('does not hand work to a superseding pause control', () => {
    beginSchedulerControl(['queue-a']);
    const pause = beginSchedulerControl();

    expect(handoffSupersededSchedulerIds(['download-a'], () => 'queue-a')).toEqual(new Set());
    expect(consumeSchedulerHandoffIds(pause)).toEqual(new Set());
  });
});
