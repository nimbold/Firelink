import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDownloadListener, useDownloadProgressStore } from './downloadStore';
import {
  clearDownloadControlIntents,
  setDownloadControlIntent,
  useDownloadStore
} from './useDownloadStore';
import * as ipc from '../ipc';

vi.mock('../ipc', () => ({
  invokeCommand: vi.fn(),
  listenEvent: vi.fn(),
}));

describe('useDownloadProgressStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.invokeCommand).mockResolvedValue(undefined);
    useDownloadProgressStore.setState({ progressMap: {} });
    clearDownloadControlIntents();
  });

  it('prunes terminal progress entries', () => {
    useDownloadProgressStore.getState().updateDownloadProgress('download-1', {
      id: 'download-1',
      fraction: 0.5,
      speed: '1 MB/s',
      eta: '10s',
      size: '2 MB',
      size_is_final: false
    });

    useDownloadProgressStore.getState().clearDownloadProgress('download-1');

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
  });

  it('shares listener setup across overlapping consumers and tears down after the last release', async () => {
    const unlisten = vi.fn();
    vi.mocked(ipc.listenEvent).mockResolvedValue(unlisten);

    const first = initDownloadListener();
    const second = initDownloadListener();

    expect(ipc.listenEvent).toHaveBeenCalledTimes(3);

    const releaseFirst = await first;
    const releaseSecond = await second;
    releaseFirst();
    expect(unlisten).not.toHaveBeenCalled();

    releaseSecond();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it('ignores late progress and opposite terminal events from an older lifecycle', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'terminal',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'completed',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'terminal',
      fraction: 0.1,
      speed: '1 MB/s',
      eta: '10s',
      size: '1 MB',
      size_is_final: false
    } });
    handlers['download-state']({ payload: {
      id: 'terminal',
      status: 'failed',
      error: 'stale failure'
    } });

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    expect(useDownloadStore.getState().downloads[0].status).toBe('completed');
    release();
  });

  it('clears progress when events arrive after a download row was removed', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadProgressStore.getState().updateDownloadProgress('removed', {
      id: 'removed',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false
    });
    useDownloadStore.setState({ downloads: [] });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'removed',
      fraction: 0.9,
      speed: '2 MB/s',
      eta: '1s',
      size: '9 MB',
      size_is_final: false
    } });

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    release();
  });

  it('drops stale progress when a download returns to a queued lifecycle', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'reused',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'reused',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false
    } });
    handlers['download-state']({ payload: {
      id: 'reused',
      status: 'queued'
    } });
    handlers['download-progress']({ payload: {
      id: 'reused',
      fraction: 0.9,
      speed: '2 MB/s',
      eta: '1s',
      size: '9 MB',
      size_is_final: false
    } });

    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    release();
  });

  it('snapshots live progress before clearing it on a terminal transition', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'snapshot',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'downloading',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-progress']({ payload: {
      id: 'snapshot',
      fraction: 0.8,
      speed: '1 MB/s',
      eta: '2s',
      size: '8 MB',
      size_is_final: false,
      downloaded_bytes: 8192,
      total_bytes: 10240,
      total_is_estimate: true
    } });
    handlers['download-state']({ payload: {
      id: 'snapshot',
      status: 'paused'
    } });

    const row = useDownloadStore.getState().downloads[0];
    expect(row.status).toBe('paused');
    expect(row.fraction).toBe(0.8);
    expect(row.downloadedBytes).toBe(8192);
    expect(row.totalBytes).toBe(10240);
    expect(row.totalIsEstimate).toBe(true);
    expect(useDownloadProgressStore.getState().progressMap).toEqual({});
    release();
  });

  it('ignores stale active state events after pause but accepts terminal reconciliation', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'paused-race',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'paused',
        category: 'Other',
        dateAdded: ''
      }]
    });

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'paused-race',
      status: 'downloading'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');

    handlers['download-state']({ payload: {
      id: 'paused-race',
      status: 'completed'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('completed');
    release();
  });

  it('ignores a stale paused event during resume and accepts the new active state', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'resume-race',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });
    setDownloadControlIntent('resume-race', 'resume');

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'resume-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('queued');

    handlers['download-state']({ payload: {
      id: 'resume-race',
      status: 'downloading'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('downloading');
    release();
  });

  it('allows a later genuine pause after consuming the stale resume event', async () => {
    const handlers: Record<string, (event: any) => void> = {};
    vi.mocked(ipc.listenEvent).mockImplementation((event, handler) => {
      handlers[event] = handler as (event: any) => void;
      return Promise.resolve(vi.fn());
    });
    useDownloadStore.setState({
      downloads: [{
        id: 'resume-pause-race',
        url: 'https://example.com/file',
        fileName: 'file.bin',
        status: 'queued',
        category: 'Other',
        dateAdded: ''
      }]
    });
    setDownloadControlIntent('resume-pause-race', 'resume');

    const release = await initDownloadListener();
    handlers['download-state']({ payload: {
      id: 'resume-pause-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('queued');

    handlers['download-state']({ payload: {
      id: 'resume-pause-race',
      status: 'paused'
    } });
    expect(useDownloadStore.getState().downloads[0].status).toBe('paused');
    release();
  });
});
