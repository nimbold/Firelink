import { describe, expect, it } from 'vitest';
import {
  resolveFallbackFilter,
  shouldRestoreSidebarRevealFocus,
  shouldRestoreSidebarToggleFocus,
} from './sidebarFocus';

describe('sidebar focus restoration', () => {
  it('restores focus to reveal button when activeElement was inside the sidebar shell', () => {
    const sidebarShell = {
      contains: (el: unknown) => el === buttonInside,
    };
    const buttonInside = {
      closest: (selector: string) => (selector === '.app-sidebar-shell' ? sidebarShell : null),
    };

    expect(shouldRestoreSidebarRevealFocus(buttonInside, sidebarShell)).toBe(true);
  });

  it('does not restore focus to reveal button when activeElement was outside the sidebar shell', () => {
    const sidebarShell = {
      contains: () => false,
    };
    const tableButton = {
      closest: () => null,
    };

    expect(shouldRestoreSidebarRevealFocus(tableButton, sidebarShell)).toBe(false);
    expect(shouldRestoreSidebarRevealFocus(null, sidebarShell)).toBe(false);
  });

  it('restores focus to sidebar toggle button when reveal button was activated', () => {
    const revealButton = {
      closest: (selector: string) => (selector === '.app-sidebar-reveal-button' ? revealButton : null),
    };

    expect(shouldRestoreSidebarToggleFocus(revealButton, revealButton)).toBe(true);

    const iconInside = {
      closest: (selector: string) => (selector === '.app-sidebar-reveal-button' ? revealButton : null),
    };
    expect(shouldRestoreSidebarToggleFocus(iconInside, revealButton)).toBe(true);
  });

  it('does not restore focus to sidebar toggle button when reveal was not focused', () => {
    const revealButton = {
      closest: () => null,
    };
    const otherButton = {
      closest: () => null,
    };

    expect(shouldRestoreSidebarToggleFocus(otherButton, revealButton)).toBe(false);
    expect(shouldRestoreSidebarToggleFocus(null, revealButton)).toBe(false);
  });
});

describe('sidebar queue filter fallback', () => {
  it('falls back to all downloads when the active filtered queue is removed', () => {
    const activeFilter = 'queue:custom-queue-1';
    const remainingQueues = ['00000000-0000-0000-0000-000000000001', 'custom-queue-2'];

    expect(resolveFallbackFilter(activeFilter, remainingQueues, true)).toBe('all');
  });

  it('preserves the active filter when the filtered queue remains present', () => {
    const activeFilter = 'queue:custom-queue-1';
    const remainingQueues = ['custom-queue-1', '00000000-0000-0000-0000-000000000001'];

    expect(resolveFallbackFilter(activeFilter, remainingQueues, true)).toBe('queue:custom-queue-1');
  });

  it('preserves queue filter while queues are not yet hydrated', () => {
    const activeFilter = 'queue:custom-queue-1';

    expect(resolveFallbackFilter(activeFilter, [], false)).toBe('queue:custom-queue-1');
  });

  it('never modifies non-queue category or status filters', () => {
    expect(resolveFallbackFilter('all', [], true)).toBe('all');
    expect(resolveFallbackFilter('active', [], true)).toBe('active');
    expect(resolveFallbackFilter('completed', [], true)).toBe('completed');
    expect(resolveFallbackFilter('unfinished', [], true)).toBe('unfinished');
    expect(resolveFallbackFilter('Musics', [], true)).toBe('Musics');
  });
});
