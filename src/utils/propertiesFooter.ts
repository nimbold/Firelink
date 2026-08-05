export type PropertiesFooterAction = 'discardChanges' | 'save' | 'close' | 'keepEditing';

export type PropertiesFooterState = {
  isDirty: boolean;
  hasUnsavedNavigation: boolean;
};

export const getPropertiesFooterActions = ({
  isDirty,
  hasUnsavedNavigation,
}: PropertiesFooterState): PropertiesFooterAction[] => {
  if (hasUnsavedNavigation) return ['discardChanges', 'save', 'keepEditing'];
  if (isDirty) return ['discardChanges', 'save', 'close'];
  return ['close'];
};
