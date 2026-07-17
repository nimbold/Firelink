import React from 'react';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { Play, Pause, MoreVertical, Clock, ArrowUp, ArrowDown } from 'lucide-react';
import type { DownloadItem as DownloadItemType } from '../bindings/DownloadItem';
import { canPauseDownload, canStartDownload, startActionLabel } from '../utils/downloadActions';
import {
  downloadProgressColorClass,
  formatDownloadTotal,
  resolveDownloadSizeDisplay
} from '../utils/downloadProgress';

interface DownloadItemProps {
  download: DownloadItemType;
  index: number;
  queueIndex: number;
  queueLength: number;
  tableGridTemplate: string;
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
  tableGridTemplate,
  setContextMenu,
  handlePause,
  handleResume,
  getCategoryIcon,
  isSelected,
  onMoveInQueue,
  onClick,
}) => {
  const liveProgress = useDownloadProgressStore(state => state.progressMap[download.id]);

  const displayFraction = download.status === 'downloading'
    ? liveProgress?.fraction ?? download.fraction ?? 0
    : download.fraction ?? 0;
  const displayPercent = `${(displayFraction * 100).toFixed(0)}%`;
  const displaySpeed = download.status === 'downloading'
    ? liveProgress?.speed ?? download.speed
    : download.status === 'processing'
      ? 'Processing...'
      : '-';
  const displayEta = download.status === 'downloading'
    ? liveProgress?.eta ?? download.eta
    : download.status === 'processing'
      ? 'Muxing...'
      : '-';
  const sizeDisplay = resolveDownloadSizeDisplay({
    downloadedBytes: liveProgress?.downloaded_bytes ?? download.downloadedBytes,
    totalBytes: liveProgress?.total_bytes ?? download.totalBytes,
    totalIsEstimate: liveProgress?.total_is_estimate ?? download.totalIsEstimate,
    fallbackSize: download.size
  });
  const hasDownloadedAmount = download.status !== 'completed' &&
    Boolean(sizeDisplay.downloaded && sizeDisplay.total);
  const completedSizeLabel = download.status === 'completed'
    ? formatDownloadTotal(sizeDisplay)
    : sizeDisplay.fallback;

  return (
    <div
      className={`download-row group cursor-default relative ${index % 2 !== 0 ? 'striped' : ''} ${isSelected ? 'is-selected' : ''}`}
      style={{ gridTemplateColumns: tableGridTemplate }}
      onClick={(e) => onClick(e, download)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, id: download.id });
      }}
    >
      <div className="download-file-cell">
        <span className="shrink-0 text-text-muted">
          {getCategoryIcon(download.category)}
        </span>
        <span className="download-file-name" title={download.fileName}>
          {download.fileName}
        </span>
      </div>
      
      <div
        className="download-cell-truncate download-size-cell tabular-nums"
        title={hasDownloadedAmount
          ? `${sizeDisplay.downloaded} downloaded of ${sizeDisplay.totalIsEstimate ? '~' : ''}${sizeDisplay.total} ${sizeDisplay.unit}`
          : completedSizeLabel}
        aria-label={hasDownloadedAmount
          ? `${sizeDisplay.downloaded} downloaded of ${sizeDisplay.totalIsEstimate ? 'approximately ' : ''}${sizeDisplay.total} ${sizeDisplay.unit}`
          : completedSizeLabel}
      >
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
      
      <div className="download-status-cell">
        {download.status === 'completed' ? (
          <span className="download-status download-status-completed" title="Completed">Completed</span>
        ) : (
          <>
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
                ? `${download.status === 'staged' ? 'In queue' : 'Queued'} #${queueIndex + 1}`
                : download.status === 'downloading'
                  ? displayPercent
                  : download.status === 'processing'
                    ? 'Processing'
                    : download.status.charAt(0).toUpperCase() + download.status.slice(1)
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
                    {download.status === 'staged' ? 'In queue' : 'Queued'} #{queueIndex + 1}
                  </span>
                </>
              ) : download.status === 'downloading' ? (
                displayPercent
              ) : download.status === 'processing' ? (
                'Processing'
              ) : (
                download.status.charAt(0).toUpperCase() + download.status.slice(1)
              )}
            </span>
          </>
        )}
      </div>
      
      <div className="download-cell-truncate">
        <span
          className="tabular-nums"
          title={displaySpeed}
        >
          {displaySpeed}
        </span>
      </div>

      <div className="download-cell-truncate">
        <span
          className="tabular-nums"
          title={displayEta}
        >
          {displayEta}
        </span>
      </div>

      <div className="download-cell-right">
        <span
          className="truncate group-hover:hidden tabular-nums"
          title={download.dateAdded ? new Date(download.dateAdded).toLocaleDateString() : '-'}
        >
          {download.dateAdded ? new Date(download.dateAdded).toLocaleDateString() : '-'}
        </span>
        
        <div
          className="hidden group-hover:flex items-center justify-end gap-0.5 w-full ml-auto"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {(download.status === 'queued' || download.status === 'staged') && queueIndex !== -1 && (
            <>
              <button 
                onClick={() => onMoveInQueue(download.id, 'up')}
                disabled={queueIndex === 0}
                className="app-icon-button h-7 w-7 disabled:opacity-40" 
                title="Move Up"
              >
                <ArrowUp size={14} />
              </button>
              <button 
                onClick={() => onMoveInQueue(download.id, 'down')}
                disabled={queueIndex === queueLength - 1}
                className="app-icon-button h-7 w-7 disabled:opacity-40" 
                title="Move Down"
              >
                <ArrowDown size={14} />
              </button>
            </>
          )}
          {canPauseDownload(download.status) && (
            <button onClick={() => handlePause(download.id)} className="app-icon-button h-7 w-7" title="Pause">
              <Pause size={14} fill="currentColor" />
            </button>
          )}
          {canStartDownload(download.status) && (
            <button onClick={() => handleResume(download)} className="app-icon-button h-7 w-7" title={startActionLabel(download.status)}>
              <Play size={14} fill="currentColor" />
            </button>
          )}
          <button
            onClick={(e) => {
               e.stopPropagation();
               setContextMenu({ x: e.clientX, y: e.clientY, id: download.id });
            }}
            className="app-icon-button h-7 w-7"
            title="Options"
          >
            <MoreVertical size={14} />
          </button>
        </div>
      </div>
    </div>
  );
});
