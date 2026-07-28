import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invokeCommand as invoke } from '../ipc';
import { save } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { attachLogger, setLogPaused, initLogger, setLogStreamActive } from '../utils/logger';
import { FileDown, Trash2, Terminal, Filter, Play, Pause, Info, Copy } from 'lucide-react';
import { WindowDragRegion } from './WindowDragRegion';
import { useToast } from '../contexts/ToastContext';
import { useSettingsStore } from '../store/useSettingsStore';
import { useTranslation } from 'react-i18next';
import { clampFloatingPosition } from '../utils/floatingPosition';
import {
  MAX_LOG_LINES,
  appendBoundedLogEntries,
  liveLogEntry,
  mergeLogSnapshotAndLiveEntries,
  persistedLogEntry,
  pushBoundedLogEntry,
  type LogEntry
} from '../utils/logEntries';

export default function LogsView() {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const logsEnabled = useSettingsStore(state => state.logsEnabled);
  const setLogsEnabled = useSettingsStore(state => state.setLogsEnabled);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<LogEntry['level'] | 'All'>('All');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  const homeDirectoryRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveBatchRef = useRef<LogEntry[]>([]);
  const liveFrameRef = useRef<number | null>(null);
  const clearGenerationRef = useRef(0);
  const clearInFlightRef = useRef<Promise<void> | null>(null);
  const toggleInFlightRef = useRef<Promise<void> | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  useEffect(() => {
    let active = true;
    void homeDir()
      .then(directory => {
        if (active) homeDirectoryRef.current = directory;
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!pageVisible) {
      void setLogStreamActive(false).catch(console.error);
      return;
    }

    if (!logsEnabled) {
      void setLogStreamActive(false).catch(console.error);
    }

    let active = true;
    let initialized = false;
    const initGeneration = clearGenerationRef.current;
    let pendingLiveEntries: LogEntry[] = [];
    let unlistenPromise: Promise<() => void> | undefined;

    const scheduleLiveEntry = (entry: LogEntry) => {
      if (!initialized) {
        pushBoundedLogEntry(pendingLiveEntries, entry);
        return;
      }

      pushBoundedLogEntry(liveBatchRef.current, entry);
      if (liveFrameRef.current !== null) return;
      liveFrameRef.current = window.requestAnimationFrame(() => {
        liveFrameRef.current = null;
        if (!active || liveBatchRef.current.length === 0) return;
        const batch = liveBatchRef.current;
        liveBatchRef.current = [];
        setLogs(current => appendBoundedLogEntries(current, batch));
      });
    };

    const init = async () => {
      try {
        await initLogger();
        if (!active) return;

        if (logsEnabled) {
          unlistenPromise = attachLogger((log) => {
            if (!active) return;
            scheduleLiveEntry(liveLogEntry(log.level, log.message, new Date(), homeDirectoryRef.current));
          });
          await unlistenPromise;
          if (!active) return;
          await setLogStreamActive(true);
          if (!active) {
            await setLogStreamActive(false).catch(console.error);
            return;
          }
        }

        const lines = await invoke('read_logs', { limit: MAX_LOG_LINES });
        if (!active) return;
        const snapshot = lines.map(line => persistedLogEntry(line, homeDirectoryRef.current));
        initialized = true;
        if (initGeneration !== clearGenerationRef.current) {
          pendingLiveEntries = [];
          return;
        }
        const caughtUpLogs = mergeLogSnapshotAndLiveEntries(snapshot, pendingLiveEntries);
        pendingLiveEntries = [];
        setLogs(caughtUpLogs);
      } catch (e) {
        console.error('Failed to init logs:', e);
      }
    };
    void init();
    
    return () => {
      active = false;
      liveBatchRef.current = [];
      if (liveFrameRef.current !== null) {
        window.cancelAnimationFrame(liveFrameRef.current);
        liveFrameRef.current = null;
      }
      if (logsEnabled) {
        void setLogStreamActive(false).catch(console.error);
      }
      if (unlistenPromise) {
        void unlistenPromise.then(unlisten => unlisten()).catch(console.error);
      }
    };
  }, [logsEnabled, pageVisible]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    const handleCloseMenu = () => setContextMenu(null);
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    window.addEventListener('click', handleCloseMenu);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('click', handleCloseMenu);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const selection = window.getSelection()?.toString();
    if (selection && selection.trim().length > 0) {
      const position = clampFloatingPosition(e.clientX, e.clientY, 150, 50, window.innerWidth, window.innerHeight);
      setContextMenuPosition(position);
      setContextMenu({ x: e.clientX, y: e.clientY, text: selection });
    } else {
      setContextMenu(null);
    }
  };

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;

    const updateContextMenuPosition = () => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const nextPosition = clampFloatingPosition(
        contextMenu.x,
        contextMenu.y,
        menu.offsetWidth || rect.width,
        menu.offsetHeight || rect.height,
        window.innerWidth,
        window.innerHeight
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
  }, [contextMenu]);

  const handleCopy = async () => {
    if (contextMenu?.text) {
      try {
        await navigator.clipboard.writeText(contextMenu.text);
        addToast({ message: t($ => $.logs.copied), variant: 'success' });
      } catch (err) {
        console.error('Clipboard write error:', err);
        addToast({ message: t($ => $.logs.copyFailed), variant: 'error' });
      }
    }
    setContextMenu(null);
  };

  const handleExport = async () => {
    try {
      const path = await save({
        defaultPath: 'Firelink-Support-Logs.log',
        filters: [{ name: t($ => $.logs.logFiles), extensions: ['log'] }],
      });
      if (!path) return;
      await invoke('export_logs', { destination: path });
      addToast({ message: t($ => $.logs.exported), variant: 'success' });
    } catch (e) {
      console.error('Export failed:', e);
      addToast({ message: t($ => $.logs.exportFailed, { detail: String(e) }), variant: 'error', isActionable: true });
    }
  };

  const handleClear = async () => {
    if (clearInFlightRef.current) return;

    const clearOperation = invoke('clear_logs');
    clearInFlightRef.current = clearOperation;
    setIsClearing(true);
    try {
      await clearOperation;
      clearGenerationRef.current += 1;
      liveBatchRef.current = [];
      if (liveFrameRef.current !== null) {
        window.cancelAnimationFrame(liveFrameRef.current);
        liveFrameRef.current = null;
      }
      setLogs([]);
      addToast({ message: t($ => $.logs.cleared), variant: 'info' });
    } catch (error) {
      addToast({
        message: t($ => $.logs.clearFailed, { detail: String(error) }),
        variant: 'error',
        isActionable: true
      });
    } finally {
      if (clearInFlightRef.current === clearOperation) {
        clearInFlightRef.current = null;
      }
      setIsClearing(false);
    }
  };

  const handleToggleLogging = async () => {
    if (toggleInFlightRef.current) return;

    const nextEnabled = !logsEnabled;
    const toggleOperation = (async () => {
      await setLogPaused(!nextEnabled);
      setLogsEnabled(nextEnabled);
      addToast({
        message: nextEnabled ? t($ => $.logs.enabled) : t($ => $.logs.disabled),
        variant: 'success'
      });
    })();
    toggleInFlightRef.current = toggleOperation;
    setIsToggling(true);
    try {
      await toggleOperation;
    } catch (error) {
      addToast({
        message: t($ => $.logs.updateFailed, { detail: String(error) }),
        variant: 'error',
        isActionable: true
      });
    } finally {
      if (toggleInFlightRef.current === toggleOperation) {
        toggleInFlightRef.current = null;
      }
      setIsToggling(false);
    }
  };

  const severityClass = (level: string) => {
    switch (level) {
      case 'Error': return 'log-error';
      case 'Warn': return 'log-warn';
      case 'Info': return 'log-info';
      default: return 'log-debug';
    }
  };

  return (
    <div className="logs-view flex-1 flex flex-col h-full overflow-hidden">
      <WindowDragRegion />

      {/* Toolbar */}
      <div className="logs-toolbar flex items-center justify-between px-4 py-2 shrink-0">
        <div className="flex items-center gap-2 text-text-secondary">
          <Terminal size={16} strokeWidth={1.8} />
          <span className="text-[13px] font-semibold text-text-primary">{t($ => $.logs.title)}</span>
          <span className="text-[11px] text-text-muted">{t($ => $.logs.entries, { count: logs.length })}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            logsEnabled ? 'bg-accent/15 text-accent' : 'bg-item-hover text-text-muted'
          }`}>
            {logsEnabled ? t($ => $.logs.collecting) : t($ => $.logs.off)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Filter size={13} className="text-text-muted" />
            <select
              value={levelFilter}
              onChange={e => setLevelFilter(e.target.value as LogEntry['level'] | 'All')}
              className="bg-bg-input border border-border-modal rounded px-1.5 py-0.5 text-[11px] text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="All">{t($ => $.logs.allLevels)}</option>
              <option value="Error">{t($ => $.logs.levels.error)}</option>
              <option value="Warn">{t($ => $.logs.levels.warn)}</option>
              <option value="Info">{t($ => $.logs.levels.info)}</option>
              <option value="Debug">{t($ => $.logs.levels.debug)}</option>
              <option value="Trace">{t($ => $.logs.levels.trace)}</option>
            </select>
          </div>
          <div className="w-[1px] h-4 bg-border-modal mx-0.5" />
          <button
            onClick={handleToggleLogging}
            disabled={isToggling}
            className={`app-icon-button disabled:cursor-not-allowed disabled:opacity-50 ${logsEnabled ? 'text-accent' : ''}`}
            title={logsEnabled ? t($ => $.logs.pauseLogging) : t($ => $.logs.enableLogging)}
          >
            {logsEnabled ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={handleClear}
            disabled={isClearing}
            className="app-icon-button disabled:cursor-not-allowed disabled:opacity-50"
            title={t($ => $.logs.clearDisplayed)}
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={handleExport}
            className="app-button px-3 text-[11px] gap-1.5"
            title={t($ => $.logs.export)}
          >
            <FileDown size={13} />
            {t($ => $.logs.exportButton)}
          </button>
        </div>
      </div>

      {/* Privacy Hint */}
      <div className="bg-black/10 border-y border-border-modal px-4 py-2 shrink-0 flex items-center gap-2 text-text-muted text-[10px] select-none">
        <Info size={12} className="text-text-muted opacity-80 shrink-0" />
        <span className="opacity-90 leading-tight">
          <strong className="font-medium text-text-primary me-1">{t($ => $.logs.localDiagnostics)}</strong>
          {t($ => $.logs.diagnosticsDescription)}
        </span>
      </div>

      {/* Console */}
      <div
        ref={scrollRef}
        onContextMenu={handleContextMenu}
        className="app-page-transition-content logs-console flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-[1.5] select-text"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {logs.length === 0 && (
          <div className="text-text-muted italic select-none">
            {logsEnabled ? t($ => $.logs.noEntries) : t($ => $.logs.disabledDescription)}
          </div>
        )}
        {logs.filter(entry => levelFilter === 'All' || entry.level === levelFilter).map((entry, i) => (
          <div key={i} className={`log-line ${severityClass(entry.level)}`}>
            <span className="log-level-tag">[{entry.level}]</span>
            <span className="log-message">{entry.message}</span>
          </div>
        ))}
      </div>

      {/* Context Menu */}
      {contextMenu && createPortal(
        <div
          role="menu"
          ref={contextMenuRef}
          className="app-modal fixed z-[70] min-w-[150px] max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden py-1.5 text-[12px] font-medium text-text-primary"
          style={{ left: contextMenuPosition?.x, top: contextMenuPosition?.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-start px-3 py-2 flex items-center hover:bg-item-hover transition-colors"
            onClick={handleCopy}
          >
            <Copy size={13} className="me-2 text-text-secondary" />
            {t($ => $.logs.copy)}
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
