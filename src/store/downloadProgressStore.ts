import { create } from 'zustand';
import type { DownloadProgressEvent } from '../bindings/DownloadProgressEvent';

export interface Aria2ProgressOwner {
  gid: string;
  lifecycleGeneration: string;
  controlEpoch: string;
  ownerRevision: string;
}

interface DownloadProgressState {
  progressMap: Record<string, DownloadProgressEvent>;
  retainedProgressMap: Record<string, DownloadProgressEvent>;
  moveProgressMap: Record<string, number>;
  aria2ProgressOwnerMap: Record<string, Aria2ProgressOwner>;
  aria2ProgressOwnerWatermarkMap: Record<string, Aria2ProgressOwner>;
  aria2LifecycleGenerationMap: Record<string, string>;
  updateDownloadProgress: (id: string, payload: DownloadProgressEvent) => void;
  clearDownloadProgress: (id: string) => void;
  resetDownloadProgress: (id: string) => void;
  setAria2LifecycleGeneration: (id: string, generation: string) => boolean;
  acceptAria2ProgressOwner: (
    id: string,
    owner: Aria2ProgressOwner,
  ) => boolean;
  clearAria2ProgressOwner: (id: string) => void;
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
  aria2ProgressOwnerMap: {},
  aria2ProgressOwnerWatermarkMap: {},
  aria2LifecycleGenerationMap: {},
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
        && !(id in state.moveProgressMap)
        && !(id in state.aria2ProgressOwnerMap)
        && !(id in state.aria2ProgressOwnerWatermarkMap)
        && !(id in state.aria2LifecycleGenerationMap)) return state;
      const next = { ...state.progressMap };
      delete next[id];
      const nextRetained = { ...state.retainedProgressMap };
      delete nextRetained[id];
      const nextMove = { ...state.moveProgressMap };
      delete nextMove[id];
      const nextOwners = { ...state.aria2ProgressOwnerMap };
      delete nextOwners[id];
      const nextWatermarks = { ...state.aria2ProgressOwnerWatermarkMap };
      delete nextWatermarks[id];
      const nextLifecycleGenerations = { ...state.aria2LifecycleGenerationMap };
      delete nextLifecycleGenerations[id];
      return {
        progressMap: next,
        retainedProgressMap: nextRetained,
        moveProgressMap: nextMove,
        aria2ProgressOwnerMap: nextOwners,
        aria2ProgressOwnerWatermarkMap: nextWatermarks,
        aria2LifecycleGenerationMap: nextLifecycleGenerations
      };
    }),
  setAria2LifecycleGeneration: (id, generation) => {
    let accepted = false;
    set((state) => {
      const current = state.aria2LifecycleGenerationMap[id];
      if (current !== undefined && BigInt(generation) < BigInt(current)) return state;
      accepted = true;
      if (current === generation) return state;
      const nextGenerations = { ...state.aria2LifecycleGenerationMap, [id]: generation };
      const nextOwners = { ...state.aria2ProgressOwnerMap };
      delete nextOwners[id];
      return {
        aria2LifecycleGenerationMap: nextGenerations,
        aria2ProgressOwnerMap: nextOwners
      };
    });
    return accepted;
  },
  acceptAria2ProgressOwner: (id, owner) => {
    let accepted = false;
    set((state) => {
      const expectedGeneration = state.aria2LifecycleGenerationMap[id];
      if (expectedGeneration !== undefined && owner.lifecycleGeneration !== expectedGeneration) {
        return state;
      }
      const watermark = state.aria2ProgressOwnerWatermarkMap[id];
      if (watermark) {
        const incomingGeneration = BigInt(owner.lifecycleGeneration);
        const watermarkGeneration = BigInt(watermark.lifecycleGeneration);
        if (incomingGeneration < watermarkGeneration) return state;
        if (incomingGeneration === watermarkGeneration) {
          const incomingEpoch = BigInt(owner.controlEpoch);
          const watermarkEpoch = BigInt(watermark.controlEpoch);
          if (incomingEpoch < watermarkEpoch) return state;
          if (incomingEpoch === watermarkEpoch) {
            const incomingRevision = BigInt(owner.ownerRevision);
            const watermarkRevision = BigInt(watermark.ownerRevision);
            if (incomingRevision < watermarkRevision) return state;
            if (incomingRevision === watermarkRevision && owner.gid !== watermark.gid) {
              return state;
            }
          }
        }
      }
      accepted = true;
      return {
        aria2ProgressOwnerMap: { ...state.aria2ProgressOwnerMap, [id]: owner },
        aria2ProgressOwnerWatermarkMap: {
          ...state.aria2ProgressOwnerWatermarkMap,
          [id]: owner
        }
      };
    });
    return accepted;
  },
  clearAria2ProgressOwner: (id) =>
    set((state) => {
      if (!(id in state.aria2ProgressOwnerMap)) return state;
      const next = { ...state.aria2ProgressOwnerMap };
      delete next[id];
      return { aria2ProgressOwnerMap: next };
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
