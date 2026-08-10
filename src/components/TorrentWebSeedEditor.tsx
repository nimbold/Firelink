import type { TorrentFile } from '../bindings/TorrentFile';
import type { TorrentFileSelectionEntry } from '../bindings/TorrentFileSelectionEntry';
import { normalizeTorrentWebSeedDrafts, type TorrentWebSeedDraft } from '../utils/downloads';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

type TorrentWebSeedFile = Pick<TorrentFile, 'index' | 'path'> | Pick<TorrentFileSelectionEntry, 'index' | 'relativePath'>;

type Props = {
  files: readonly TorrentWebSeedFile[];
  rows: readonly TorrentWebSeedDraft[];
  onChange: (rows: TorrentWebSeedDraft[]) => void;
  disabled?: boolean;
  idPrefix: string;
};

const filePath = (file: TorrentWebSeedFile): string => 'path' in file ? file.path : file.relativePath;

export const TorrentWebSeedEditor = ({ files, rows, onChange, disabled = false, idPrefix }: Props) => {
  const { t } = useTranslation();
  const uriRefs = useRef<Array<HTMLInputElement | null>>([]);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterRemoveRef = useRef<number | null>(null);
  const filesForValidation = files.map(file => ({ index: file.index }));
  const rowsAreValid = normalizeTorrentWebSeedDrafts(rows, filesForValidation) !== null;
  useEffect(() => {
    const rowIndex = focusAfterRemoveRef.current;
    focusAfterRemoveRef.current = null;
    if (rowIndex === -1) {
      addButtonRef.current?.focus();
    } else if (rowIndex !== null) {
      uriRefs.current[rowIndex]?.focus();
    }
  }, [rows]);
  const addRow = () => onChange([...rows, { fileIndex: files[0]?.index ?? null, uri: '' }]);
  const updateRow = (rowIndex: number, update: Partial<TorrentWebSeedDraft>) => onChange(
      rows.map((row, index) => index === rowIndex ? { ...row, ...update } : row)
  );
  const removeRow = (rowIndex: number) => {
    const nextRows = rows.filter((_, index) => index !== rowIndex);
    focusAfterRemoveRef.current = nextRows.length > 0 ? Math.min(rowIndex, nextRows.length - 1) : -1;
    onChange(nextRows);
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="text-[11px] text-text-muted">{t($ => $.properties.torrentWebSeedsEmpty)}</p>
      )}
      {rows.map((row, rowIndex) => {
        const rowId = `${idPrefix}-${rowIndex}`;
        const rowIsValid = normalizeTorrentWebSeedDrafts([row], filesForValidation) !== null;
        return (
          <div key={rowId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-2 items-end">
            <div className="min-w-0">
              <label htmlFor={`${rowId}-file`} className="block text-[10px] text-text-muted mb-1">
                {t($ => $.properties.torrentWebSeedsFile)}
              </label>
              {files.length === 1 ? (
                <select
                  id={`${rowId}-file`}
                  value={files[0].index}
                  onChange={() => undefined}
                  disabled
                  dir="ltr"
                  aria-invalid={!rowIsValid}
                  className="app-control w-full min-h-[30px] px-2 py-1.5 text-xs disabled:opacity-70"
                >
                  <option value={files[0].index}>{files[0].index + 1}: {filePath(files[0])}</option>
                </select>
              ) : (
                <select
                  id={`${rowId}-file`}
                  value={row.fileIndex ?? ''}
                  onChange={event => updateRow(rowIndex, { fileIndex: Number(event.currentTarget.value) })}
                  disabled={disabled || files.length === 0}
                  dir="ltr"
                  aria-invalid={!rowIsValid}
                  className="app-control w-full min-h-[30px] px-2 py-1.5 text-xs disabled:opacity-50"
                >
                  <option value="" disabled>{t($ => $.properties.torrentWebSeedsFile)}</option>
                  {files.map(file => (
                    <option key={file.index} value={file.index}>
                      {file.index + 1}: {filePath(file)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="min-w-0">
              <label htmlFor={`${rowId}-uri`} className="block text-[10px] text-text-muted mb-1">
                {t($ => $.properties.torrentWebSeedsUri)}
              </label>
              <input
                id={`${rowId}-uri`}
                type="url"
                ref={element => { uriRefs.current[rowIndex] = element; }}
                value={row.uri}
                onChange={event => updateRow(rowIndex, { uri: event.currentTarget.value })}
                disabled={disabled}
                dir="ltr"
                aria-invalid={!rowIsValid}
                placeholder="https://mirror.example/torrent/"
                className="app-control w-full min-h-[30px] px-2 py-1.5 text-xs font-mono disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => removeRow(rowIndex)}
              disabled={disabled}
              aria-label={t($ => $.properties.torrentWebSeedsRemove)}
              className="app-button min-h-[30px] px-2 text-xs disabled:opacity-50"
            >
              ×
            </button>
          </div>
        );
      })}
      {rows.length > 0 && !rowsAreValid && (
        <p className="text-[11px] text-red-500" role="alert">
          {t($ => $.properties.torrentWebSeedsInvalid)}
        </p>
      )}
      <button
        type="button"
        ref={addButtonRef}
        onClick={addRow}
        disabled={disabled || files.length === 0}
        className="app-button px-3 text-xs disabled:opacity-50"
      >
        + {t($ => $.properties.torrentWebSeedsAdd)}
      </button>
    </div>
  );
};
