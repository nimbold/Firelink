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
    hasFocus: () => document.hasFocus(),
    listenFocus: listener => currentWindow.listen(TauriEvent.WINDOW_FOCUS, listener),
    listenBlur: listener => currentWindow.listen(TauriEvent.WINDOW_BLUR, listener),
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
  const unlisteners = new Set<WindowFocusDisposer>();

  const publish = (active: boolean) => {
    receivedNativeEvent = true;
    if (!disposed) onChange(active);
  };

  const safelyDispose = (disposeListener: WindowFocusDisposer) => {
    try {
      void Promise.resolve(disposeListener()).catch(() => undefined);
    } catch {
      // One faulty native disposer must not prevent other listener cleanup.
    }
  };

  const register = (pending: Promise<WindowFocusDisposer>) => pending.then(disposeListener => {
    if (disposed) safelyDispose(disposeListener);
    else unlisteners.add(disposeListener);
  });

  const registrations = [
    register(source.listenFocus(() => publish(true))),
    register(source.listenBlur(() => publish(false))),
  ];

  void Promise.allSettled(registrations).then(() => {
    // Listener registration is asynchronous. Re-read focus only after both
    // attempts settle so a transition during setup cannot be missed. A native
    // event that already arrived is newer and must remain authoritative.
    if (!disposed && !receivedNativeEvent) onChange(getInitialWindowFocus(source));
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

  useEffect(() => subscribeToWindowFocus(source, setActive), [source]);

  return active;
};
