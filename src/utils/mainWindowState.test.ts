import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMainWindowSizePersistence,
  normalizeMainWindowSize,
  physicalToLogicalSize,
  type MainWindowEventSource
} from './mainWindowState';

const createWindowMock = () => {
  let resized: ((event: { payload: { width: number; height: number } }) => void) | undefined;
  let scaleChanged: ((event: {
    payload: { scaleFactor: number; size: { width: number; height: number } }
  }) => void) | undefined;
  const appWindow: MainWindowEventSource = {
    onResized: vi.fn(async handler => {
      resized = handler;
      return vi.fn();
    }),
    onScaleChanged: vi.fn(async handler => {
      scaleChanged = handler;
      return vi.fn();
    }),
    scaleFactor: vi.fn(async () => 2)
  };
  return {
    appWindow,
    resize: (width: number, height: number) => resized?.({ payload: { width, height } }),
    scale: (scaleFactor: number, width: number, height: number) =>
      scaleChanged?.({ payload: { scaleFactor, size: { width, height } } })
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('main window geometry', () => {
  it('converts physical event sizes to bounded logical pixels', () => {
    expect(physicalToLogicalSize(2560, 1600, 2)).toEqual({ width: 1280, height: 800 });
    expect(normalizeMainWindowSize({ width: 959, height: 800 })).toBeNull();
    expect(normalizeMainWindowSize({ width: 1280, height: 16_385 })).toBeNull();
    expect(normalizeMainWindowSize({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  });

  it('debounces resize persistence to the latest logical size', async () => {
    vi.useFakeTimers();
    const mock = createWindowMock();
    const onSize = vi.fn();
    const controller = createMainWindowSizePersistence({ appWindow: mock.appWindow, onSize });

    mock.resize(2560, 1600);
    await vi.waitFor(() => expect(mock.appWindow.scaleFactor).toHaveBeenCalledTimes(1));
    mock.resize(2800, 1800);
    await vi.waitFor(() => expect(mock.appWindow.scaleFactor).toHaveBeenCalledTimes(2));
    await vi.runAllTicks();
    expect(onSize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(onSize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSize).toHaveBeenCalledWith({ width: 1400, height: 900 });
    controller.dispose();
  });

  it('flushes a pending scale read and ignores a stale result', async () => {
    let resolveScale!: (scale: number) => void;
    const mock = createWindowMock();
    vi.mocked(mock.appWindow.scaleFactor).mockImplementationOnce(
      () => new Promise(resolve => { resolveScale = resolve; })
    );
    const onSize = vi.fn();
    const controller = createMainWindowSizePersistence({
      appWindow: mock.appWindow,
      onSize,
      debounceMs: 10_000
    });

    mock.resize(2560, 1600);
    mock.scale(1, 1400, 900);
    const flush = controller.flush();
    resolveScale(2);
    await flush;

    expect(onSize).toHaveBeenCalledTimes(1);
    expect(onSize).toHaveBeenCalledWith({ width: 1400, height: 900 });
    controller.dispose();
  });

  it('waits for scale reads started while a flush is already in progress', async () => {
    let resolveFirst!: (scale: number) => void;
    let resolveSecond!: (scale: number) => void;
    const mock = createWindowMock();
    vi.mocked(mock.appWindow.scaleFactor)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    const onSize = vi.fn();
    const controller = createMainWindowSizePersistence({
      appWindow: mock.appWindow,
      onSize,
      debounceMs: 10_000
    });

    mock.resize(2560, 1600);
    const flush = controller.flush();
    await vi.waitFor(() => expect(mock.appWindow.scaleFactor).toHaveBeenCalledTimes(1));

    mock.resize(2800, 1800);
    await vi.waitFor(() => expect(mock.appWindow.scaleFactor).toHaveBeenCalledTimes(2));
    resolveFirst(2);
    await Promise.resolve();
    expect(onSize).not.toHaveBeenCalled();

    resolveSecond(2);
    await flush;

    expect(onSize).toHaveBeenCalledTimes(1);
    expect(onSize).toHaveBeenCalledWith({ width: 1400, height: 900 });
    controller.dispose();
  });

  it('cleans up listeners when one registration fails', async () => {
    const unlistenResize = vi.fn();
    const onResized = vi.fn(async () => unlistenResize);
    const onScaleChanged = vi.fn(async () => {
      throw new Error('scale listener unavailable');
    });
    const appWindow: MainWindowEventSource = {
      onResized,
      onScaleChanged,
      scaleFactor: vi.fn(async () => 2)
    };
    const controller = createMainWindowSizePersistence({ appWindow, onSize: vi.fn() });

    await vi.waitFor(() => expect(unlistenResize).toHaveBeenCalledTimes(1));
    controller.dispose();
    expect(unlistenResize).toHaveBeenCalledTimes(1);
  });

  it('ignores a synchronous scale-factor failure without breaking resize handling', () => {
    const mock = createWindowMock();
    vi.mocked(mock.appWindow.scaleFactor).mockImplementationOnce(() => {
      throw new Error('scale factor unavailable');
    });
    const onSize = vi.fn();
    const controller = createMainWindowSizePersistence({ appWindow: mock.appWindow, onSize });

    expect(() => mock.resize(2560, 1600)).not.toThrow();
    expect(onSize).not.toHaveBeenCalled();
    controller.dispose();
  });
});
