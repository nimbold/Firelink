import React, { useState, useEffect, useRef } from 'react';
import {
  Inbox, Zap, CheckCircle2, CircleDashed,
  Film, Music, FileText, Box, Image as ImageIcon, Archive, FileQuestion,
  List, CalendarClock, Gauge, Settings, Plus, Play, Pause, Edit2, Trash2
} from 'lucide-react';
import { useDownloadStore, DownloadCategory, Queue } from '../store/useDownloadStore';
import { ActiveView, useSettingsStore } from '../store/useSettingsStore';
import { WindowDragRegion } from './WindowDragRegion';

export type SidebarFilter = 'all' | 'active' | 'completed' | 'unfinished' | DownloadCategory | 'settings' | string;

interface SidebarProps {
  selectedFilter: SidebarFilter;
  onSelectFilter: (filter: SidebarFilter) => void;
}

export const Sidebar: React.FC<SidebarProps> = (props) => {
  const { selectedFilter, onSelectFilter } = props;
  const { downloads, queues, addQueue, renameQueue, removeQueue, startQueue, pauseQueue } = useDownloadStore();
  const { activeView, setActiveView } = useSettingsStore();

  const [isAddingQueue, setIsAddingQueue] = useState(false);
  const [newQueueName, setNewQueueName] = useState('');
  const [renamingQueueId, setRenamingQueueId] = useState<string | null>(null);
  const [editingQueueName, setEditingQueueName] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const addInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleCloseMenu = () => setContextMenu(null);
    window.addEventListener('click', handleCloseMenu);
    return () => window.removeEventListener('click', handleCloseMenu);
  }, []);

  useEffect(() => {
    if (isAddingQueue) addInputRef.current?.focus();
  }, [isAddingQueue]);

  useEffect(() => {
    if (renamingQueueId) renameInputRef.current?.focus();
  }, [renamingQueueId]);

  const getCount = (filter: SidebarFilter) => {
    if (filter.startsWith('queue:')) {
      const qid = filter.replace('queue:', '');
      return downloads.filter(d => d.queueId === qid).length;
    }
    switch (filter) {
      case 'all': return downloads.length;
      case 'active': return downloads.filter(d => d.status === 'downloading').length;
      case 'completed': return downloads.filter(d => d.status === 'completed').length;
      case 'unfinished': return downloads.filter(d => d.status !== 'completed').length;
      default: return downloads.filter(d => d.category === filter as DownloadCategory).length;
    }
  };

  const NavItem = ({ icon: Icon, label, filter }: { icon: any, label: string, filter: SidebarFilter }) => {
    const isSelected = activeView === 'downloads' && selectedFilter === filter;

    return (
      <button
        type="button"
        data-active={isSelected}
        className={`sidebar-nav-item group flex h-8 w-full items-center px-3.5 rounded-lg text-[12px] text-left cursor-default transition-colors duration-150 mb-0.5 ${
          isSelected
            ? 'bg-item-selected text-text-primary font-semibold'
            : 'text-text-secondary hover:bg-item-hover hover:text-text-primary'
        }`}
        onClick={() => onSelectFilter(filter)}
      >
        <Icon className={`w-4 h-4 mr-2.5 transition-colors ${isSelected ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'}`} strokeWidth={isSelected ? 2.25 : 1.8} />
        <span className="truncate">{label}</span>
        {getCount(filter) > 0 && (
          <span className={`ml-auto min-w-5 px-1.5 py-0.5 rounded-full text-center text-[10px] leading-none font-semibold transition-colors ${
            isSelected ? 'bg-accent/15 text-accent' : 'bg-item-hover text-text-muted'
          }`}>
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
    if (newQueueName.trim()) addQueue(newQueueName.trim());
    setNewQueueName('');
    setIsAddingQueue(false);
  };

  const handleRenameQueueSubmit = () => {
    if (renamingQueueId && editingQueueName.trim()) {
      renameQueue(renamingQueueId, editingQueueName.trim());
    }
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
        className={`sidebar-nav-item group flex h-8 w-full items-center px-3.5 rounded-lg text-[12px] text-left cursor-default transition-colors duration-150 mb-0.5 ${
          isSelected
            ? 'bg-item-selected text-text-primary font-semibold'
            : 'text-text-secondary hover:bg-item-hover hover:text-text-primary'
        }`}
      >
        <List className={`w-4 h-4 mr-2.5 shrink-0 transition-colors ${isSelected ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'}`} strokeWidth={isSelected ? 2.25 : 1.8} />
        <span className="truncate">{queue.name}</span>
        {getCount(filterId) > 0 && (
          <span className={`ml-auto min-w-5 px-1.5 py-0.5 rounded-full text-center text-[10px] leading-none font-semibold shrink-0 transition-colors ${
            isSelected ? 'bg-accent/15 text-accent' : 'bg-item-hover text-text-muted'
          }`}>
            {getCount(filterId)}
          </span>
        )}
      </button>
    );
  };

  const ToolItem = ({ icon: Icon, label, view }: { icon: any; label: string; view: ActiveView }) => {
    const isSelected = activeView === view;
    return (
      <button
        type="button"
        data-active={isSelected}
        onClick={() => setActiveView(view)}
        className={`sidebar-nav-item group flex h-8 w-full items-center px-3.5 rounded-lg text-[12px] text-left cursor-default transition-colors duration-150 mb-0.5 ${
          isSelected ? 'bg-item-selected text-text-primary font-semibold' : 'text-text-secondary hover:bg-item-hover hover:text-text-primary'
        }`}
      >
        <Icon className={`w-4 h-4 mr-2.5 transition-colors ${isSelected ? 'text-accent' : 'text-text-muted group-hover:text-text-secondary'}`} strokeWidth={isSelected ? 2.25 : 1.8} />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <aside className="w-full h-full flex flex-col relative shrink-0">
      <WindowDragRegion />
      <div className="overflow-y-auto flex-1 px-3 pb-3">
        <section className="mb-4">
          <div className="text-[9px] font-bold tracking-[0.14em] text-text-muted uppercase px-3.5 mb-1.5">Library</div>
          <NavItem icon={Inbox} label="All" filter="all" />
          <NavItem icon={Zap} label="Active" filter="active" />
          <NavItem icon={CheckCircle2} label="Completed" filter="completed" />
          <NavItem icon={CircleDashed} label="Unfinished" filter="unfinished" />
        </section>

        <section className="mb-4">
          <div className="text-[9px] font-bold tracking-[0.14em] text-text-muted uppercase px-3.5 mb-1.5">Folders</div>
          <NavItem icon={Music} label="Musics" filter="Musics" />
          <NavItem icon={Film} label="Movies" filter="Movies" />
          <NavItem icon={Archive} label="Compressed" filter="Compressed" />
          <NavItem icon={FileText} label="Documents" filter="Documents" />
          <NavItem icon={ImageIcon} label="Pictures" filter="Pictures" />
          <NavItem icon={Box} label="Applications" filter="Applications" />
          <NavItem icon={FileQuestion} label="Other" filter="Other" />
        </section>

        <section className="mb-4">
          <div className="text-[9px] font-bold tracking-[0.14em] text-text-muted uppercase px-3.5 mb-1.5">Queues</div>
          {queues.map(queue => (
            <QueueItem key={queue.id} queue={queue} />
          ))}
          {isAddingQueue ? (
            <div className="flex items-center px-2.5 py-1 rounded-lg bg-item-hover">
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
              onClick={() => { setIsAddingQueue(true); setNewQueueName(''); }}
              className="flex w-full items-center px-3.5 py-1.5 rounded-lg text-[12px] text-text-muted hover:bg-item-hover hover:text-text-secondary cursor-default transition-colors"
            >
              <Plus className="w-4 h-4 mr-2 shrink-0" strokeWidth={2} />
              <span className="truncate">Add new queue</span>
            </button>
          )}
        </section>

        <section className="mt-auto pt-4 border-t border-border-color/30">
          <div className="text-[9px] font-bold tracking-[0.14em] text-text-muted uppercase px-3.5 mb-1.5">Tools</div>
          <ToolItem icon={CalendarClock} label="Scheduler" view="scheduler" />
          <ToolItem icon={Gauge} label="Speed Limiter" view="speedLimiter" />
        </section>
      </div>

      <div className="shrink-0 border-t border-border-color bg-sidebar-bg px-3 py-2">
        <button
          type="button"
          data-active={activeView === 'settings'}
          onClick={() => setActiveView('settings')}
          className={`sidebar-nav-item flex h-8 w-full items-center px-3.5 rounded-lg text-[12px] text-left cursor-default transition-colors ${
            activeView === 'settings'
              ? 'bg-item-selected text-text-primary font-semibold'
              : 'text-text-secondary hover:bg-item-hover hover:text-text-primary'
          }`}
        >
          <Settings className={`w-4 h-4 mr-2 ${activeView === 'settings' ? 'text-accent' : 'text-text-muted'}`} strokeWidth={activeView === 'settings' ? 2.25 : 1.8} />
          <span>Settings</span>
        </button>
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 w-48 py-1 rounded-xl shadow-lg border border-border-modal bg-bg-context-menu backdrop-blur-xl animate-fade-in text-[13px] text-text-primary overflow-hidden"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 flex items-center hover:bg-item-hover"
            onClick={() => { startQueue(contextMenu.id); setContextMenu(null); }}
          >
            <Play size={14} className="mr-2 text-text-secondary" />
            Start Queue
          </button>
          <button
            className="w-full text-left px-3 py-1.5 flex items-center hover:bg-item-hover"
            onClick={() => { pauseQueue(contextMenu.id); setContextMenu(null); }}
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
              onClick={() => { removeQueue(contextMenu.id); setContextMenu(null); }}
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
