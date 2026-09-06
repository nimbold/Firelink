import React, { useEffect } from 'react';
import { useDownloadStore } from '../store/useDownloadStore';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTopmostModal, useModalFocus } from '../hooks/useModalFocus';

export const DeleteConfirmationModal: React.FC = () => {
  const { t } = useTranslation();
  const { deleteModalState, closeDeleteModal, requestRemovals, downloads } = useDownloadStore();
  const modalRef = useModalFocus(deleteModalState.isOpen);

  useEffect(() => {
    if (!deleteModalState.isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isTopmostModal(modalRef.current)) {
        event.preventDefault();
        closeDeleteModal();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeDeleteModal, deleteModalState.isOpen]);

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

    await requestRemovals(ids, deleteFile);
  };

  const handleRemoveFromList = () => removeMany(false);
  const handleDeleteFile = () => removeMany(true);
  const itemCount = deleteModalState.downloadIds?.length ?? 0;
  const selectedItems = (deleteModalState.downloadIds ?? [])
    .map(id => downloads.find(download => download.id === id))
    .filter(Boolean);
  const hasCompletedSelection = selectedItems.some(item => item?.status === 'completed');
  const hasUnfinishedSelection = selectedItems.some(item => item?.status !== 'completed');

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) handleCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-download-title"
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        data-modal-surface="true"
        className="app-modal keychain-modal flex w-full max-w-md flex-col overflow-hidden text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border-modal flex items-center gap-3">
          <div className="p-2 bg-red-500/10 rounded-full flex items-center justify-center">
            <AlertTriangle size={20} className="text-red-400" />
          </div>
          <h2 id="remove-download-title" className="text-lg font-semibold text-text-primary m-0">{t($ => $.dialogs.removeDownload.title)}</h2>
        </div>

        <div className="px-5 py-6 flex-1 text-sm text-text-secondary leading-relaxed">
          {itemCount > 1
            ? t($ => $.dialogs.removeDownload.confirmationMultiple, { count: itemCount })
            : t($ => $.dialogs.removeDownload.confirmationSingle)}
          {hasCompletedSelection && hasUnfinishedSelection && (
            <div className="mt-3 text-xs text-amber-300" role="note">
              {t($ => $.dialogs.removeDownload.mixedRemovalPolicy)}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border-modal flex justify-end gap-3 bg-bg-modal-accent">
          <button
            onClick={handleCancel}
            className="app-button px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {t($ => $.actions.cancel)}
          </button>
          <button
            onClick={handleRemoveFromList}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-border-modal hover:bg-border-modal/80 text-text-primary disabled:opacity-50"
          >
            {t($ => $.dialogs.removeDownload.remove)}
          </button>
          <button
            onClick={handleDeleteFile}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
          >
            {t($ => $.dialogs.removeDownload.deleteFile)}
          </button>
        </div>
      </div>
    </div>
  );
};
