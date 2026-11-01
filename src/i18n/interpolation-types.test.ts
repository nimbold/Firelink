import { describe, expect, it } from 'vitest';
import i18n, { i18nReady } from './index';

describe('interpolation argument types', () => {
  it('requires the variables declared by a translation', async () => {
    await i18nReady;
    const translated = i18n.t($ => $.keychain.unavailable, { store: 'Credential Manager' });
    expect(translated).toBe('Credential Manager is unavailable.');

    // @ts-expect-error Strict interpolation typing requires the store variable.
    i18n.t($ => $.keychain.unavailable);

    // @ts-expect-error The translation expects `store`, not `stores`.
    i18n.t($ => $.keychain.unavailable, { stores: 'Credential Manager' });
  });
});
