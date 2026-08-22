import { describe, expect, it } from 'vitest';
import {
  canReplaceAllDuplicateConflicts,
  duplicateConflictCanReplace,
} from './DuplicateResolutionModal';

describe('duplicate replacement eligibility', () => {
  it('exposes Replace for an eligible unmanaged regular-file conflict', () => {
    expect(duplicateConflictCanReplace({ replaceAllowed: true })).toBe(true);
    expect(duplicateConflictCanReplace({ replaceAllowed: false })).toBe(false);
    expect(duplicateConflictCanReplace({})).toBe(false);
  });

  it('enables Replace all only when every conflict is eligible', () => {
    expect(canReplaceAllDuplicateConflicts([{ replaceAllowed: true }])).toBe(true);
    expect(canReplaceAllDuplicateConflicts([
      { replaceAllowed: true },
      { replaceAllowed: true },
    ])).toBe(true);
    expect(canReplaceAllDuplicateConflicts([
      { replaceAllowed: true },
      { replaceAllowed: false },
    ])).toBe(false);
    expect(canReplaceAllDuplicateConflicts([])).toBe(false);
  });
});
