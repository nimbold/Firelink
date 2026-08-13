export const shouldApplyTorrentNetworkInputResult = (
  requestId: number,
  currentRequestId: number,
  editRequestId: number,
  currentEditId: number
): boolean => requestId === currentRequestId && editRequestId === currentEditId;
