import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useMemo, useState } from 'react';

type WindowStateDisposer = () => void | Promise<void>;

export type WindowMaximizedSource = {
  isMaximized: () => boolean | Promise<boolean>;
  listenResized: (listener: () => void) => Promise<WindowStateDisposer>;
};

const createCurrentWindowMaximizedSource = (): WindowMaximizedSource => {
  const currentWindow = getCurrentWindow();
  return {
    isMaximized: () => currentWindow.isMaximized(),
    listenResized: listener => currentWindow.onResized(listener),
  };
};

const safelyDispose = (disposer: WindowStateDisposer | undefined) => {
  if (typeof disposer !== 'function') return;
  try {
    void Promise.resolve(disposer()).catch(() => undefined);
  } catch {
    // Window teardown remains best-effort if the native listener is already gone.
  }
};

export const subscribeToWindowMaximized = (
  source: WindowMaximizedSource,
  onChange: (maximized: boolean) => void,
): (() => void) => {
  let disposed = false;
  let readGeneration = 0;
  let lastPublished: boolean | undefined;
  let listenerDisposer: WindowStateDisposer | undefined;

  const refresh = () => {
    const generation = ++readGeneration;
    let stateRead: boolean | Promise<boolean>;
    try {
      stateRead = source.isMaximized();
    } catch {
      return;
    }
    void Promise.resolve(stateRead)
      .then(maximized => {
        if (disposed || generation !== readGeneration || maximized === lastPublished) return;
        lastPublished = maximized;
        onChange(maximized);
      })
      .catch(() => undefined);
  };

  let registration: Promise<WindowStateDisposer>;
  try {
    registration = Promise.resolve(source.listenResized(refresh));
  } catch {
    registration = Promise.reject();
  }
  void registration
    .then(disposer => {
      if (disposed) safelyDispose(disposer);
      else if (typeof disposer === 'function') listenerDisposer = disposer;
      // Close the registration gap with an authoritative post-listener read.
      if (!disposed) refresh();
    })
    .catch(() => undefined);

  // Do not delay the first state read behind asynchronous listener registration.
  refresh();

  return () => {
    if (disposed) return;
    disposed = true;
    readGeneration += 1;
    safelyDispose(listenerDisposer);
    listenerDisposer = undefined;
  };
};

export const useWindowMaximizedState = (providedSource?: WindowMaximizedSource): boolean => {
  const source = useMemo(
    () => providedSource ?? createCurrentWindowMaximizedSource(),
    [providedSource],
  );
  const [maximized, setMaximized] = useState(false);

  useEffect(() => subscribeToWindowMaximized(source, setMaximized), [source]);

  return maximized;
};
