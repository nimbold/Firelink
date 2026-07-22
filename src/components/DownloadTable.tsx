import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useDownloadStore, DownloadItem, MAIN_QUEUE_ID } from '../store/useDownloadStore';
import { useToast } from '../contexts/ToastContext';
import { useSettingsStore } from '../store/useSettingsStore';
import { SidebarFilter } from './Sidebar';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import {
  Play, Pause, Plus, FileText, Image as ImageIcon, Music, Film, Box, Archive, FileQuestion,
  ArrowDownCircle, Command, ChevronRight, ChevronUp, ChevronDown, MoreHorizontal,
  AlignLeft, AlignCenter, AlignRight, GripVertical
} from 'lucide-react';
import { DownloadItem as DownloadItemComponent } from './DownloadItem';
import { invokeCommand as invoke } from '../ipc';
import {
  resolveCategoryDestination,
  resolveDownloadFilePath
} from '../utils/downloadLocations';
import {
  canPauseDownload,
  canRedownload,
  canStartDownload
} from '../utils/downloadActions';
import { isActiveDownloadStatus, isTransferActiveStatus } from '../utils/downloads';
import { readClipboardDownloadUrls } from '../utils/clipboard';
import { useTranslation } from 'react-i18next';
import {
  sortDownloads,
  type DownloadSortColumn,
  type DownloadSortConfig
} from '../utils/downloadTableSorting';
import {
  COLUMN_ALIGNMENTS_STORAGE_KEY,
  COLUMN_ALIGNMENT_JUSTIFY,
  COLUMN_MINIMUMS,
  COLUMN_ORDER_STORAGE_KEY,
  COLUMN_WIDTHS_STORAGE_KEY,
  DEFAULT_COLUMN_ALIGNMENTS,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_WIDTHS,
  buildColumnGridTemplate,
  columnIndex,
  getColumnGridColumn,
  normalizeColumnAlignments,
  normalizeColumnOrder,
  normalizeColumnWidths,
  type DownloadColumnAlignment,
  type DownloadTableColumnKey
} from '../utils/downloadTableColumns';

interface DownloadTableProps {
  filter: SidebarFilter;
}

const persistColumnWidths = (widths: number[]): void => {
  try {
    window.localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Local storage can be unavailable in restricted WebView contexts.
  }
};

const persistColumnOrder = (order: DownloadTableColumnKey[]): void => {
  try {
    window.localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Local storage can be unavailable in restricted WebView contexts.
  }
};

const persistColumnAlignments = (alignments: Record<DownloadTableColumnKey, DownloadColumnAlignment>): void => {
  try {
    window.localStorage.setItem(COLUMN_ALIGNMENTS_STORAGE_KEY, JSON.stringify(alignments));
  } catch {
    // Local storage can be unavailable in restricted WebView contexts.
  }
};

interface ColumnDragState {
  key: DownloadTableColumnKey;
  startX: number;
  pointerX: number;
  offsetX: number;
  top: number;
  width: number;
  dropIndex: number;
  markerX: number;
}

interface ColumnMenuState {
  key: DownloadTableColumnKey;
  x: number;
  y: number;
}

interface ColumnLayoutBounds {
  left: number;
  right: number;
}

