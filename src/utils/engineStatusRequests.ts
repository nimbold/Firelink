export const createEngineStatusRequestTracker = () => {
  let nextRequestId = 0;
  const latestRequestByKind = new Map<string, number>();

  return {
    begin(kind: string): number {
      const requestId = ++nextRequestId;
      latestRequestByKind.set(kind, requestId);
      return requestId;
    },
    isCurrent(kind: string, requestId: number): boolean {
      return latestRequestByKind.get(kind) === requestId;
    }
  };
};
