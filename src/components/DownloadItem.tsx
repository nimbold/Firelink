import React from 'react';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { Play, Pause, MoreVertical, Clock, RefreshCw } from 'lucide-react';
import type { DownloadItem as DownloadItemType } from '../bindings/DownloadItem';
import {
  canPauseDownload,
  canStartDownload,
  formatDownloadActionCount,
  type DownloadActionCounts,
} from '../utils/downloadActions';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { isAllocationPhaseVisible } from '../utils/downloads';
import { formatDateTime } from '../utils/dateTime';
import {
  downloadProgressColorClass,
  formatTorrentDuration,
  formatDownloadTotal,
  resolveDownloadSizeDisplay,
  resolveDownloadFraction
} from '../utils/downloadProgress';
import {
  COLUMN_ALIGNMENT_JUSTIFY,
  getDownloadActionPosition,
  getColumnGridColumn,
  type DownloadColumnAlignment,
  type DownloadTableColumnKey
} from '../utils/downloadTableColumns';

interface DownloadItemProps {
  download: DownloadItemType;
  allocationPending: boolean;
  queueIndex: number;
  columnOrder: DownloadTableColumnKey[];
  columnAlignments: Record<DownloadTableColumnKey, DownloadColumnAlignment>;
  tableGridTemplate: string;
  tableMinWidth: number | string;
  setContextMenu: (menu: { x: number; y: number; id: string }) => void;
  handlePause: (id: string, skipConfirm?: boolean) => void;
  handleResume: (item: DownloadItemType) => void;
  handlePauseSelected: () => void;
  handleResumeSelected: () => void;
  getCategoryIcon: (category: string) => React.ReactNode;
  isSelected: boolean;
  selectedDownloadCount: number;
  selectedActionCounts: DownloadActionCounts;
  isQueueReorderable: boolean;
  isQueueDragSource: boolean;
  onMoveInQueue: (id: string, direction: 'up' | 'down') => void;
  onQueueDragStart: (id: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onClick: (e: React.MouseEvent, item: DownloadItemType) => void;
}

export const DownloadItem = React.memo<DownloadItemProps>(({
  download,
  allocationPending,
  queueIndex,
  columnOrder,
  columnAlignments,
  tableGridTemplate,
  tableMinWidth,
  setContextMenu,
  handlePause,
  handleResume,
  handlePauseSelected,
  handleResumeSelected,
  getCategoryIcon,
  isSelected,
  selectedDownloadCount,
  selectedActionCounts,
  isQueueReorderable,
  isQueueDragSource,
  onMoveInQueue,
  onQueueDragStart,
  onClick,
}) => {
  const { t, i18n } = useTranslation();
  const calendarPreference = useSettingsStore(state => state.calendarPreference);
  const liveProgress = useDownloadProgressStore(state => state.progressMap[download.id]);
  const moveProgress = useDownloadProgressStore(state => state.moveProgressMap[download.id]);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [isRowHovered, setIsRowHovered] = React.useState(false);
  const [isRowKeyboardFocused, setIsRowKeyboardFocused] = React.useState(false);
  const [isActionHovered, setIsActionHovered] = React.useState(false);
  const [isActionFocused, setIsActionFocused] = React.useState(false);
  const [actionPosition, setActionPosition] = React.useState<React.CSSProperties | undefined>();
  const allocationVisible = isAllocationPhaseVisible(allocationPending, download.status);
  const hasRowActions = download.status !== 'completed';
  const isBulkSelection = isSelected && selectedDownloadCount > 1;
  const pauseSelectionCount = isBulkSelection && selectedActionCounts.pause > 0
    ? selectedActionCounts.pause
    : null;
  const resumeSelectionCount = isBulkSelection && selectedActionCounts.resume > 0
    ? selectedActionCounts.resume
    : null;
  const canResumeAction = isBulkSelection
    ? selectedActionCounts.resume > 0
    : canStartDownload(download.status);
  const canPauseAction = isBulkSelection
    ? selectedActionCounts.pause > 0
    : canPauseDownload(download.status);
  const selectedCountLabel = (count: number | null) => count === null
    ? null
    : t($ => $.downloadTable.summary.selected, { count });
  const isActionVisible = hasRowActions && (
    isRowHovered ||
    isActionHovered ||
    isRowKeyboardFocused ||
    isActionFocused
  );
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
    const rowPadding = Number.parseFloat(getComputedStyle(row).getPropertyValue('--download-row-padding-x'));
    const nextPosition = getDownloadActionPosition(
      rowRect,
      horizontalViewportRect,
      verticalViewportRect,
      window.innerWidth,
      Number.isFinite(rowPadding) ? rowPadding : undefined
    );

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

  React.useLayoutEffect(() => {
    if (!isActionVisible) return;

    let frame: number | null = null;
    const schedulePositionUpdate = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
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
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [isActionVisible, updateActionPosition]);

  const progressFraction = download.status === 'moving'
    ? moveProgress ?? download.fraction
    : download.status === 'downloading' || download.status === 'verifying' || download.status === 'seeding'
    ? liveProgress?.fraction ?? download.fraction
    : download.fraction;
  const displayFraction = download.status === 'moving' && moveProgress !== undefined
    ? Math.max(0, Math.min(1, moveProgress))
    : download.status === 'moving'
    ? resolveDownloadFraction({ fraction: progressFraction, status: download.status })
    : resolveDownloadFraction({
      fraction: progressFraction,
      downloadedBytes: liveProgress?.downloaded_bytes ?? download.downloadedBytes,
      totalBytes: liveProgress?.total_bytes ?? download.totalBytes,
      totalIsEstimate: liveProgress?.total_is_estimate ?? download.totalIsEstimate,
      isMedia: download.isMedia,
      size: download.size,
      status: download.status,
    });
  const displayPercent = `${(displayFraction * 100).toFixed(0)}%`;
  const displaySpeed = allocationVisible
    ? '-'
    : download.status === 'seeding'
    ? liveProgress?.upload_speed ?? '-'
    : download.status === 'downloading' || download.status === 'verifying'
    ? liveProgress?.speed ?? download.speed
    : download.status === 'processing'
      ? t($ => $.downloads.values.processing)
      : '-';
  const displayEta = allocationVisible
    ? '-'
    : download.status === 'seeding'
    ? typeof download.torrentSeedRemaining === 'number' && Number.isFinite(download.torrentSeedRemaining) && download.torrentSeedRemaining > 0
      ? formatTorrentDuration(download.torrentSeedRemaining * 60, i18n.language)
      : '-'
    : download.status === 'downloading' || download.status === 'verifying'
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
  const downloadStatusLabel = allocationVisible
    ? t($ => $.downloads.status.allocatingFiles)
    : t($ => $.downloads.status[download.status]);
  const visibleErrorStatusLabel = download.lastErrorKind === 'nameResolution'
    ? download.status === 'retrying' && download.lastResolverFallback === true
      ? t($ => $.downloads.errors.nameResolutionRetrying)
      : download.status === 'failed'
        ? t($ => $.downloads.errors.nameResolutionFailed)
        : downloadStatusLabel
    : downloadStatusLabel;
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
        data-column-key="File Name"
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
          {download.isTorrent ? (
            <span className="download-quality-chip shrink-0" title={t($ => $.addDownloads.torrent)}>
              {t($ => $.addDownloads.torrent)}
            </span>
          ) : null}
        </div>
      </div>
    ),
    Size: (
      <div
        className="download-column-cell download-cell-truncate download-size-cell tabular-nums"
        data-column-key="Size"
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
        data-column-key="Status"
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
            <div
              className="download-progress-track"
              aria-label={allocationVisible ? downloadStatusLabel : undefined}
              aria-busy={allocationVisible ? true : undefined}
              aria-valuetext={allocationVisible ? downloadStatusLabel : undefined}
              role={allocationVisible ? 'progressbar' : undefined}
            >
              <div
                className={`download-progress-fill ${
                  allocationVisible ? 'allocating' :
                  download.status === 'paused' ? 'paused' :
                  download.status === 'seeding' ? 'seeding' :
                  download.status === 'processing' ? 'processing' :
                  download.status === 'verifying' ? 'processing' :
                  download.status === 'moving' ? 'processing' :
                  download.status === 'queued' || download.status === 'staged' ? 'queued' :
                  download.status === 'retrying' ? 'retrying' : ''
                }`}
                style={{ width: allocationVisible ? undefined : `${displayFraction * 100}%` }}
              />
            </div>
            <span
              title={
                allocationVisible
                  ? downloadStatusLabel
                  : download.lastError && (
                  download.status === 'failed'
                  || download.status === 'retrying'
                  || download.lastErrorKind === 'destinationAccess'
                )
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
                allocationVisible ? 'download-status-downloading' :
                download.status === 'paused' ? 'download-status-paused' :
                download.status === 'seeding' ? 'download-status-seeding' :
                download.status === 'failed' ? 'download-status-failed' :
                  download.status === 'processing' ? 'download-status-processing' :
                download.status === 'verifying' ? 'download-status-processing' :
                download.status === 'moving' ? 'download-status-processing' :
                download.status === 'downloading' ? 'download-status-downloading' :
                download.status === 'queued' || download.status === 'staged' ? 'download-status-queued' :
                download.status === 'retrying' ? 'download-status-retrying' : ''
              }`}
            >
              {allocationVisible ? (
                <>
                  <RefreshCw size={12} className="animate-spin motion-reduce:animate-none shrink-0" aria-hidden="true" />
                  <span className="truncate">{downloadStatusLabel}</span>
                </>
              ) : (download.status === 'queued' || download.status === 'staged') && queueIndex !== -1 ? (
                <>
                  <Clock size={12} className={download.status === 'queued' ? 'animate-pulse motion-reduce:animate-none shrink-0' : 'shrink-0'} />
                  <span className="truncate">
                    {downloadStatusLabel} #{queueIndex + 1}
                  </span>
                </>
              ) : download.status === 'downloading' || download.status === 'verifying' || download.status === 'moving' ? (
                displayPercent
              ) : download.status === 'seeding' ? (
                displayPercent
              ) : download.status === 'processing' ? (
                downloadStatusLabel
              ) : (
                visibleErrorStatusLabel
              )}
            </span>
          </div>
        )}
      </div>
    ),
    Speed: (
      <div className="download-column-cell download-cell-truncate" data-column-key="Speed" style={columnStyle('Speed')}>
        <span className="download-cell-content tabular-nums" title={displaySpeed}>
          {displaySpeed}
        </span>
      </div>
    ),
    ETA: (
      <div className="download-column-cell download-cell-truncate" data-column-key="ETA" style={columnStyle('ETA')}>
        <span className="download-cell-content tabular-nums" title={displayEta}>
          {displayEta}
        </span>
      </div>
    ),
    'Date Added': (
      <div className="download-column-cell download-cell-right download-column-date-added" data-column-key="Date Added" style={columnStyle('Date Added')}>
        <span
          className="download-cell-content download-date-value tabular-nums"
          title={dateAddedLabel}
        >
          {dateAddedLabel}
        </span>
      </div>
    ),
  };

  const rowActions = hasRowActions ? (
    <div
      className={`download-row-actions main-control-group ${actionPosition?.visibility === 'visible' ? 'is-positioned' : ''}`}
      style={{
        ...actionPosition,
        // Preserve the geometry helper's hidden result when the row is
        // outside the scroll viewport. A fixed rail is not clipped by the
        // list, while visible state remains CSS-owned so pointer handoff
        // cannot leave two rails visible.
        visibility: actionPosition?.visibility === 'hidden' ? 'hidden' : undefined,
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={() => {
        setIsActionHovered(true);
        updateActionPosition();
      }}
      onMouseLeave={() => setIsActionHovered(false)}
      onFocusCapture={event => {
        const target = event.target;
        const keyboardFocused = target instanceof HTMLElement && target.matches(':focus-visible');
        setIsActionFocused(keyboardFocused);
        if (keyboardFocused) updateActionPosition();
      }}
      onBlurCapture={event => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsActionFocused(false);
        }
      }}
    >
      <button
        disabled={!canResumeAction}
        onClick={() => isBulkSelection ? handleResumeSelected() : handleResume(download)}
        className="app-icon-button main-control-button"
        title={resumeSelectionCount === null
          ? download.status === 'paused' ? t($ => $.downloads.actions.resume) : t($ => $.downloads.actions.start)
          : `${t($ => $.downloadTable.startResume)} (${selectedCountLabel(resumeSelectionCount)})`}
        aria-label={resumeSelectionCount === null
          ? download.status === 'paused' ? t($ => $.downloads.actions.resume) : t($ => $.downloads.actions.start)
          : `${t($ => $.downloadTable.startResume)} (${selectedCountLabel(resumeSelectionCount)})`}
      >
        <Play size={14} fill="currentColor" />
        {resumeSelectionCount !== null ? (
          <span className="download-row-action-badge" aria-hidden="true">
            {formatDownloadActionCount(resumeSelectionCount)}
          </span>
        ) : null}
      </button>
      <button
        disabled={!canPauseAction}
        onClick={() => isBulkSelection ? handlePauseSelected() : handlePause(download.id)}
        className="app-icon-button main-control-button"
        title={pauseSelectionCount === null
          ? t($ => $.downloads.actions.pause)
          : `${t($ => $.downloads.actions.pause)} (${selectedCountLabel(pauseSelectionCount)})`}
        aria-label={pauseSelectionCount === null
          ? t($ => $.downloads.actions.pause)
          : `${t($ => $.downloads.actions.pause)} (${selectedCountLabel(pauseSelectionCount)})`}
      >
        <Pause size={14} fill="currentColor" />
        {pauseSelectionCount !== null ? (
          <span className="download-row-action-badge" aria-hidden="true">
            {formatDownloadActionCount(pauseSelectionCount)}
          </span>
        ) : null}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, id: download.id });
        }}
        className="app-icon-button main-control-button"
        title={t($ => $.downloads.actions.options)}
      >
        <MoreVertical size={14} />
      </button>
    </div>
  ) : null;

  return (
    <div
      ref={rowRef}
      data-download-id={download.id}
      className={`download-row group cursor-default relative ${isActionVisible ? 'has-visible-actions' : ''} ${isRowKeyboardFocused || isActionFocused ? 'has-keyboard-action-focus' : ''} ${isSelected ? 'is-selected' : ''} ${isQueueReorderable ? 'is-queue-reorderable' : ''} ${isQueueDragSource ? 'is-queue-drag-source' : ''}`}
      style={{ minWidth: tableMinWidth }}
      tabIndex={0}
      onMouseEnter={() => {
        setIsRowHovered(true);
        if (hasRowActions) updateActionPosition();
      }}
      onMouseLeave={event => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsRowHovered(false);
        }
      }}
      onFocus={() => {
        const target = document.activeElement;
        const keyboardFocused = target instanceof HTMLElement && target.matches(':focus-visible');
        setIsRowKeyboardFocused(keyboardFocused);
        if (hasRowActions && keyboardFocused) updateActionPosition();
      }}
      onBlur={event => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsRowKeyboardFocused(false);
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
