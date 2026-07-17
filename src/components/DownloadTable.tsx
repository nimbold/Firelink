import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useDownloadStore, DownloadItem, MAIN_QUEUE_ID } from '../store/useDownloadStore';
import { useToast } from '../contexts/ToastContext';
import { useSettingsStore } from '../store/useSettingsStore';
import { SidebarFilter } from './Sidebar';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { Play, Pause, Plus, FileText, Image as ImageIcon, Music, Film, Box, Archive, FileQuestion, ArrowDownCircle, Command, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { DownloadItem as DownloadItemComponent } from './DownloadItem';
import { invokeCommand as invoke } from '../ipc';
import {
  resolveCategoryDestination,
  resolveDownloadFilePath
} from '../utils/downloadLocations';
import {
  canPauseDownload,
  canRedownload,
  canStartDownload,
  startActionLabel
} from '../utils/downloadActions';
import { isActiveDownloadStatus, isTransferActiveStatus } from '../utils/downloads';
import { readClipboardDownloadUrls } from '../utils/clipboard';
import {
  sortDownloads,
  type DownloadSortColumn,
  type DownloadSortConfig
} from '../utils/downloadTableSorting';

interface DownloadTableProps {
  filter: SidebarFilter;
}

const DEFAULT_COLUMN_WIDTHS = [340, 100, 220, 100, 80, 170];
const COLUMN_WIDTHS_STORAGE_KEY = 'firelink-download-column-widths';

export const DownloadTable: React.FC<DownloadTableProps> = ({ filter }) => {
  const { downloads, queues, assignToQueue, openDeleteModal, redownload, moveInQueue } = useDownloadStore();
  const { addToast } = useToast();
  const isMac = navigator.userAgent.includes('Mac');
  const [isReadingClipboard, setIsReadingClipboard] = useState(false);
  const clipboardReadInFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [animationParent] = useAutoAnimate<HTMLDivElement>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<DownloadSortConfig>({ column: 'Date Added', direction: 'desc' });
  const [queueSortConfig, setQueueSortConfig] = useState<DownloadSortConfig | null>(null);
  const selectedIdsRef = useRef(selectedIds);
  const lastSelectedIdRef = useRef(lastSelectedId);
  const sortedDownloadsRef = useRef<DownloadItem[]>([]);
  selectedIdsRef.current = selectedIds;
  lastSelectedIdRef.current = lastSelectedId;
  const [columnWidths, setColumnWidths] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY) || 'null');
      return Array.isArray(stored) &&
        stored.length === DEFAULT_COLUMN_WIDTHS.length &&
        stored.every(value => typeof value === 'number' && Number.isFinite(value))
        ? stored
        : DEFAULT_COLUMN_WIDTHS;
    } catch {
      return DEFAULT_COLUMN_WIDTHS;
    }
  });
  const columnMinimums = [0, 58, 92, 58, 48, 112];
  const tableGridTemplate = columnWidths.map((width, index) => `minmax(${columnMinimums[index]}px, ${width}fr)`).join(' ');

  const startColumnResize = (index: number, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[index];

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(columnMinimums[index], startWidth + moveEvent.clientX - startX);
      setColumnWidths(widths => widths.map((width, columnIndex) => columnIndex === index ? nextWidth : width));
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-resizing');
    };

    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  useEffect(() => {
    const handleCloseMenu = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', handleCloseMenu);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('click', handleCloseMenu);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('.app-modal-backdrop') || document.querySelector('.app-modal')) return;
      const activeEl = document.activeElement as HTMLElement | null;
      const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
      
      if (!isInput) {
        if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const allIds = sortedDownloadsRef.current.map(d => d.id);
          setSelectedIds(new Set(allIds));
          return;
        }
        
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (!activeEl || !activeEl.closest('.sidebar-inner')) {
            if (selectedIdsRef.current.size > 0) {
              handleDelete(Array.from(selectedIdsRef.current));
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);


  const showInteractionError = useCallback((message: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    addToast({ message: `${message}: ${detail}`, variant: 'error', isActionable: true });
  }, [addToast]);

  const getDownloadPath = useCallback(async (item: DownloadItem) => {
    const fileName = item.fileName?.trim();
    if (!fileName) return null;
    const settings = useSettingsStore.getState();
    const destination = item.destination ||
      await resolveCategoryDestination(settings, item.category);
    return resolveDownloadFilePath(destination, fileName);
  }, []);

  const openProperties = useCallback((id: string) => {
    useDownloadStore.getState().setSelectedPropertiesDownloadId(id);
  }, []);

  const openDownloadFile = useCallback(async (item: DownloadItem) => {
    if (item.status !== 'completed') {
      openProperties(item.id);
      return;
    }

    const fullPath = await getDownloadPath(item);
    if (!fullPath) {
      openProperties(item.id);
      return;
    }

    try {
      await invoke('open_downloaded_file', { path: fullPath });
    } catch (error) {
      console.error("Failed to open file:", error);
      showInteractionError('Could not open downloaded file', error);
    }
  }, [getDownloadPath, openProperties, showInteractionError]);

  const revealDownloadFile = async (item: DownloadItem) => {
    const pathToReveal = await getDownloadPath(item);

    if (!pathToReveal) {
      openProperties(item.id);
      return;
    }

    try {
      await invoke('reveal_in_file_manager', { path: pathToReveal });
    } catch (error) {
      console.error("Failed to show in Finder:", error);
      showInteractionError('Could not show download in Finder', error);
    }
  };

  const handleDownloadDoubleClick = useCallback((item: DownloadItem) => {
    if (item.status === 'completed') {
      void openDownloadFile(item);
      return;
    }

    openProperties(item.id);
  }, [openDownloadFile, openProperties]);

  const isQueueFilter = filter.startsWith('queue:');
  const filteredDownloads = useMemo(() => downloads.filter((d: DownloadItem) => {
    if (isQueueFilter) {
      return d.queueId === filter.replace('queue:', '') && d.status !== 'completed';
    }
    switch (filter) {
      case 'all': return true;
      case 'active': return isTransferActiveStatus(d.status);
      case 'completed': return d.status === 'completed';
      case 'unfinished': return d.status !== 'completed';
      default: return d.category === filter;
    }
  }), [downloads, filter, isQueueFilter]);

  // Queue views use the persisted queue order until the user explicitly sorts
  // a column. This keeps move-up/down controls truthful while still making
  // every header a working sort target.
  const sortedDownloads = useMemo(() => isQueueFilter && !queueSortConfig
    ? [...filteredDownloads].sort((left, right) => {
        const leftActive = isActiveDownloadStatus(left.status) && left.status !== 'queued';
        const rightActive = isActiveDownloadStatus(right.status) && right.status !== 'queued';
        
        if (leftActive && !rightActive) return -1;
        if (!leftActive && rightActive) return 1;
        
        const positionComparison = (left.queuePosition ?? Number.MAX_SAFE_INTEGER) -
          (right.queuePosition ?? Number.MAX_SAFE_INTEGER);
        return positionComparison || left.id.localeCompare(right.id);
      })
    : sortDownloads(filteredDownloads, isQueueFilter ? queueSortConfig! : sortConfig),
    [filteredDownloads, isQueueFilter, queueSortConfig, sortConfig]);

  // Each row used to derive this by filtering and sorting the complete store
  // independently. That made a 1000-entry playlist perform O(n^2 log n) work
  // on every download update. Compute the same queue membership once and pass
  // the resulting position to rows instead.
  const queuePositionsByDownloadId = useMemo(() => {
    const grouped = new Map<string, DownloadItem[]>();
    for (const download of downloads) {
      if (
        download.status === 'completed'
        || (isActiveDownloadStatus(download.status) && download.status !== 'queued')
      ) {
        continue;
      }
      const queueId = download.queueId || MAIN_QUEUE_ID;
      const queueItems = grouped.get(queueId) || [];
      queueItems.push(download);
      grouped.set(queueId, queueItems);
    }

    const positions = new Map<string, { index: number; length: number }>();
    for (const queueItems of grouped.values()) {
      queueItems.sort((left, right) =>
        (left.queuePosition ?? Number.MAX_SAFE_INTEGER) -
        (right.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      );
      queueItems.forEach((download, index) => {
        positions.set(download.id, { index, length: queueItems.length });
      });
    }
    return positions;
  }, [downloads]);
  sortedDownloadsRef.current = sortedDownloads;

  useEffect(() => {
    const visibleIds = new Set(sortedDownloads.map(download => download.id));
    setSelectedIds(current => {
      const next = new Set(Array.from(current).filter(id => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setLastSelectedId(current => current && visibleIds.has(current) ? current : null);
  }, [sortedDownloads]);

  useEffect(() => {
    setQueueSortConfig(null);
  }, [filter, isQueueFilter]);
  const handleItemClick = useCallback((e: React.MouseEvent, item: DownloadItem) => {
    if (e.detail === 2) {
      handleDownloadDoubleClick(item);
      return;
    }
    const currentSortedDownloads = sortedDownloadsRef.current;
    const currentSelectedIds = selectedIdsRef.current;
    const currentLastSelectedId = lastSelectedIdRef.current;
    if (e.shiftKey && currentLastSelectedId) {
      const currentIndex = currentSortedDownloads.findIndex(d => d.id === item.id);
      const lastIndex = currentSortedDownloads.findIndex(d => d.id === currentLastSelectedId);
      
      if (currentIndex !== -1 && lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex);
        const end = Math.max(currentIndex, lastIndex);
        
        const newSelected = (e.metaKey || e.ctrlKey) ? new Set(currentSelectedIds) : new Set<string>();
        for (let i = start; i <= end; i++) {
          newSelected.add(currentSortedDownloads[i].id);
        }
        setSelectedIds(newSelected);
      }
    } else if (e.metaKey || e.ctrlKey) {
      const newSelected = new Set(currentSelectedIds);
      if (newSelected.has(item.id)) {
        newSelected.delete(item.id);
      } else {
        newSelected.add(item.id);
      }
      setSelectedIds(newSelected);
      setLastSelectedId(item.id);
    } else {
      setSelectedIds(new Set([item.id]));
      setLastSelectedId(item.id);
    }
  }, [handleDownloadDoubleClick]);

  const handleContextMenu = useCallback((menu: { x: number; y: number; id: string }) => {
    if (!selectedIdsRef.current.has(menu.id)) {
      setSelectedIds(new Set([menu.id]));
      setLastSelectedId(menu.id);
    }
    setContextMenu(menu);
  }, []);

  const handleMoveInQueue = useCallback((id: string, direction: 'up' | 'down') => {
    const ids = selectedIdsRef.current.has(id)
      ? Array.from(selectedIdsRef.current)
      : id;
    void moveInQueue(ids, direction);
  }, [moveInQueue]);

  const handleSort = (column: DownloadSortColumn) => {
    const update = (current: DownloadSortConfig | null): DownloadSortConfig =>
      current?.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' };

    if (isQueueFilter) {
      setQueueSortConfig(update);
    } else {
      setSortConfig(current => update(current));
    }
  };


  const getFilterTitle = () => {
    if (filter.startsWith('queue:')) {
      const qid = filter.replace('queue:', '');
      const queue = useDownloadStore.getState().queues.find(q => q.id === qid);
      return queue ? queue.name : 'Unknown Queue';
    }
    switch (filter) {
      case 'all': return 'All Downloads';
      case 'active': return 'Active';
      case 'completed': return 'Completed';
      case 'unfinished': return 'Unfinished';
      default: return filter;
    }
  };

  const handlePause = useCallback(async (id: string, skipConfirm = false) => {
    const download = useDownloadStore.getState().downloads.find(d => d.id === id);
    if (!skipConfirm && download && download.resumable === false) {
      const confirmPause = window.confirm("This download does not support resuming. If you pause it, you will have to start over again later. Are you sure you want to pause?");
      if (!confirmPause) {
        return;
      }
    }

    try {
      await useDownloadStore.getState().pauseDownload(id);
    } catch (e) {
      console.error("Failed to pause:", e);
      showInteractionError('Could not pause download', e);
    }
  }, [showInteractionError]);

  const handleResume = useCallback(async (item: DownloadItem) => {
    try {
      const resumed = await useDownloadStore.getState().resumeDownload(item.id);
      if (!resumed) {
        throw new Error('The backend rejected the start/resume request.');
      }
    } catch (error) {
      console.error("Failed to resume:", error);
      showInteractionError(`Could not resume ${item.fileName}`, error);
    }
  }, [showInteractionError]);

  const resumeItemsSequentially = async (items: DownloadItem[]) => {
    for (const item of items) {
      const current = useDownloadStore.getState().downloads.find(download => download.id === item.id);
      if (current && canStartDownload(current.status)) {
        await handleResume(current);
      }
    }
  };

  const handleDelete = (ids: string | string[]) => {
    openDeleteModal(ids);
  };

  const contextItem = contextMenu ? downloads.find(d => d.id === contextMenu.id) : null;

  const handleAddDownload = async () => {
    if (clipboardReadInFlightRef.current) return;

    clipboardReadInFlightRef.current = true;
    setIsReadingClipboard(true);
    const store = useDownloadStore.getState();
    const initialModalState = {
      isOpen: store.isAddModalOpen,
      requestVersion: store.pendingAddRequestVersion,
    };

    try {
      const urls = await readClipboardDownloadUrls();
      if (!isMountedRef.current) return;
      const currentStore = useDownloadStore.getState();

      // Do not append a late clipboard result to a newer extension, deep-link,
      // paste, or modal request that arrived while the OS clipboard was read.
      if (
        currentStore.isAddModalOpen !== initialModalState.isOpen ||
        currentStore.pendingAddRequestVersion !== initialModalState.requestVersion
      ) {
        return;
      }

      if (urls.length > 0) {
        currentStore.openAddModalWithUrls(urls.join('\n'));
      } else {
        currentStore.toggleAddModal(true);
      }
    } catch (error) {
      console.warn('Could not read clipboard for Add Download:', error);
      if (!isMountedRef.current) return;
      const currentStore = useDownloadStore.getState();
      if (
        currentStore.isAddModalOpen === initialModalState.isOpen &&
        currentStore.pendingAddRequestVersion === initialModalState.requestVersion
      ) {
        currentStore.toggleAddModal(true);
      }
    } finally {
      clipboardReadInFlightRef.current = false;
      if (isMountedRef.current) setIsReadingClipboard(false);
    }
  };


  const getCategoryIcon = useCallback((category: string) => {
    switch(category) {
      case 'Musics': return <Music size={16} className="text-pink-400" />;
      case 'Movies': return <Film size={16} className="text-red-400" />;
      case 'Documents': return <FileText size={16} className="text-blue-400" />;
      case 'Applications': return <Box size={16} className="text-indigo-400" />;
      case 'Pictures': return <ImageIcon size={16} className="text-purple-400" />;
      case 'Compressed': return <Archive size={16} className="text-amber-600" />;
      case 'Other': return <FileQuestion size={16} className="text-gray-400" />;
      default: return <FileQuestion size={16} className="text-gray-400" />;
    }
  }, []);

  return (
    <div className="downloads-view flex-1 flex flex-col h-full min-w-0">
      <div
        className="main-titlebar"
        data-tauri-drag-region
      >
        <div className="main-titlebar-title cursor-default" data-tauri-drag-region>Firelink</div>

        <div className="main-control-group">
          <button
            className="main-control-button primary"
            onClick={() => void handleAddDownload()}
            disabled={isReadingClipboard}
            aria-busy={isReadingClipboard}
            title="Add Download"
          >
            <Plus size={16} />
          </button>

          <button 
            className="main-control-button" 
            disabled={sortedDownloads.length === 0}
            onClick={() => {
              void resumeItemsSequentially(sortedDownloads.filter(d => canStartDownload(d.status)));
            }}
            title="Resume All"
          >
            <Play size={15} fill="currentColor" />
          </button>

          <button 
            className="main-control-button" 
            disabled={sortedDownloads.length === 0}
            onClick={() => {
              const toPause = sortedDownloads.filter(d => canPauseDownload(d.status));
              const nonResumableCount = toPause.filter(d => d.resumable === false).length;
              if (nonResumableCount > 0) {
                const confirmPause = window.confirm(
                  nonResumableCount === 1
                    ? "1 download does not support resuming. If you pause it, you will have to start over again later. Are you sure you want to pause?"
                    : `${nonResumableCount} downloads do not support resuming. If you pause them, you will have to start over again later. Are you sure you want to pause?`
                );
                if (!confirmPause) {
                  return;
                }
              }
              // Skip the individual check by passing a flag to handlePause, or just invoking directly.
              toPause.forEach(d => handlePause(d.id, true));
            }}
            title="Pause All"
          >
            <Pause size={15} fill="currentColor" />
          </button>
        </div>
      </div>

      <div className="downloads-content-header">
        <div className="downloads-title">
          {getFilterTitle()}
          <span className="downloads-count">{sortedDownloads.length}</span>
        </div>
      </div>

      <div className="downloads-table flex-1 flex flex-col">
        <div className="download-table-scroll">
          <div className="download-table-header" style={{ gridTemplateColumns: tableGridTemplate }}>
            {['File Name', 'Size', 'Status', 'Speed', 'ETA', 'Date Added'].map((label, index) => (
              <div 
                key={label} 
                className={`${index === 5 ? 'download-cell-right' : ''} cursor-pointer hover:text-text-primary transition-colors flex items-center justify-between`}
                onClick={() => handleSort(label as DownloadSortColumn)}
              >
                <div className="flex items-center gap-1 w-full h-full select-none">
                  <span>{label}</span>
                  {(isQueueFilter ? queueSortConfig : sortConfig)?.column === label && (
                    (isQueueFilter ? queueSortConfig : sortConfig)?.direction === 'asc'
                      ? <ChevronUp size={14} />
                      : <ChevronDown size={14} />
                  )}
                </div>
                <div
                  className="column-resize-handle"
                  onPointerDown={(event) => startColumnResize(index, event)}
                />
              </div>
            ))}
          </div>

          <div className="download-table-body">
            <div className="download-table-list" ref={animationParent}>
              {sortedDownloads.length === 0 ? (
                <div className="downloads-empty-state">
                  <ArrowDownCircle aria-hidden="true" />
                  <div className="downloads-empty-title">
                    {isQueueFilter ? 'Queue is empty' : filter === 'completed' ? 'No Completed Downloads' : 'No Downloads'}
                  </div>
                  <div className="downloads-empty-description flex items-center justify-center mt-2.5 text-[13px] text-text-muted">
                    {isQueueFilter ? (
                      'Add downloads to this queue from an item menu or the Add window.'
                    ) : filter === 'completed' ? (
                      'Completed downloads will appear here.'
                    ) : (
                      <>
                        Click <Plus size={15} className="text-accent stroke-[3] mx-1.5" /> button or
                        <span className="flex items-center mx-1.5">
                          <span className="flex items-center justify-center px-1.5 py-0.5 bg-item-hover rounded border border-border-color shadow-sm min-w-[22px] min-h-[22px]">
                            {isMac ? <Command size={12} strokeWidth={2.5} className="text-text-primary" /> : <span className="text-[10px] font-bold text-text-primary">Ctrl</span>}
                          </span>
                          <span className="text-accent font-bold mx-1.5 text-[14px]">+</span>
                          <span className="flex items-center justify-center px-1.5 py-0.5 bg-item-hover rounded border border-border-color shadow-sm min-w-[22px] min-h-[22px]">
                            <span className="text-[11px] font-bold text-text-primary">V</span>
                          </span>
                        </span>
                        to add downloads
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {sortedDownloads.map((d, index) => (
                    <DownloadItemComponent
                      key={d.id}
                      download={d}
                      index={index}
                      queueIndex={queuePositionsByDownloadId.get(d.id)?.index ?? -1}
                      queueLength={queuePositionsByDownloadId.get(d.id)?.length ?? 0}
                      tableGridTemplate={tableGridTemplate}
                      setContextMenu={handleContextMenu}
                      handlePause={handlePause}
                      handleResume={handleResume}
                      getCategoryIcon={getCategoryIcon}
                      isSelected={selectedIds.has(d.id)}
                      onMoveInQueue={handleMoveInQueue}
                      onClick={handleItemClick}
                    />
                  ))}
                  <div className="flex-1 min-h-0 bg-transparent pointer-events-none" />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Floating Context Menu */}
      {contextMenu && contextItem && (
        <div
          role="menu"
          className="app-modal fixed z-50 min-w-[180px] overflow-visible py-1.5 text-[12px] font-medium text-text-primary"
          style={{
             top: Math.min(contextMenu.y, window.innerHeight - 300),
             left: Math.min(contextMenu.x, window.innerWidth - 200)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {selectedIds.size > 1 ? (() => {
            const selectedDownloads = Array.from(selectedIds)
              .map(id => downloads.find(d => d.id === id))
              .filter((item): item is DownloadItem => !!item);
            
            const itemsToResume = selectedDownloads.filter(d => canStartDownload(d.status));
            const itemsToPause = selectedDownloads.filter(d => canPauseDownload(d.status));
            const itemsToQueue = selectedDownloads.filter(d => d.status !== 'completed');

            return (
            <>
              {/* Multi-Select Context Menu */}
              {itemsToResume.length > 0 && (
              <button
              onClick={() => {
                setContextMenu(null);
                void resumeItemsSequentially(itemsToResume);
              }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                Start/Resume
              </button>
              )}

              {itemsToPause.length > 0 && (
                <button
                  onClick={() => {
                    setContextMenu(null);
                    const nonResumableCount = itemsToPause.filter(d => d.resumable === false).length;
                    if (nonResumableCount > 0) {
                      const confirmPause = window.confirm(
                        nonResumableCount === 1
                          ? "1 download does not support resuming. If you pause it, you will have to start over again later. Are you sure you want to pause?"
                          : `${nonResumableCount} downloads do not support resuming. If you pause them, you will have to start over again later. Are you sure you want to pause?`
                      );
                      if (!confirmPause) {
                        return;
                      }
                    }
                    itemsToPause.forEach(d => handlePause(d.id, true));
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  Pause
                </button>
              )}

              {(itemsToResume.length > 0 || itemsToPause.length > 0) && (
                <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>
              )}

              {itemsToQueue.length > 0 && (
                <div className="group relative">
                  <button className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors flex justify-between items-center">
                    Add to Queue
                    <ChevronRight size={14} />
                  </button>
                  <div className="absolute left-full top-0 hidden group-hover:block ml-1 min-w-[150px] bg-bg-modal border border-border-modal rounded-lg shadow-lg py-1.5 z-50">
                    {queues.map(q => (
                      <button key={q.id} onClick={() => {
                        setContextMenu(null);
                        void assignToQueue(itemsToQueue.map(item => item.id), q.id).catch(error => {
                          showInteractionError('Could not move downloads to queue', error);
                        });
                      }} className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors text-[12px]">
                        {q.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  const urls = Array.from(selectedIds)
                    .map(id => downloads.find(d => d.id === id)?.url)
                    .filter(Boolean)
                    .join('\n');
                  navigator.clipboard.writeText(urls).catch(error => {
                    showInteractionError('Could not copy addresses', error);
                  });
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                Copy Address
              </button>

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  handleDelete(Array.from(selectedIds));
                }}
                className="w-full text-left px-3 py-2 text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Remove
              </button>
            </>
            );
          })() : (
            <>
              {/* Single-Select Context Menu */}
              {contextItem.status === 'completed' && (
                <button
                  onClick={async () => {
                    setContextMenu(null);
                    await openDownloadFile(contextItem);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  Open
                </button>
              )}

              <button
                onClick={async () => {
                  setContextMenu(null);
                  await revealDownloadFile(contextItem);
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
              Show in Folder
              </button>

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              {canPauseDownload(contextItem.status) && (
                <button
                  onClick={() => {
                    setContextMenu(null);
                    handlePause(contextItem.id);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  Pause
                </button>
              )}

              {canStartDownload(contextItem.status) && (
                <button
                  onClick={() => {
                    setContextMenu(null);
                    handleResume(contextItem);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  {startActionLabel(contextItem.status)}
                </button>
              )}

              {canRedownload(contextItem.status) && (
                <button
                  onClick={async () => {
                    setContextMenu(null);
                    try {
                      await redownload(contextItem.id);
                    } catch (error) {
                      showInteractionError('Redownload failed', error);
                    }
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  Redownload
                </button>
              )}

              {contextItem.status !== 'completed' && (
                <div className="group relative">
                  <button className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors flex justify-between items-center">
                    Add to Queue
                    <ChevronRight size={14} />
                  </button>
                  <div className="absolute left-full top-0 hidden group-hover:block ml-1 min-w-[150px] bg-bg-modal border border-border-modal rounded-lg shadow-lg py-1.5 z-50">
                    {queues.map(q => (
                      <button key={q.id} onClick={() => {
                        setContextMenu(null);
                        void assignToQueue([contextItem.id], q.id).catch(error => {
                          showInteractionError('Could not move download to queue', error);
                        });
                      }} className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors text-[12px]">
                        {q.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  navigator.clipboard.writeText(contextItem.url).catch(error => {
                    showInteractionError('Could not copy address', error);
                  });
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                Copy Address
              </button>

              {contextItem.status === 'completed' && (
                <button
                  onClick={async () => {
                    setContextMenu(null);
                    const fullPath = await getDownloadPath(contextItem);
                    if (!fullPath) {
                      showInteractionError('Could not copy file path', 'File name is missing');
                      return;
                    }
                    try {
                      await navigator.clipboard.writeText(fullPath);
                    } catch (error) {
                      showInteractionError('Could not copy file path', error);
                    }
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  Copy File Path
                </button>
              )}

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  handleDelete(contextItem.id);
                }}
                className="w-full text-left px-3 py-2 text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Remove
              </button>

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  openProperties(contextItem.id);
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                Properties
              </button>
            </>
          )}
        </div>
      )}

    </div>
  );
};
