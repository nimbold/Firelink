import { describe, expect, it } from 'vitest';
import { getPropertiesFooterActions } from './propertiesFooter';

describe('Properties footer state', () => {
  it('shows discard, save, and close for ordinary dirty edits', () => {
    expect(getPropertiesFooterActions({ isDirty: true, hasUnsavedNavigation: false }))
      .toEqual(['discardChanges', 'save', 'close']);
  });

  it('shows discard, save, and keep editing for an unsaved tab or close prompt', () => {
    expect(getPropertiesFooterActions({ isDirty: true, hasUnsavedNavigation: true }))
      .toEqual(['discardChanges', 'save', 'keepEditing']);
    expect(getPropertiesFooterActions({ isDirty: false, hasUnsavedNavigation: true }))
      .toEqual(['discardChanges', 'save', 'keepEditing']);
  });

  it('keeps close available when there are no edits', () => {
    expect(getPropertiesFooterActions({ isDirty: false, hasUnsavedNavigation: false }))
      .toEqual(['close']);
  });
});
