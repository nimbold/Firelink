import { create } from 'zustand';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';

interface DownloadProgressState {
  progressMap: Record<string, DownloadProgressEvent>;
  moveProgressMap: Record<string, number>;
  updateDownloadProgress: (id: string, payload: DownloadProgressEvent) => void;
  clearDownloadProgress: (id: string) => void;
  setMoveProgress: (id: string, fraction: number) => void;
  clearMoveProgress: (id: string) => void;
}

export const useDownloadProgressStore = create<DownloadProgressState>((set) => ({
  progressMap: {},
  moveProgressMap: {},
  updateDownloadProgress: (id, payload) =>
    set((state) => ({
      progressMap: {
        ...state.progressMap,
        [id]: payload,
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
