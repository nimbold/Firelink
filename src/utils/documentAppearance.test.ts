import { describe, expect, it } from 'vitest';
import { applyDocumentAppearance } from './documentAppearance';

const fakeDocument = () => {
  const classes = new Set<string>(['theme-light', 'dark']);
  const root = {
    classList: {
      add: (...values: string[]) => values.forEach(value => classes.add(value)),
      remove: (...values: string[]) => values.forEach(value => classes.delete(value)),
    },
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    lang: '',
    dir: '',
  };
  return {
    classes,
    root,
    document: { documentElement: root } as unknown as Document,
  };
};

describe('document appearance synchronization', () => {
  it('applies a complete dark RTL projection without retaining stale theme classes', () => {
    const target = fakeDocument();
    applyDocumentAppearance(target.document, {
      theme: 'nord',
      fontFamily: 'vazirmatn',
      appFontSize: 'large',
      listRowDensity: 'compact',
      locale: 'fa',
    }, false);

    expect([...target.classes].sort()).toEqual(['dark', 'theme-nord']);
    expect(target.root.dataset).toEqual({
      resolvedTheme: 'dark',
      fontFamily: 'vazirmatn',
      fontSize: 'large',
      listDensity: 'compact',
    });
    expect(target.root.style.colorScheme).toBe('dark');
    expect(target.root.lang).toBe('fa');
    expect(target.root.dir).toBe('rtl');
  });

  it('resolves system appearance while preserving an LTR locale', () => {
    const target = fakeDocument();
    applyDocumentAppearance(target.document, {
      theme: 'system',
      fontFamily: 'system',
      appFontSize: 'standard',
      listRowDensity: 'standard',
      locale: 'en',
    }, false);

    expect([...target.classes]).toEqual(['theme-light']);
    expect(target.root.dataset.resolvedTheme).toBe('light');
    expect(target.root.style.colorScheme).toBe('light');
    expect(target.root.lang).toBe('en');
    expect(target.root.dir).toBe('ltr');
  });
});
