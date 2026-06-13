import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  CheckCircle2, Clock3, List, Moon, LockKeyhole,
  Pause, Play, Power, RotateCcw, Save
} from 'lucide-react';
import { PostQueueAction, SchedulerSettings, useSettingsStore } from '../store/useSettingsStore';
import { useDownloadStore, MAIN_QUEUE_ID } from '../store/useDownloadStore';
import { WindowDragRegion } from './WindowDragRegion';

const days = [
  { value: 0, label: 'Su' },
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Tu' },
  { value: 3, label: 'We' },
  { value: 4, label: 'Th' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
];

const postActions: { value: PostQueueAction; label: string; icon: typeof Moon }[] = [
  { value: 'none', label: 'Do nothing', icon: CheckCircle2 },
  { value: 'sleep', label: 'Sleep', icon: Moon },
  { value: 'restart', label: 'Restart', icon: RotateCcw },
  { value: 'shutdown', label: 'Shut down', icon: Power },
];

function nextScheduledRun(settings: SchedulerSettings): string {
  if (!settings.enabled) return 'Scheduler is disabled';

  const [hour, minute] = settings.startTime.split(':').map(Number);
  const now = new Date();

  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    const allowedDay = settings.everyday || settings.selectedDays.includes(candidate.getDay());
    if (allowedDay && candidate > now) {
      return candidate.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    }
  }

  return 'No scheduled day selected';
}

