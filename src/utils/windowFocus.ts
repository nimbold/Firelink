import { TauriEvent } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useMemo, useState } from 'react';

type WindowFocusSource = {
  hasFocus: () => boolean;
  listenFocus: (listener: () => void) => Promise<WindowFocusDisposer>;
  listenBlur: (listener: () => void) => Promise<WindowFocusDisposer>;
};

type WindowFocusDisposer = () => void | Promise<void>;

const createCurrentWindowFocusSource = (): WindowFocusSource => {
  const currentWindow = getCurrentWindow();
  return {
    hasFocus: () => (typeof document !== 'undefined' ? document.hasFocus() : true),
    listenFocus: async listener => {
      let domDisposer: (() => void) | undefined;
      if (typeof window !== 'undefined') {
        const domListener = () => listener();
        window.addEventListener('focus', domListener);
        domDisposer = () => window.removeEventListener('focus', domListener);
      }
      let nativeDisposer: WindowFocusDisposer | undefined;
      try {
        nativeDisposer = await currentWindow.listen(TauriEvent.WINDOW_FOCUS, listener);
      } catch {
        // Keep the DOM listener active when native window IPC is unavailable.
      }
      return async () => {
        domDisposer?.();
        if (nativeDisposer) await nativeDisposer();
      };
    },
    listenBlur: async listener => {
      let domDisposer: (() => void) | undefined;
      if (typeof window !== 'undefined') {
        const domListener = () => listener();
        window.addEventListener('blur', domListener);
        domDisposer = () => window.removeEventListener('blur', domListener);
      }
      let nativeDisposer: WindowFocusDisposer | undefined;
      try {
        nativeDisposer = await currentWindow.listen(TauriEvent.WINDOW_BLUR, listener);
      } catch {
        // Keep the DOM listener active when native window IPC is unavailable.
      }
      return async () => {
        domDisposer?.();
        if (nativeDisposer) await nativeDisposer();
      };
    },
  };
};

export const getInitialWindowFocus = (source: WindowFocusSource): boolean => {
  try {
    return source.hasFocus();
  } catch {
    // Keep the shell fully visible until the native focus stream establishes
    // an authoritative state.
    return true;
  }
};

export const subscribeToWindowFocus = (
  source: WindowFocusSource,
  onChange: (active: boolean) => void,
): (() => void) => {
  let disposed = false;
  let receivedNativeEvent = false;
  let lastPublished: boolean | undefined;
  const unlisteners = new Set<WindowFocusDisposer>();

  const publish = (active: boolean) => {
    receivedNativeEvent = true;
    if (!disposed && active !== lastPublished) {
      lastPublished = active;
      onChange(active);
    }
  };

  const safelyDispose = (disposeListener: WindowFocusDisposer) => {
    try {
      if (typeof disposeListener === 'function') {
        void Promise.resolve(disposeListener()).catch(() => undefined);
      }
    } catch {
      // One faulty native disposer must not prevent other listener cleanup.
    }
  };

  const register = (pending: Promise<WindowFocusDisposer>) =>
    pending
      .then(disposeListener => {
        if (typeof disposeListener === 'function') {
          if (disposed) safelyDispose(disposeListener);
          else unlisteners.add(disposeListener);
        }
      })
      .catch(() => undefined);

  const safeRegister = (start: () => Promise<WindowFocusDisposer>) => {
    try {
      return register(Promise.resolve(start()));
    } catch {
      return Promise.resolve();
    }
  };

  const registrations = [
    safeRegister(() => source.listenFocus(() => publish(true))),
    safeRegister(() => source.listenBlur(() => publish(false))),
  ];

  void Promise.allSettled(registrations).then(() => {
    // Listener registration is asynchronous. Re-read focus only after both
    // attempts settle so a transition during setup cannot be missed. A native
    // event that already arrived is newer and must remain authoritative.
    if (!disposed && !receivedNativeEvent) {
      const current = getInitialWindowFocus(source);
      if (current !== lastPublished) {
        lastPublished = current;
        onChange(current);
      }
    }
  });

  return () => {
    disposed = true;
    unlisteners.forEach(safelyDispose);
    unlisteners.clear();
  };
};

export const useWindowFocusState = (providedSource?: WindowFocusSource): boolean => {
  const source = useMemo(
    () => providedSource ?? createCurrentWindowFocusSource(),
    [providedSource],
  );
  const [active, setActive] = useState(() => getInitialWindowFocus(source));

  useEffect(() => {
    setActive(getInitialWindowFocus(source));
    return subscribeToWindowFocus(source, setActive);
  }, [source]);

  return active;
};
