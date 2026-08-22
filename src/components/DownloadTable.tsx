import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useDownloadStore, DownloadItem, MAIN_QUEUE_ID } from '../store/useDownloadStore';
import { useDownloadProgressStore } from '../store/downloadProgressStore';
import { useToast } from '../contexts/ToastContext';
import { useSettingsStore } from '../store/useSettingsStore';
import { SidebarFilter } from './Sidebar';
import {
  Play, Pause, Plus, FileText, Image as ImageIcon, Music, Film, Box, Archive, FileQuestion, Magnet,
  ArrowDownCircle, ArrowUp, ArrowDown, Command, ChevronUp, ChevronDown, MoreHorizontal,
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
  canStartDownload,
  countDownloadActions
} from '../utils/downloadActions';
import { isActiveDownloadStatus, isTransferActiveStatus } from '../utils/downloads';
import { summarizeDownloads, type DownloadSummary } from '../utils/downloadSummary';
import { readClipboardDownloadUrls } from '../utils/clipboard';
import { writeText as writeClipboardText } from '@tauri-apps/plugin-clipboard-manager';
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
import {
  moveSelectedBlockToIndex
} from '../utils/queueOrdering';
import { selectContextMenuTarget, updateDownloadSelection } from '../utils/downloadSelection';
import { createColumnResizeSession } from '../utils/columnResize';
import { clampFloatingPosition } from '../utils/floatingPosition';
import { FloatingQueueSubmenu } from './FloatingQueueSubmenu';
import { openPropertiesWindow } from '../propertiesBridge';

export interface DownloadTableStatusSummary {
  summary: DownloadSummary;
}

