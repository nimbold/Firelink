import { create } from 'zustand';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';

interface DownloadProgressState {
  progressMap: Record<string, DownloadProgressEvent>;
  retainedProgressMap: Record<string, DownloadProgressEvent>;
  moveProgressMap: Record<string, number>;
  updateDownloadProgress: (id: string, payload: DownloadProgressEvent) => void;
  clearDownloadProgress: (id: string) => void;
  resetDownloadProgress: (id: string) => void;
  setMoveProgress: (id: string, fraction: number) => void;
  clearMoveProgress: (id: string) => void;
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const retainProgressSnapshot = (
  previous: DownloadProgressEvent | undefined,
  next: DownloadProgressEvent,
): DownloadProgressEvent => {
  const previousDownloaded = finiteNonNegative(previous?.downloaded_bytes)
    ? previous.downloaded_bytes
    : undefined;
  const nextDownloaded = finiteNonNegative(next.downloaded_bytes)
    ? next.downloaded_bytes
    : undefined;
  const downloadedBytes = previousDownloaded === undefined
    ? nextDownloaded
    : nextDownloaded === undefined
      ? previousDownloaded
      : Math.max(previousDownloaded, nextDownloaded);

  const exactTotal = [next, previous]
    .find(snapshot => snapshot?.total_is_estimate === false
      && finiteNonNegative(snapshot.total_bytes))
    ?.total_bytes;
  const totalBytes = exactTotal
    ?? (finiteNonNegative(next.total_bytes)
      ? next.total_bytes
      : finiteNonNegative(previous?.total_bytes)
        ? previous.total_bytes
        : undefined);
  const totalIsEstimate = exactTotal !== undefined
    ? false
    : next.total_is_estimate ?? previous?.total_is_estimate;
  const fractions = [previous?.fraction, next.fraction]
    .filter(finiteNonNegative);
  if (downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0) {
    fractions.push(Math.min(downloadedBytes, totalBytes) / totalBytes);
  }

  return {
    ...next,
    fraction: fractions.length > 0
      ? Math.min(1, Math.max(0, Math.max(...fractions)))
      : next.fraction,
    ...(downloadedBytes !== undefined ? { downloaded_bytes: downloadedBytes } : {}),
    ...(totalBytes !== undefined ? { total_bytes: totalBytes } : {}),
    ...(totalIsEstimate !== undefined ? { total_is_estimate: totalIsEstimate } : {})
  };
};

export const useDownloadProgressStore = create<DownloadProgressState>((set) => ({
  progressMap: {},
  retainedProgressMap: {},
  moveProgressMap: {},
  updateDownloadProgress: (id, payload) =>
    set((state) => ({
      progressMap: {
        ...state.progressMap,
        [id]: payload,
      },
      retainedProgressMap: {
        ...state.retainedProgressMap,
        [id]: retainProgressSnapshot(state.retainedProgressMap[id], payload),
      },
    })),
  clearDownloadProgress: (id) =>
    set((state) => {
      if (!(id in state.progressMap) && !(id in state.moveProgressMap)) return state;
      const next = { ...state.progressMap };
      delete next[id];
      const nextMove = { ...state.moveProgressMap };
      delete nextMove[id];
      return { progressMap: next, moveProgressMap: nextMove };
    }),
  resetDownloadProgress: (id) =>
    set((state) => {
      if (!(id in state.progressMap)
        && !(id in state.retainedProgressMap)
        && !(id in state.moveProgressMap)) return state;
      const next = { ...state.progressMap };
      delete next[id];
      const nextRetained = { ...state.retainedProgressMap };
      delete nextRetained[id];
      const nextMove = { ...state.moveProgressMap };
      delete nextMove[id];
      return {
        progressMap: next,
        retainedProgressMap: nextRetained,
        moveProgressMap: nextMove
      };
    }),
  setMoveProgress: (id, fraction) =>
    set((state) => ({
      moveProgressMap: { ...state.moveProgressMap, [id]: fraction }
    })),
  clearMoveProgress: (id) =>
    set((state) => {
      if (!(id in state.moveProgressMap)) return state;
      const next = { ...state.moveProgressMap };
      delete next[id];
      return { moveProgressMap: next };
    }),
}));
