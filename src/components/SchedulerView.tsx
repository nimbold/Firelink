import { useCallback, useEffect, useMemo, useState } from 'react';
import { invokeCommand as invoke } from '../ipc';
import {
  AlertCircle, CheckCircle2, Clock3, List, Moon, LockKeyhole,
  Pause, Play, Power, RotateCcw, Save
} from 'lucide-react';
import { PostQueueAction, SchedulerSettings, useSettingsStore } from '../store/useSettingsStore';
import { MAIN_QUEUE_ID, useDownloadStore } from '../store/useDownloadStore';
import { isActiveDownloadStatus } from '../utils/downloads';
import { WindowDragRegion } from './WindowDragRegion';
import { useToast } from '../contexts/ToastContext';
import { usePlatformInfo } from '../utils/platform';
import { useTranslation } from 'react-i18next';

const days = [
  { value: 0, key: 'su' },
  { value: 1, key: 'mo' },
  { value: 2, key: 'tu' },
  { value: 3, key: 'we' },
  { value: 4, key: 'th' },
  { value: 5, key: 'fr' },
  { value: 6, key: 'sa' },
] as const;

const postActions: { value: PostQueueAction; icon: typeof Moon }[] = [
  { value: 'none', icon: CheckCircle2 },
  { value: 'sleep', icon: Moon },
  { value: 'restart', icon: RotateCcw },
  { value: 'shutdown', icon: Power },
];

const minuteOfDay = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

function nextScheduledRun(settings: SchedulerSettings): Date | 'disabled' | 'none' {
  if (!settings.enabled) return 'disabled';

  const [hour, minute] = settings.startTime.split(':').map(Number);
  const now = new Date();

  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    const allowedDay = settings.everyday || settings.selectedDays.includes(candidate.getDay());
    if (allowedDay && candidate > now) {
      return candidate;
    }
  }

  return 'none';
}

