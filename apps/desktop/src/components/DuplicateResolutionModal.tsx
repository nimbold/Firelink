import { useState } from 'react';

export type DuplicateReason = { type: 'url', msg: string } | { type: 'file', msg: string };

export interface DuplicateConflict {
  id: string; // id of the pending item
  fileName: string;
  reason: DuplicateReason;
  resolution: 'rename' | 'replace' | 'skip';
}

interface Props {
  conflicts: DuplicateConflict[];
  onConfirm: (resolutions: { id: string, resolution: 'rename' | 'replace' | 'skip' }[]) => void;
  onCancel: () => void;
}

export const DuplicateResolutionModal = ({ conflicts: initialConflicts, onConfirm, onCancel }: Props) => {
  const [conflicts, setConflicts] = useState<DuplicateConflict[]>(initialConflicts);

  const updateResolution = (id: string, resolution: 'rename' | 'replace' | 'skip') => {
    setConflicts(conflicts.map(c => c.id === id ? { ...c, resolution } : c));
  };

  return (
    <div className="app-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center">
      <div className="app-modal w-[500px] flex flex-col overflow-hidden text-sm">
        <div className="p-4 border-b border-border-modal flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-text-primary">Duplicate Downloads Detected</h2>
          <p className="text-xs text-text-muted">Some of the downloads you are adding already exist in the queue or on disk. Please choose how to resolve these conflicts.</p>
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
                onChange={(e) => updateResolution(conflict.id, e.target.value as any)}
                className="app-control w-24 shrink-0 px-2 py-1 text-xs"
              >
                <option value="rename">Rename</option>
                <option value="replace">Replace</option>
                <option value="skip">Skip</option>
              </select>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-border-modal flex items-center justify-between bg-sidebar-bg/50">
          <button onClick={onCancel} className="app-button border-transparent bg-transparent px-4 text-xs text-text-secondary">
            Cancel
          </button>
          <button 
            onClick={() => onConfirm(conflicts.map(c => ({ id: c.id, resolution: c.resolution })))}
            className="app-button app-button-primary px-5 text-xs"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
