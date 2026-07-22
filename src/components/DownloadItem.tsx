import React from 'react';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { Play, Pause, MoreVertical, Clock, ArrowUp, ArrowDown } from 'lucide-react';
import type { DownloadItem as DownloadItemType } from '../bindings/DownloadItem';
import { canPauseDownload, canStartDownload } from '../utils/downloadActions';
import { useTranslation } from 'react-i18next';
import {
  downloadProgressColorClass,
  formatDownloadTotal,
  resolveDownloadSizeDisplay
} from '../utils/downloadProgress';
import {
  COLUMN_ALIGNMENT_JUSTIFY,
  getColumnGridColumn,
  type DownloadColumnAlignment,
  type DownloadTableColumnKey
} from '../utils/downloadTableColumns';

interface DownloadItemProps {
  download: DownloadItemType;
  index: number;
  queueIndex: number;
  queueLength: number;
  columnOrder: DownloadTableColumnKey[];
  columnAlignments: Record<DownloadTableColumnKey, DownloadColumnAlignment>;
  tableGridTemplate: string;
  tableMinWidth: number | string;
  setContextMenu: (menu: { x: number; y: number; id: string }) => void;
  handlePause: (id: string, skipConfirm?: boolean) => void;
  handleResume: (item: DownloadItemType) => void;
  getCategoryIcon: (category: string) => React.ReactNode;
  isSelected: boolean;
  onMoveInQueue: (id: string, direction: 'up' | 'down') => void;
  onClick: (e: React.MouseEvent, item: DownloadItemType) => void;
}

