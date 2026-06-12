import React from 'react';
// Force Vite HMR rebuild
import { 
  Inbox, Zap, CheckCircle2, CircleDashed, 
  Film, Music, FileText, Box, Image as ImageIcon, Archive, FileQuestion,
  List, CalendarClock, Gauge, Settings
} from 'lucide-react';
import { useDownloadStore, DownloadCategory } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type SidebarFilter = 'all' | 'active' | 'completed' | 'unfinished' | DownloadCategory | 'settings';

interface SidebarProps {
  selectedFilter: SidebarFilter;
  onSelectFilter: (filter: SidebarFilter) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ selectedFilter, onSelectFilter }) => {
  const downloads = useDownloadStore(state => state.downloads);

  const getCount = (filter: SidebarFilter) => {
    switch (filter) {
      case 'all': return downloads.length;
      case 'active': return downloads.filter(d => d.status === 'downloading').length;
      case 'completed': return downloads.filter(d => d.status === 'completed').length;
      case 'unfinished': return downloads.filter(d => d.status !== 'completed').length;
      default: return downloads.filter(d => d.category === filter).length;
    }
  };

  const NavItem = ({ icon: Icon, label, filter }: { icon: any, label: string, filter: SidebarFilter }) => (
    <div 
      className={`flex items-center px-2 py-1.5 rounded-md text-[13px] cursor-default transition-colors mb-0.5 ${
        selectedFilter === filter 
          ? 'bg-blue-500/20 text-blue-500' 
          : 'text-text-secondary hover:bg-item-hover'
      }`}
      onClick={() => onSelectFilter(filter)}
    >
      <Icon className={`w-4 h-4 mr-2 ${selectedFilter === filter ? 'opacity-100' : 'opacity-80'}`} />
      <span>{label}</span>
      {getCount(filter) > 0 && (
        <span className="ml-auto text-[11px] text-text-muted bg-item-hover px-1.5 py-0.5 rounded-full">
          {getCount(filter)}
        </span>
      )}
    </div>
  );

  return (
    <div className="w-[220px] min-w-[190px] max-w-[260px] bg-sidebar-bg/80 backdrop-blur-xl border-r border-border-color flex flex-col p-3 pt-8 pb-4 overflow-y-auto relative shrink-0">
      <div 
        className="absolute top-0 left-0 right-0 h-10 z-50" 
        onPointerDown={(e) => {
          if (e.button === 0) getCurrentWindow().startDragging();
        }}
      />
      <div className="mb-4 shrink-0 mt-2">
        <div className="text-[11px] font-semibold text-text-muted/80 uppercase tracking-wider px-2 mb-1">Library</div>
        <NavItem icon={Inbox} label="All" filter="all" />
        <NavItem icon={Zap} label="Active" filter="active" />
        <NavItem icon={CheckCircle2} label="Completed" filter="completed" />
        <NavItem icon={CircleDashed} label="Unfinished" filter="unfinished" />
      </div>

      <div className="mb-4 shrink-0">
        <div className="text-[11px] font-semibold text-text-muted/80 uppercase tracking-wider px-2 mb-1">Folders</div>
        <NavItem icon={Film} label="Video" filter="Video" />
        <NavItem icon={Music} label="Audio" filter="Audio" />
        <NavItem icon={FileText} label="Documents" filter="Documents" />
        <NavItem icon={Box} label="Apps" filter="Apps" />
        <NavItem icon={ImageIcon} label="Images" filter="Images" />
        <NavItem icon={Archive} label="Archives" filter="Archives" />
        <NavItem icon={FileQuestion} label="Other" filter="Other" />
      </div>

      <div className="mb-4 shrink-0">
        <div className="text-[11px] font-semibold text-text-muted/80 uppercase tracking-wider px-2 mb-1">Queues</div>
        <div className="flex items-center px-2 py-1.5 rounded-md text-[13px] text-text-secondary hover:bg-item-hover cursor-default transition-colors mb-0.5">
          <List className="w-4 h-4 mr-2 opacity-80" />
          <span>Main Queue</span>
        </div>
      </div>

      <div className="flex-1 min-h-[16px]"></div>

      <div className="shrink-0 pb-2">
        <div className="text-[11px] font-semibold text-text-muted/80 uppercase tracking-wider px-2 mb-1">Tools</div>
        <div className="flex items-center px-2 py-1.5 rounded-md text-[13px] text-text-secondary hover:bg-item-hover cursor-default transition-colors mb-0.5">
          <CalendarClock className="w-4 h-4 mr-2 opacity-80" /><span>Scheduler</span>
        </div>
        <div className="flex items-center px-2 py-1.5 rounded-md text-[13px] text-text-secondary hover:bg-item-hover cursor-default transition-colors mb-0.5">
          <Gauge className="w-4 h-4 mr-2 opacity-80" /><span>Speed Limiter</span>
        </div>
        <div 
          onClick={() => useSettingsStore.getState().toggleSettingsModal(true)}
          className="flex items-center px-2 py-1.5 rounded-md text-[13px] text-text-secondary hover:bg-item-hover cursor-pointer transition-colors"
        >
          <Settings className="w-4 h-4 mr-2 opacity-80" /><span>Settings</span>
        </div>
      </div>
    </div>
  );
};
