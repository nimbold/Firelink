import { describe, expect, it, vi } from 'vitest';
import { createColumnResizeSession } from './columnResize';

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

describe('column resize session', () => {
  it('ignores other pointers, clamps the active pointer, and persists on completion', () => {
    const windowTarget = createEventTarget();
    const documentTarget = createEventTarget();
    const classes = new Set<string>();
    const onWidth = vi.fn();
    const onEnd = vi.fn();
    const classList = {
      add: (value: string) => classes.add(value),
      remove: (value: string) => classes.delete(value),
    } as unknown as DOMTokenList;
    createColumnResizeSession({
      windowTarget: windowTarget.target,
      documentTarget: documentTarget.target,
      body: { classList },
      pointerId: 7,
      startX: 100,
      startWidth: 220,
      minWidth: 92,
      onWidth,
      onEnd,
    });

    expect(classes.has('is-column-resizing')).toBe(true);
    windowTarget.dispatch('pointermove', { pointerId: 8, clientX: 1 });
    expect(onWidth).not.toHaveBeenCalled();
    windowTarget.dispatch('pointermove', { pointerId: 7, clientX: 1 });
    expect(onWidth).toHaveBeenLastCalledWith(121);
    windowTarget.dispatch('pointermove', { pointerId: 7, clientX: 1000 });
    expect(onWidth).toHaveBeenLastCalledWith(1120);

    windowTarget.dispatch('pointerup', { pointerId: 8 });
    expect(classes.has('is-column-resizing')).toBe(true);
    windowTarget.dispatch('pointerup', { pointerId: 7 });
    expect(classes.has('is-column-resizing')).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('cleans up on visibility interruption and makes cleanup idempotent', () => {
    const windowTarget = createEventTarget();
    const documentTarget = createEventTarget();
    const classList = {
      add: vi.fn(),
      remove: vi.fn(),
    } as unknown as DOMTokenList;
    const cleanup = createColumnResizeSession({
      windowTarget: windowTarget.target,
      documentTarget: documentTarget.target,
      body: { classList },
      pointerId: 3,
      startX: 100,
      startWidth: 220,
      minWidth: 92,
      onWidth: vi.fn(),
    });

    documentTarget.dispatch('visibilitychange');
    expect(classList.remove).toHaveBeenCalledWith('is-column-resizing');
    cleanup();
    expect(classList.remove).toHaveBeenCalledTimes(1);
  });
});