export default function SchedulerView() {
  const { t } = useTranslation();
  const savedSettings = useSettingsStore(state => state.scheduler);
  const schedulerRunning = useSettingsStore(state => state.schedulerRunning);
  const setScheduler = useSettingsStore(state => state.setScheduler);
  const queues = useDownloadStore(state => state.queues);
  const [draft, setDraft] = useState<SchedulerSettings>(savedSettings);
  const { addToast } = useToast();
  const [permissionMessage, setPermissionMessage] = useState('');
  const [automationPermissionGranted, setAutomationPermissionGranted] = useState<boolean | null>(null);
  const platform = usePlatformInfo();
  const isMac = platform.os === 'macos';

  useEffect(() => {
    setDraft(savedSettings);
  }, [savedSettings]);


  const nextRun = useMemo(() => {
    const scheduledRun = nextScheduledRun(draft);
    if (scheduledRun === 'disabled') return t($ => $.scheduler.disabled);
    if (scheduledRun === 'none') return t($ => $.scheduler.noScheduledDay);
    return scheduledRun.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }, [draft, t]);
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedSettings),
    [draft, savedSettings]
  );

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

  const availableQueueIds = new Set(queues.map(queue => queue.id));
  const selectedQueueIds = draft.selectedQueueIds.filter(queueId => availableQueueIds.has(queueId));
  const effectiveSelectedQueueIds = selectedQueueIds;

  const toggleQueue = (queueId: string) => {
    setDraft(current => {
      const isSelected = current.selectedQueueIds.includes(queueId);
      const availableSelectionCount = current.selectedQueueIds
        .filter(id => availableQueueIds.has(id))
        .length;
      if (isSelected && availableSelectionCount === 1) return current;
      return {
        ...current,
        selectedQueueIds: isSelected
          ? current.selectedQueueIds.filter(id => id !== queueId)
          : [...current.selectedQueueIds, queueId]
      };
    });
  };

  const save = () => {
    if (draft.enabled && !draft.everyday && draft.selectedDays.length === 0) {
      addToast({ message: t($ => $.scheduler.validationDay), variant: 'error', isActionable: true });
      return;
    }
    if (draft.enabled && effectiveSelectedQueueIds.length === 0) {
      addToast({ message: t($ => $.scheduler.validationQueue), variant: 'error', isActionable: true });
      return;
    }
    if (draft.enabled && draft.stopTimeEnabled && minuteOfDay(draft.stopTime) === minuteOfDay(draft.startTime)) {
      addToast({ message: t($ => $.scheduler.validationStopTime), variant: 'error', isActionable: true });
      return;
    }
    const normalized = {
      ...draft,
      selectedDays: draft.selectedDays,
      selectedQueueIds: effectiveSelectedQueueIds
    };
    setScheduler(normalized);
    setDraft(normalized);
    addToast({ message: t($ => $.scheduler.saved), variant: 'success' });
  };

  const runNow = async () => {
    const previouslyTrackedIds = new Set(useSettingsStore.getState().schedulerActiveDownloadIds);
    const results = await Promise.all(
      effectiveSelectedQueueIds.map(queueId => useDownloadStore.getState().startQueue(queueId))
    );
    const acceptedIds = results.flat();
    const selectedQueueSet = new Set(effectiveSelectedQueueIds);
    const trackedIds = useDownloadStore.getState().downloads
      .filter(download =>
        previouslyTrackedIds.has(download.id) &&
        selectedQueueSet.has(download.queueId || MAIN_QUEUE_ID) &&
        isActiveDownloadStatus(download.status)
      )
      .map(download => download.id);
    const activeIds = [...new Set([...acceptedIds, ...trackedIds])];
    if (activeIds.length > 0) {
      useSettingsStore.getState().setSchedulerRunning(true);
      useSettingsStore.getState().setSchedulerActiveDownloadIds(activeIds);
      addToast({
        message: activeIds.length === 1
          ? t($ => $.scheduler.trackingOne)
          : t($ => $.scheduler.trackingMany, { count: activeIds.length }),
        variant: 'success'
      });
    } else {
      addToast({ message: t($ => $.scheduler.noStartableDownloads), variant: 'info' });
    }
  };

  const pauseNow = async () => {
    const counts = await Promise.all(
      effectiveSelectedQueueIds.map(queueId => useDownloadStore.getState().pauseQueue(queueId))
    );
    const count = counts.reduce((total, queueCount) => total + queueCount, 0);
    useSettingsStore.getState().setSchedulerRunning(false);
    useSettingsStore.getState().setSchedulerActiveDownloadIds([]);
    addToast({
      message: count === 0
        ? t($ => $.scheduler.noActiveDownloads)
        : count === 1
          ? t($ => $.scheduler.pausedOne)
          : t($ => $.scheduler.pausedMany, { count }),
      variant: 'info'
    });
  };

  const refreshPermissionStatus = useCallback(async (showMessage = false) => {
    if (!isMac) return;

    try {
      await invoke('check_automation_permission');
      setAutomationPermissionGranted(true);
      if (showMessage) {
        setPermissionMessage(t($ => $.scheduler.permissionAvailable));
      }
    } catch {
      setAutomationPermissionGranted(false);
      if (showMessage) {
        setPermissionMessage(t($ => $.scheduler.permissionMissingDetails));
      }
    }
  }, [isMac]);

  useEffect(() => {
    if (!isMac) return;

    void refreshPermissionStatus();

    const refreshOnFocus = () => {
      void refreshPermissionStatus();
    };
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshPermissionStatus();
      }
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);

    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [isMac, refreshPermissionStatus]);

  const openAutomationSettings = async (message: string) => {
    setPermissionMessage(message);
    try {
      await invoke('open_automation_settings');
    } catch (error) {
      setPermissionMessage(String(error));
    }
  };

  const handlePermissionAction = async () => {
    if (automationPermissionGranted) {
      await openAutomationSettings(t($ => $.scheduler.revokePermissionDetails));
      return;
    }

    setPermissionMessage(t($ => $.scheduler.requestingPermission));
    try {
      await invoke('request_automation_permission');
      setAutomationPermissionGranted(true);
      setPermissionMessage(t($ => $.scheduler.permissionAvailable));
    } catch {
      setAutomationPermissionGranted(false);
      await openAutomationSettings(t($ => $.scheduler.enablePermissionDetails));
    }
  };

  return (
    <div className="flex-1 flex h-full flex-col overflow-hidden bg-main-bg">
      <WindowDragRegion />

      <div className="flex items-center gap-3 border-b border-border-color px-6 pb-4">
        <div className="flex items-center gap-3 text-[17px] font-semibold tracking-tight text-text-primary">
          <button
            onClick={() => updateDraft('enabled', !draft.enabled)}
            className={`relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none ${draft.enabled ? 'bg-accent' : 'bg-item-hover'}`}
            aria-checked={draft.enabled}
            role="switch"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ease-in-out ${draft.enabled ? 'translate-x-4' : 'translate-x-1'}`}
            />
          </button>
          {t($ => $.scheduler.title)}
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          schedulerRunning ? 'bg-green-500/15 text-green-500' : 'bg-item-hover text-text-muted'
        }`}>
          {schedulerRunning ? t($ => $.scheduler.running) : nextRun}
        </span>
        {hasUnsavedChanges && (
          <span className="rounded-full bg-orange-500/10 px-2.5 py-1 text-[11px] font-semibold text-orange-300">
            {t($ => $.scheduler.unsavedChanges)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={runNow} className="app-button px-3 text-[11px]">
            <Play size={14} /> {t($ => $.scheduler.runNow)}
          </button>
          <button onClick={pauseNow} className="app-button px-3 text-[11px]">
            <Pause size={14} /> {t($ => $.scheduler.pause)}
          </button>
          <button onClick={save} className="app-button app-button-primary px-3 text-[11px]">
            <Save size={14} /> {t($ => $.scheduler.saveSettings)}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className={`max-w-[760px] space-y-4 ${draft.enabled ? '' : 'opacity-50'}`}>
          <section className="app-card p-5">
            <div className="mb-5 flex items-center gap-2 font-semibold text-text-primary">
              <Clock3 size={17} className="text-accent" /> {t($ => $.scheduler.timing)}
            </div>
            <div className="flex flex-wrap items-end gap-8">
              <label className="space-y-2 text-[12px] text-text-secondary">
                <span className="block">{t($ => $.scheduler.startTime)}</span>
                <input type="time" value={draft.startTime} onChange={event => updateDraft('startTime', event.target.value)} disabled={!draft.enabled} className="app-control px-3 py-2 text-text-primary" />
              </label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-[12px] text-text-secondary">
                  <input type="checkbox" checked={draft.stopTimeEnabled} onChange={event => updateDraft('stopTimeEnabled', event.target.checked)} disabled={!draft.enabled} className="accent-accent" />
                  {t($ => $.scheduler.stopTime)}
                </label>
                <input type="time" value={draft.stopTime} onChange={event => updateDraft('stopTime', event.target.value)} disabled={!draft.enabled || !draft.stopTimeEnabled} className="app-control px-3 py-2 text-text-primary disabled:opacity-50" />
              </div>
            </div>
            <p className="mt-4 text-[11px] text-text-muted">
              {t($ => $.scheduler.timingDescription)}
            </p>

            <div className="my-5 border-t border-border-color" />
            <label className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
              <input type="checkbox" checked={draft.everyday} onChange={event => updateDraft('everyday', event.target.checked)} disabled={!draft.enabled} className="accent-accent" />
              {t($ => $.scheduler.runEveryDay)}
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
                      {t($ => $.scheduler.days[day.key])}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="app-card p-5">
            <div className="mb-4 flex items-center gap-2 font-semibold text-text-primary">
              <List size={17} className="text-accent" /> {t($ => $.scheduler.queuesToSchedule)}
            </div>
            <div className="space-y-3">
              {queues.map(queue => {
                const selected = draft.selectedQueueIds.includes(queue.id);
                return (
                  <label key={queue.id} className="flex items-center gap-3 text-[13px] text-text-primary">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleQueue(queue.id)}
                      disabled={!draft.enabled || (selected && selectedQueueIds.length === 1)}
                      className="accent-accent"
                    />
                    {queue.name}
                    {queue.isMain && (
                      <span className="text-[11px] text-text-muted">{t($ => $.scheduler.defaultQueue)}</span>
                    )}
                  </label>
                );
              })}
            </div>
          </section>

          <section className="app-card p-5">
            <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
              <Power size={17} className="text-accent" /> {t($ => $.scheduler.afterCompletion)}
            </div>
            <p className="mb-4 text-[12px] text-text-muted">{t($ => $.scheduler.afterCompletionDescription)}</p>
            <div className="grid grid-cols-2 gap-2">
              {postActions.map(action => {
                const Icon = action.icon;
                return (
                  <label key={action.value} className={`flex items-center gap-3 rounded-lg border p-3 text-[13px] ${
                    draft.postQueueAction === action.value ? 'border-accent bg-item-selected text-text-primary' : 'border-border-modal text-text-secondary'
                  }`}>
                    <input type="radio" name="post-action" checked={draft.postQueueAction === action.value} onChange={() => updateDraft('postQueueAction', action.value)} disabled={!draft.enabled} className="accent-accent" />
                    <Icon size={15} />
                    {t($ => $.scheduler.postActions[action.value])}
                  </label>
                );
              })}
            </div>
            {draft.postQueueAction !== 'none' && (
              <p className="mt-3 text-[11px] text-orange-400">{t($ => $.scheduler.actionWarning)}</p>
            )}
          </section>
        </div>

        {isMac ? (
          <section className="app-card mt-4 max-w-[760px] p-5">
            <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
              <LockKeyhole size={17} className="text-accent" /> {t($ => $.scheduler.systemPermissions)}
            </div>
          <p className="mb-4 text-[12px] text-text-muted">{t($ => $.scheduler.macPermissionDescription)}</p>
          <div className="mb-4 flex items-center gap-2 text-[12px]">
            {automationPermissionGranted ? (
              <>
                <CheckCircle2 size={16} className="text-green-500" />
                <span className="font-medium text-green-500">{t($ => $.scheduler.permissionGranted)}</span>
              </>
            ) : (
              <>
                <AlertCircle size={16} className="text-orange-400" />
                <span className="font-medium text-orange-400">
                  {automationPermissionGranted === null ? t($ => $.scheduler.permissionChecking) : t($ => $.scheduler.permissionMissing)}
                </span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handlePermissionAction} className="app-button app-button-primary px-3 text-[11px]">
              {automationPermissionGranted ? t($ => $.scheduler.revokePermission) : t($ => $.scheduler.grantPermission)}
            </button>
          </div>
            {permissionMessage && <p className="mt-3 text-[11px] text-text-muted">{permissionMessage}</p>}
          </section>
        ) : (
          <section className="app-card mt-4 max-w-[760px] p-5">
            <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
              <LockKeyhole size={17} className="text-accent" /> {t($ => $.scheduler.systemActions)}
            </div>
            <p className="text-[12px] text-text-muted">
              {platform.os === 'windows'
                ? t($ => $.scheduler.windowsActionsDescription)
                : t($ => $.scheduler.linuxActionsDescription)}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
