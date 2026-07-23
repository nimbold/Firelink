import React from 'react';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { Play, Pause, MoreVertical, Clock } from 'lucide-react';
import type { DownloadItem as DownloadItemType } from '../bindings/DownloadItem';
import { canPauseDownload, canStartDownload } from '../utils/downloadActions';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { formatDateTime } from '../utils/dateTime';
import {
  downloadProgressColorClass,
  formatDownloadTotal,
  resolveDownloadSizeDisplay
} from '../utils/downloadProgress';
import {
  COLUMN_ALIGNMENT_JUSTIFY,
  DOWNLOAD_ACTIONS_COLUMN_WIDTH,
  DOWNLOAD_ACTIONS_VIEWPORT_INSET,
  getColumnGridColumn,
  type DownloadColumnAlignment,
  type DownloadTableColumnKey
} from '../utils/downloadTableColumns';

interface DownloadItemProps {
  download: DownloadItemType;
  queueIndex: number;
  columnOrder: DownloadTableColumnKey[];
  columnAlignments: Record<DownloadTableColumnKey, DownloadColumnAlignment>;
  tableGridTemplate: string;
  tableMinWidth: number | string;
  setContextMenu: (menu: { x: number; y: number; id: string }) => void;
  handlePause: (id: string, skipConfirm?: boolean) => void;
  handleResume: (item: DownloadItemType) => void;
  getCategoryIcon: (category: string) => React.ReactNode;
  isSelected: boolean;
  isQueueReorderable: boolean;
  isQueueDragSource: boolean;
  onMoveInQueue: (id: string, direction: 'up' | 'down') => void;
  onQueueDragStart: (id: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent, item: DownloadItemType) => void;
}

