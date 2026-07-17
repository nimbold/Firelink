import React, { useState, useEffect } from 'react';
import { useDownloadStore } from '../store/useDownloadStore';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const DeleteConfirmationModal: React.FC = () => {
  const { t } = useTranslation();
  const { deleteModalState, closeDeleteModal, removeDownload } = useDownloadStore();
  const [errorMessage, setErrorMessage] = useState('');
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    if (deleteModalState.isOpen) {
      setIsRemoving(false);
      setErrorMessage('');
    }
  }, [deleteModalState.isOpen]);

  useEffect(() => {
    if (!deleteModalState.isOpen || isRemoving) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDeleteModal();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeDeleteModal, deleteModalState.isOpen, isRemoving]);

  if (!deleteModalState.isOpen) return null;

  const handleCancel = () => {
    closeDeleteModal();
  };

  const removeMany = async (deleteFile: boolean) => {
    const ids = deleteModalState.downloadIds ?? [];
    if (ids.length === 0) {
      closeDeleteModal();
      return;
    }

    setIsRemoving(true);
    setErrorMessage('');
    let succeeded = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await removeDownload(id, deleteFile);
        succeeded += 1;
      } catch (error) {
        failures.push(String(error));
      }
    }

    if (failures.length > 0) {
      setErrorMessage(t($ => $.dialogs.removeDownload.errorSummary, {
        succeeded,
        failed: failures.length,
        detail: failures[0],
      }));
      setIsRemoving(false);
      return;
    }
    setIsRemoving(false);
    closeDeleteModal();
  };

  const handleRemoveFromList = () => removeMany(false);
  const handleDeleteFile = () => removeMany(true);
  const itemCount = deleteModalState.downloadIds?.length ?? 0;

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isRemoving) handleCancel();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="window-safe-modal bg-bg-modal rounded-xl w-full max-w-md overflow-hidden flex flex-col shadow-2xl border border-border-modal scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border-modal flex items-center gap-3">
          <div className="p-2 bg-red-500/10 rounded-full flex items-center justify-center">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary m-0">{t($ => $.dialogs.removeDownload.title)}</h2>
        </div>

        <div className="px-5 py-6 flex-1 text-sm text-text-secondary leading-relaxed">
          {itemCount > 1
            ? t($ => $.dialogs.removeDownload.confirmationMultiple, { count: itemCount })
            : t($ => $.dialogs.removeDownload.confirmationSingle)}
          {errorMessage && <div className="mt-3 text-xs text-red-400">{errorMessage}</div>}
        </div>

        <div className="px-5 py-4 border-t border-border-modal flex justify-end gap-3 bg-bg-modal-accent">
          <button
            onClick={handleCancel}
            disabled={isRemoving}
            className="app-button px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {t($ => $.actions.cancel)}
          </button>
          <button
            onClick={handleRemoveFromList}
            disabled={isRemoving}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-border-modal hover:bg-border-modal/80 text-text-primary disabled:opacity-50"
          >
            {t($ => $.dialogs.removeDownload.remove)}
          </button>
          <button
            onClick={handleDeleteFile}
            disabled={isRemoving}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
          >
            {t($ => $.dialogs.removeDownload.deleteFile)}
          </button>
        </div>
      </div>
    </div>
  );
};
