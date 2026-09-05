import { describe, expect, it, vi } from 'vitest';
import { subscribeToWindowMaximized, type WindowMaximizedSource } from './windowMaximized';

type WindowStateDisposer = () => void | Promise<void>;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

describe('window maximized state', () => {
  it('reads state immediately and again after listener registration closes the startup gap', async () => {
    const onChange = vi.fn();
    const source: WindowMaximizedSource = {
      isMaximized: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      listenResized: vi.fn(async () => vi.fn()),
    };

    const dispose = subscribeToWindowMaximized(source, onChange);

    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(true));
    expect(source.isMaximized).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('keeps the newest resize state when native reads resolve out of order', async () => {
    const initial = deferred<boolean>();
    const maximized = deferred<boolean>();
    const restored = deferred<boolean>();
    let onResize: (() => void) | undefined;
    const onChange = vi.fn();
    const source: WindowMaximizedSource = {
      isMaximized: vi.fn()
        .mockReturnValueOnce(initial.promise)
        .mockReturnValueOnce(maximized.promise)
        .mockReturnValueOnce(restored.promise)
        .mockResolvedValue(false),
      listenResized: vi.fn(async listener => {
        onResize = listener;
        return vi.fn();
      }),
    };

    const dispose = subscribeToWindowMaximized(source, onChange);
    await vi.waitFor(() => expect(source.isMaximized).toHaveBeenCalledTimes(2));
    onResize?.();
    expect(source.isMaximized).toHaveBeenCalledTimes(3);

    restored.resolve(false);
    maximized.resolve(true);
    initial.resolve(false);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(false));

    expect(onChange).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('disposes a listener that finishes registering after unmount and ignores late state', async () => {
    const registration = deferred<WindowStateDisposer>();
    const state = deferred<boolean>();
    const disposer = vi.fn();
    const onChange = vi.fn();
    const source: WindowMaximizedSource = {
      isMaximized: () => state.promise,
      listenResized: () => registration.promise,
    };

    const dispose = subscribeToWindowMaximized(source, onChange);
    dispose();
    registration.resolve(disposer);
    state.resolve(true);

    await vi.waitFor(() => expect(disposer).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives synchronous native state and listener failures', () => {
    const source: WindowMaximizedSource = {
      isMaximized: () => { throw new Error('state unavailable'); },
      listenResized: () => { throw new Error('listener unavailable'); },
    };

    expect(() => subscribeToWindowMaximized(source, vi.fn())()).not.toThrow();
  });
});
