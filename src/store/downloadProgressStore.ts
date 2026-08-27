import { create } from 'zustand';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';

interface DownloadProgressState {
  progressMap: Record<string, DownloadProgressEvent>;
  updateDownloadProgress: (id: string, payload: DownloadProgressEvent) => void;
  clearDownloadProgress: (id: string) => void;
}

export const useDownloadProgressStore = create<DownloadProgressState>((set) => ({
  progressMap: {},
  updateDownloadProgress: (id, payload) =>
    set((state) => ({
      progressMap: {
        ...state.progressMap,
        [id]: payload,
      },
    })),
  clearDownloadProgress: (id) =>
    set((state) => {
      if (!(id in state.progressMap)) return state;
      const next = { ...state.progressMap };
      delete next[id];
      return { progressMap: next };
    }),
}));
