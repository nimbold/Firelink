import { describe, expect, it } from 'vitest';
import { shouldApplySchedulerTriggerToRun } from './schedulerTrigger';

describe('scheduler trigger run fencing', () => {
  it('accepts the current or next start and rejects a stale or malformed start', () => {
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-23-start', '2026-06-23-start', '2026-06-22-start'
    )).toBe(true);
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-23-start', '2026-06-23-start', '2026-06-23-start'
    )).toBe(true);
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-22-start', '2026-06-22-start', '2026-06-23-start'
    )).toBe(false);
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-23-start', '2026-06-22-start', null
    )).toBe(false);
  });

  it('rejects a delayed start after its stop while allowing the next scheduled run', () => {
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-22-start', '2026-06-22-start', null, '2026-06-22-start'
    )).toBe(false);
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-23-start', '2026-06-23-start', null, '2026-06-22-start'
    )).toBe(true);
    expect(shouldApplySchedulerTriggerToRun(
      'start', '2026-06-22-start', '2026-06-22-start', '2026-06-22-start', '2026-06-22-start'
    )).toBe(true);
  });

  it('applies a stop only to the run that is currently active', () => {
    expect(shouldApplySchedulerTriggerToRun(
      'stop', '2026-06-23-stop', '2026-06-22-start', '2026-06-22-start'
    )).toBe(true);
    expect(shouldApplySchedulerTriggerToRun(
      'stop', '2026-06-23-stop', '2026-06-22-start', '2026-06-23-start'
    )).toBe(false);
  });
});
