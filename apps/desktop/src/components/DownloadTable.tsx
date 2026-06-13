import React, { useState, useEffect } from 'react';
import { useDownloadStore, DownloadItem } from '../store/useDownloadStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { SidebarFilter } from './Sidebar';
import { Play, Pause, Plus, Trash2, FileText, Image as ImageIcon, Music, Film, Box, Archive, FileQuestion, MoreVertical, PanelLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { WindowDragRegion } from './WindowDragRegion';

interface DownloadTableProps {
  filter: SidebarFilter;
}

export const DownloadTable: React.FC<DownloadTableProps> = ({ filter }) => {
  const { downloads, toggleAddModal, updateDownload, removeDownload, clearFinished, redownload } = useDownloadStore();
  const { isSidebarVisible, toggleSidebar, listRowDensity } = useSettingsStore();

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
    if (filter.startsWith('queue:')) {
      return d.queueId === filter.replace('queue:', '');
    }
    switch (filter) {
      case 'all': return true;
      case 'active': return d.status === 'downloading';
      case 'completed': return d.status === 'completed';
      case 'unfinished': return d.status !== 'completed';
      default: return d.category === filter;
    }
  });

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
  const rowPadding = {
    compact: 'py-2',
    standard: 'py-2.5',
    relaxed: 'py-3.5'
  }[listRowDensity];

  const getCategoryIcon = (category: string) => {
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
  }

  return (
    <div className="flex-1 flex flex-col bg-transparent h-full relative p-3 pb-0">
      <div className="app-surface shrink-0 rounded-xl mb-3 z-10">
        <WindowDragRegion className={!isSidebarVisible ? 'pl-20' : ''} />

        {/* Download Toolbar */}
        <div className={`flex px-3 pb-2.5 pt-0.5 items-center ${!isSidebarVisible ? 'pl-20' : ''}`}>
          <button
            onClick={toggleSidebar}
            className="app-icon-button mr-2"
            title="Toggle Sidebar"
          >
            <PanelLeft size={17} strokeWidth={2} />
          </button>
          <div className="mr-auto">
            <h2 className="text-[14px] font-semibold text-text-primary tracking-tight cursor-default">{getFilterTitle()}</h2>
            <p className="mt-0.5 text-[10px] text-text-muted tabular-nums">
              {filteredDownloads.length} {filteredDownloads.length === 1 ? 'item' : 'items'}
            </p>
          </div>

          <div className="flex items-center gap-0.5">
            <button
              onClick={() => toggleAddModal(true)}
              className="app-icon-button text-accent"
              title="Add Download"
            >
              <Plus size={17} strokeWidth={2.25} />
            </button>
            <div className="mx-1 h-4 w-px bg-border-color"></div>
            <button
              onClick={() => {
                filteredDownloads.filter(d => d.status === 'paused').forEach(d => handleResume(d));
              }}
              className="app-icon-button"
              title="Resume All"
            >
              <Play size={15} fill="currentColor" className="opacity-80" />
            </button>
            <button
              onClick={() => {
                filteredDownloads.filter(d => d.status === 'downloading').forEach(d => handlePause(d.id));
              }}
              className="app-icon-button"
              title="Pause All"
            >
              <Pause size={15} fill="currentColor" className="opacity-80" />
            </button>
            <div className="mx-1 h-4 w-px bg-border-color"></div>
            <button
              onClick={clearFinished}
              className="app-icon-button hover:text-red-400"
              title="Clear Finished"
            >
              <Trash2 size={15} strokeWidth={1.9} />
            </button>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto bg-transparent pb-3 relative">
        <div className="w-full text-left">
          <div className="flex text-text-muted text-[9px] font-bold tracking-[0.12em] uppercase px-4 pb-2 pt-1 sticky top-0 z-0 bg-main-bg/85 backdrop-blur-md">
            <div className="flex-1 min-w-[200px]">FILE</div>
            <div className="w-32">SIZE</div>
            <div className="w-32">STATUS</div>
            <div className="w-28">SPEED</div>
            <div className="w-28">ETA</div>
            <div className="w-32 text-right pr-4">DATE ADDED</div>
          </div>
          <div className="flex flex-col gap-2">
            {filteredDownloads.length === 0 ? (
              <div className="app-card mx-1 mt-2 py-14 text-center">
                <div className="flex flex-col items-center justify-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border-color bg-bg-input text-text-muted">
                    <Box size={23} strokeWidth={1.6} />
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-text-primary">No downloads here</p>
                    <p className="mt-1 text-[11px] text-text-muted">Add a link to start a new transfer.</p>
                  </div>
                  <button onClick={() => toggleAddModal(true)} className="app-button app-button-primary mt-1 px-3 text-[11px]">
                    <Plus size={14} /> Add Download
                  </button>
                </div>
              </div>
            ) : (
              filteredDownloads.map(d => (
                <div
                  key={d.id}
                  className={`group mx-1 flex items-center rounded-lg border border-border-color bg-bg-modal/30 px-4 ${rowPadding} cursor-default transition-colors duration-150 hover:border-border-modal hover:bg-item-hover/50`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      id: d.id
                    });
                  }}
                >
                  <div className="flex-1 min-w-[200px] text-[13px] text-text-primary pr-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border-color bg-bg-input text-text-muted">
                         {getCategoryIcon(d.category)}
                      </div>
                      <span className="font-medium truncate max-w-[280px]">{d.fileName}</span>
                    </div>
                  </div>
                  <div className="w-32 pr-4">
                    {d.status === 'downloading' || d.status === 'paused' ? (
                      <div className="w-full">
                        <div className="w-full bg-border-color/30 rounded-full h-1.5 mb-1.5 overflow-hidden">
                          <div className={`h-1.5 rounded-full transition-all duration-300 ${d.status === 'paused' ? 'bg-orange-500' : 'bg-accent'}`} style={{ width: `${(d.fraction || 0) * 100}%` }}></div>
                        </div>
                        <div className="text-[11px] text-text-muted font-medium">
                          {((d.fraction || 0) * 100).toFixed(1)}%
                        </div>
                      </div>
                    ) : (
                      <span className="text-[12px] text-text-secondary font-medium">{d.size || '-'}</span>
                    )}
                  </div>
                  <div className="w-32">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-widest uppercase shadow-sm ${
                      d.status === 'completed' ? 'bg-green-500/10 text-green-500 border border-green-500/20' :
                      d.status === 'downloading' ? 'bg-accent/10 text-accent border border-accent/20' :
                      d.status === 'failed' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                      d.status === 'paused' ? 'bg-orange-500/10 text-orange-500 border border-orange-500/20' :
                      'bg-item-hover text-text-muted border border-border-color/30'
                    }`}>
                      {d.status}
                    </span>
                  </div>
                  <div className="w-28 text-[12px] text-text-secondary font-medium">{d.speed}</div>
                  <div className="w-28 text-[12px] text-text-secondary font-medium">{d.eta}</div>
                  <div className="w-32 relative text-right pr-4">
                    <div className="flex items-center justify-end">
                      <span className="text-[12px] text-text-secondary font-medium group-hover:opacity-0 transition-opacity duration-200">
                        {d.dateAdded ? new Date(d.dateAdded).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '-'}
                      </span>
                      <div className="flex justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 absolute right-4 top-1/2 -translate-y-1/2">
                        {d.status === 'downloading' && (
                          <button onClick={() => handlePause(d.id)} className="app-icon-button h-7 w-7 border border-border-color bg-bg-modal hover:text-orange-400" title="Pause">
                            <Pause size={14} fill="currentColor" />
                          </button>
                        )}
                        {d.status === 'paused' && (
                          <button onClick={() => handleResume(d)} className="app-icon-button h-7 w-7 border border-border-color bg-bg-modal hover:text-green-400" title="Resume">
                            <Play size={14} fill="currentColor" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                             e.stopPropagation();
                             setContextMenu({ x: e.clientX, y: e.clientY, id: d.id });
                          }}
                          className="app-icon-button h-7 w-7 border border-border-color bg-bg-modal hover:text-accent"
                          title="More Actions"
                        >
                          <MoreVertical size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Floating Context Menu */}
      {contextMenu && contextItem && (
        <div
          className="app-modal fixed z-50 min-w-[180px] overflow-hidden py-1.5 text-[12px] font-medium text-text-primary"
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
              className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
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
            className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
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
              className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
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
              className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
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
              className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
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
            className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
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
            Remove from List
          </button>

          <div className="h-[1px] bg-border-modal/60 my-1.5 mx-2"></div>

          <button
            onClick={() => {
              setContextMenu(null);
              useDownloadStore.getState().setSelectedPropertiesDownloadId(contextItem.id);
            }}
            className="w-full text-left px-3 py-2 hover:bg-item-hover transition-colors"
          >
            Properties
          </button>
        </div>
      )}

    </div>
  );
};
