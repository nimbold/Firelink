export function parseAppImageOffset(output) {
  const offset = typeof output === 'string' ? output.trim() : '';
  if (!/^[1-9]\d*$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
    throw new Error('AppImage runtime returned an invalid SquashFS offset.');
  }
  return offset;
}