export default function SchedulerView() {
  const savedSettings = useSettingsStore(state => state.scheduler);
  const schedulerRunning = useSettingsStore(state => state.schedulerRunning);
  const setScheduler = useSettingsStore(state => state.setScheduler);
  const [draft, setDraft] = useState<SchedulerSettings>(savedSettings);
  const [toast, setToast] = useState('');
  const [permissionMessage, setPermissionMessage] = useState('');
  const isMac = navigator.userAgent.includes('Mac');

  useEffect(() => {
    setDraft(savedSettings);
  }, [savedSettings]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const nextRun = useMemo(() => nextScheduledRun(draft), [draft]);

  const updateDraft = <K extends keyof SchedulerSettings>(key: K, value: SchedulerSettings[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
  };

  const toggleDay = (day: number) => {
    setDraft(current => ({
      ...current,
      selectedDays: current.selectedDays.includes(day)
        ? current.selectedDays.filter(value => value !== day)
        : [...current.selectedDays, day].sort()
    }));
  };

  const save = () => {
    const normalized = {
      ...draft,
      selectedDays: draft.everyday || draft.selectedDays.length > 0
        ? draft.selectedDays
        : savedSettings.selectedDays
    };
    setScheduler(normalized);
    setDraft(normalized);
    setToast('Scheduler settings saved');
  };

  const runNow = async () => {
    const count = await useDownloadStore.getState().startQueue(MAIN_QUEUE_ID);
    if (count > 0) {
      useSettingsStore.getState().setSchedulerRunning(true);
      setToast(`Started ${count} download${count === 1 ? '' : 's'}`);
    } else {
      setToast('No paused or failed downloads to start');
    }
  };

  const pauseNow = async () => {
    const count = await useDownloadStore.getState().pauseQueue(MAIN_QUEUE_ID);
    useSettingsStore.getState().setSchedulerRunning(false);
    setToast(count > 0 ? `Paused ${count} active download${count === 1 ? '' : 's'}` : 'No active downloads');
  };

  const requestPermission = async () => {
    setPermissionMessage('Requesting permission...');
    try {
      await invoke('request_automation_permission');
      setPermissionMessage('Automation permission is available.');
    } catch (error) {
      setPermissionMessage(String(error));
    }
  };

  return (
    <div className="flex-1 flex h-full flex-col overflow-hidden bg-main-bg">
      <WindowDragRegion />

      <div className="flex items-center gap-3 border-b border-border-color px-6 pb-4">
        <label className="flex items-center gap-3 text-[17px] font-semibold tracking-tight text-text-primary">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={event => updateDraft('enabled', event.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Scheduler
        </label>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          schedulerRunning ? 'bg-green-500/15 text-green-500' : 'bg-item-hover text-text-muted'
        }`}>
          {schedulerRunning ? 'Running' : nextRun}
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={runNow} className="app-button px-3 text-[11px]">
            <Play size={14} /> Run Now
          </button>
          <button onClick={pauseNow} className="app-button px-3 text-[11px]">
            <Pause size={14} /> Pause
          </button>
          <button onClick={save} className="app-button app-button-primary px-3 text-[11px]">
            <Save size={14} /> Save Settings
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className={`max-w-[760px] space-y-4 ${draft.enabled ? '' : 'opacity-50'}`}>
          <section className="app-card p-5">
            <div className="mb-5 flex items-center gap-2 font-semibold text-text-primary">
              <Clock3 size={17} className="text-accent" /> Timing
            </div>
            <div className="flex flex-wrap items-end gap-8">
              <label className="space-y-2 text-[12px] text-text-secondary">
                <span className="block">Start Time</span>
                <input type="time" value={draft.startTime} onChange={event => updateDraft('startTime', event.target.value)} disabled={!draft.enabled} className="app-control px-3 py-2 text-text-primary" />
              </label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                  <input type="checkbox" checked={draft.stopTimeEnabled} onChange={event => updateDraft('stopTimeEnabled', event.target.checked)} disabled={!draft.enabled} className="accent-accent" />
                  Stop Time
                </label>
                <input type="time" value={draft.stopTime} onChange={event => updateDraft('stopTime', event.target.value)} disabled={!draft.enabled || !draft.stopTimeEnabled} className="app-control px-3 py-2 text-text-primary disabled:opacity-50" />
              </div>
            </div>

            <div className="my-5 border-t border-border-color" />
            <label className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
              <input type="checkbox" checked={draft.everyday} onChange={event => updateDraft('everyday', event.target.checked)} disabled={!draft.enabled} className="accent-accent" />
              Run Every Day
            </label>
            {!draft.everyday && (
              <div className="mt-4 flex gap-2">
                {days.map(day => {
                  const selected = draft.selectedDays.includes(day.value);
                  return (
                    <button
                      key={day.value}
                      type="button"
                      disabled={!draft.enabled}
                      onClick={() => toggleDay(day.value)}
                      className={`h-8 w-8 rounded-full text-[12px] font-semibold ${
                        selected ? 'bg-accent text-white' : 'bg-bg-input text-text-primary hover:bg-item-hover'
                      }`}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="app-card p-5">
            <div className="mb-4 flex items-center gap-2 font-semibold text-text-primary">
              <List size={17} className="text-accent" /> Queues to Schedule
            </div>
            <label className="flex items-center gap-3 text-[13px] text-text-primary">
              <input type="checkbox" checked readOnly disabled={!draft.enabled} className="accent-accent" />
              Main Queue
              <span className="text-[11px] text-text-muted">All paused and failed downloads</span>
            </label>
          </section>

          <section className="app-card p-5">
            <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
              <Power size={17} className="text-accent" /> After Completion
            </div>
            <p className="mb-4 text-[12px] text-text-muted">Choose what happens after downloads started by the scheduler finish.</p>
            <div className="grid grid-cols-2 gap-2">
              {postActions.map(action => {
                const Icon = action.icon;
                return (
                  <label key={action.value} className={`flex items-center gap-3 rounded-lg border p-3 text-[13px] ${
                    draft.postQueueAction === action.value ? 'border-accent bg-item-selected text-text-primary' : 'border-border-modal text-text-secondary'
                  }`}>
                    <input type="radio" name="post-action" checked={draft.postQueueAction === action.value} onChange={() => updateDraft('postQueueAction', action.value)} disabled={!draft.enabled} className="accent-accent" />
                    <Icon size={15} />
                    {action.label}
                  </label>
                );
              })}
            </div>
            {draft.postQueueAction !== 'none' && (
              <p className="mt-3 text-[11px] text-orange-400">This action can interrupt other work on the computer. Firelink invokes it immediately after the scheduled queue finishes.</p>
            )}
          </section>
        </div>

        {isMac && (
          <section className="app-card mt-4 max-w-[760px] p-5">
            <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
              <LockKeyhole size={17} className="text-accent" /> System Permissions
            </div>
            <p className="mb-4 text-[12px] text-text-muted">Sleep, restart, and shut down require macOS Automation permission for Finder.</p>
            <div className="flex gap-2">
              <button onClick={requestPermission} className="app-button app-button-primary px-3 text-[11px]">Grant Permission</button>
              <button onClick={() => invoke('open_automation_settings')} className="app-button px-3 text-[11px]">Open Settings</button>
            </div>
            {permissionMessage && <p className="mt-3 text-[11px] text-text-muted">{permissionMessage}</p>}
          </section>
        )}
      </div>

      {toast && (
        <div className="app-toast pointer-events-none absolute bottom-7 left-1/2 -translate-x-1/2 px-4 py-2 text-[12px] font-medium">
          {toast}
        </div>
      )}
    </div>
  );
}
