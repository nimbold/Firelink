import React from 'react';
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

export const Sidebar: React.FC<SidebarProps> = (props) => {
  const selectedFilter = props.selectedFilter;
  const onSelectFilter = props.onSelectFilter;
  const downloads = useDownloadStore(state => state.downloads);
  const activeView = useSettingsStore(state => state.activeView);

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
      className={`flex items-center px-3 py-1.5 rounded-md text-[13px] cursor-default transition-colors mb-[2px] ${
        selectedFilter === filter
          ? 'bg-[#3B66DE] text-white shadow-sm font-medium'
          : 'text-text-secondary hover:bg-item-hover hover:text-text-primary font-medium'
      }`}
      onClick={() => onSelectFilter(filter)}
    >
      <Icon className={`w-4 h-4 mr-2.5 ${selectedFilter === filter ? 'opacity-100 text-white' : 'opacity-70'}`} strokeWidth={selectedFilter === filter ? 2.5 : 2} />
      <span>{label}</span>
      {getCount(filter) > 0 && (
        <span className={`ml-auto text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
          selectedFilter === filter
            ? 'bg-black/20 text-white'
            : 'bg-item-hover text-text-muted group-hover:bg-black/10'
        }`}>
          {getCount(filter)}
        </span>
      )}
    </div>
  );

  return (
    <div className="w-[220px] min-w-[190px] max-w-[260px] bg-[#1E1E20] border-r border-border-color flex flex-col p-2.5 pt-8 pb-4 relative shrink-0">
      <div
        className="absolute top-0 left-0 right-0 h-10 z-50"
        data-tauri-drag-region
        onPointerDown={(e) => {
          if (e.button === 0) getCurrentWindow().startDragging();
        }}
      />
      <div className="overflow-y-auto flex-1 flex flex-col hide-scrollbar">
        <div className="mb-5 shrink-0 mt-2">
          <div className="text-[10px] font-bold text-text-muted/60 tracking-widest px-3 mb-2">LIBRARY</div>
          <NavItem icon={Inbox} label="All" filter="all" />
          <NavItem icon={Zap} label="Active" filter="active" />
          <NavItem icon={CheckCircle2} label="Completed" filter="completed" />
          <NavItem icon={CircleDashed} label="Unfinished" filter="unfinished" />
        </div>

        <div className="mb-5 shrink-0">
          <div className="text-[10px] font-bold text-text-muted/60 tracking-widest px-3 mb-2">FOLDERS</div>
          <NavItem icon={Film} label="Video" filter="Video" />
          <NavItem icon={Music} label="Audio" filter="Audio" />
          <NavItem icon={FileText} label="Documents" filter="Documents" />
          <NavItem icon={Box} label="Apps" filter="Apps" />
          <NavItem icon={ImageIcon} label="Images" filter="Images" />
          <NavItem icon={Archive} label="Archives" filter="Archives" />
          <NavItem icon={FileQuestion} label="Other" filter="Other" />
        </div>

        <div className="mb-5 shrink-0">
          <div className="text-[10px] font-bold text-text-muted/60 tracking-widest px-3 mb-2">QUEUES</div>
          <div className="flex items-center px-3 py-1.5 rounded-md text-[13px] font-medium text-text-secondary hover:bg-item-hover hover:text-text-primary cursor-default transition-colors mb-[2px]">
            <List className="w-4 h-4 mr-2.5 opacity-70" strokeWidth={2} />
            <span>Main Queue</span>
          </div>
        </div>

        <div className="shrink-0 pb-2">
          <div className="text-[10px] font-bold text-text-muted/60 tracking-widest px-3 mb-2">TOOLS</div>
          <div className="flex items-center px-3 py-1.5 rounded-md text-[13px] font-medium text-text-secondary hover:bg-item-hover hover:text-text-primary cursor-default transition-colors mb-[2px]">
            <CalendarClock className="w-4 h-4 mr-2.5 opacity-70" strokeWidth={2} /><span>Scheduler</span>
          </div>
          <div className="flex items-center px-3 py-1.5 rounded-md text-[13px] font-medium text-text-secondary hover:bg-item-hover hover:text-text-primary cursor-default transition-colors mb-[2px]">
            <Gauge className="w-4 h-4 mr-2.5 opacity-70" strokeWidth={2} /><span>Speed Limiter</span>
          </div>
        </div>
      </div>

      <div className="shrink-0 pt-4 mt-auto">
        <div
          onClick={() => useSettingsStore.getState().setActiveView('settings')}
          className={`flex items-center px-3 py-2 rounded-md text-[13px] font-medium cursor-pointer transition-colors ${
            activeView === 'settings'
              ? 'bg-[#3B66DE] text-white shadow-sm'
              : 'text-text-secondary hover:bg-[#2A2C2F] hover:text-text-primary'
          }`}
        >
          <Settings className={`w-4 h-4 mr-2.5 ${activeView === 'settings' ? 'opacity-100' : 'opacity-70'}`} strokeWidth={activeView === 'settings' ? 2.5 : 2} /><span>Settings</span>
        </div>
      </div>
    </div>
  );
};
