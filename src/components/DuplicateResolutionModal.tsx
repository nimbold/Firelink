import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type DuplicateReason = { type: 'url', msg: string } | { type: 'file', msg: string };
type DuplicateResolution = 'rename' | 'replace' | 'skip';

export interface DuplicateConflict {
  id: string; // id of the pending item
  fileName: string;
  reason: DuplicateReason;
  resolution: DuplicateResolution;
  replaceAllowed?: boolean;
  existingDownloadId?: string;
}

interface Props {
  conflicts: DuplicateConflict[];
  onConfirm: (resolutions: { id: string, resolution: DuplicateResolution }[]) => void;
  onCancel: () => void;
}

export const DuplicateResolutionModal = ({ conflicts: initialConflicts, onConfirm, onCancel }: Props) => {
  const { t } = useTranslation();
  const [conflicts, setConflicts] = useState<DuplicateConflict[]>(initialConflicts);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onCancel]);

  const updateResolution = (id: string, resolution: DuplicateResolution) => {
    setConflicts(conflicts.map(c => c.id === id ? { ...c, resolution } : c));
  };

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="app-modal w-[500px] flex flex-col overflow-hidden text-sm">
        <div className="p-4 border-b border-border-modal flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-text-primary">{t($ => $.dialogs.duplicateDownloads.title)}</h2>
          <p className="text-xs text-text-muted">{t($ => $.dialogs.duplicateDownloads.description)}</p>
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
                {conflict.reason.type === 'file' && conflict.replaceAllowed && <option value="replace">{t($ => $.dialogs.duplicateDownloads.replace)}</option>}
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
            onClick={() => onConfirm(conflicts.map(c => ({ id: c.id, resolution: c.resolution })))}
            className="app-button app-button-primary px-5 text-xs"
          >
            {t($ => $.actions.continue)}
          </button>
        </div>
      </div>
    </div>
  );
};