interface DownloadTableProps {
  filter: SidebarFilter;
  onSummaryChange?: (summary: DownloadTableStatusSummary | null) => void;
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

const QUEUE_ROW_REORDER_DURATION = 180;
const QUEUE_ROW_REORDER_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const COLUMN_REORDER_DURATION = QUEUE_ROW_REORDER_DURATION;
const COLUMN_REORDER_EASING = QUEUE_ROW_REORDER_EASING;

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

interface QueueDragState {
  pointerId: number;
  sourceId: string;
  queueId: string;
  ids: string[];
  startX: number;
  startY: number;
  pointerY: number;
  pointerOffsetY: number;
  active: boolean;
  targetIndex: number;
  markerTop: number;
}

interface QueueDragRowGeometry {
  top: number;
  height: number;
  space: number;
}

interface QueueDragGeometry {
  listTop: number;
  scrollTop: number;
  rows: Map<string, QueueDragRowGeometry>;
}

interface ColumnMotionLayout {
  element: HTMLElement;
  left: number;
}

export const DownloadTable: React.FC<DownloadTableProps> = ({ filter, onSummaryChange }) => {
  const { t } = useTranslation();
  const {
    downloads,
    queues,
    assignToQueue,
    openDeleteModal,
    redownload,
    moveInQueue,
    moveManyInQueueToPosition,
    startAll,
    pauseAll,
    startSelected,
    allocationPendingIds
  } = useDownloadStore();
  const progressMap = useDownloadProgressStore(state => state.progressMap);
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
  }, []);
  const columnDragStateRef = useRef<ColumnDragState | null>(null);
  const columnDragOrderRef = useRef<DownloadTableColumnKey[] | null>(null);
  const columnDragLayoutRef = useRef<Map<DownloadTableColumnKey, ColumnLayoutBounds> | null>(null);
  const columnDragTargetRef = useRef<HTMLDivElement | null>(null);
  const columnDragCaptureTargetRef = useRef<HTMLDivElement | null>(null);
  const columnDragCapturePointerIdRef = useRef<number | null>(null);
  const columnDragCleanupRef = useRef<(() => void) | null>(null);
  const columnDropFlashTimerRef = useRef<number | null>(null);
  const columnMotionFirstRef = useRef<ColumnMotionLayout[] | null>(null);
  const columnMotionElementsRef = useRef(new Set<HTMLElement>());
  const columnMotionFrameRef = useRef<number | null>(null);
  const columnMotionTimerRef = useRef<number | null>(null);
  const columnMotionGenerationRef = useRef(0);
  const suppressHeaderClickRef = useRef(false);
  const selectedIdsRef = useRef(selectedIds);
  const lastSelectedIdRef = useRef(lastSelectedId);
  const sortedDownloadsRef = useRef<DownloadItem[]>([]);
  const queueListElementRef = useRef<HTMLDivElement | null>(null);
  const queueRowsContainerElementRef = useRef<HTMLDivElement | null>(null);
  const queueReorderableDownloadsRef = useRef<DownloadItem[]>([]);
  const queueDragItemsRef = useRef<DownloadItem[]>([]);
  const queueDragBaseItemsRef = useRef<DownloadItem[]>([]);
  const queueDragStateRef = useRef<QueueDragState | null>(null);
  const queueDragCleanupRef = useRef<(() => void) | null>(null);
  const queueDragCaptureTargetRef = useRef<HTMLElement | null>(null);
  const queueDragCapturePointerIdRef = useRef<number | null>(null);
  const queueDragPreviewOrderRef = useRef<string[] | null>(null);
  const queueDragGeometryRef = useRef<QueueDragGeometry | null>(null);
  const queueDragPreviewElementRef = useRef<HTMLDivElement | null>(null);
  const queueRowTopsRef = useRef(new Map<string, number>());
  const queueRowHeightsRef = useRef(new Map<string, number>());
  const queueRowAnimationFrameRef = useRef<number | null>(null);
  const queueRowAnimationTimerRef = useRef<number | null>(null);
  const queueRowAnimationActiveRef = useRef(false);
  const queueRowAnimationGenerationRef = useRef(0);
  const queueReorderPendingCountRef = useRef(0);
  const suppressQueueClickRef = useRef(false);
  const suppressQueueClickTimerRef = useRef<number | null>(null);
  const [queueDragState, setQueueDragState] = useState<QueueDragState | null>(null);
  const [queueDragPreviewOrder, setQueueDragPreviewOrder] = useState<string[] | null>(null);

  const clearQueueClickSuppression = useCallback(() => {
    suppressQueueClickRef.current = false;
    if (suppressQueueClickTimerRef.current !== null) {
      window.clearTimeout(suppressQueueClickTimerRef.current);
      suppressQueueClickTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const className = 'is-queue-dragging';
    if (queueDragState?.active) {
      document.body.classList.add(className);
    } else {
      document.body.classList.remove(className);
    }
    return () => document.body.classList.remove(className);
  }, [queueDragState?.active]);

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
  const [columnMenuPosition, setColumnMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [columnDropFlashKey, setColumnDropFlashKey] = useState<DownloadTableColumnKey | null>(null);
  const columnWidthsRef = useRef(columnWidths);
  const columnOrderRef = useRef(columnOrder);
  const normalizedColumnWidths = columnWidthsRef.current.map((width, index) =>
    Math.max(COLUMN_MINIMUMS[index], width)
  );
  const orderedColumns = columnDragOrderRef.current ?? columnDragOrder ?? columnOrder;
  const columnMotionOrderKey = orderedColumns.join('\u0001');
  const tableGridTemplate = buildColumnGridTemplate(orderedColumns, normalizedColumnWidths);
  const tableMinWidth = normalizedColumnWidths.reduce(
    (total, width) => total + width,
    0
  );
  const tableMinWidthWithPadding = 'calc(' + tableMinWidth + 'px + var(--download-row-padding-x) + var(--download-row-padding-x))';
  const downloadsViewRef = useRef<HTMLDivElement>(null);
  const queueListRef = useCallback((element: HTMLDivElement | null) => {
    queueListElementRef.current = element;
  }, []);
  const queueRowsContainerRef = useCallback((element: HTMLDivElement | null) => {
    queueRowsContainerElementRef.current = element;
  }, []);

  const captureColumnMotionLayout = (): ColumnMotionLayout[] => {
    const header = headerContainerRef.current;
    const body = queueRowsContainerElementRef.current;
    const verticalViewport = queueListElementRef.current?.getBoundingClientRect();
    const headerElements = header
      ? Array.from(header.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && Boolean(element.dataset.columnKey)
        )
      : [];
    const bodyElements: HTMLElement[] = [];
    if (body) {
      for (const row of Array.from(body.children)) {
        if (!(row instanceof HTMLElement) || !row.dataset.downloadId) continue;
        if (verticalViewport) {
          const rowRect = row.getBoundingClientRect();
          if (rowRect.bottom < verticalViewport.top || rowRect.top > verticalViewport.bottom) continue;
        }
        const motionElement = row.querySelector<HTMLElement>('.download-row-motion');
        if (!motionElement) continue;
        bodyElements.push(...Array.from(motionElement.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && Boolean(element.dataset.columnKey)
        ));
      }
    }

    return [...headerElements, ...bodyElements].map(element => ({
      element,
      left: element.getBoundingClientRect().left,
    }));
  };

  const clearColumnMotionStyles = () => {
    columnMotionGenerationRef.current += 1;
    if (columnMotionFrameRef.current !== null) {
      window.cancelAnimationFrame(columnMotionFrameRef.current);
      columnMotionFrameRef.current = null;
    }
    if (columnMotionTimerRef.current !== null) {
      window.clearTimeout(columnMotionTimerRef.current);
      columnMotionTimerRef.current = null;
    }
    for (const element of columnMotionElementsRef.current) {
      element.style.removeProperty('transition');
      element.style.removeProperty('transform');
      element.style.removeProperty('will-change');
    }
    columnMotionElementsRef.current.clear();
  };

  const prepareColumnMotion = () => {
    const prefersReducedMotion = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      clearColumnMotionStyles();
      columnMotionFirstRef.current = null;
      return;
    }

    // Capture the visual position before cancelling an in-flight transition.
    // The next FLIP pass can then continue from what the user actually sees
    // instead of snapping back to the previous logical grid position.
    const first = captureColumnMotionLayout();
    clearColumnMotionStyles();
    columnMotionFirstRef.current = first;
  };

  useLayoutEffect(() => {
    const first = columnMotionFirstRef.current;
    columnMotionFirstRef.current = null;
    if (!first || first.length === 0) return;

    const prefersReducedMotion = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    const moved = first.flatMap(({ element, left }) => {
      if (!element.isConnected) return [];
      const deltaX = left - element.getBoundingClientRect().left;
      return Math.abs(deltaX) > 0.5 ? [{ element, deltaX }] : [];
    });
    if (moved.length === 0) return;

    const generation = ++columnMotionGenerationRef.current;
    for (const { element, deltaX } of moved) {
      columnMotionElementsRef.current.add(element);
      element.style.willChange = 'transform';
      element.style.transition = 'none';
      element.style.transform = `translate3d(${deltaX}px, 0, 0)`;
    }
    // Commit the inverse transforms before releasing them on the next frame so
    // React's grid reflow becomes a smooth physical-LTR motion for headers and
    // every visible row cell alike.
    void headerContainerRef.current?.offsetHeight;
    void queueRowsContainerElementRef.current?.offsetHeight;

    columnMotionFrameRef.current = window.requestAnimationFrame(() => {
      columnMotionFrameRef.current = null;
      if (columnMotionGenerationRef.current !== generation) return;
      for (const { element } of moved) {
        element.style.transition = `transform ${COLUMN_REORDER_DURATION}ms ${COLUMN_REORDER_EASING}`;
        element.style.transform = 'translate3d(0, 0, 0)';
      }
    });
    columnMotionTimerRef.current = window.setTimeout(() => {
      columnMotionTimerRef.current = null;
      if (columnMotionGenerationRef.current !== generation) return;
      for (const { element } of moved) {
        element.style.removeProperty('transition');
        element.style.removeProperty('transform');
        element.style.removeProperty('will-change');
        columnMotionElementsRef.current.delete(element);
      }
    }, COLUMN_REORDER_DURATION + 60);
  }, [columnMotionOrderKey]);

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
    // CSS FLIP transforms affect the visual box; offsetLeft/offsetWidth retain
    // the stable grid geometry needed for hit-testing during a live reorder.
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
    const shouldAnimateCancel = cancelled && gesture.active && Boolean(current);
    if (shouldAnimateCancel) {
      prepareColumnMotion();
    }
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
      // The custom FLIP pass animates the visual boxes while offset geometry
      // remains stable for pointer hit-testing.
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
        prepareColumnMotion();
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

    const cleanup = createColumnResizeSession({
      windowTarget: window,
      documentTarget: document,
      body: document.body,
      pointerId: event.pointerId,
      startX,
      startWidth,
      minWidth: COLUMN_MINIMUMS[index],
      onWidth: nextWidth => {
      const nextWidths = columnWidthsRef.current.map((width, columnIndex) =>
        columnIndex === index ? nextWidth : width
      );
      columnWidthsRef.current = nextWidths;
      setColumnWidths(nextWidths);
      },
      onEnd: () => {
        persistColumnWidths(columnWidthsRef.current);
        resizeCleanupRef.current = null;
      },
    });
    resizeCleanupRef.current = cleanup;
  };

  const clampMenuPosition = useCallback((x: number, y: number, menuWidth: number, menuHeight: number) => {
    return clampFloatingPosition(
      x,
      y,
      menuWidth,
      menuHeight,
      window.innerWidth,
      window.innerHeight
    );
  }, []);

  const openColumnMenu = (key: DownloadTableColumnKey, x: number, y: number) => {
    const position = clampMenuPosition(x, y, 188, 220);
    setContextMenu(null);
    setColumnMenuPosition(position);
    setColumnMenu({ key, x, y });
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
    if (order.join('|') !== columnOrderRef.current.join('|')) {
      prepareColumnMotion();
    }
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
    columnMotionFirstRef.current = null;
    clearColumnMotionStyles();
    try {
      queueDragCleanupRef.current?.();
    } catch (error) {
      console.error('Failed to clean up queue drag listeners during unmount:', error);
    }
    columnDragCleanupRef.current = null;
    queueDragCleanupRef.current = null;
    queueDragStateRef.current = null;
    clearQueueClickSuppression();
    const queueCaptureTarget = queueDragCaptureTargetRef.current;
    const queueCapturePointerId = queueDragCapturePointerIdRef.current;
    queueDragCaptureTargetRef.current = null;
    queueDragCapturePointerIdRef.current = null;
    try {
      if (queueCaptureTarget && queueCapturePointerId !== null && queueCaptureTarget.hasPointerCapture(queueCapturePointerId)) {
        queueCaptureTarget.releasePointerCapture(queueCapturePointerId);
      }
    } catch (error) {
      console.warn('Failed to release queue pointer capture during unmount:', error);
    }
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
      const gesture = dragGestureRef.current;
      if (!gesture) return;
      if (gesture.active && columnDragStateRef.current) {
        prepareColumnMotion();
      }
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

  useLayoutEffect(() => {
    if (!columnMenu || !columnMenuRef.current) return;

    const updateColumnMenuPosition = () => {
      const menu = columnMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const nextPosition = clampMenuPosition(
        columnMenu.x,
        columnMenu.y,
        menu.offsetWidth || rect.width,
        menu.offsetHeight || rect.height
      );
      setColumnMenuPosition(current => (
        current?.x === nextPosition.x && current.y === nextPosition.y
          ? current
          : nextPosition
      ));
    };

    updateColumnMenuPosition();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateColumnMenuPosition);
    resizeObserver?.observe(columnMenuRef.current);
    window.addEventListener('resize', updateColumnMenuPosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateColumnMenuPosition);
    };
  }, [columnMenu, clampMenuPosition]);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;

    const updateContextMenuPosition = () => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const nextPosition = clampMenuPosition(
        contextMenu.x,
        contextMenu.y,
        menu.offsetWidth || rect.width,
        menu.offsetHeight || rect.height
      );
      setContextMenuPosition(current => (
        current?.x === nextPosition.x && current.y === nextPosition.y
          ? current
          : nextPosition
      ));
    };

    updateContextMenuPosition();
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateContextMenuPosition);
    resizeObserver?.observe(contextMenuRef.current);
    window.addEventListener('resize', updateContextMenuPosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateContextMenuPosition);
    };
  }, [contextMenu, clampMenuPosition]);

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

  const queueRowsById = (list: HTMLDivElement): Map<string, HTMLElement> => {
    const rows = new Map<string, HTMLElement>();
    const rowsContainer = queueRowsContainerElementRef.current;
    if (!rowsContainer || !list.contains(rowsContainer)) return rows;
    for (const element of Array.from(rowsContainer.children)) {
      if (!(element instanceof HTMLElement)) continue;
      const id = element.dataset.downloadId;
      if (id) rows.set(id, element);
    }
    return rows;
  };

  const queueRowForId = (id: string): HTMLElement | null => {
    const list = queueListElementRef.current;
    if (!list) return null;
    return queueRowsById(list).get(id) || null;
  };

  const captureQueueDragGeometry = (items: DownloadItem[]): QueueDragGeometry | null => {
    const list = queueListElementRef.current;
    if (!list) return null;

    const listRect = list.getBoundingClientRect();
    const rowsById = queueRowsById(list);
    const rows = new Map<string, QueueDragRowGeometry>();
    for (const item of items) {
      const row = rowsById.get(item.id);
      if (!row) continue;

      const rect = row.getBoundingClientRect();
      const styles = window.getComputedStyle(row);
      const marginTop = Number.parseFloat(styles.marginTop) || 0;
      const marginBottom = Number.parseFloat(styles.marginBottom) || 0;
      rows.set(item.id, {
        top: rect.top,
        height: rect.height,
        space: rect.height + marginTop + marginBottom,
      });
    }

    return {
      listTop: listRect.top,
      scrollTop: list.scrollTop,
      rows,
    };
  };

  const queueDropPosition = (
    clientY: number,
    items: DownloadItem[],
    selectedIds: ReadonlySet<string>
  ): { targetIndex: number; markerTop: number } => {
    const list = queueListElementRef.current;
    if (!list || items.length === 0) return { targetIndex: 0, markerTop: 0 };
    const geometry = queueDragGeometryRef.current;
    if (!geometry) return { targetIndex: 0, markerTop: 0 };

    // Hit-test against the geometry captured before the preview starts. The
    // Rendered rows may be in the middle of a FLIP transition; their
    // transformed client rects are visual output, not stable drop slots.
    // Keeping the logical slots immutable prevents marker jitter and makes
    // upward and downward drops use the same coordinate system. The pointer
    // is compared with the original row centers so a drag started in a row
    // does not immediately jump past that row when its space is removed.
    const scrollDelta = list.scrollTop - geometry.scrollTop;
    let selectedSpaceBefore = 0;
    let remainingIndex = 0;
    let markerTop = 0;
    for (const item of items) {
      const row = geometry.rows.get(item.id);
      if (!row) continue;
      const markerSlotTop = row.top - geometry.listTop + geometry.scrollTop - selectedSpaceBefore;
      const rowTop = row.top - scrollDelta;
      if (clientY < rowTop + row.height / 2) {
        markerTop = markerSlotTop;
        break;
      }

      if (selectedIds.has(item.id)) {
        // Before and after a selected row are the same logical insertion slot
        // once that row is removed from the list.
        markerTop = markerSlotTop;
        selectedSpaceBefore += row.space;
      } else {
        markerTop = markerSlotTop + row.height;
        remainingIndex += 1;
      }
    }
    return {
      targetIndex: remainingIndex,
      markerTop: Math.max(0, markerTop)
    };
  };

  const queueDragPreviewTopForPointer = (pointerY: number): number => {
    const list = queueListElementRef.current;
    const geometry = queueDragGeometryRef.current;
    const drag = queueDragStateRef.current;
    if (!list || !geometry || !drag) return 0;
    return Math.max(
      0,
      pointerY - geometry.listTop + list.scrollTop - drag.pointerOffsetY
    );
  };

  const updateQueueDragPreviewPosition = (pointerY: number) => {
    const preview = queueDragPreviewElementRef.current;
    if (!preview) return;
    preview.style.top = `${queueDragPreviewTopForPointer(pointerY)}px`;
  };

  const clearQueueDragPreview = () => {
    queueDragPreviewOrderRef.current = null;
    queueDragGeometryRef.current = null;
    queueDragBaseItemsRef.current = [];
    queueDragItemsRef.current = queueReorderableDownloadsRef.current;
    if (isMountedRef.current) {
      setQueueDragPreviewOrder(null);
    }
  };

  const releaseQueuePointerCapture = () => {
    const captureTarget = queueDragCaptureTargetRef.current;
    const capturePointerId = queueDragCapturePointerIdRef.current;
    queueDragCaptureTargetRef.current = null;
    queueDragCapturePointerIdRef.current = null;
    if (!captureTarget || capturePointerId === null) return;
    try {
      if (captureTarget.hasPointerCapture(capturePointerId)) {
        captureTarget.releasePointerCapture(capturePointerId);
      }
    } catch (error) {
      // A row can be removed or its WebView can lose the pointer between the
      // terminal event and cleanup. Listener/state cleanup must still finish.
      console.warn('Failed to release queue pointer capture:', error);
    }
  };

  const trackQueueReorderOperation = (operation: () => Promise<void>): Promise<void> => {
    queueReorderPendingCountRef.current += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        queueReorderPendingCountRef.current = Math.max(0, queueReorderPendingCountRef.current - 1);
      });
  };

  const queueDragBeforeId = (
    previewOrder: string[] | null,
    selectedIds: ReadonlySet<string>
  ): string | null => {
    if (!previewOrder) return null;
    let lastSelectedIndex = -1;
    previewOrder.forEach((id, index) => {
      if (selectedIds.has(id)) lastSelectedIndex = index;
    });
    if (lastSelectedIndex === -1) return null;
    return previewOrder.slice(lastSelectedIndex + 1).find(id => !selectedIds.has(id)) ?? null;
  };

  const finishQueueDrag = (cancelled = false) => {
    const current = queueDragStateRef.current;
    if (!current) return;
    const cleanup = queueDragCleanupRef.current;
    queueDragCleanupRef.current = null;
    queueDragStateRef.current = null;
    if (isMountedRef.current) {
      setQueueDragState(null);
    }
    try {
      cleanup?.();
    } catch (error) {
      console.error('Failed to clean up queue drag listeners:', error);
    } finally {
      releaseQueuePointerCapture();
    }
    if (current.active) {
      if (suppressQueueClickTimerRef.current !== null) {
        window.clearTimeout(suppressQueueClickTimerRef.current);
      }
      suppressQueueClickRef.current = true;
      suppressQueueClickTimerRef.current = window.setTimeout(() => {
        suppressQueueClickRef.current = false;
        suppressQueueClickTimerRef.current = null;
      }, 0);
    }

    if (!cancelled && current.active) {
      const committedPreviewOrder = queueDragPreviewOrderRef.current;
      const targetBeforeId = queueDragBeforeId(
        committedPreviewOrder,
        new Set(current.ids)
      );
      const reorderOperation = trackQueueReorderOperation(
        () => moveManyInQueueToPosition(
          current.ids,
          current.queueId,
          current.targetIndex,
          targetBeforeId
        )
      );
      void reorderOperation
        .catch(error => showInteractionError(t($ => $.downloadTable.queueReorderFailed), error))
        .finally(() => {
          // Keep the optimistic order visible until the store has accepted or
          // rolled back the atomic backend move. A second drag must own its
          // own preview and cannot be cleared by this completion callback.
          if (queueDragPreviewOrderRef.current === committedPreviewOrder) {
            clearQueueDragPreview();
          }
        });
    } else {
      clearQueueDragPreview();
    }

    window.requestAnimationFrame(() => {
      if (!isMountedRef.current) return;
      queueRowForId(current.sourceId)?.focus({ preventScroll: true });
    });
  };

  const handleQueueDragStart = (
    id: string,
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    // Keep pointer capture on the persistent list instead of the row being
    // reordered. React moves row nodes during the live preview; a row-owned
    // capture can be lost when that node changes position in the DOM.
    const captureTarget = queueListElementRef.current ?? event.currentTarget;
    const pointerId = event.pointerId;
    if (
      !queueReorderingEnabled ||
      event.button !== 0 ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      queueDragStateRef.current ||
      queueDragPreviewOrderRef.current ||
      queueReorderPendingCountRef.current > 0
    ) return;
    clearQueueClickSuppression();
    if (
      event.target instanceof Element &&
      event.target.closest('button, a, input, textarea, select, [role="menu"], .download-row-actions')
    ) {
      return;
    }
    const currentDownloads = useDownloadStore.getState().downloads;
    const source = currentDownloads.find(download => download.id === id);
    if (!source) return;

    const reorderableById = new Map(
      queueReorderableDownloadsRef.current.map(download => [download.id, download])
    );
    if (!reorderableById.has(id)) return;

    const currentSelectedIds = selectedIdsRef.current;
    const ids = (currentSelectedIds.has(id) ? Array.from(currentSelectedIds) : [id])
      .filter(selectedId => {
        const selected = reorderableById.get(selectedId);
        return selected && (selected.queueId || MAIN_QUEUE_ID) === (source.queueId || MAIN_QUEUE_ID);
      });
    if (!ids.includes(id)) return;

    if (!currentSelectedIds.has(id)) {
      setSelectedIds(new Set([id]));
      setLastSelectedId(id);
    }

    queueDragCleanupRef.current?.();
    clearQueueDragPreview();
    const queueId = source.queueId || MAIN_QUEUE_ID;
    const selectedIdSet = new Set(ids);
    const sourceRect = event.currentTarget.getBoundingClientRect();
    const initialItems = queueDragItemsRef.current
      .filter(download => (download.queueId || MAIN_QUEUE_ID) === queueId);
    queueDragBaseItemsRef.current = initialItems;
    queueDragGeometryRef.current = captureQueueDragGeometry(initialItems);
    const initialPosition = queueDropPosition(event.clientY, initialItems, selectedIdSet);
    const initialState: QueueDragState = {
      pointerId: event.pointerId,
      sourceId: id,
      queueId,
      ids,
      startX: event.clientX,
      startY: event.clientY,
      pointerY: event.clientY,
      pointerOffsetY: event.clientY - sourceRect.top,
      active: false,
      ...initialPosition
    };
    queueDragStateRef.current = initialState;
    setQueueDragState(initialState);
    queueDragCaptureTargetRef.current = captureTarget;
    queueDragCapturePointerIdRef.current = pointerId;
    let pointerMoveFrame: number | null = null;
    let pendingPointerPosition: { clientX: number; clientY: number } | null = null;

    const applyPointerMove = (clientX: number, clientY: number) => {
      const drag = queueDragStateRef.current;
      if (!drag) return;
      const distance = Math.hypot(
        clientX - drag.startX,
        clientY - drag.startY
      );
      if (!drag.active && distance < 5) return;

      if (!drag.active) {
        try {
          captureTarget.setPointerCapture(pointerId);
        } catch {
          // The pointer may have been cancelled before the drag threshold.
          // Window-level listeners remain the best-effort cleanup fallback.
        }
      }

      const baseItems = queueDragBaseItemsRef.current;
      const selectedIdSet = new Set(drag.ids);
      queueDragStateRef.current = { ...drag, pointerY: clientY };
      const nextPosition = queueDropPosition(clientY, baseItems, selectedIdSet);
      const previewItems = moveSelectedBlockToIndex(
        baseItems,
        selectedIdSet,
        nextPosition.targetIndex
      );
      const nextPreviewOrder = previewItems.map(item => item.id);
      const currentPreviewOrder = queueDragPreviewOrderRef.current;
      const previewChanged = currentPreviewOrder === null ||
        currentPreviewOrder.length !== nextPreviewOrder.length ||
        currentPreviewOrder.some((itemId, index) => itemId !== nextPreviewOrder[index]);
      if (previewChanged) {
        queueDragItemsRef.current = previewItems;
        queueDragPreviewOrderRef.current = nextPreviewOrder;
        setQueueDragPreviewOrder(nextPreviewOrder);
      }
      suppressQueueClickRef.current = true;
      updateQueueDragPreviewPosition(clientY);
      if (
        !drag.active ||
        previewChanged ||
        nextPosition.markerTop !== drag.markerTop
      ) {
        const nextState = { ...queueDragStateRef.current, ...nextPosition, active: true };
        nextState.pointerY = clientY;
        queueDragStateRef.current = nextState;
        setQueueDragState(nextState);
      }
    };

    const flushPointerMove = () => {
      if (pointerMoveFrame !== null) {
        window.cancelAnimationFrame(pointerMoveFrame);
        pointerMoveFrame = null;
      }
      const pending = pendingPointerPosition;
      pendingPointerPosition = null;
      if (pending) applyPointerMove(pending.clientX, pending.clientY);
    };

    const pointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      pendingPointerPosition = {
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
      };
      const drag = queueDragStateRef.current;
      if (drag && (drag.active || Math.hypot(
        pointerEvent.clientX - drag.startX,
        pointerEvent.clientY - drag.startY
      ) >= 5)) {
        pointerEvent.preventDefault();
      }
      if (pointerMoveFrame === null) {
        pointerMoveFrame = window.requestAnimationFrame(() => {
          pointerMoveFrame = null;
          const pending = pendingPointerPosition;
          pendingPointerPosition = null;
          if (pending) applyPointerMove(pending.clientX, pending.clientY);
        });
      }
    };
    const pointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) {
        flushPointerMove();
        finishQueueDrag();
      }
    };
    const pointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) {
        pendingPointerPosition = null;
        if (pointerMoveFrame !== null) {
          window.cancelAnimationFrame(pointerMoveFrame);
          pointerMoveFrame = null;
        }
        finishQueueDrag(true);
      }
    };
    const lostPointerCapture = (event: Event) => {
      if ((event as PointerEvent).pointerId === pointerId) finishQueueDrag(true);
    };
    const cancel = () => finishQueueDrag(true);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', cancel);
    captureTarget.addEventListener('lostpointercapture', lostPointerCapture);
    queueDragCleanupRef.current = () => {
      pendingPointerPosition = null;
      if (pointerMoveFrame !== null) {
        window.cancelAnimationFrame(pointerMoveFrame);
        pointerMoveFrame = null;
      }
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', cancel);
      captureTarget.removeEventListener('lostpointercapture', lostPointerCapture);
    };
  };

  // The implementation closes over the current drag helpers, while rows need
  // a stable prop so React.memo can keep the entire queue from rerendering on
  // every pointer frame.
  const queueDragStartHandlerRef = useRef(handleQueueDragStart);
  queueDragStartHandlerRef.current = handleQueueDragStart;
  const stableHandleQueueDragStart = useCallback((id: string, event: React.PointerEvent<HTMLDivElement>) => {
    queueDragStartHandlerRef.current(id, event);
  }, []);

  const getDownloadPath = useCallback(async (item: DownloadItem) => {
    if (item.isTorrent) {
      try {
        const ownedPath = await invoke('get_download_primary_path', { id: item.id });
        if (ownedPath) return ownedPath;
      } catch (error) {
        console.error("Failed to resolve torrent output path:", error);
      }
    }
    const fileName = item.fileName?.trim();
    if (!fileName) return null;
    const settings = useSettingsStore.getState();
    const destination = item.destination ||
      await resolveCategoryDestination(settings, item.category);
    return resolveDownloadFilePath(destination, fileName);
  }, []);

  const openProperties = useCallback((id: string) => {
    void openPropertiesWindow(id).catch(error => {
      showInteractionError(t($ => $.downloadTable.interactionError, {
        message: t($ => $.downloadTable.properties),
        detail: error instanceof Error ? error.message : String(error)
      }), error);
    });
  }, [showInteractionError, t]);

  const revealDownloadFile = useCallback(async (item: DownloadItem) => {
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
  }, [getDownloadPath, openProperties, showInteractionError]);

  const openDownloadFile = useCallback(async (item: DownloadItem) => {
    if (item.status !== 'completed') {
      openProperties(item.id);
      return;
    }

    if (item.isTorrent) {
      await revealDownloadFile(item);
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
  }, [getDownloadPath, openProperties, revealDownloadFile, showInteractionError]);

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

  const queueReorderingEnabled = isQueueFilter && !queueSortConfig;
  const queueReorderableDownloads = useMemo(
    () => queueReorderingEnabled
      ? sortedDownloads.filter(download =>
          download.status !== 'completed' &&
          !(isActiveDownloadStatus(download.status) && download.status !== 'queued')
        )
      : [],
    [queueReorderingEnabled, sortedDownloads]
  );
  const queueReorderableIds = useMemo(
    () => new Set(queueReorderableDownloads.map(download => download.id)),
    [queueReorderableDownloads]
  );
  queueReorderableDownloadsRef.current = queueReorderableDownloads;

  const renderedDownloads = useMemo(() => {
    if (!queueDragPreviewOrder || !queueReorderingEnabled) return sortedDownloads;

    const previewRank = new Map(queueDragPreviewOrder.map((id, index) => [id, index]));
    const previewItems = [...queueReorderableDownloads].sort((left, right) =>
      (previewRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (previewRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
    let previewIndex = 0;
    return sortedDownloads.map(download => queueReorderableIds.has(download.id)
      ? previewItems[previewIndex++] ?? download
      : download
    );
  }, [queueDragPreviewOrder, queueReorderableDownloads, queueReorderableIds, queueReorderingEnabled, sortedDownloads]);
  queueDragItemsRef.current = renderedDownloads.filter(download => queueReorderableIds.has(download.id));

  const queueRowOrderKey = useMemo(
    () => renderedDownloads.map(download => download.id).join('\u0001'),
    [renderedDownloads]
  );

  useLayoutEffect(() => {
    const container = queueRowsContainerElementRef.current;
    const scrollContainer = queueListElementRef.current;
    if (!container || !scrollContainer) return;

    const measureRows = () => {
      const rows = new Map<string, { element: HTMLElement; motionElement: HTMLElement; top: number; height: number }>();
      const scrollContainerTop = scrollContainer.getBoundingClientRect().top;
      const scrollTop = scrollContainer.scrollTop;
      for (const child of Array.from(container.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const id = child.dataset.downloadId;
        const motionElement = Array.from(child.children).find(element =>
          element instanceof HTMLElement && element.classList.contains('download-row-motion')
        );
        if (!id || !(motionElement instanceof HTMLElement)) continue;
        const rowRect = child.getBoundingClientRect();
        const motionRect = motionElement.getBoundingClientRect();
        rows.set(id, {
          element: child,
          motionElement,
          top: motionRect.top - scrollContainerTop + scrollTop,
          height: rowRect.height,
        });
      }
      return rows;
    };

    const currentRows = measureRows();
    const previousTops = queueRowTopsRef.current;
    const previousHeights = queueRowHeightsRef.current;
    const wasAnimating = queueRowAnimationActiveRef.current;
    const layoutChanged = Array.from(currentRows).some(([id, row]) => {
      const previousHeight = previousHeights.get(id);
      return previousHeight !== undefined && Math.abs(previousHeight - row.height) > 0.5;
    });
    const generation = ++queueRowAnimationGenerationRef.current;

    if (queueRowAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(queueRowAnimationFrameRef.current);
      queueRowAnimationFrameRef.current = null;
    }
    if (queueRowAnimationTimerRef.current !== null) {
      window.clearTimeout(queueRowAnimationTimerRef.current);
      queueRowAnimationTimerRef.current = null;
    }

    const startTops = new Map<string, number>();
    for (const [id, row] of currentRows) {
      startTops.set(
        id,
        wasAnimating || layoutChanged ? row.top : previousTops.get(id) ?? row.top
      );
      row.motionElement.style.transition = 'none';
      row.motionElement.style.transform = '';
    }

    const finalRows = measureRows();
    queueRowTopsRef.current = new Map(
      Array.from(finalRows, ([id, row]) => [id, row.top])
    );
    queueRowHeightsRef.current = new Map(
      Array.from(finalRows, ([id, row]) => [id, row.height])
    );
    queueRowAnimationActiveRef.current = false;

    const movedRows = Array.from(finalRows).flatMap(([id, row]) => {
      const deltaY = (startTops.get(id) ?? row.top) - row.top;
      return Math.abs(deltaY) > 0.5 ? [{ element: row.motionElement, deltaY }] : [];
    });
    if (movedRows.length === 0) return;

    const prefersReducedMotion = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    for (const { element, deltaY } of movedRows) {
      element.style.willChange = 'transform';
      element.style.transform = `translate3d(0, ${deltaY}px, 0)`;
    }
    // Force the inverse transforms to be committed before releasing them on
    // the next frame. This keeps the FLIP animation independent of React's
    // render timing and avoids a layout read during pointer movement.
    void container.offsetHeight;

    queueRowAnimationActiveRef.current = true;
    queueRowAnimationFrameRef.current = window.requestAnimationFrame(() => {
      queueRowAnimationFrameRef.current = null;
      if (queueRowAnimationGenerationRef.current !== generation) return;
      for (const { element } of movedRows) {
        element.style.transition = `transform ${QUEUE_ROW_REORDER_DURATION}ms ${QUEUE_ROW_REORDER_EASING}`;
        element.style.transform = 'translate3d(0, 0, 0)';
      }
    });
    queueRowAnimationTimerRef.current = window.setTimeout(() => {
      queueRowAnimationTimerRef.current = null;
      if (queueRowAnimationGenerationRef.current !== generation) return;
      queueRowAnimationActiveRef.current = false;
      for (const { element } of movedRows) {
        element.style.removeProperty('transition');
        element.style.removeProperty('transform');
        element.style.removeProperty('will-change');
      }
    }, QUEUE_ROW_REORDER_DURATION + 60);
  }, [queueRowOrderKey]);

  useLayoutEffect(() => {
    if (!queueDragState?.active) return;
    // The preview follows the pointer imperatively so high-frequency pointer
    // movement does not rerender every row. Keep React renders caused by
    // progress or other download updates from overwriting that live position
    // with an older pointerY value.
    updateQueueDragPreviewPosition(queueDragState.pointerY);
  }, [queueDragState?.active]);

  useEffect(() => () => {
    queueRowAnimationGenerationRef.current += 1;
    if (queueRowAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(queueRowAnimationFrameRef.current);
    }
    if (queueRowAnimationTimerRef.current !== null) {
      window.clearTimeout(queueRowAnimationTimerRef.current);
    }
    const container = queueRowsContainerElementRef.current;
    if (container) {
      for (const child of Array.from(container.children)) {
        if (!(child instanceof HTMLElement) || !child.dataset.downloadId) continue;
        const motionElement = Array.from(child.children).find(element =>
          element instanceof HTMLElement && element.classList.contains('download-row-motion')
        );
        if (!(motionElement instanceof HTMLElement)) continue;
        motionElement.style.removeProperty('transition');
        motionElement.style.removeProperty('transform');
        motionElement.style.removeProperty('will-change');
      }
    }
    queueRowAnimationActiveRef.current = false;
    queueRowTopsRef.current.clear();
    queueRowHeightsRef.current.clear();
  }, []);

  useEffect(() => {
    const current = queueDragStateRef.current;
    if (!current) return;
    const currentQueueIds = new Set(
      queueReorderableDownloads
        .filter(download => (download.queueId || MAIN_QUEUE_ID) === current.queueId)
        .map(download => download.id)
    );
    if (
      !queueReorderingEnabled ||
      current.ids.some(id => !currentQueueIds.has(id))
    ) {
      finishQueueDrag(true);
    }
  }, [queueReorderableDownloads, queueReorderingEnabled]);

  const selectedDownloads = useMemo(
    () => filteredDownloads.filter(download => selectedIds.has(download.id)),
    [filteredDownloads, selectedIds]
  );
  const selectedActionCounts = useMemo(
    () => countDownloadActions(selectedDownloads),
    [selectedDownloads]
  );
  const hasStartableDownloads = downloads.some(download =>
    download.status === 'queued' || canStartDownload(download.status)
  );
  const hasPausableDownloads = downloads.some(download => canPauseDownload(download.status));
  const summaryDownloads = selectedDownloads.length > 0 ? selectedDownloads : filteredDownloads;
  const downloadSummary = useMemo(
    () => summarizeDownloads(summaryDownloads, progressMap),
    [summaryDownloads, progressMap]
  );
  const selectedQueueItems = useMemo(
    () => queueReorderableDownloads.filter(download => selectedIds.has(download.id)),
    [queueReorderableDownloads, selectedIds]
  );
  const selectedQueueIndices = selectedQueueItems
    .map(item => queueReorderableDownloads.findIndex(candidate => candidate.id === item.id));
  const canMoveSelectedUp = selectedQueueIndices.length > 0 && Math.min(...selectedQueueIndices) > 0;
  const canMoveSelectedDown = selectedQueueIndices.length > 0 &&
    Math.max(...selectedQueueIndices) < queueReorderableDownloads.length - 1;
  const queueReorderPending = queueDragState !== null ||
    queueDragPreviewOrder !== null;

  useEffect(() => {
    onSummaryChange?.({
      summary: downloadSummary,
    });
  }, [downloadSummary, onSummaryChange]);

  useEffect(() => () => onSummaryChange?.(null), [onSummaryChange]);

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
    if (queueDragPreviewOrder && queueReorderingEnabled && !queueDragState?.active) {
      queueDragPreviewOrder.forEach((id, index) => {
        positions.set(id, { index, length: queueDragPreviewOrder.length });
      });
    }
    return positions;
  }, [downloads, queueDragPreviewOrder, queueDragState?.active, queueReorderingEnabled]);
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
    if (suppressQueueClickRef.current) {
      clearQueueClickSuppression();
      return;
    }
    if (e.detail === 2) {
      handleDownloadDoubleClick(item);
      return;
    }
    const nextSelection = updateDownloadSelection({
      orderedIds: sortedDownloadsRef.current.map(download => download.id),
      selectedIds: selectedIdsRef.current,
      lastSelectedId: lastSelectedIdRef.current,
      targetId: item.id,
      extendRange: e.shiftKey,
      toggle: e.metaKey || e.ctrlKey,
    });
    setSelectedIds(nextSelection.selectedIds);
    setLastSelectedId(nextSelection.lastSelectedId);
  }, [clearQueueClickSuppression, handleDownloadDoubleClick]);

  const handleContextMenu = useCallback((menu: { x: number; y: number; id: string }) => {
    const nextSelection = selectContextMenuTarget({
      selectedIds: selectedIdsRef.current,
      lastSelectedId: lastSelectedIdRef.current,
      targetId: menu.id,
    });
    setSelectedIds(nextSelection.selectedIds);
    setLastSelectedId(nextSelection.lastSelectedId);
    setColumnMenu(null);
    const position = clampMenuPosition(menu.x, menu.y, 200, 300);
    setContextMenuPosition(position);
    setContextMenu(menu);
  }, [clampMenuPosition]);

  const handleMoveInQueue = useCallback((id: string, direction: 'up' | 'down') => {
    if (
      queueDragStateRef.current ||
      queueDragPreviewOrderRef.current
    ) return;
    const currentQueueItems = queueReorderableDownloadsRef.current;
    const source = currentQueueItems.find(item => item.id === id);
    if (!source) return;
    const sourceQueueId = source.queueId || MAIN_QUEUE_ID;
    const currentQueueIds = new Set(
      currentQueueItems
        .filter(item => (item.queueId || MAIN_QUEUE_ID) === sourceQueueId)
        .map(item => item.id)
    );
    const ids = selectedIdsRef.current.has(id)
      ? Array.from(selectedIdsRef.current).filter(selectedId => currentQueueIds.has(selectedId))
      : [id];
    if (ids.length === 0) return;
    void trackQueueReorderOperation(() => moveInQueue(ids, direction))
      .catch(error => showInteractionError(t($ => $.downloadTable.queueReorderFailed), error));
  }, [moveInQueue, showInteractionError, t]);

  const moveSelectedQueueItems = useCallback((ids: string[], direction: 'up' | 'down') => {
    if (
      queueDragStateRef.current ||
      queueDragPreviewOrderRef.current
    ) return;
    void trackQueueReorderOperation(() => moveInQueue(ids, direction))
      .catch(error => showInteractionError(t($ => $.downloadTable.queueReorderFailed), error));
  }, [moveInQueue, showInteractionError, t]);

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
      case 'Torrents': return t($ => $.navigation.categories.torrents);
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
      const current = useDownloadStore.getState().downloads.find(download => download.id === item.id);
      if (!current) return;
      let resumeWithoutCredentials = false;
      if (current.credentialsRequired === true) {
        resumeWithoutCredentials = window.confirm(t($ => $.properties.resumeWithoutCredentialsConfirm));
        if (!resumeWithoutCredentials) return;
      }
      const resumed = await useDownloadStore.getState().resumeDownload(item.id, {
        resumeWithoutCredentials
      });
      if (!resumed) {
        const latest = useDownloadStore.getState().downloads.find(
          download => download.id === item.id
        );
        const reason = latest?.lastError?.trim();
        throw new Error(reason || t($ => $.downloadTable.backendRejectedStart));
      }
    } catch (error) {
      console.error("Failed to resume:", error);
        showInteractionError(t($ => $.downloadTable.resumeFailed, { fileName: item.fileName }), error);
    }
  }, [showInteractionError, t]);

  const getCurrentSelectedDownloads = useCallback(() => {
    const selected = selectedIdsRef.current;
    return useDownloadStore.getState().downloads.filter(download => selected.has(download.id));
  }, []);

  const handlePauseSelected = useCallback(async () => {
    const items = getCurrentSelectedDownloads().filter(download => canPauseDownload(download.status));
    if (items.length === 0) return;

    const nonResumableCount = items.filter(download => download.resumable === false).length;
    if (nonResumableCount > 0) {
      const confirmPause = window.confirm(
        nonResumableCount === 1
          ? t($ => $.downloadTable.nonResumableOne)
          : t($ => $.downloadTable.nonResumableMany, { count: nonResumableCount })
      );
      if (!confirmPause) return;
    }

    await Promise.all(items.map(item => {
      const current = useDownloadStore.getState().downloads.find(download => download.id === item.id);
      return current && canPauseDownload(current.status)
        ? handlePause(current.id, true)
        : Promise.resolve();
    }));
  }, [getCurrentSelectedDownloads, handlePause, t]);

  const handleResumeSelected = useCallback(() => {
    const ids = Array.from(selectedIdsRef.current);
    if (ids.length === 0) return;
    const selected = useDownloadStore.getState().downloads.filter(download => ids.includes(download.id));
    const credentialMarkedIds = selected
      .filter(download => download.credentialsRequired === true && canStartDownload(download.status))
      .map(download => download.id);
    if (credentialMarkedIds.length > 0
      && !window.confirm(t($ => $.properties.resumeWithoutCredentialsConfirm))) {
      // Continue ordinary selected resumes. Credential-marked rows remain
      // fail-closed and can be handled individually after the user supplies
      // credentials or confirms a credentialless retry.
      const credentialMarkedIdSet = new Set(credentialMarkedIds);
      const ordinaryIds = ids.filter(id => !credentialMarkedIdSet.has(id));
      if (ordinaryIds.length === 0) return;
      void startSelected(ordinaryIds).catch(error => {
        showInteractionError(t($ => $.downloadTable.resumeFailed), error);
      });
      return;
    }
    void startSelected(ids, {
      resumeWithoutCredentialsIds: credentialMarkedIds
    }).catch(error => {
      showInteractionError(t($ => $.downloadTable.resumeFailed), error);
    });
  }, [showInteractionError, startSelected, t]);

  const handleStartAll = useCallback(() => {
    const credentialMarkedIds = useDownloadStore.getState().downloads
      .filter(download =>
        download.credentialsRequired === true
        && (download.status === 'queued' || canStartDownload(download.status))
      )
      .map(download => download.id);
    const resumeWithoutCredentials = credentialMarkedIds.length > 0
      && window.confirm(t($ => $.properties.resumeWithoutCredentialsConfirm));
    void startAll({
      resumeWithoutCredentialsIds: resumeWithoutCredentials ? credentialMarkedIds : []
    }).catch(error => {
      showInteractionError(t($ => $.downloadTable.resumeFailed), error);
    });
  }, [showInteractionError, startAll, t]);

  const handlePauseAll = useCallback(async () => {
    const currentDownloads = useDownloadStore.getState().downloads;
    const pausableDownloads = currentDownloads.filter(download => canPauseDownload(download.status));
    if (pausableDownloads.length === 0) return;

    const nonResumableCount = pausableDownloads.filter(download => download.resumable === false).length;
    if (nonResumableCount > 0) {
      const confirmPause = window.confirm(
        nonResumableCount === 1
          ? t($ => $.downloadTable.nonResumableOne)
          : t($ => $.downloadTable.nonResumableMany, { count: nonResumableCount })
      );
      if (!confirmPause) return;
    }

    try {
      await pauseAll();
    } catch (error) {
      showInteractionError(t($ => $.downloadTable.pauseFailed), error);
    }
  }, [pauseAll, showInteractionError, t]);

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
      case 'Torrents': return <Magnet size={16} className="text-violet-400" />;
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
  const queueDragPreviewItem = queueDragState?.active
    ? queueDragState.ids
      .map(id => queueReorderableDownloads.find(download => download.id === id))
      .find((download): download is DownloadItem => Boolean(download))
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
            disabled={!hasStartableDownloads}
            onClick={handleStartAll}
            title={t($ => $.downloadTable.resumeAll)}
          >
            <Play size={15} fill="currentColor" />
          </button>

          <button 
            className="main-control-button" 
            disabled={!hasPausableDownloads}
            onClick={() => void handlePauseAll()}
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
          {queueReorderingEnabled && queueReorderableDownloads.length > 0 ? (
            <span className="downloads-queue-reorder-hint" title={t($ => $.downloadTable.queueReorderShortcut, { key: isMac ? 'Option' : 'Alt' })}>
              <span>{t($ => $.downloadTable.queueReorderHint)}</span>
              <span
                className="downloads-queue-reorder-shortcut"
                aria-label={t($ => $.downloadTable.queueReorderShortcut, { key: isMac ? 'Option' : 'Alt' })}
              >
                <kbd>{isMac ? 'Option' : 'Alt'}</kbd>
                <span aria-hidden="true">+</span>
                <kbd>↑</kbd>
                <span aria-hidden="true">/</span>
                <kbd>↓</kbd>
              </span>
            </span>
          ) : null}
        </div>
        <div className="downloads-header-actions">
          {selectedDownloads.length > 0 ? (
            <span className="downloads-selection-status">
              {t($ => $.downloadTable.summary.selected, { count: selectedDownloads.length })}
            </span>
          ) : null}
          {queueReorderingEnabled && queueReorderableDownloads.length > 0 ? (
            <div
              className="main-control-group downloads-queue-priority-controls"
              role="group"
              aria-label={t($ => $.downloadTable.queuePriorityControls)}
            >
              <button
                type="button"
                className="main-control-button"
                disabled={queueReorderPending || !canMoveSelectedUp}
                aria-label={t($ => $.downloads.actions.moveUp)}
                title={t($ => $.downloads.actions.moveUp)}
                onClick={() => moveSelectedQueueItems(selectedQueueItems.map(item => item.id), 'up')}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="main-control-button"
                disabled={queueReorderPending || !canMoveSelectedDown}
                aria-label={t($ => $.downloads.actions.moveDown)}
                title={t($ => $.downloads.actions.moveDown)}
                onClick={() => moveSelectedQueueItems(selectedQueueItems.map(item => item.id), 'down')}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="app-page-transition-content downloads-table flex-1 flex flex-col">
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
            <div className="download-table-list" ref={queueListRef}>
              <div className="download-table-list-content" ref={queueRowsContainerRef}>
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
                    {renderedDownloads.map(d => (
                      <DownloadItemComponent
                        key={d.id}
                        download={d}
                        allocationPending={allocationPendingIds.has(d.id)}
                        queueIndex={queuePositionsByDownloadId.get(d.id)?.index ?? -1}
                        columnOrder={orderedColumns}
                        columnAlignments={columnAlignments}
                        tableGridTemplate={tableGridTemplate}
                        tableMinWidth={tableMinWidthWithPadding}
                        setContextMenu={handleContextMenu}
                        handlePause={handlePause}
                        handleResume={handleResume}
                        handlePauseSelected={handlePauseSelected}
                        handleResumeSelected={handleResumeSelected}
                        getCategoryIcon={getCategoryIcon}
                        isSelected={selectedIds.has(d.id)}
                        selectedDownloadCount={selectedDownloads.length}
                        selectedActionCounts={selectedActionCounts}
                        isQueueReorderable={queueReorderableIds.has(d.id)}
                        isQueueDragSource={Boolean(queueDragState?.active && queueDragState.ids.includes(d.id))}
                        onMoveInQueue={handleMoveInQueue}
                        onQueueDragStart={stableHandleQueueDragStart}
                        onClick={handleItemClick}
                      />
                    ))}
                    <div className="flex-1 min-h-0 bg-transparent pointer-events-none" />
                  </>
                )}
              </div>
              {queueDragState?.active && queueDragPreviewItem ? (
                <div
                  ref={queueDragPreviewElementRef}
                  className="download-queue-drag-preview"
                  aria-hidden="true"
                >
                  <span className="download-queue-drag-preview-icon">
                    {getCategoryIcon(queueDragPreviewItem.category)}
                  </span>
                  <span className="download-queue-drag-preview-name">
                    {queueDragPreviewItem.fileName}
                  </span>
                  {queueDragState.ids.length > 1 ? (
                    <span className="download-queue-drag-preview-count">
                      +{queueDragState.ids.length - 1}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {queueDragState?.active ? (
                <div
                  className="download-queue-drop-marker"
                  style={{ top: `${queueDragState.markerTop}px` }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {columnMenu && createPortal(
        <div
          role="menu"
          ref={columnMenuRef}
          className="download-column-menu app-modal fixed z-[70] min-w-[188px] max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden py-1.5 text-[12px] font-medium text-text-primary"
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
        </div>,
        document.body
      )}

      {/* Floating Context Menu */}
      {contextMenu && contextItem && createPortal(
        <div
          role="menu"
          ref={contextMenuRef}
          className="app-modal fixed z-[70] min-w-[180px] max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden py-1.5 text-[12px] font-medium text-text-primary"
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
                handleResumeSelected();
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
                    void handlePauseSelected();
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
                <FloatingQueueSubmenu
                  label={t($ => $.downloadTable.addToQueue)}
                  queues={queues}
                  onSelect={q => {
                    setContextMenu(null);
                    void assignToQueue(itemsToQueue.map(item => item.id), q.id).catch(error => {
                      showInteractionError(t($ => $.downloadTable.moveManyFailed), error);
                    });
                  }}
                />
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
                <FloatingQueueSubmenu
                  label={t($ => $.downloadTable.addToQueue)}
                  queues={queues}
                  onSelect={q => {
                    setContextMenu(null);
                    void assignToQueue([contextItem.id], q.id).catch(error => {
                      showInteractionError(t($ => $.downloadTable.moveOneFailed), error);
                    });
                  }}
                />
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

              {contextItem.isTorrent && (
                <button
                  onClick={async () => {
                    setContextMenu(null);
                    try {
                      const magnet = await invoke('get_torrent_magnet_link', { id: contextItem.id });
                      await writeClipboardText(magnet);
                    } catch (error) {
                      showInteractionError(t($ => $.downloadTable.copyMagnetFailed), error);
                    }
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
                >
                  {t($ => $.downloadTable.copyMagnet)}
                </button>
              )}

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
        </div>,
        document.body
      )}

    </div>
  );
};
