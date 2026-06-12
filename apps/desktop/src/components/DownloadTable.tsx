import React, { useState, useEffect } from 'react';
import { useDownloadStore, DownloadItem } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { SidebarFilter } from './Sidebar';
import { Play, Pause, Plus, Trash2, FileText, Image as ImageIcon, Music, Film, Box, Archive, FileQuestion, MoreVertical, PanelLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface DownloadTableProps {
  filter: SidebarFilter;
}

export const DownloadTable: React.FC<DownloadTableProps> = ({ filter }) => {
  const { downloads, toggleAddModal, updateDownload, removeDownload, clearFinished, redownload } = useDownloadStore();
  const { isSidebarVisible, toggleSidebar, listRowDensity } = useSettingsStore();

  const getPaddingY = () => {
    switch (listRowDensity) {
      case 'compact': return 'py-1';
      case 'spacious': return 'py-4';
      default: return 'py-3';
    }
  };
  const py = getPaddingY();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  useEffect(() => {
    const handleCloseMenu = () => setContextMenu(null);
    window.addEventListener('click', handleCloseMenu);
    return () => window.removeEventListener('click', handleCloseMenu);
  }, []);

  const resolvePath = async (dir: string, file: string) => {
    let resolvedDir = dir;
    if (dir.startsWith('~/')) {
      const home = await homeDir();
      resolvedDir = home + '/' + dir.slice(2);
    } else if (dir === '~') {
      resolvedDir = await homeDir();
    }
    return resolvedDir + '/' + file;
  };

  const filteredDownloads = downloads.filter((d: DownloadItem) => {
    switch (filter) {
      case 'all': return true;
      case 'active': return d.status === 'downloading';
      case 'completed': return d.status === 'completed';
      case 'unfinished': return d.status !== 'completed';
      default: return d.category === filter;
    }
  });

  const getFilterTitle = () => {
    switch (filter) {
      case 'all': return 'All Downloads';
      case 'active': return 'Active';
      case 'completed': return 'Completed';
      case 'unfinished': return 'Unfinished';
      default: return filter;
    }
  };

  const handlePause = async (id: string) => {
    try {
      await invoke('pause_download', { id });
      updateDownload(id, { status: 'paused', speed: '-', eta: '-' });
    } catch (e) {
      console.error("Failed to pause:", e);
    }
  };

  const handleResume = (item: DownloadItem) => {
    useDownloadStore.setState((state) => ({
      downloads: state.downloads.map(d => d.id === item.id ? { ...d, status: 'queued', speed: '-', eta: '-' } : d)
    }));
    useDownloadStore.getState().processQueue();
  };

  const handleDelete = async (id: string) => {
    try {
      await removeDownload(id);
    } catch (e) {
      console.error("Failed to delete download:", e);
    }
  };

  const contextItem = contextMenu ? downloads.find(d => d.id === contextMenu.id) : null;

  const getCategoryIcon = (category: string) => {
    switch(category) {
      case 'Documents': return <FileText size={16} className="text-blue-400" />;
      case 'Images': return <ImageIcon size={16} className="text-purple-400" />;
      case 'Audio': return <Music size={16} className="text-pink-400" />;
      case 'Video': return <Film size={16} className="text-red-400" />;
      case 'Apps': return <Box size={16} className="text-orange-400" />;
      case 'Archives': return <Archive size={16} className="text-yellow-400" />;
      default: return <FileQuestion size={16} className="text-gray-400" />;
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-main-bg h-full relative">
      
      {/* Modern Toolbar */}
      <div 
        className={`flex px-6 py-4 border-b border-border-color items-center glass-panel z-10 sticky top-0 ${!isSidebarVisible ? 'pl-24' : ''}`} 
        onPointerDown={(e) => {
          if (e.button === 0 && (e.target as HTMLElement).closest('.no-drag') === null) {
            getCurrentWindow().startDragging();
          }
        }}
      >
        <button 
          onClick={toggleSidebar}
          className="no-drag mr-3 p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-item-hover transition-colors"
          title="Toggle Sidebar"
        >
          <PanelLeft size={18} strokeWidth={2} />
        </button>
        <h2 className="text-lg font-bold mr-auto text-text-primary tracking-tight cursor-default">{getFilterTitle()}</h2>
        
        <div className="flex gap-1.5 items-center bg-bg-input/50 p-1 rounded-xl border border-border-modal/50 shadow-sm no-drag">
          <button 
            onClick={() => toggleAddModal(true)}
            className="p-2 rounded-lg text-text-secondary hover:text-blue-500 hover:bg-blue-500/10 transition-all duration-200 group relative"
            title="Add Download"
          >
            <Plus size={18} strokeWidth={2.5} />
          </button>
          <div className="w-[1px] h-4 bg-border-color/60 mx-1"></div>
          <button 
            onClick={() => {
              filteredDownloads.filter(d => d.status === 'paused').forEach(d => handleResume(d));
            }}
            className="p-2 rounded-lg text-text-secondary hover:text-green-500 hover:bg-green-500/10 transition-all duration-200"
            title="Resume All"
          >
            <Play size={18} fill="currentColor" className="opacity-80" />
          </button>
          <button 
            onClick={() => {
              filteredDownloads.filter(d => d.status === 'downloading').forEach(d => handlePause(d.id));
            }}
            className="p-2 rounded-lg text-text-secondary hover:text-orange-500 hover:bg-orange-500/10 transition-all duration-200"
            title="Pause All"
          >
            <Pause size={18} fill="currentColor" className="opacity-80" />
          </button>
          <div className="w-[1px] h-4 bg-border-color/60 mx-1"></div>
          <button 
            onClick={clearFinished}
            className="p-2 rounded-lg text-text-secondary hover:text-red-500 hover:bg-red-500/10 transition-all duration-200"
            title="Clear Finished"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-main-bg/95 backdrop-blur-md z-0 shadow-sm border-b border-border-color">
            <tr className="text-text-muted text-xs uppercase tracking-wider font-semibold">
              <th className={`${py} px-3 pl-6`}>File</th>
              <th className={`${py} px-3`}>Size</th>
              <th className={`${py} px-3`}>Status</th>
              <th className={`${py} px-3`}>Speed</th>
              <th className={`${py} px-3 pr-6`}>ETA</th>
              <th className={`${py} px-3 w-16`}></th>
            </tr>
          </thead>
          <tbody>
            {filteredDownloads.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-16 text-center">
                  <div className="flex flex-col items-center justify-center text-text-muted/50 gap-3">
                    <Box size={48} strokeWidth={1} />
                    <span className="text-sm font-medium">No downloads in this view</span>
                  </div>
                </td>
              </tr>
            ) : (
              filteredDownloads.map(d => (
                <tr 
                  key={d.id} 
                  className="border-b border-border-color/30 hover:bg-item-hover transition-colors duration-200 group cursor-default"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      id: d.id
                    });
                  }}
                >
                  <td className={`${py} px-3 pl-6 text-sm text-text-primary`}>
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-bg-input/50 rounded-lg shadow-sm border border-border-modal/20">
                         {getCategoryIcon(d.category)}
                      </div>
                      <span className="font-medium truncate max-w-[250px]">{d.fileName}</span>
                    </div>
                  </td>
                  <td className={`${py} px-3 text-[13px] text-text-secondary w-32`}>
                    <div className="w-full bg-border-color rounded-full h-1.5 mb-1.5 mt-0.5 overflow-hidden shadow-inner">
                      <div className={`h-1.5 rounded-full transition-all duration-300 ${d.status === 'completed' ? 'bg-green-500' : d.status === 'paused' ? 'bg-orange-500' : d.status === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${(d.fraction || 0) * 100}%` }}></div>
                    </div>
                    <div className="text-[11px] font-mono text-text-muted font-medium">
                      {((d.fraction || 0) * 100).toFixed(1)}%
                    </div>
                  </td>
                  <td className={`${py} px-3 text-[13px]`}>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider ${
                      d.status === 'completed' ? 'bg-green-500/10 text-green-500' :
                      d.status === 'downloading' ? 'bg-blue-500/10 text-blue-500' :
                      d.status === 'failed' ? 'bg-red-500/10 text-red-500' :
                      d.status === 'paused' ? 'bg-orange-500/10 text-orange-500' :
                      'bg-zinc-500/10 text-text-secondary'
                    }`}>
                      {d.status}
                    </span>
                  </td>
                  <td className={`${py} px-3 text-[12px] text-text-secondary font-mono`}>{d.speed}</td>
                  <td className={`${py} px-3 pr-6 text-[12px] text-text-secondary font-mono`}>{d.eta}</td>
                  <td className={`${py} px-3 pr-6 text-right opacity-0 group-hover:opacity-100 transition-opacity duration-200`}>
                    <div className="flex justify-end gap-1.5">
                      {d.status === 'downloading' && (
                        <button onClick={() => handlePause(d.id)} className="p-1.5 bg-bg-input/80 shadow-sm border border-border-modal/50 hover:bg-item-hover rounded-md text-text-muted hover:text-orange-500 transition-colors" title="Pause">
                          <Pause size={14} fill="currentColor" />
                        </button>
                      )}
                      {d.status === 'paused' && (
                        <button onClick={() => handleResume(d)} className="p-1.5 bg-bg-input/80 shadow-sm border border-border-modal/50 hover:bg-item-hover rounded-md text-text-muted hover:text-green-500 transition-colors" title="Resume">
                          <Play size={14} fill="currentColor" />
                        </button>
                      )}
                      <button 
                        onClick={(e) => {
                           e.stopPropagation();
                           setContextMenu({ x: e.clientX, y: e.clientY, id: d.id });
                        }} 
                        className="p-1.5 bg-bg-input/80 shadow-sm border border-border-modal/50 hover:bg-item-hover rounded-md text-text-muted hover:text-text-primary transition-colors"
                      >
                        <MoreVertical size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      
      {/* Status Bar */}
      <div className="px-6 py-2 border-t border-border-color text-[11px] font-medium text-text-muted bg-sidebar-bg/50 backdrop-blur-md">
        {downloads.length} Item{downloads.length !== 1 ? 's' : ''}
      </div>

      {/* Floating Context Menu */}
      {contextMenu && contextItem && (
        <div 
          className="fixed z-50 bg-bg-modal/95 backdrop-blur-xl border border-border-modal rounded-xl shadow-2xl py-1.5 min-w-[180px] text-[13px] font-medium text-text-primary overflow-hidden"
          style={{ 
             top: Math.min(contextMenu.y, window.innerHeight - 300), 
             left: Math.min(contextMenu.x, window.innerWidth - 200) 
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextItem.status === 'completed' && (
            <button 
              onClick={async () => {
                setContextMenu(null);
                try {
                  const fullPath = await resolvePath(contextItem.destination || '~/Downloads', contextItem.fileName);
                  await invoke('open_file', { path: fullPath });
                } catch (e) {
                  console.error("Failed to open file:", e);
                }
              }} 
              className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
            >
              Open File
            </button>
          )}

          <button 
            onClick={async () => {
              setContextMenu(null);
              try {
                const fullPath = await resolvePath(contextItem.destination || '~/Downloads', contextItem.fileName);
                await invoke('show_in_folder', { path: fullPath });
              } catch (e) {
                console.error("Failed to show in folder:", e);
              }
            }} 
            className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
          >
            Show in Finder
          </button>

          <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

          {(contextItem.status === 'downloading' || contextItem.status === 'queued') && (
            <button 
              onClick={() => {
                setContextMenu(null);
                handlePause(contextItem.id);
              }} 
              className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
            >
              Pause
            </button>
          )}

          {(contextItem.status === 'paused' || contextItem.status === 'failed') && (
            <button 
              onClick={() => {
                setContextMenu(null);
                handleResume(contextItem);
              }} 
              className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
            >
              Resume
            </button>
          )}

          {['completed', 'failed', 'paused'].includes(contextItem.status) && (
            <button 
              onClick={() => {
                setContextMenu(null);
                redownload(contextItem.id);
              }} 
              className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
            >
              Redownload
            </button>
          )}

          <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

          <button 
            onClick={() => {
              setContextMenu(null);
              navigator.clipboard.writeText(contextItem.url);
            }} 
            className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
          >
            Copy Address
          </button>

          {contextItem.status === 'completed' && (
            <button 
              onClick={async () => {
                setContextMenu(null);
                const fullPath = await resolvePath(contextItem.destination || '~/Downloads', contextItem.fileName);
                navigator.clipboard.writeText(fullPath);
              }} 
              className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
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
            className="w-full text-left px-4 py-1.5 hover:bg-red-500 hover:text-white text-red-500 transition-colors"
          >
            Remove from List
          </button>

          <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

          <button 
            onClick={() => {
              setContextMenu(null);
              useDownloadStore.getState().setSelectedPropertiesDownloadId(contextItem.id);
            }} 
            className="w-full text-left px-4 py-1.5 hover:bg-blue-500 hover:text-white transition-colors"
          >
            Properties
          </button>
        </div>
      )}

    </div>
  );
};
