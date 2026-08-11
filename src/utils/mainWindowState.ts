import type { MainWindowSize } from '../bindings/MainWindowSize';

export type { MainWindowSize } from '../bindings/MainWindowSize';

export const MAIN_WINDOW_DEFAULT_WIDTH = 1280;
export const MAIN_WINDOW_DEFAULT_HEIGHT = 800;
export const MAIN_WINDOW_MIN_WIDTH = 960;
export const MAIN_WINDOW_MIN_HEIGHT = 640;
export const MAIN_WINDOW_MAX_WIDTH = 16_384;
export const MAIN_WINDOW_MAX_HEIGHT = 16_384;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizeMainWindowSize = (value: unknown): MainWindowSize | null => {
  if (!isRecord(value)) return null;
  const { width, height } = value;
  if (
    typeof width !== 'number'
    || typeof height !== 'number'
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < MAIN_WINDOW_MIN_WIDTH
    || height < MAIN_WINDOW_MIN_HEIGHT
    || width > MAIN_WINDOW_MAX_WIDTH
    || height > MAIN_WINDOW_MAX_HEIGHT
  ) {
    return null;
  }
  return { width, height };
};

export const physicalToLogicalSize = (
  width: number,
  height: number,
  scaleFactor: number
): MainWindowSize | null => {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  return normalizeMainWindowSize({
    width: Math.round(width / scaleFactor),
    height: Math.round(height / scaleFactor)
  });
};

type PhysicalSize = { width: number; height: number };
type EventPayload<T> = { payload: T };

export interface MainWindowEventSource {
  onResized: (handler: (event: EventPayload<PhysicalSize>) => void) => Promise<() => void>;
  onScaleChanged: (
    handler: (event: EventPayload<{ scaleFactor: number; size: PhysicalSize }>) => void
  ) => Promise<() => void>;
  scaleFactor: () => Promise<number>;
}

export interface MainWindowSizePersistence {
  flush: () => Promise<void>;
  dispose: () => void;
}

export const createMainWindowSizePersistence = ({
  appWindow,
  onSize,
  debounceMs = 250
}: {
  appWindow: MainWindowEventSource;
  onSize: (size: MainWindowSize) => void;
  debounceMs?: number;
}): MainWindowSizePersistence => {
  let disposed = false;
  let generation = 0;
  let pendingSize: MainWindowSize | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pendingScaleReads = new Set<Promise<void>>();

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const commit = () => {
    if (disposed) return;
    clearTimer();
    const size = pendingSize;
    pendingSize = null;
    if (size) onSize(size);
  };

  const scheduleCommit = () => {
    clearTimer();
    timer = setTimeout(commit, debounceMs);
  };

  const record = (size: PhysicalSize, scaleFactor: number, eventGeneration: number) => {
    if (disposed || eventGeneration !== generation) return;
    const logicalSize = physicalToLogicalSize(size.width, size.height, scaleFactor);
    if (!logicalSize) return;
    pendingSize = logicalSize;
    scheduleCommit();
  };

  const recordResized = (size: PhysicalSize) => {
    const eventGeneration = ++generation;
    let scaleFactorRead: Promise<number>;
    try {
      scaleFactorRead = appWindow.scaleFactor();
    } catch {
      return;
    }
    const read = scaleFactorRead
      .then(scaleFactor => record(size, scaleFactor, eventGeneration))
      .catch(() => undefined);
    pendingScaleReads.add(read);
    void read.then(
      () => pendingScaleReads.delete(read),
      () => pendingScaleReads.delete(read)
    );
  };

  const recordScaleChanged = ({ scaleFactor, size }: { scaleFactor: number; size: PhysicalSize }) => {
    const eventGeneration = ++generation;
    record(size, scaleFactor, eventGeneration);
  };

  const registerListener = <T>(register: () => Promise<T>): Promise<T> => {
    try {
      return Promise.resolve(register());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const listenersReady = Promise.allSettled([
    registerListener(() => appWindow.onResized(({ payload }) => recordResized(payload))),
    registerListener(() => appWindow.onScaleChanged(({ payload }) => recordScaleChanged(payload)))
  ]);
  let listenerDisposers: (() => void)[] | null = null;
  let listenersDisposed = false;
  const disposeListeners = (disposers: (() => void)[]) => {
    if (listenersDisposed) return;
    listenersDisposed = true;
    disposers.forEach(dispose => {
      try {
        dispose();
      } catch {
        // Listener teardown is best-effort; continue cleaning up the rest.
      }
    });
  };
  void listenersReady.then(results => {
    const disposers = results
      .filter((result): result is PromiseFulfilledResult<() => void> => result.status === 'fulfilled')
      .map(result => result.value);
    const hasRegistrationFailure = results.some(result => result.status === 'rejected');
    if (disposed || hasRegistrationFailure) disposeListeners(disposers);
    else listenerDisposers = disposers;
  });

  return {
    flush: async () => {
      while (pendingScaleReads.size > 0) {
        await Promise.all([...pendingScaleReads]);
      }
      commit();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearTimer();
      pendingSize = null;
      if (listenerDisposers) disposeListeners(listenerDisposers);
      listenerDisposers = null;
    }
  };
};
