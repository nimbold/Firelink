import { describe, expect, it, vi } from 'vitest';
import type { DownloadItem } from './store/useDownloadStore';

vi.mock('./ipc', () => ({
  invokeCommand: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  emitTo: vi.fn(),
}));

import { applySecretPatch, sanitizePropertiesSnapshot } from './propertiesBridge';

describe('Properties window bridge', () => {
  it('sanitizes transfer secrets while preserving presence flags', () => {
    const item = {
      id: 'download-1',
      fileName: 'example.iso',
      url: 'https://example.test/file',
      password: 'password',
      cookies: 'sid=secret',
      headers: 'Authorization: Bearer secret',
      username: 'user',
    } as DownloadItem;

    const snapshot = sanitizePropertiesSnapshot(item);

    expect(snapshot).not.toHaveProperty('password');
    expect(snapshot).not.toHaveProperty('cookies');
    expect(snapshot).not.toHaveProperty('headers');
    expect(snapshot).not.toHaveProperty('username');
    expect(snapshot.hasPassword).toBe(true);
    expect(snapshot.hasCookies).toBe(true);
    expect(snapshot.hasHeaders).toBe(true);
    expect(snapshot.hasUsername).toBe(true);
  });

  it('applies explicit secret changes without conflating unchanged fields', () => {
    expect(applySecretPatch(undefined, 'existing')).toBe('existing');
    expect(applySecretPatch({ kind: 'unchanged' }, 'existing')).toBe('existing');
  expect(applySecretPatch({ kind: 'replace', value: 'new' }, 'existing')).toBe('new');
  expect(applySecretPatch({ kind: 'clear' }, 'existing')).toBeUndefined();
  expect(() => applySecretPatch({ kind: 'replace', value: 42 }, 'existing')).toThrow('Invalid secret value');
  expect(() => applySecretPatch({ kind: 'unexpected' }, 'existing')).toThrow('Invalid secret patch');
});
});
