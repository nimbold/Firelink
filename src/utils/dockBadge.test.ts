import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '../ipc';
import { resetDockBadgeStateForTests, updateDockBadge } from './dockBadge';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn()
}));

describe('dock badge synchronization', () => {
  beforeEach(() => {
    resetDockBadgeStateForTests();
    vi.clearAllMocks();
    vi.mocked(ipc.invokeCommand).mockImplementation(async command => (
      command === 'begin_dock_badge_session' ? 1 : undefined
    ));
  });

  it('attaches increasing generations to concurrent updates', async () => {
    await Promise.all([updateDockBadge(3), updateDockBadge(0)]);

    const calls = vi.mocked(ipc.invokeCommand).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(['begin_dock_badge_session']);
    const badgeCalls = calls.slice(1);
    expect(badgeCalls[0]).toEqual([
      'update_dock_badge',
      { count: 3, generation: expect.any(Number), session: 1 }
    ]);
    expect(badgeCalls[1]).toEqual([
      'update_dock_badge',
      { count: 0, generation: expect.any(Number), session: 1 }
    ]);
    const firstBadgeArgs = badgeCalls[0][1] as { generation: number };
    const secondBadgeArgs = badgeCalls[1][1] as { generation: number };
    expect(secondBadgeArgs.generation).toBe(firstBadgeArgs.generation + 1);
  });
});