export const DownloadItem = React.memo<DownloadItemProps>(({
  download,
  index,
  queueIndex,
  queueLength,
  columnOrder,
  columnAlignments,
  tableGridTemplate,
  tableMinWidth,
  setContextMenu,
  handlePause,
  handleResume,
  getCategoryIcon,
  isSelected,
  onMoveInQueue,
  onClick,
}) => {
  const { t } = useTranslation();
  const liveProgress = useDownloadProgressStore(state => state.progressMap[download.id]);

  const displayFraction = download.status === 'downloading'
    ? liveProgress?.fraction ?? download.fraction ?? 0
    : download.fraction ?? 0;
  const displayPercent = `${(displayFraction * 100).toFixed(0)}%`;
  const displaySpeed = download.status === 'downloading'
    ? liveProgress?.speed ?? download.speed
    : download.status === 'processing'
      ? t($ => $.downloads.values.processing)
      : '-';
  const displayEta = download.status === 'downloading'
    ? liveProgress?.eta ?? download.eta
    : download.status === 'processing'
      ? t($ => $.downloads.values.muxing)
      : '-';
  const sizeDisplay = resolveDownloadSizeDisplay({
    downloadedBytes: liveProgress?.downloaded_bytes ?? download.downloadedBytes,
    totalBytes: liveProgress?.total_bytes ?? download.totalBytes,
    totalIsEstimate: liveProgress?.total_is_estimate ?? download.totalIsEstimate,
    fallbackSize: download.size
  });
  const hasDownloadedAmount = download.status !== 'completed' &&
    Boolean(sizeDisplay.downloaded && sizeDisplay.total);
  const completedSizeLabel = (() => {
    const value = download.status === 'completed' ? formatDownloadTotal(sizeDisplay) : sizeDisplay.fallback;
    return value === 'Unknown' ? t($ => $.addDownloads.unknown) : value;
  })();
  const downloadStatusLabel = t($ => $.downloads.status[download.status]);
  const downloadedSizeLabel = sizeDisplay.totalIsEstimate
    ? t($ => $.downloads.size.downloadedOfApproximate, {
      downloaded: sizeDisplay.downloaded ?? '',
      total: sizeDisplay.total ?? '',
      unit: sizeDisplay.unit ?? '',
    })
    : t($ => $.downloads.size.downloadedOf, {
      downloaded: sizeDisplay.downloaded ?? '',
      total: sizeDisplay.total ?? '',
      unit: sizeDisplay.unit ?? '',
    });

  const columnStyle = (key: DownloadTableColumnKey): React.CSSProperties => ({
    '--column-justify': COLUMN_ALIGNMENT_JUSTIFY[columnAlignments[key]],
    gridColumn: getColumnGridColumn(key, columnOrder),
  } as React.CSSProperties);

  const cells: Record<DownloadTableColumnKey, React.ReactNode> = {
    'File Name': (
      <div
        className="download-column-cell download-file-cell download-column-file-name"
        style={columnStyle('File Name')}
      >
        <div className="download-cell-content">
          <span className="shrink-0 text-text-muted">
            {getCategoryIcon(download.category)}
          </span>
          <span className="download-file-name" title={download.fileName}>
            {download.fileName}
          </span>
        </div>
      </div>
    ),
    Size: (
      <div
        className="download-column-cell download-cell-truncate download-size-cell tabular-nums"
        style={columnStyle('Size')}
        title={hasDownloadedAmount ? downloadedSizeLabel : completedSizeLabel}
        aria-label={hasDownloadedAmount ? downloadedSizeLabel : completedSizeLabel}
      >
        <div className="download-cell-content download-size-content">
          {hasDownloadedAmount ? (
            <span className="download-size-progress">
              <span className={downloadProgressColorClass(download.status)}>{sizeDisplay.downloaded}</span>
              <span className="text-text-muted"> / </span>
            </span>
          ) : null}
          <span className="download-size-total">
            {hasDownloadedAmount
              ? `${sizeDisplay.totalIsEstimate ? '~' : ''}${sizeDisplay.total} ${sizeDisplay.unit}`
              : completedSizeLabel}
          </span>
        </div>
      </div>
    ),
    Status: (
      <div
        className="download-column-cell download-status-cell"
        style={columnStyle('Status')}
      >
        {download.status === 'completed' ? (
          <span className="download-cell-content download-status download-status-completed" title={downloadStatusLabel}>
            {downloadStatusLabel}
          </span>
        ) : (
          <div className="download-cell-content download-status-content">
            <div className="download-progress-track">
              <div
                className={`download-progress-fill ${
                  download.status === 'paused' ? 'paused' :
                  download.status === 'processing' ? 'processing' :
                  download.status === 'queued' || download.status === 'staged' ? 'queued' :
                  download.status === 'retrying' ? 'retrying' : ''
                }`}
                style={{ width: `${displayFraction * 100}%` }}
              />
            </div>
            <span
              title={
                download.lastError && (download.status === 'failed' || download.status === 'retrying')
                  ? download.lastError
                  : (download.status === 'queued' || download.status === 'staged') && queueIndex !== -1
                  ? `${downloadStatusLabel} #${queueIndex + 1}`
                  : download.status === 'downloading'
                  ? displayPercent
                  : download.status === 'processing'
                  ? downloadStatusLabel
                  : downloadStatusLabel
              }
              className={`download-status flex items-center gap-1.5 ${
                download.status === 'paused' ? 'download-status-paused' :
                download.status === 'failed' ? 'download-status-failed' :
                download.status === 'processing' ? 'download-status-processing' :
                download.status === 'downloading' ? 'download-status-downloading' :
                download.status === 'queued' || download.status === 'staged' ? 'download-status-queued' :
                download.status === 'retrying' ? 'download-status-retrying' : ''
              }`}
            >
              {(download.status === 'queued' || download.status === 'staged') && queueIndex !== -1 ? (
                <>
                  <Clock size={12} className={download.status === 'queued' ? 'animate-pulse shrink-0' : 'shrink-0'} />
                  <span className="truncate">
                    {downloadStatusLabel} #{queueIndex + 1}
                  </span>
                </>
              ) : download.status === 'downloading' ? (
                displayPercent
              ) : download.status === 'processing' ? (
                downloadStatusLabel
              ) : (
                downloadStatusLabel
              )}
            </span>
          </div>
        )}
      </div>
    ),
    Speed: (
      <div className="download-column-cell download-cell-truncate" style={columnStyle('Speed')}>
        <span className="download-cell-content tabular-nums" title={displaySpeed}>
          {displaySpeed}
        </span>
      </div>
    ),
    ETA: (
      <div className="download-column-cell download-cell-truncate" style={columnStyle('ETA')}>
        <span className="download-cell-content tabular-nums" title={displayEta}>
          {displayEta}
        </span>
      </div>
    ),
    'Date Added': (
      <div className="download-column-cell download-cell-right download-column-date-added" style={columnStyle('Date Added')}>
        <span
          className="download-cell-content download-date-value tabular-nums"
          title={download.dateAdded ? new Date(download.dateAdded).toLocaleDateString() : '-'}
        >
          {download.dateAdded ? new Date(download.dateAdded).toLocaleDateString() : '-'}
        </span>
      </div>
    ),
  };

  const rowActions = (
    <div
      className="download-row-actions hidden group-hover:flex items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {(download.status === 'queued' || download.status === 'staged') && queueIndex !== -1 && (
        <>
          <button
            onClick={() => onMoveInQueue(download.id, 'up')}
            disabled={queueIndex === 0}
            className="app-icon-button h-7 w-7 disabled:opacity-40"
            title={t($ => $.downloads.actions.moveUp)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            onClick={() => onMoveInQueue(download.id, 'down')}
            disabled={queueIndex === queueLength - 1}
            className="app-icon-button h-7 w-7 disabled:opacity-40"
            title={t($ => $.downloads.actions.moveDown)}
          >
            <ArrowDown size={14} />
          </button>
        </>
      )}
      {canPauseDownload(download.status) && (
        <button onClick={() => handlePause(download.id)} className="app-icon-button h-7 w-7" title={t($ => $.downloads.actions.pause)}>
          <Pause size={14} fill="currentColor" />
        </button>
      )}
      {canStartDownload(download.status) && (
        <button onClick={() => handleResume(download)} className="app-icon-button h-7 w-7" title={download.status === 'paused' ? t($ => $.downloads.actions.resume) : t($ => $.downloads.actions.start)}>
          <Play size={14} fill="currentColor" />
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, id: download.id });
        }}
        className="app-icon-button h-7 w-7"
        title={t($ => $.downloads.actions.options)}
      >
        <MoreVertical size={14} />
      </button>
    </div>
  );

  return (
    <div
      className={`download-row group cursor-default relative ${index % 2 !== 0 ? 'striped' : ''} ${isSelected ? 'is-selected' : ''}`}
      style={{ gridTemplateColumns: tableGridTemplate, minWidth: tableMinWidth }}
      onClick={(e) => onClick(e, download)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, id: download.id });
      }}
    >
      {columnOrder.map(columnKey => (
        <React.Fragment key={columnKey}>{cells[columnKey]}</React.Fragment>
      ))}
      {rowActions}
    </div>
  );
});
