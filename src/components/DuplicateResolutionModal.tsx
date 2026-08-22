import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTopmostModal, useModalFocus } from '../hooks/useModalFocus';

export type DuplicateReason = { type: 'url', msg: string } | { type: 'file', msg: string };
type DuplicateResolution = 'rename' | 'replace' | 'skip';

export interface DuplicateConflict {
  id: string; // id of the pending item
  fileName: string;
  reason: DuplicateReason;
  resolution: DuplicateResolution;
  replaceAllowed?: boolean;
  replaceFingerprint?: string;
  existingDownloadId?: string;
}

interface Props {
  conflicts: DuplicateConflict[];
  onConfirm: (resolutions: {
    id: string;
    resolution: DuplicateResolution;
    replaceFingerprint?: string;
  }[]) => void;
  onCancel: () => void;
}

export const duplicateConflictCanReplace = (
  conflict: Pick<DuplicateConflict, 'replaceAllowed'>
): boolean => conflict.replaceAllowed === true;

export const canReplaceAllDuplicateConflicts = (
  conflicts: readonly Pick<DuplicateConflict, 'replaceAllowed'>[]
): boolean => conflicts.length > 0 && conflicts.every(duplicateConflictCanReplace);

export const DuplicateResolutionModal = ({ conflicts: initialConflicts, onConfirm, onCancel }: Props) => {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState<DuplicateConflict[]>(initialConflicts);
  const modalRef = useModalFocus();

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopmostModal(modalRef.current)) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  const updateResolution = (id: string, resolution: DuplicateResolution) => {
    setConflicts(current => current.map(c => c.id === id ? { ...c, resolution } : c));
  };

  const canReplaceAll = canReplaceAllDuplicateConflicts(conflicts);

  const applyResolutionToAll = (resolution: DuplicateResolution) => {
    if (resolution === 'replace' && !canReplaceAll) return;
    setConflicts(current => current.map(conflict => ({ ...conflict, resolution })));
  };

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="duplicate-downloads-title"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        data-modal-surface="true"
        className="app-modal w-[500px] flex flex-col overflow-hidden text-sm"
      >
        <div className="p-4 border-b border-border-modal flex flex-col gap-2">
          <h2 id="duplicate-downloads-title" className="text-lg font-semibold text-text-primary">{t($ => $.dialogs.duplicateDownloads.title)}</h2>
          <p className="text-xs text-text-muted">{t($ => $.dialogs.duplicateDownloads.description)}</p>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border-modal/60 bg-sidebar-bg/30 px-4 py-2.5">
          <span className="shrink-0 text-xs font-medium text-text-secondary">
            {t($ => $.dialogs.duplicateDownloads.applyToAll)}
          </span>
          <div className="flex min-w-0 items-center justify-end gap-1.5" role="group" aria-label={t($ => $.dialogs.duplicateDownloads.applyToAll)}>
            <button
              type="button"
              onClick={() => applyResolutionToAll('rename')}
              className="app-button px-2.5 py-1 text-[11px]"
            >
              {t($ => $.dialogs.duplicateDownloads.renameAll)}
            </button>
            <button
              type="button"
              onClick={() => applyResolutionToAll('replace')}
              disabled={!canReplaceAll}
              className="app-button px-2.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t($ => $.dialogs.duplicateDownloads.replaceAll)}
            </button>
            <button
              type="button"
              onClick={() => applyResolutionToAll('skip')}
              className="app-button px-2.5 py-1 text-[11px]"
            >
              {t($ => $.dialogs.duplicateDownloads.skipAll)}
            </button>
          </div>
        </div>

        <div className="max-h-[300px] overflow-y-auto p-4 space-y-3">
          {conflicts.map(conflict => (
            <div key={conflict.id} className="flex items-center justify-between bg-bg-input/50 p-2.5 rounded-lg border border-border-modal/50 gap-4">
              <div className="flex flex-col overflow-hidden min-w-0">
                <span className="font-medium text-text-primary truncate" title={conflict.fileName}>{conflict.fileName}</span>
                <span className="text-[11px] text-orange-400 mt-0.5">{conflict.reason.msg}</span>
              </div>
              <select 
                value={conflict.resolution}
                onChange={(e) => updateResolution(conflict.id, e.target.value as DuplicateResolution)}
                className="app-control w-24 shrink-0 px-2 py-1 text-xs"
              >
                <option value="rename">{t($ => $.dialogs.duplicateDownloads.rename)}</option>
                {duplicateConflictCanReplace(conflict) && <option value="replace">{t($ => $.dialogs.duplicateDownloads.replace)}</option>}
                <option value="skip">{t($ => $.dialogs.duplicateDownloads.skip)}</option>
              </select>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-border-modal flex items-center justify-between bg-sidebar-bg/50">
          <button onClick={onCancel} className="app-button px-4 text-xs">
            {t($ => $.actions.cancel)}
          </button>
          <button 
            onClick={() => onConfirm(conflicts.map(c => ({
              id: c.id,
              resolution: c.resolution,
              ...(c.replaceFingerprint ? { replaceFingerprint: c.replaceFingerprint } : {})
            })))}
            className="app-button app-button-primary px-5 text-xs"
          >
            {t($ => $.actions.continue)}
          </button>
        </div>
      </div>
    </div>
  );
};
