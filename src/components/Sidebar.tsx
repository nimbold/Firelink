import React, { useState, useEffect, useRef } from 'react';
import {
  Inbox, Zap, CheckCircle2, CircleDashed,
  Film, Music, FileText, Box, Image as ImageIcon, Archive, FileQuestion,
  List, CalendarClock, Gauge, Bug, Settings, Plus, Play, Pause, Edit2, Trash2, PanelLeft,
  ChevronDown,
  type LucideIcon
} from 'lucide-react';
import { useDownloadStore, DownloadCategory, Queue } from '../store/useDownloadStore';
import { ActiveView, useSettingsStore } from '../store/useSettingsStore';
import { WindowDragRegion } from './WindowDragRegion';
import { useToast } from '../contexts/ToastContext';
import { isTransferActiveStatus } from '../utils/downloads';

export type SidebarFilter = 'all' | 'active' | 'completed' | 'unfinished' | DownloadCategory | 'settings' | string;

interface SidebarProps {
  selectedFilter: SidebarFilter;
  onSelectFilter: (filter: SidebarFilter) => void;
}

export const Sidebar: React.FC<SidebarProps> = (props) => {
  const { selectedFilter, onSelectFilter } = props;
  const { downloads, queues, addQueue, renameQueue, removeQueue, startQueue, pauseQueue } = useDownloadStore();
  const { activeView, setActiveView, toggleSidebar } = useSettingsStore();
  const { addToast } = useToast();

  const [isAddingQueue, setIsAddingQueue] = useState(false);
  const [newQueueName, setNewQueueName] = useState('');
  const [renamingQueueId, setRenamingQueueId] = useState<string | null>(null);
  const [editingQueueName, setEditingQueueName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [foldersCollapsed, setFoldersCollapsed] = useState(() =>
    window.localStorage.getItem('firelink-folders-collapsed') === 'true'
  );
  const foldersToggleRef = useRef<HTMLButtonElement>(null);
  const foldersListRef = useRef<HTMLDivElement>(null);

  const addInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const addQueueSubmitRef = useRef(false);
  const renameQueueSubmitRef = useRef(false);

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
    if (isAddingQueue) addInputRef.current?.focus();
  }, [isAddingQueue]);

  useEffect(() => {
    if (renamingQueueId) renameInputRef.current?.focus();
  }, [renamingQueueId]);

  useEffect(() => {
    window.localStorage.setItem('firelink-folders-collapsed', String(foldersCollapsed));
  }, [foldersCollapsed]);

  useEffect(() => {
    if (foldersCollapsed && foldersListRef.current?.contains(document.activeElement)) {
      foldersToggleRef.current?.focus();
    }
  }, [foldersCollapsed]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('.app-modal-backdrop') || document.querySelector('.app-modal')) return;
      const activeEl = document.activeElement as HTMLElement | null;
      const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
      
      if (!isInput && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (activeEl && activeEl.closest('.sidebar-inner')) {
          if (activeView === 'downloads' && selectedFilter.startsWith('queue:')) {
            const queueId = selectedFilter.replace('queue:', '');
            const q = queues.find(q => q.id === queueId);
            if (q && !q.isMain) {
              if (!window.confirm(`Delete queue "${q.name}"? Its unfinished downloads will move to Main Queue.`)) {
                return;
              }
              void removeQueue(queueId).catch(error => {
                addToast({ message: `Could not delete queue: ${String(error)}`, variant: 'error', isActionable: true });
              });
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addToast, activeView, queues, removeQueue, selectedFilter]);

  const getCount = (filter: SidebarFilter) => {
    if (filter.startsWith('queue:')) {
      const qid = filter.replace('queue:', '');
      return downloads.filter(d => d.queueId === qid && d.status !== 'completed').length;
    }
    switch (filter) {
      case 'all': return downloads.length;
      case 'active': return downloads.filter(d => isTransferActiveStatus(d.status)).length;
      case 'completed': return downloads.filter(d => d.status === 'completed').length;
      case 'unfinished': return downloads.filter(d => d.status !== 'completed').length;
      default: return downloads.filter(d => d.category === filter as DownloadCategory).length;
    }
  };

  const NavItem = ({ icon: Icon, label, filter }: { icon: LucideIcon, label: string, filter: SidebarFilter }) => {
    const isSelected = activeView === 'downloads' && selectedFilter === filter;

    return (
      <button
        type="button"
        data-active={isSelected}
        className="sidebar-nav-item group flex w-full items-center text-[13px] text-left cursor-default font-medium"
        onClick={() => onSelectFilter(filter)}
      >
        <Icon className="w-[18px] h-[18px] mr-3 shrink-0" strokeWidth={isSelected ? 2.5 : 2} />
        <span className="truncate">{label}</span>
        {getCount(filter) > 0 && (
          <span className="sidebar-count ml-auto min-w-5 px-1.5 py-0.5 rounded-full text-center text-[10px] leading-none font-bold">
            {getCount(filter)}
          </span>
        )}
      </button>
    );
  };

  const handleQueueContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, id });
  };

  const handleAddQueueSubmit = () => {
    if (addQueueSubmitRef.current) return;
    const normalizedName = newQueueName.trim();
    if (!normalizedName) {
      addToast({ message: 'Queue name cannot be empty', variant: 'error', isActionable: true });
      return;
    }
    if (!addQueue(normalizedName)) {
      addToast({ message: 'A queue with this name already exists', variant: 'error', isActionable: true });
      return;
    }
    addQueueSubmitRef.current = true;
    setNewQueueName('');
    setIsAddingQueue(false);
  };

  const handleRenameQueueSubmit = () => {
    if (renameQueueSubmitRef.current) return;
    const normalizedName = editingQueueName.trim();
    if (!renamingQueueId) return;
    if (!normalizedName) {
      addToast({ message: 'Queue name cannot be empty', variant: 'error', isActionable: true });
      return;
    }
    if (!renameQueue(renamingQueueId, normalizedName)) {
      addToast({ message: 'A queue with this name already exists', variant: 'error', isActionable: true });
      return;
    }
    renameQueueSubmitRef.current = true;
    setRenamingQueueId(null);
  };

  const QueueItem = ({ queue }: { queue: Queue }) => {
    const filterId = `queue:${queue.id}`;
    const isSelected = activeView === 'downloads' && selectedFilter === filterId;
    const isRenaming = renamingQueueId === queue.id;

    if (isRenaming) {
      return (
        <div className="flex items-center px-2.5 py-1 rounded-lg mb-0.5 bg-item-hover">
          <List className="w-4 h-4 mr-2 text-text-secondary" strokeWidth={2} />
          <input
            ref={renameInputRef}
            type="text"
            className="flex-1 bg-transparent border border-accent rounded px-1 text-[13px] text-text-primary outline-none min-w-0"
            value={editingQueueName}
            onChange={e => setEditingQueueName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRenameQueueSubmit();
              if (e.key === 'Escape') setRenamingQueueId(null);
            }}
            onBlur={handleRenameQueueSubmit}
          />
        </div>
      );
    }

    return (
      <button
        type="button"
        data-active={isSelected}
        onContextMenu={e => handleQueueContextMenu(e, queue.id)}
        onClick={() => onSelectFilter(filterId)}
        className="sidebar-nav-item group flex w-full items-center text-[13px] text-left cursor-default font-medium"
      >
        <List className="w-[18px] h-[18px] mr-3 shrink-0" strokeWidth={isSelected ? 2.5 : 2} />
        <span className="truncate">{queue.name}</span>
        {getCount(filterId) > 0 && (
          <span className="sidebar-count ml-auto min-w-5 px-1.5 py-0.5 rounded-full text-center text-[10px] leading-none font-bold shrink-0">
            {getCount(filterId)}
          </span>
        )}
      </button>
    );
  };

  const ToolItem = ({ icon: Icon, label, view }: { icon: LucideIcon; label: string; view: ActiveView }) => {
    const isSelected = activeView === view;
    return (
      <button
        type="button"
        data-active={isSelected}
        onClick={() => setActiveView(view)}
        className="sidebar-nav-item group flex w-full items-center text-[13px] text-left cursor-default font-medium"
      >
        <Icon className="w-[18px] h-[18px] mr-3 shrink-0" strokeWidth={isSelected ? 2.5 : 2} />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <aside className="sidebar-inner">
      <div className="sidebar-top-region">
        <WindowDragRegion />

        <button
          type="button"
          onClick={toggleSidebar}
          className="sidebar-toggle-button"
          title="Hide Sidebar"
        >
          <PanelLeft size={14} strokeWidth={1.9} />
        </button>
      </div>
      <div className="sidebar-scroll">
        <section className="sidebar-section">
          <div className="sidebar-section-label">Library</div>
          <NavItem icon={Inbox} label="All" filter="all" />
          <NavItem icon={Zap} label="Active" filter="active" />
          <NavItem icon={CheckCircle2} label="Completed" filter="completed" />
          <NavItem icon={CircleDashed} label="Unfinished" filter="unfinished" />
        </section>

        <section className="sidebar-section">
          <button
            type="button"
            ref={foldersToggleRef}
            className="sidebar-section-label sidebar-section-label-toggle"
            aria-expanded={!foldersCollapsed}
            aria-controls="sidebar-folders-list"
            onClick={() => setFoldersCollapsed(collapsed => !collapsed)}
          >
            <span>Folders</span>
            <ChevronDown
              aria-hidden="true"
              size={13}
              className={`sidebar-section-chevron ${foldersCollapsed ? 'is-collapsed' : ''}`}
            />
          </button>
          <div
            ref={foldersListRef}
            id="sidebar-folders-list"
            className={`sidebar-collapse-grid ${foldersCollapsed ? 'is-collapsed' : ''}`}
            aria-hidden={foldersCollapsed}
            inert={foldersCollapsed}
          >
            <div className="sidebar-collapse-content">
              <NavItem icon={Music} label="Musics" filter="Musics" />
              <NavItem icon={Film} label="Movies" filter="Movies" />
              <NavItem icon={Archive} label="Compressed" filter="Compressed" />
              <NavItem icon={FileText} label="Documents" filter="Documents" />
              <NavItem icon={ImageIcon} label="Pictures" filter="Pictures" />
              <NavItem icon={Box} label="Applications" filter="Applications" />
              <NavItem icon={FileQuestion} label="Other" filter="Other" />
            </div>
          </div>
        </section>

        <section className="sidebar-section">
          <div className="sidebar-section-label">Queues</div>
          {queues.map(queue => (
            <QueueItem key={queue.id} queue={queue} />
          ))}
          {isAddingQueue ? (
            <div className="flex items-center px-3.5 py-1.5 rounded-lg bg-item-hover mb-1">
              <Plus className="w-4 h-4 mr-2 text-text-secondary shrink-0" strokeWidth={2} />
              <input
                ref={addInputRef}
                type="text"
                placeholder="Queue name"
                className="flex-1 bg-transparent border border-accent rounded px-1 text-[13px] text-text-primary outline-none min-w-0"
                value={newQueueName}
                onChange={e => setNewQueueName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAddQueueSubmit();
                  if (e.key === 'Escape') setIsAddingQueue(false);
                }}
                onBlur={handleAddQueueSubmit}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { addQueueSubmitRef.current = false; setIsAddingQueue(true); setNewQueueName(''); }}
              className="flex w-full items-center px-3.5 py-1.5 rounded-lg text-[13px] text-text-muted hover:bg-item-hover hover:text-text-secondary cursor-default transition-colors mb-1"
            >
              <Plus className="w-4 h-4 mr-2 shrink-0" strokeWidth={2} />
              <span className="truncate">Add new queue</span>
            </button>
          )}
        </section>

        <section className="sidebar-section">
          <div className="sidebar-section-label">Tools</div>
          <ToolItem icon={CalendarClock} label="Scheduler" view="scheduler" />
          <ToolItem icon={Gauge} label="Speed Limiter" view="speedLimiter" />
          <ToolItem icon={Bug} label="Logs" view="logs" />
        </section>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          data-active={activeView === 'settings'}
          onClick={() => setActiveView('settings')}
          className="sidebar-nav-item sidebar-settings-button group flex w-full items-center text-[13px] text-left cursor-default font-medium transition-colors"
        >
          <Settings className={`w-[18px] h-[18px] mr-3 shrink-0 ${activeView === 'settings' ? 'text-white' : 'text-text-muted'}`} strokeWidth={activeView === 'settings' ? 2.5 : 2} />
          <span>Settings</span>
        </button>
      </div>

      {contextMenu && (
        <div
          role="menu"
          className="fixed z-50 w-48 py-1 rounded-xl shadow-lg border border-border-modal bg-bg-context-menu backdrop-blur-xl animate-fade-in text-[13px] text-text-primary overflow-hidden"
          style={{ 
            top: Math.min(contextMenu.y, window.innerHeight - 200), 
            left: Math.min(contextMenu.x, window.innerWidth - 200) 
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 flex items-center hover:bg-item-hover"
            onClick={() => {
              const queueId = contextMenu.id;
              setContextMenu(null);
              void startQueue(queueId).catch(error => {
                addToast({
                  message: `Could not start queue: ${String(error)}`,
                  variant: 'error',
                  isActionable: true
                });
              });
            }}
          >
            <Play size={14} className="mr-2 text-text-secondary" />
            Start Queue
          </button>
          <button
            className="w-full text-left px-3 py-1.5 flex items-center hover:bg-item-hover"
            onClick={() => {
              const queueId = contextMenu.id;
              setContextMenu(null);
              void pauseQueue(queueId).catch(error => {
                addToast({
                  message: `Could not pause queue: ${String(error)}`,
                  variant: 'error',
                  isActionable: true
                });
              });
            }}
          >
            <Pause size={14} className="mr-2 text-text-secondary" />
            Pause Queue
          </button>
          <div className="h-px bg-border-color my-1 mx-2" />
          <button
            className="w-full text-left px-3 py-1.5 flex items-center hover:bg-item-hover"
            onClick={() => {
              const q = queues.find(q => q.id === contextMenu.id);
              if (q) {
                renameQueueSubmitRef.current = false;
                setEditingQueueName(q.name);
                setRenamingQueueId(q.id);
              }
              setContextMenu(null);
            }}
          >
            <Edit2 size={14} className="mr-2 text-text-secondary" />
            Rename Queue
          </button>
          {!queues.find(q => q.id === contextMenu.id)?.isMain && (
            <button
              className="w-full text-left px-3 py-1.5 flex items-center hover:bg-red-500/20 text-red-400"
              onClick={() => {
                const queueId = contextMenu.id;
                const queue = queues.find(q => q.id === queueId);
                if (!queue || queue.isMain) {
                  setContextMenu(null);
                  return;
                }
                if (!window.confirm(`Delete queue "${queue.name}"? Its unfinished downloads will move to Main Queue.`)) {
                  return;
                }
                setContextMenu(null);
                void removeQueue(queueId).catch(error => {
                  addToast({
                    message: `Could not delete queue: ${String(error)}`,
                    variant: 'error',
                    isActionable: true
                  });
                });
              }}
            >
              <Trash2 size={14} className="mr-2" />
              Delete Queue
            </button>
          )}
        </div>
      )}
    </aside>
  );
};
