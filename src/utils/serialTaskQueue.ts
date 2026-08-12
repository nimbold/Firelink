export type SerialTask = () => void | Promise<void>;

export type SerialTaskQueue = (task: SerialTask) => Promise<void>;

export const createSerialTaskQueue = (): SerialTaskQueue => {
  let tail: Promise<void> = Promise.resolve();

  return task => {
    const next = tail.catch(() => undefined).then(task);
    tail = next.catch(() => undefined);
    return next;
  };
};
