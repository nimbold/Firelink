import { describe, expect, it, vi } from 'vitest';
import { getInitialWindowFocus, subscribeToWindowFocus } from './windowFocus';

const fakeWindow = (initialFocus: boolean) => {
  let focused = initialFocus;
  const focusListeners = new Set<() => void>();
  const blurListeners = new Set<() => void>();
  const source = {
    hasFocus: () => focused,
    listenFocus: vi.fn(async (listener: () => void) => {
      focusListeners.add(listener);
      return () => {
        focusListeners.delete(listener);
      };
    }),
    listenBlur: vi.fn(async (listener: () => void) => {
      blurListeners.add(listener);
      return () => {
        blurListeners.delete(listener);
      };
    }),
  };

  return {
    source,
    listenerCount: () => focusListeners.size + blurListeners.size,
    dispatch: (active: boolean) => {
      focused = active;
      const listeners = active ? focusListeners : blurListeners;
      listeners.forEach(listener => listener());
    },
  };
};

describe('window focus state', () => {
  it('reads the renderer focus state and defaults active when it is unavailable', () => {
    expect(getInitialWindowFocus(fakeWindow(true).source)).toBe(true);
    expect(getInitialWindowFocus(fakeWindow(false).source)).toBe(false);
    expect(getInitialWindowFocus({
      ...fakeWindow(false).source,
      hasFocus: () => { throw new Error('unavailable'); },
    })).toBe(true);
  });

  it('reports native focus transitions after reconciling listener setup', async () => {
    const fixture = fakeWindow(false);
    const onChange = vi.fn();
    const dispose = subscribeToWindowFocus(fixture.source, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(false));
    expect(fixture.listenerCount()).toBe(2);
    onChange.mockClear();

    fixture.dispatch(true);
    fixture.dispatch(false);

    expect(onChange.mock.calls).toEqual([[true], [false]]);
    dispose();
    expect(fixture.listenerCount()).toBe(0);
  });

  it('does not overwrite a native setup event with a stale renderer focus read', async () => {
    let resolveFocusRegistration: ((dispose: () => void) => void) | undefined;
    let resolveBlurRegistration: ((dispose: () => void) => void) | undefined;
    let blurListener: (() => void) | undefined;
    const onChange = vi.fn();
    const source = {
      hasFocus: () => true,
      listenFocus: () => new Promise<() => void>(resolve => {
        resolveFocusRegistration = resolve;
      }),
      listenBlur: (listener: () => void) => {
        blurListener = listener;
        return new Promise<() => void>(resolve => {
          resolveBlurRegistration = resolve;
        });
      },
    };

    const dispose = subscribeToWindowFocus(source, onChange);
    blurListener?.();
    resolveFocusRegistration?.(() => undefined);
    resolveBlurRegistration?.(() => undefined);

    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
    expect(onChange.mock.calls).toEqual([[false]]);
    dispose();
  });

  it('cleans up every listener across a StrictMode-style remount', async () => {
    const fixture = fakeWindow(true);
    const firstListener = vi.fn();
    const secondListener = vi.fn();

    const disposeFirst = subscribeToWindowFocus(fixture.source, firstListener);
    await vi.waitFor(() => expect(firstListener).toHaveBeenCalledWith(true));
    expect(fixture.listenerCount()).toBe(2);
    disposeFirst();
    expect(fixture.listenerCount()).toBe(0);

    const disposeSecond = subscribeToWindowFocus(fixture.source, secondListener);
    await vi.waitFor(() => expect(secondListener).toHaveBeenCalledWith(true));
    expect(fixture.listenerCount()).toBe(2);
    firstListener.mockClear();
    secondListener.mockClear();
    fixture.dispatch(false);
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledWith(false);
    disposeSecond();
    expect(fixture.listenerCount()).toBe(0);
  });

  it('disposes both listeners when they resolve after teardown', async () => {
    let resolveFocusRegistration: ((dispose: () => void) => void) | undefined;
    let resolveBlurRegistration: ((dispose: () => void) => void) | undefined;
    let blurListener: (() => void) | undefined;
    const disposeFocus = vi.fn();
    const disposeBlur = vi.fn();
    const onChange = vi.fn();
    const source = {
      hasFocus: () => true,
      listenFocus: () => new Promise<() => void>(resolve => {
        resolveFocusRegistration = resolve;
      }),
      listenBlur: (listener: () => void) => {
        blurListener = listener;
        return new Promise<() => void>(resolve => {
          resolveBlurRegistration = resolve;
        });
      },
    };

    const dispose = subscribeToWindowFocus(source, onChange);
    dispose();
    blurListener?.();
    resolveFocusRegistration?.(disposeFocus);
    resolveBlurRegistration?.(disposeBlur);

    await vi.waitFor(() => {
      expect(disposeFocus).toHaveBeenCalledOnce();
      expect(disposeBlur).toHaveBeenCalledOnce();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the surviving listener when the other native registration fails', async () => {
    const onChange = vi.fn();
    let focusListener: (() => void) | undefined;
    const disposeFocus = vi.fn();
    const source = {
      hasFocus: () => false,
      listenFocus: async (listener: () => void) => {
        focusListener = listener;
        return disposeFocus;
      },
      listenBlur: async () => { throw new Error('listener unavailable'); },
    };

    expect(getInitialWindowFocus(source)).toBe(false);
    const dispose = subscribeToWindowFocus(source, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
    onChange.mockClear();
    focusListener?.();
    expect(onChange).toHaveBeenCalledWith(true);
    dispose();
    expect(disposeFocus).toHaveBeenCalledOnce();
  });

  it('attempts every cleanup even when one native disposer throws', async () => {
    const disposeBlur = vi.fn();
    const onChange = vi.fn();
    const source = {
      hasFocus: () => true,
      listenFocus: async () => () => { throw new Error('cleanup failed'); },
      listenBlur: async () => disposeBlur,
    };

    const dispose = subscribeToWindowFocus(source, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    dispose();
    expect(disposeBlur).toHaveBeenCalledOnce();
  });

  it('contains asynchronous native cleanup failures', async () => {
    const disposeBlur = vi.fn();
    const onChange = vi.fn();
    const source = {
      hasFocus: () => true,
      listenFocus: async () => async () => { throw new Error('cleanup failed'); },
      listenBlur: async () => disposeBlur,
    };

    const dispose = subscribeToWindowFocus(source, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    dispose();
    await Promise.resolve();
    expect(disposeBlur).toHaveBeenCalledOnce();
  });

  it('cleans up in-flight listeners when a sibling registration throws synchronously', async () => {
    let resolveFocusRegistration: ((dispose: () => void) => void) | undefined;
    const disposeFocus = vi.fn();
    const onChange = vi.fn();
    const source = {
      hasFocus: () => true,
      listenFocus: () => new Promise<() => void>(resolve => {
        resolveFocusRegistration = resolve;
      }),
      listenBlur: () => {
        throw new Error('synchronous blur registration failure');
      },
    };

    const dispose = subscribeToWindowFocus(source, onChange);
    dispose();
    resolveFocusRegistration?.(disposeFocus);

    await vi.waitFor(() => {
      expect(disposeFocus).toHaveBeenCalledOnce();
    });
  });

  it('deduplicates consecutive identical focus notifications', async () => {
    const fixture = fakeWindow(false);
    const onChange = vi.fn();
    const dispose = subscribeToWindowFocus(fixture.source, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(false));
    onChange.mockClear();

    fixture.dispatch(true);
    fixture.dispatch(true);
    fixture.dispatch(false);
    fixture.dispatch(false);

    expect(onChange.mock.calls).toEqual([[true], [false]]);
    dispose();
  });

  it('ignores non-function disposers safely during teardown', async () => {
    const onChange = vi.fn();
    const source = {
      hasFocus: () => true,
      listenFocus: async () => undefined as unknown as () => void,
      listenBlur: async () => null as unknown as () => void,
    };

    const dispose = subscribeToWindowFocus(source, onChange);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    expect(() => dispose()).not.toThrow();
  });
});
