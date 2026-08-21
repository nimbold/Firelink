import { describe, expect, it, vi } from 'vitest';
import { createSidebarResizeSession } from './sidebarResize';

const createEventTarget = () => {
  const listeners = new Map<string, Set<EventListener>>();
  const target = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener);
      listeners.set(type, current);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
  };
  return {
    target,
    dispatch: (type: string, event: Partial<PointerEvent> = {}) => {
      listeners.get(type)?.forEach(listener => listener(event as Event));
    },
  };
};

describe('sidebar resize session', () => {
  it('ignores other pointers and clamps the active pointer width', () => {
    const eventTarget = createEventTarget();
    const classes = new Set<string>();
    const onWidth = vi.fn();
    const classList = {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
    } as unknown as DOMTokenList;
    const cleanup = createSidebarResizeSession({
      windowTarget: eventTarget.target,
      body: { classList },
      pointerId: 7,
      startX: 100,
      startWidth: 220,
      isRight: false,
      onWidth,
    });

    expect(classes.has('is-resizing')).toBe(true);
    eventTarget.dispatch('pointermove', { pointerId: 8, clientX: 1 });
    eventTarget.dispatch('pointermove', { pointerId: 7, clientX: 1 });
    expect(onWidth).toHaveBeenLastCalledWith(190);

    eventTarget.dispatch('pointermove', { pointerId: 7, clientX: 1000 });
    expect(onWidth).toHaveBeenLastCalledWith(260);
    cleanup();
  });

  it('cleans global state on cancellation and makes cleanup idempotent', () => {
    const eventTarget = createEventTarget();
    const classes = new Set<string>();
    const classList = {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
    } as unknown as DOMTokenList;
    const cleanup = createSidebarResizeSession({
      windowTarget: eventTarget.target,
      body: { classList },
      pointerId: 3,
      startX: 100,
      startWidth: 220,
      isRight: true,
      onWidth: vi.fn(),
    });

    eventTarget.dispatch('pointercancel', { pointerId: 3 });
    expect(classes.has('is-resizing')).toBe(false);
    expect(eventTarget.target.removeEventListener).toHaveBeenCalledTimes(5);
    cleanup();
    expect(eventTarget.target.removeEventListener).toHaveBeenCalledTimes(5);
  });
});
