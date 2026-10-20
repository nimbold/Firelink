import { describe, expect, it } from 'vitest';
import { takeSettledStartupInputs } from './startupInputs';

describe('startup input queue', () => {
  it('retains deep links until start-at-login synchronization completes', () => {
    const pending = [
      { type: 'extension', id: 'first' },
      { type: 'deep-link', id: 'link' },
      { type: 'extension-media-discovery', id: 'last' }
    ];

    expect(takeSettledStartupInputs(pending, false)).toBeNull();
    expect(pending.map(input => input.id)).toEqual(['first', 'link', 'last']);

    expect(takeSettledStartupInputs(pending, true)).toEqual([
      { type: 'extension', id: 'first' },
      { type: 'deep-link', id: 'link' },
      { type: 'extension-media-discovery', id: 'last' }
    ]);
    expect(pending).toEqual([]);
  });

  it('drains extension-only input without waiting for unrelated login-item state', () => {
    const pending = [
      { type: 'extension', id: 'first' },
      { type: 'extension-media-discovery', id: 'last' }
    ];

    expect(takeSettledStartupInputs(pending, false)).toEqual([
      { type: 'extension', id: 'first' },
      { type: 'extension-media-discovery', id: 'last' }
    ]);
    expect(pending).toEqual([]);
  });

  it('drains deep links after the login-item query fails', () => {
    const pending = [{ type: 'deep-link', id: 'link' }];
    // A failed OS query is terminal for this attempt, even though it did not
    // produce an authoritative enabled/disabled value.
    const loginItemSyncSettled = true;

    expect(takeSettledStartupInputs(pending, loginItemSyncSettled)).toEqual([
      { type: 'deep-link', id: 'link' }
    ]);
    expect(pending).toEqual([]);
  });
});