export const DownloadTable: React.FC<DownloadTableProps> = ({ filter }) => {
  const { t } = useTranslation();
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
  const [headerAnimationParent, setHeaderAnimationEnabled] = useAutoAnimate<HTMLDivElement>({
    duration: 140,
    easing: 'ease-out',
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [sortConfig, setSortConfig] = useState<DownloadSortConfig>({ column: 'Date Added', direction: 'desc' });
  const [queueSortConfig, setQueueSortConfig] = useState<DownloadSortConfig | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const dragGestureRef = useRef<{
    key: DownloadTableColumnKey;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const headerElementsRef = useRef(new Map<DownloadTableColumnKey, HTMLDivElement>());
  const headerContainerRef = useRef<HTMLDivElement>(null);
  const headerRef = useCallback((element: HTMLDivElement | null) => {
    headerContainerRef.current = element;
    headerAnimationParent(element);
  }, [headerAnimationParent]);
  const columnDragStateRef = useRef<ColumnDragState | null>(null);
  const columnDragOrderRef = useRef<DownloadTableColumnKey[] | null>(null);
  const columnDragLayoutRef = useRef<Map<DownloadTableColumnKey, ColumnLayoutBounds> | null>(null);
  const columnDragTargetRef = useRef<HTMLDivElement | null>(null);
  const columnDragCaptureTargetRef = useRef<HTMLDivElement | null>(null);
  const columnDragCapturePointerIdRef = useRef<number | null>(null);
  const columnDragCleanupRef = useRef<(() => void) | null>(null);
  const columnDropFlashTimerRef = useRef<number | null>(null);
  const suppressHeaderClickRef = useRef(false);
  const selectedIdsRef = useRef(selectedIds);
  const lastSelectedIdRef = useRef(lastSelectedId);
  const sortedDownloadsRef = useRef<DownloadItem[]>([]);
  selectedIdsRef.current = selectedIds;
  lastSelectedIdRef.current = lastSelectedId;
  const [columnWidths, setColumnWidths] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY) || 'null');
      return normalizeColumnWidths(stored);
    } catch {
      return [...DEFAULT_COLUMN_WIDTHS];
    }
  });
  const [columnOrder, setColumnOrder] = useState<DownloadTableColumnKey[]>(() => {
    try {
      return normalizeColumnOrder(JSON.parse(window.localStorage.getItem(COLUMN_ORDER_STORAGE_KEY) || 'null'));
    } catch {
      return [...DEFAULT_COLUMN_ORDER];
    }
  });
  const [columnAlignments, setColumnAlignments] = useState(() => {
    try {
      return normalizeColumnAlignments(JSON.parse(window.localStorage.getItem(COLUMN_ALIGNMENTS_STORAGE_KEY) || 'null'));
    } catch {
      return { ...DEFAULT_COLUMN_ALIGNMENTS };
    }
  });
  const [columnDragState, setColumnDragState] = useState<ColumnDragState | null>(null);
  const [columnDragOrder, setColumnDragOrder] = useState<DownloadTableColumnKey[] | null>(null);
  const [columnMenu, setColumnMenu] = useState<ColumnMenuState | null>(null);
  const [columnDropFlashKey, setColumnDropFlashKey] = useState<DownloadTableColumnKey | null>(null);
  const [, setMenuViewportVersion] = useState(0);
  const columnWidthsRef = useRef(columnWidths);
  const columnOrderRef = useRef(columnOrder);
  const normalizedColumnWidths = columnWidthsRef.current.map((width, index) =>
    Math.max(COLUMN_MINIMUMS[index], width)
  );
  const orderedColumns = columnDragOrderRef.current ?? columnDragOrder ?? columnOrder;
  const tableGridTemplate = buildColumnGridTemplate(orderedColumns, normalizedColumnWidths);
  const tableMinWidth = normalizedColumnWidths.reduce(
    (total, width) => total + width,
    0
  );
  const tableMinWidthWithPadding = 'calc(' + tableMinWidth + 'px + var(--download-row-padding-x) + var(--download-row-padding-x))';
  const downloadsViewRef = useRef<HTMLDivElement>(null);

  const updateColumnDragState = (next: ColumnDragState | null) => {
    columnDragStateRef.current = next;
    setColumnDragState(next);
  };

  const reorderColumn = (
    order: DownloadTableColumnKey[],
    key: DownloadTableColumnKey,
    dropIndex: number
  ): DownloadTableColumnKey[] => {
    const remainingColumns = order.filter(columnKey => columnKey !== key);
    remainingColumns.splice(dropIndex, 0, key);
    return remainingColumns;
  };

  const getColumnLayoutBounds = (element: HTMLDivElement) => {
    // AutoAnimate transforms the visual box; offsetLeft/offsetWidth retain the
    // stable grid geometry needed for hit-testing during a live reorder.
    const container = headerContainerRef.current;
    if (!container) {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }

    const containerRect = container.getBoundingClientRect();
    return {
      left: containerRect.left + element.offsetLeft,
      right: containerRect.left + element.offsetLeft + element.offsetWidth,
    };
  };

  const captureColumnLayout = (order: DownloadTableColumnKey[]) => {
    const layout = new Map<DownloadTableColumnKey, ColumnLayoutBounds>();
    for (const key of order) {
      const element = headerElementsRef.current.get(key);
      if (element) layout.set(key, getColumnLayoutBounds(element));
    }
    return layout;
  };

  const getColumnDropPosition = (
    key: DownloadTableColumnKey,
    pointerX: number,
    order: DownloadTableColumnKey[] = columnDragOrderRef.current ?? columnOrderRef.current
  ) => {
    const remainingColumns = order.filter(columnKey => columnKey !== key);
    const targetIndex = remainingColumns.findIndex(columnKey => {
      const element = headerElementsRef.current.get(columnKey);
      if (!element) return false;
      const bounds = columnDragLayoutRef.current?.get(columnKey) ?? getColumnLayoutBounds(element);
      return pointerX < bounds.left + (bounds.right - bounds.left) / 2;
    });
    const dropIndex = targetIndex === -1 ? remainingColumns.length : targetIndex;
    const markerElement = dropIndex < remainingColumns.length
      ? headerElementsRef.current.get(remainingColumns[dropIndex])
      : headerElementsRef.current.get(remainingColumns[remainingColumns.length - 1]);
    const markerBounds = markerElement ? getColumnLayoutBounds(markerElement) : null;
    const markerX = markerBounds
      ? dropIndex < remainingColumns.length ? markerBounds.left : markerBounds.right
      : pointerX;
    return { dropIndex, markerX };
  };

  const finishColumnDrag = (key: DownloadTableColumnKey, pointerId: number, cancelled = false) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.key !== key || gesture.pointerId !== pointerId) return;

    const current = columnDragStateRef.current;
    const nextOrder = columnDragOrderRef.current ?? columnOrderRef.current;
    const captureTarget = columnDragCaptureTargetRef.current;
    dragGestureRef.current = null;
    columnDragTargetRef.current = null;
    columnDragCaptureTargetRef.current = null;
    columnDragCapturePointerIdRef.current = null;
    columnDragOrderRef.current = null;
    columnDragLayoutRef.current = null;
    columnDragCleanupRef.current?.();
    columnDragCleanupRef.current = null;
    updateColumnDragState(null);
    setColumnDragOrder(null);
    setHeaderAnimationEnabled(true);
    if (captureTarget?.hasPointerCapture(pointerId)) {
      captureTarget.releasePointerCapture(pointerId);
    }
    if (cancelled || !gesture.active || !current) {
      suppressHeaderClickRef.current = false;
      return;
    }
    window.setTimeout(() => {
      suppressHeaderClickRef.current = false;
    }, 0);

    if (nextOrder.join('|') === columnOrderRef.current.join('|')) return;

    columnOrderRef.current = nextOrder;
    setColumnOrder(nextOrder);
    persistColumnOrder(nextOrder);
    if (columnDropFlashTimerRef.current !== null) {
      window.clearTimeout(columnDropFlashTimerRef.current);
    }
    setColumnDropFlashKey(key);
    columnDropFlashTimerRef.current = window.setTimeout(() => {
      setColumnDropFlashKey(null);
      columnDropFlashTimerRef.current = null;
    }, 260);
  };

  const handleColumnPointerMove = (
    key: DownloadTableColumnKey,
    pointerId: number,
    clientX: number,
    clientY: number,
    preventDefault?: () => void
  ) => {
    const gesture = dragGestureRef.current;
    if (!gesture || gesture.key !== key || gesture.pointerId !== pointerId) return;

    const distance = Math.hypot(clientX - gesture.startX, clientY - gesture.startY);
    if (!gesture.active) {
      if (distance < 5) return;
      gesture.active = true;
      suppressHeaderClickRef.current = true;
      const captureTarget = columnDragCaptureTargetRef.current;
      if (captureTarget) {
        try {
          // Delay capture until the gesture is a real drag. A click on the
          // sortable header button must retain its original target so the
          // browser can dispatch the button click normally.
          captureTarget.setPointerCapture(pointerId);
        } catch {
          // Window listeners below still handle browsers that reject capture
          // after the pointer has already been cancelled.
        }
      }
      const target = columnDragTargetRef.current;
      const rect = target?.getBoundingClientRect();
      if (!rect) return;
      // The header children are reordered in the live grid while dragging.
      // AutoAnimate's MutationObserver must not animate the same structural
      // changes that drive pointer hit-testing; it is restored on completion.
      setHeaderAnimationEnabled(false);
      const currentOrder = columnOrderRef.current;
      columnDragLayoutRef.current = captureColumnLayout(currentOrder);
      columnDragOrderRef.current = [...currentOrder];
      setColumnDragOrder([...currentOrder]);
      const { dropIndex, markerX } = getColumnDropPosition(key, clientX, currentOrder);
      updateColumnDragState({
        key,
        startX: gesture.startX,
        pointerX: clientX,
        offsetX: clientX - rect.left,
        top: rect.top,
        width: rect.width,
        dropIndex,
        markerX,
      });
    } else {
      const current = columnDragStateRef.current;
      if (!current) return;
      const currentOrder = columnDragOrderRef.current ?? columnOrderRef.current;
      const { dropIndex, markerX } = getColumnDropPosition(key, clientX, currentOrder);
      const nextOrder = reorderColumn(currentOrder, key, dropIndex);
      const orderChanged = nextOrder.some((columnKey, index) => columnKey !== currentOrder[index]);
      if (orderChanged) {
        columnDragOrderRef.current = nextOrder;
        setColumnDragOrder(nextOrder);
      }
      updateColumnDragState({
        ...current,
        pointerX: clientX,
        dropIndex: nextOrder.indexOf(key),
        markerX,
      });
    }

    preventDefault?.();
  };

  const handleColumnPointerDown = (key: DownloadTableColumnKey, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.column-resize-handle, .download-column-options')) return;

    const existingGesture = dragGestureRef.current;
    if (existingGesture) {
      finishColumnDrag(existingGesture.key, existingGesture.pointerId, true);
    }
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const captureTarget = headerContainerRef.current;
    columnDragTargetRef.current = target;
    columnDragCaptureTargetRef.current = captureTarget;
    columnDragCapturePointerIdRef.current = pointerId;
    columnDragLayoutRef.current = null;
    dragGestureRef.current = {
      key,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    const pointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      handleColumnPointerMove(
        key,
        pointerEvent.pointerId,
        pointerEvent.clientX,
        pointerEvent.clientY,
        () => pointerEvent.preventDefault()
      );
    };
    const pointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) {
        finishColumnDrag(key, pointerEvent.pointerId);
      }
    };
    const pointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) {
        finishColumnDrag(key, pointerEvent.pointerId, true);
      }
    };
    const lostPointerCapture = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) {
        finishColumnDrag(key, pointerEvent.pointerId, true);
      }
    };
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    captureTarget?.addEventListener('lostpointercapture', lostPointerCapture);
    columnDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      captureTarget?.removeEventListener('lostpointercapture', lostPointerCapture);
    };
  };

  const startColumnResize = (key: DownloadTableColumnKey, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    const index = columnIndex(key);
    const startX = event.clientX;
    const startWidth = columnWidthsRef.current[index];

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(COLUMN_MINIMUMS[index], startWidth + moveEvent.clientX - startX);
      const nextWidths = columnWidthsRef.current.map((width, columnIndex) =>
        columnIndex === index ? nextWidth : width
      );
      columnWidthsRef.current = nextWidths;
      setColumnWidths(nextWidths);
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('blur', handlePointerUp);
      document.removeEventListener('visibilitychange', handlePointerUp);
      persistColumnWidths(columnWidthsRef.current);
      document.body.classList.remove('is-column-resizing');
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = handlePointerUp;
    document.body.classList.add('is-column-resizing');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('blur', handlePointerUp);
    document.addEventListener('visibilitychange', handlePointerUp);
  };

  const clampMenuPosition = useCallback((x: number, y: number, menuWidth: number, menuHeight: number) => {
    const workspaceRect = downloadsViewRef.current?.getBoundingClientRect();
    const minX = Math.max(8, (workspaceRect?.left ?? 0) + 8);
    const minY = Math.max(8, (workspaceRect?.top ?? 0) + 8);
    const maxX = Math.max(minX, Math.min(
      window.innerWidth - menuWidth - 8,
      (workspaceRect?.right ?? window.innerWidth) - menuWidth - 8
    ));
    const maxY = Math.max(minY, Math.min(
      window.innerHeight - menuHeight - 8,
      (workspaceRect?.bottom ?? window.innerHeight) - menuHeight - 8
    ));
    return {
      x: Math.min(Math.max(minX, x), maxX),
      y: Math.min(Math.max(minY, y), maxY),
    };
  }, []);

  const openColumnMenu = (key: DownloadTableColumnKey, x: number, y: number) => {
    const position = clampMenuPosition(x, y, 188, 220);
    setContextMenu(null);
    setColumnMenu({
      key,
      ...position,
    });
  };

  const setColumnAlignment = (alignment: DownloadColumnAlignment) => {
    if (!columnMenu) return;
    const key = columnMenu.key;
    setColumnAlignments(current => {
      const next = { ...current, [key]: alignment };
      persistColumnAlignments(next);
      return next;
    });
    setColumnMenu(null);
  };

  const resetColumnLayout = () => {
    const widths = [...DEFAULT_COLUMN_WIDTHS];
    const order = [...DEFAULT_COLUMN_ORDER];
    const alignments = { ...DEFAULT_COLUMN_ALIGNMENTS };
    setColumnWidths(widths);
    columnWidthsRef.current = widths;
    columnOrderRef.current = order;
    setColumnOrder(order);
    setColumnAlignments(alignments);
    persistColumnWidths(widths);
    persistColumnOrder(order);
    persistColumnAlignments(alignments);
    setColumnMenu(null);
  };

  useEffect(() => {
    const handleCloseMenu = () => {
      setContextMenu(null);
      setColumnMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setColumnMenu(null);
      }
    };
    window.addEventListener('click', handleCloseMenu);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('click', handleCloseMenu);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
    columnDragCleanupRef.current?.();
    columnDragCleanupRef.current = null;
    const captureTarget = columnDragCaptureTargetRef.current;
    const capturePointerId = columnDragCapturePointerIdRef.current;
    columnDragTargetRef.current = null;
    columnDragCaptureTargetRef.current = null;
    columnDragCapturePointerIdRef.current = null;
    if (captureTarget && capturePointerId !== null && captureTarget.hasPointerCapture(capturePointerId)) {
      captureTarget.releasePointerCapture(capturePointerId);
    }
    if (columnDropFlashTimerRef.current !== null) {
      window.clearTimeout(columnDropFlashTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const cancelColumnDrag = () => {
      if (!dragGestureRef.current) return;
      columnDragCleanupRef.current?.();
      columnDragCleanupRef.current = null;
      const captureTarget = columnDragCaptureTargetRef.current;
      const capturePointerId = columnDragCapturePointerIdRef.current;
      columnDragTargetRef.current = null;
      columnDragCaptureTargetRef.current = null;
      columnDragCapturePointerIdRef.current = null;
      if (captureTarget && capturePointerId !== null && captureTarget.hasPointerCapture(capturePointerId)) {
        captureTarget.releasePointerCapture(capturePointerId);
      }
      dragGestureRef.current = null;
      columnDragStateRef.current = null;
      columnDragOrderRef.current = null;
      columnDragLayoutRef.current = null;
      setHeaderAnimationEnabled(true);
      setColumnDragState(null);
      setColumnDragOrder(null);
      suppressHeaderClickRef.current = false;
    };

    window.addEventListener('blur', cancelColumnDrag);
    window.addEventListener('resize', cancelColumnDrag);
    document.addEventListener('visibilitychange', cancelColumnDrag);
    return () => {
      window.removeEventListener('blur', cancelColumnDrag);
      window.removeEventListener('resize', cancelColumnDrag);
      document.removeEventListener('visibilitychange', cancelColumnDrag);
    };
  }, []);

  useEffect(() => {
    if (!columnMenu && !contextMenu) return;
    const updateMenuViewport = () => setMenuViewportVersion(version => version + 1);
    window.addEventListener('resize', updateMenuViewport);
    return () => window.removeEventListener('resize', updateMenuViewport);
  }, [columnMenu, contextMenu]);

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
      showInteractionError(t($ => $.downloadTable.openFileFailed), error);
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
      showInteractionError(t($ => $.downloadTable.revealFileFailed), error);
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
    setColumnMenu(null);
    setContextMenu({
      ...menu,
      ...clampMenuPosition(menu.x, menu.y, 200, 300),
    });
  }, [clampMenuPosition]);

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
      return queue ? queue.name : t($ => $.downloadTable.unknownQueue);
    }
    switch (filter) {
      case 'all': return t($ => $.downloadTable.allDownloads);
      case 'active': return t($ => $.downloadTable.active);
      case 'completed': return t($ => $.downloadTable.completed);
      case 'unfinished': return t($ => $.downloadTable.unfinished);
      case 'Musics': return t($ => $.navigation.categories.musics);
      case 'Movies': return t($ => $.navigation.categories.movies);
      case 'Compressed': return t($ => $.navigation.categories.compressed);
      case 'Documents': return t($ => $.navigation.categories.documents);
      case 'Pictures': return t($ => $.navigation.categories.pictures);
      case 'Applications': return t($ => $.navigation.categories.applications);
      case 'Other': return t($ => $.navigation.categories.other);
      default: return filter;
    }
  };

  const handlePause = useCallback(async (id: string, skipConfirm = false) => {
    const download = useDownloadStore.getState().downloads.find(d => d.id === id);
    if (!skipConfirm && download && download.resumable === false) {
      const confirmPause = window.confirm(t($ => $.downloadTable.nonResumableOne));
      if (!confirmPause) {
        return;
      }
    }

    try {
      await useDownloadStore.getState().pauseDownload(id);
    } catch (e) {
      console.error("Failed to pause:", e);
      showInteractionError(t($ => $.downloadTable.pauseFailed), e);
    }
  }, [showInteractionError]);

  const handleResume = useCallback(async (item: DownloadItem) => {
    try {
      const resumed = await useDownloadStore.getState().resumeDownload(item.id);
      if (!resumed) {
        throw new Error(t($ => $.downloadTable.backendRejectedStart));
      }
    } catch (error) {
      console.error("Failed to resume:", error);
        showInteractionError(t($ => $.downloadTable.resumeFailed, { fileName: item.fileName }), error);
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

  const columnDefinitions: Array<{ key: DownloadTableColumnKey; label: string }> = [
    { key: 'File Name', label: t($ => $.downloadTable.headers.fileName) },
    { key: 'Size', label: t($ => $.downloadTable.headers.size) },
    { key: 'Status', label: t($ => $.downloadTable.headers.status) },
    { key: 'Speed', label: t($ => $.downloadTable.headers.speed) },
    { key: 'ETA', label: t($ => $.downloadTable.headers.eta) },
    { key: 'Date Added', label: t($ => $.downloadTable.headers.dateAdded) },
  ];
  const columnLabels = new Map(columnDefinitions.map(column => [column.key, column.label]));
  const columnAlignmentStyle = (key: DownloadTableColumnKey): React.CSSProperties => ({
    '--column-justify': COLUMN_ALIGNMENT_JUSTIFY[columnAlignments[key]],
  } as React.CSSProperties);
  const columnMenuPosition = columnMenu
    ? clampMenuPosition(columnMenu.x, columnMenu.y, 188, 220)
    : null;
  const contextMenuPosition = contextMenu
    ? clampMenuPosition(contextMenu.x, contextMenu.y, 200, 300)
    : null;

  return (
    <div ref={downloadsViewRef} className="downloads-view flex-1 flex flex-col h-full min-w-0">
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
            title={t($ => $.downloadTable.addDownload)}
          >
            <Plus size={16} />
          </button>

          <button 
            className="main-control-button" 
            disabled={sortedDownloads.length === 0}
            onClick={() => {
              void resumeItemsSequentially(sortedDownloads.filter(d => canStartDownload(d.status)));
            }}
            title={t($ => $.downloadTable.resumeAll)}
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
                    ? t($ => $.downloadTable.nonResumableOne)
                    : t($ => $.downloadTable.nonResumableMany, { count: nonResumableCount })
                );
                if (!confirmPause) {
                  return;
                }
              }
              // Skip the individual check by passing a flag to handlePause, or just invoking directly.
              toPause.forEach(d => handlePause(d.id, true));
            }}
            title={t($ => $.downloadTable.pauseAll)}
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
          <div
            ref={headerRef}
            className={`download-table-header ${columnDragState ? 'is-column-dragging' : ''}`}
            style={{ gridTemplateColumns: tableGridTemplate, minWidth: tableMinWidthWithPadding }}
          >
            {orderedColumns.map(key => {
              const label = columnLabels.get(key) ?? key;
              const activeSort = isQueueFilter ? queueSortConfig : sortConfig;
              const isDragging = columnDragState?.key === key;
              const isDropFlashing = columnDropFlashKey === key;
              return (
                <div
                  key={key}
                  ref={element => {
                    if (element) headerElementsRef.current.set(key, element);
                    else headerElementsRef.current.delete(key);
                  }}
                  data-column-key={key}
                  role="columnheader"
                  aria-sort={activeSort?.column === key
                    ? activeSort.direction === 'asc' ? 'ascending' : 'descending'
                    : 'none'}
                  className={`download-column-header group ${isDragging ? 'is-dragging' : ''} ${isDropFlashing ? 'is-drop-flashing' : ''}`}
                  style={{
                    ...columnAlignmentStyle(key),
                    gridColumn: getColumnGridColumn(key, orderedColumns),
                  }}
                  onContextMenu={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    openColumnMenu(key, event.clientX, event.clientY);
                  }}
                  onPointerDown={event => handleColumnPointerDown(key, event)}
                >
                  <button
                    type="button"
                    className="download-column-header-content"
                    onClick={event => {
                      event.stopPropagation();
                      if (suppressHeaderClickRef.current) {
                        suppressHeaderClickRef.current = false;
                        return;
                      }
                      handleSort(key);
                    }}
                    title={t($ => $.downloadTable.columnOptions.dragToReorder)}
                  >
                    <span>{label}</span>
                    {activeSort?.column === key && (
                      activeSort.direction === 'asc'
                        ? <ChevronUp size={14} aria-hidden="true" />
                        : <ChevronDown size={14} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="download-column-options"
                    aria-label={t($ => $.downloadTable.columnOptions.open, { column: label })}
                    title={t($ => $.downloadTable.columnOptions.open, { column: label })}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openColumnMenu(key, rect.left, rect.bottom + 6);
                    }}
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </button>
                  <div
                    className="column-resize-handle"
                    aria-hidden="true"
                    onPointerDown={event => {
                      event.stopPropagation();
                      startColumnResize(key, event);
                    }}
                  />
                </div>
              );
            })}
          </div>

          {columnDragState && (
            <>
              <div
                className="download-column-drop-marker"
                style={{ top: columnDragState.top, left: columnDragState.markerX }}
                aria-hidden="true"
              />
              <div
                className="download-column-drag-preview"
                style={{
                  top: columnDragState.top,
                  left: columnDragState.pointerX - columnDragState.offsetX,
                  width: columnDragState.width,
                }}
                aria-hidden="true"
              >
                <GripVertical size={14} />
                <span>{columnLabels.get(columnDragState.key) ?? columnDragState.key}</span>
              </div>
            </>
          )}

          <div className="download-table-body" style={{ minWidth: tableMinWidthWithPadding }}>
            <div className="download-table-list" ref={animationParent}>
              {sortedDownloads.length === 0 ? (
                <div className="downloads-empty-state">
                  <ArrowDownCircle aria-hidden="true" />
                  <div className="downloads-empty-title">
                    {isQueueFilter ? t($ => $.downloadTable.queueEmpty) : filter === 'completed' ? t($ => $.downloadTable.noCompletedDownloads) : t($ => $.downloadTable.noDownloads)}
                  </div>
                  <div className="downloads-empty-description flex items-center justify-center mt-2.5 text-[13px] text-text-muted">
                    {isQueueFilter ? (
                      t($ => $.downloadTable.queueEmptyDescription)
                    ) : filter === 'completed' ? (
                      t($ => $.downloadTable.completedDescription)
                    ) : (
                      <>
                        {t($ => $.downloadTable.clickToAdd)} <Plus size={15} className="text-accent stroke-[3] mx-1.5" /> {t($ => $.downloadTable.addButtonOr)}
                        <span className="flex items-center mx-1.5">
                          <span className="flex items-center justify-center px-1.5 py-0.5 bg-item-hover rounded border border-border-color shadow-sm min-w-[22px] min-h-[22px]">
                            {isMac ? <Command size={12} strokeWidth={2.5} className="text-text-primary" /> : <span className="text-[10px] font-bold text-text-primary">Ctrl</span>}
                          </span>
                          <span className="text-accent font-bold mx-1.5 text-[14px]">+</span>
                          <span className="flex items-center justify-center px-1.5 py-0.5 bg-item-hover rounded border border-border-color shadow-sm min-w-[22px] min-h-[22px]">
                            <span className="text-[11px] font-bold text-text-primary">V</span>
                          </span>
                        </span>
                        {t($ => $.downloadTable.toAddDownloads)}
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
                      columnOrder={orderedColumns}
                      columnAlignments={columnAlignments}
                      tableGridTemplate={tableGridTemplate}
                      tableMinWidth={tableMinWidthWithPadding}
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

      {columnMenu && (
        <div
          role="menu"
          className="download-column-menu app-modal fixed z-50 min-w-[188px] overflow-hidden py-1.5 text-[12px] font-medium text-text-primary"
          style={{ top: columnMenuPosition?.y, left: columnMenuPosition?.x }}
          onClick={event => event.stopPropagation()}
        >
          <div className="download-column-menu-title px-3 py-1.5 text-text-muted">
            {columnLabels.get(columnMenu.key) ?? columnMenu.key}
          </div>
          <div className="download-column-menu-label px-3 pb-1 text-[10px] uppercase tracking-[0.12em] text-text-muted">
            {t($ => $.downloadTable.columnOptions.alignContent)}
          </div>
          {([
            ['left', AlignLeft],
            ['center', AlignCenter],
            ['right', AlignRight],
          ] as const).map(([alignment, Icon]) => (
            <button
              key={alignment}
              type="button"
              role="menuitemradio"
              aria-checked={columnAlignments[columnMenu.key] === alignment}
              className="download-column-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-start hover:bg-item-hover"
              onClick={() => setColumnAlignment(alignment)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{t($ => $.downloadTable.columnOptions[alignment])}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-border-color" />
          <button
            type="button"
            className="download-column-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-start hover:bg-item-hover"
            onClick={resetColumnLayout}
          >
            <GripVertical size={14} aria-hidden="true" />
            <span>{t($ => $.downloadTable.columnOptions.resetLayout)}</span>
          </button>
        </div>
      )}

      {/* Floating Context Menu */}
      {contextMenu && contextItem && (
        <div
          role="menu"
          className="app-modal fixed z-50 min-w-[180px] overflow-visible py-1.5 text-[12px] font-medium text-text-primary"
          style={{
             top: contextMenuPosition?.y,
             left: contextMenuPosition?.x,
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
                {t($ => $.downloadTable.startResume)}
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
                          ? t($ => $.downloadTable.nonResumableOne)
                          : t($ => $.downloadTable.nonResumableMany, { count: nonResumableCount })
                      );
                      if (!confirmPause) {
                        return;
                      }
                    }
                    itemsToPause.forEach(d => handlePause(d.id, true));
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  {t($ => $.downloadTable.pause)}
                </button>
              )}

              {(itemsToResume.length > 0 || itemsToPause.length > 0) && (
                <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>
              )}

              {itemsToQueue.length > 0 && (
                <div className="group relative">
                  <button className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors flex justify-between items-center">
                    {t($ => $.downloadTable.addToQueue)}
                    <ChevronRight size={14} className="download-context-menu-chevron" />
                  </button>
                  <div className="download-context-submenu absolute top-0 hidden group-hover:block min-w-[150px] bg-bg-modal border border-border-modal rounded-lg shadow-lg py-1.5 z-50">
                    {queues.map(q => (
                      <button key={q.id} onClick={() => {
                        setContextMenu(null);
                        void assignToQueue(itemsToQueue.map(item => item.id), q.id).catch(error => {
                          showInteractionError(t($ => $.downloadTable.moveManyFailed), error);
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
                    showInteractionError(t($ => $.downloadTable.copyAddressesFailed), error);
                  });
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                {t($ => $.downloadTable.copyAddress)}
              </button>

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  handleDelete(Array.from(selectedIds));
                }}
                className="w-full text-left px-3 py-2 text-red-400 hover:bg-red-500/10 transition-colors"
              >
                {t($ => $.downloadTable.remove)}
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
                  {t($ => $.downloadTable.open)}
                </button>
              )}

              <button
                onClick={async () => {
                  setContextMenu(null);
                  await revealDownloadFile(contextItem);
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
              {t($ => $.downloadTable.showInFolder)}
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
                  {t($ => $.downloadTable.pause)}
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
                  {contextItem.status === 'paused' ? t($ => $.downloadTable.resume) : t($ => $.downloadTable.start)}
                </button>
              )}

              {canRedownload(contextItem.status) && (
                <button
                  onClick={async () => {
                    setContextMenu(null);
                    try {
                      await redownload(contextItem.id);
                    } catch (error) {
                      showInteractionError(t($ => $.downloadTable.redownloadFailed), error);
                    }
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  {t($ => $.downloadTable.redownload)}
                </button>
              )}

              {contextItem.status !== 'completed' && (
                <div className="group relative">
                  <button className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors flex justify-between items-center">
                    {t($ => $.downloadTable.addToQueue)}
                    <ChevronRight size={14} className="download-context-menu-chevron" />
                  </button>
                  <div className="download-context-submenu absolute top-0 hidden group-hover:block min-w-[150px] bg-bg-modal border border-border-modal rounded-lg shadow-lg py-1.5 z-50">
                    {queues.map(q => (
                      <button key={q.id} onClick={() => {
                        setContextMenu(null);
                        void assignToQueue([contextItem.id], q.id).catch(error => {
                          showInteractionError(t($ => $.downloadTable.moveOneFailed), error);
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
                    showInteractionError(t($ => $.downloadTable.copyAddressFailed), error);
                  });
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                {t($ => $.downloadTable.copyAddress)}
              </button>

              {contextItem.status === 'completed' && (
                <button
                  onClick={async () => {
                    setContextMenu(null);
                    const fullPath = await getDownloadPath(contextItem);
                    if (!fullPath) {
                      showInteractionError(t($ => $.downloadTable.copyPathFailed), t($ => $.downloadTable.missingFileName));
                      return;
                    }
                    try {
                      await navigator.clipboard.writeText(fullPath);
                    } catch (error) {
                      showInteractionError(t($ => $.downloadTable.copyPathFailed), error);
                    }
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  {t($ => $.downloadTable.copyFilePath)}
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
                {t($ => $.downloadTable.remove)}
              </button>

              <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

              <button
                onClick={() => {
                  setContextMenu(null);
                  openProperties(contextItem.id);
                }}
                className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
              >
                {t($ => $.downloadTable.properties)}
              </button>
            </>
          )}
        </div>
      )}

    </div>
  );
};
