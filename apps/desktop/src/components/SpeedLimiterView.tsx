import { useEffect, useState } from 'react';
import { Gauge, Save, Zap } from 'lucide-react';
import { useSettingsStore } from '../store/useSettingsStore';
import { WindowDragRegion } from './WindowDragRegion';

type SpeedUnit = 'KB/s' | 'MB/s';

function parseLimit(limit: string, fallback: number): { value: number; unit: SpeedUnit } {
  const match = limit.trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)b?(?:\/s)?$/i);
  const valueKiB = match
    ? Math.max(1, Math.round(Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1024 : 1)))
    : fallback;

  return valueKiB >= 1024 && valueKiB % 1024 === 0
    ? { value: valueKiB / 1024, unit: 'MB/s' }
    : { value: valueKiB, unit: 'KB/s' };
}

export default function SpeedLimiterView() {
  const globalSpeedLimit = useSettingsStore(state => state.globalSpeedLimit);
  const lastCustomSpeedLimitKiB = useSettingsStore(state => state.lastCustomSpeedLimitKiB);
  const setGlobalSpeedLimit = useSettingsStore(state => state.setGlobalSpeedLimit);
  const setLastCustomSpeedLimitKiB = useSettingsStore(state => state.setLastCustomSpeedLimitKiB);
  const initial = parseLimit(globalSpeedLimit, lastCustomSpeedLimitKiB);
  const [enabled, setEnabled] = useState(Boolean(globalSpeedLimit));
  const [value, setValue] = useState(initial.value);
  const [unit, setUnit] = useState<SpeedUnit>(initial.unit);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const parsed = parseLimit(globalSpeedLimit, lastCustomSpeedLimitKiB);
    setEnabled(Boolean(globalSpeedLimit));
    setValue(parsed.value);
    setUnit(parsed.unit);
  }, [globalSpeedLimit, lastCustomSpeedLimitKiB]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const save = () => {
    const numericValue = Math.max(1, Math.min(Number(value) || 1, unit === 'MB/s' ? 10240 : 10_485_760));
    const valueKiB = Math.min(10_485_760, Math.round(unit === 'MB/s' ? numericValue * 1024 : numericValue));
    setLastCustomSpeedLimitKiB(valueKiB);
    setGlobalSpeedLimit(enabled ? `${valueKiB}K` : '');
    setToast(enabled ? `Global limit saved at ${numericValue} ${unit}` : 'Global speed limit disabled');
  };

  const preset = (presetValue: number) => {
    setEnabled(true);
    setValue(presetValue);
    setUnit('MB/s');
  };

  return (
    <div className="flex-1 flex h-full flex-col overflow-hidden bg-main-bg">
      <WindowDragRegion />

      <div className="flex items-center gap-3 border-b border-border-color px-6 pb-4">
        <label className="flex items-center gap-3 text-[17px] font-semibold tracking-tight text-text-primary">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} className="h-4 w-4 accent-accent" />
          Speed Limiter
        </label>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          enabled ? 'bg-accent/15 text-accent' : 'bg-item-hover text-text-muted'
        }`}>
          {enabled ? `${value} ${unit}` : 'Unlimited'}
        </span>
        <button onClick={save} className="app-button app-button-primary ml-auto px-3 text-[11px]">
          <Save size={14} /> Save Limit
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <section className={`app-card max-w-[720px] p-5 ${enabled ? '' : 'opacity-50'}`}>
          <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
            <Gauge size={18} className="text-accent" /> Global Speed Limit
          </div>
          <p className="max-w-xl text-[12px] leading-relaxed text-text-muted">
            This cap is shared across the configured concurrent download slots. A lower per-download limit still takes precedence.
            Saving a new limit gracefully restarts active jobs so the change takes effect immediately.
          </p>

          <div className="mt-6 flex items-center gap-3">
            <input
              type="number"
              min="1"
              value={value}
              disabled={!enabled}
              onChange={event => setValue(Math.max(1, Number(event.target.value) || 1))}
              className="app-control w-28 px-3 py-2 text-right font-mono"
            />
            <div className="flex rounded-md border border-border-modal bg-bg-input p-1">
              {(['KB/s', 'MB/s'] as SpeedUnit[]).map(option => (
                <button
                  key={option}
                  type="button"
                  disabled={!enabled}
                  onClick={() => setUnit(option)}
                  className={`rounded px-3 py-1.5 text-[12px] font-medium ${
                    unit === option ? 'bg-accent text-white' : 'text-text-secondary hover:bg-item-hover'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div className="my-6 border-t border-border-color" />
          <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-text-secondary">
            <Zap size={14} /> Quick Presets
          </div>
          <div className="flex flex-wrap gap-2">
            {[1, 5, 10].map(presetValue => (
              <button
                key={presetValue}
                type="button"
                disabled={!enabled}
                onClick={() => preset(presetValue)}
                className="app-button px-4 text-[12px] disabled:opacity-50"
              >
                {presetValue} MB/s
              </button>
            ))}
          </div>
        </section>
      </div>

      {toast && (
        <div className="app-toast pointer-events-none absolute bottom-7 left-1/2 -translate-x-1/2 px-4 py-2 text-[12px] font-medium">
          {toast}
        </div>
      )}
    </div>
  );
}