export const DownloadItem = React.memo<DownloadItemProps>(({
  download,
  queueIndex,
  columnOrder,
  columnAlignments,
  tableGridTemplate,
  tableMinWidth,
  setContextMenu,
  handlePause,
  handleResume,
  getCategoryIcon,
  isSelected,
  isQueueReorderable,
  isQueueDragSource,
  onMoveInQueue,
  onQueueDragStart,
  onClick,
}) => {
  const { t, i18n } = useTranslation();
  const calendarPreference = useSettingsStore(state => state.calendarPreference);
  const liveProgress = useDownloadProgressStore(state => state.progressMap[download.id]);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [isRowHovered, setIsRowHovered] = React.useState(false);
  const [isRowFocused, setIsRowFocused] = React.useState(false);
  const [actionPosition, setActionPosition] = React.useState<React.CSSProperties | undefined>();
  const isActionVisible = isRowHovered || isRowFocused;
  const mediaQualityLabel = (() => {
    if (!download.isMedia || typeof download.mediaQuality !== 'string') return undefined;
    const normalized = download.mediaQuality.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 && normalized.length <= 48 ? normalized : undefined;
  })();
  const dateAddedLabel = download.dateAdded
    ? formatDateTime(download.dateAdded, {
        locale: i18n.language,
        calendar: calendarPreference
      })
    : '-';

  const updateActionPosition = React.useCallback(() => {
    const row = rowRef.current;
    const view = row?.closest<HTMLElement>('.downloads-view');
    if (!row || !view) return;

    const horizontalViewport = row.closest<HTMLElement>('.download-table-scroll') ?? view;
    const verticalViewport = row.closest<HTMLElement>('.download-table-list') ?? view;
    const rowRect = row.getBoundingClientRect();
    const horizontalViewportRect = horizontalViewport.getBoundingClientRect();
    const verticalViewportRect = verticalViewport.getBoundingClientRect();
    const viewportTolerance = 1;
    const visibleTop = Math.max(rowRect.top, verticalViewportRect.top);
    const visibleBottom = Math.min(rowRect.bottom, verticalViewportRect.bottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const isVisible = visibleHeight > viewportTolerance;
    const actionHeight = Math.min(rowRect.height, visibleHeight);
    const nextPosition: React.CSSProperties = {
      top: visibleTop,
      right: Math.max(0, window.innerWidth - horizontalViewportRect.right) + DOWNLOAD_ACTIONS_VIEWPORT_INSET,
      height: actionHeight,
      overflow: actionHeight < rowRect.height ? 'hidden' : 'visible',
      visibility: isVisible ? 'visible' : 'hidden',
    };

    setActionPosition(previous => (
      previous?.top === nextPosition.top &&
      previous?.right === nextPosition.right &&
      previous?.height === nextPosition.height &&
      previous?.overflow === nextPosition.overflow &&
      previous?.visibility === nextPosition.visibility
        ? previous
        : nextPosition
    ));
  }, []);

  React.useEffect(() => {
    if (!isActionVisible) return;

    let frame = 0;
    const schedulePositionUpdate = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateActionPosition();
      });
    };

    const row = rowRef.current;
    const view = row?.closest<HTMLElement>('.downloads-view');
    const horizontalViewport = row?.closest<HTMLElement>('.download-table-scroll');
    const verticalViewport = row?.closest<HTMLElement>('.download-table-list');
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedulePositionUpdate);

    updateActionPosition();
    window.addEventListener('resize', schedulePositionUpdate);
    window.addEventListener('scroll', schedulePositionUpdate, true);
    [row, view, horizontalViewport, verticalViewport].forEach(element => {
      if (element) resizeObserver?.observe(element);
    });

    return () => {
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', schedulePositionUpdate, true);
      resizeObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [isActionVisible, updateActionPosition]);

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
          {mediaQualityLabel ? (
            <span className="download-quality-chip shrink-0" title={t($ => $.addDownloads.quality)}>
              {mediaQualityLabel}
            </span>
          ) : null}
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
        data-column-alignment={columnAlignments.Status}
        style={columnStyle('Status')}
      >
        {download.status === 'completed' ? (
          <div className="download-cell-content download-status-content download-status-content-static">
            <span className="download-status download-status-completed" title={downloadStatusLabel}>
              {downloadStatusLabel}
            </span>
          </div>
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
          title={dateAddedLabel}
        >
          {dateAddedLabel}
        </span>
      </div>
    ),
  };

  const rowActions = (
    <div
      className="download-row-actions items-center gap-0.5"
      style={{
        ...actionPosition,
        width: `${DOWNLOAD_ACTIONS_COLUMN_WIDTH}px`,
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
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
      ref={rowRef}
      data-download-id={download.id}
      className={`download-row group cursor-default relative ${isActionVisible ? 'has-visible-actions' : ''} ${isSelected ? 'is-selected' : ''} ${isQueueReorderable ? 'is-queue-reorderable' : ''} ${isQueueDragSource ? 'is-queue-drag-source' : ''}`}
      style={{ minWidth: tableMinWidth }}
      tabIndex={0}
      onMouseEnter={() => {
        setIsRowHovered(true);
        updateActionPosition();
      }}
      onMouseLeave={event => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsRowHovered(false);
        }
      }}
      onFocus={() => {
        setIsRowFocused(true);
        updateActionPosition();
      }}
      onBlur={event => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsRowFocused(false);
        }
      }}
      onPointerDown={event => {
        // Modifier clicks belong to selection. Starting a row drag first can
        // capture the pointer and suppress the click that applies Cmd/Ctrl or
        // Shift selection.
        if (
          isQueueReorderable &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          onQueueDragStart(download.id, event);
        }
      }}
      onClick={(e) => onClick(e, download)}
      onKeyDown={event => {
        if (
          isQueueReorderable &&
          event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        ) {
          event.preventDefault();
          event.stopPropagation();
          onMoveInQueue(download.id, event.key === 'ArrowUp' ? 'up' : 'down');
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, id: download.id });
      }}
    >
      <div
        className="download-row-motion"
        style={{ gridTemplateColumns: tableGridTemplate, minWidth: tableMinWidth }}
      >
        {columnOrder.map(columnKey => (
          <React.Fragment key={columnKey}>{cells[columnKey]}</React.Fragment>
        ))}
      </div>
      {rowActions}
    </div>
  );
});
