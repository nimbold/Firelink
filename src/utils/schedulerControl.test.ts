import { describe, expect, it } from 'vitest';
import {
  beginSchedulerControl,
  cancelPendingPostAction,
  consumeSchedulerHandoffIds,
  handoffSupersededSchedulerIds,
  isSchedulerControlCurrent,
  registerPostActionCanceller,
  resolveSchedulerStopOutcome
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

  it('retains failed pauses and any still-active download for a scheduler stop retry', () => {
    expect(resolveSchedulerStopOutcome({
      controlCurrent: true,
      attemptedIds: ['paused', 'failed-active', 'failed-paused-in-memory', 'resolved-but-active'],
      failedIds: new Set(['failed-active', 'failed-paused-in-memory']),
      activeIds: new Set(['failed-active', 'resolved-but-active']),
      currentTrackedIds: ['newer-control-id']
    })).toEqual({
      trackedIds: ['failed-active', 'failed-paused-in-memory', 'resolved-but-active'],
      retryIds: ['failed-active', 'failed-paused-in-memory', 'resolved-but-active'],
      acknowledge: false
    });
  });

  it('preserves newer scheduler tracking when a stop was superseded', () => {
    expect(resolveSchedulerStopOutcome({
      controlCurrent: false,
      attemptedIds: ['old-id'],
      failedIds: new Set(['old-id']),
      activeIds: new Set(['old-id']),
      currentTrackedIds: ['new-id', 'new-id']
    })).toEqual({
      trackedIds: ['new-id'],
      retryIds: [],
      acknowledge: true
    });
  });

  it('cancels pending post actions when a new control generation begins', () => {
    let cancelled = 0;
    const unregister = registerPostActionCanceller(() => {
      cancelled += 1;
    });

    beginSchedulerControl();
    expect(cancelled).toBe(1);

    cancelPendingPostAction();
    expect(cancelled).toBe(2);

    unregister();
    beginSchedulerControl();
    expect(cancelled).toBe(2);
  });
});
