import { useEffect, useMemo, useRef, useState } from 'react';
import { Gauge, Plus, Save, X, Zap } from 'lucide-react';
import { useSettingsStore } from '../store/useSettingsStore';
import { WindowDragRegion } from './WindowDragRegion';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from 'react-i18next';

type SpeedUnit = 'KB/s' | 'MB/s';

const MAX_LIMIT_KIB = 10_485_760;
const MAX_LIMIT_MB = 10240;
const KIB_PER_MIB = 1024;

export function speedValueToKiB(value: number, unit: SpeedUnit): number {
  const numericValue = Number.isFinite(value) ? value : 1;
  const valueKiB = unit === 'MB/s' ? numericValue * KIB_PER_MIB : numericValue;
  return Math.max(1, Math.min(MAX_LIMIT_KIB, Math.round(valueKiB)));
}

export function speedValueFromKiB(valueKiB: number, unit: SpeedUnit): number {
  const normalizedKiB = Math.max(1, Math.min(MAX_LIMIT_KIB, Math.round(valueKiB)));
  return unit === 'MB/s' ? normalizedKiB / KIB_PER_MIB : normalizedKiB;
}

export function convertSpeedValue(value: number, fromUnit: SpeedUnit, toUnit: SpeedUnit): number {
  return speedValueFromKiB(speedValueToKiB(value, fromUnit), toUnit);
}

export function parseLimit(
  limit: string,
  fallback: number,
  fallbackUnit: SpeedUnit = 'MB/s'
): { value: number; unit: SpeedUnit } {
  const match = limit.trim().match(/^(\d+(?:\.\d+)?)\s*([km]?)b?(?:\/s)?$/i);
  const suffix = match?.[2].toLowerCase();
  const valueKiB = match
    ? speedValueToKiB(Number(match[1]) * (suffix === 'm' ? KIB_PER_MIB : 1), 'KB/s')
    : speedValueToKiB(fallback, 'KB/s');

  if (!match) {
    return { value: speedValueFromKiB(valueKiB, fallbackUnit), unit: fallbackUnit };
  }

  if (suffix === 'm') {
    return { value: speedValueFromKiB(valueKiB, 'MB/s'), unit: 'MB/s' };
  }

  if (suffix === 'k') {
    return { value: valueKiB, unit: 'KB/s' };
  }

  return valueKiB >= 1024 && valueKiB % 1024 === 0
    ? { value: valueKiB / 1024, unit: 'MB/s' }
    : { value: valueKiB, unit: 'KB/s' };
}

export function formatSpeedLimitForStorage(value: number, unit: SpeedUnit): string {
  const valueKiB = speedValueToKiB(value, unit);
  return unit === 'MB/s'
    ? `${speedValueFromKiB(valueKiB, 'MB/s')}M`
    : `${valueKiB}K`;
}

export function clampSpeedDisplayValue(value: number, unit: SpeedUnit): number {
  const numericValue = Number.isFinite(value) ? value : speedValueFromKiB(1, unit);
  const minimum = speedValueFromKiB(1, unit);
  const maximum = speedValueFromKiB(MAX_LIMIT_KIB, unit);
  return Math.max(minimum, Math.min(maximum, numericValue));
}

function sanitizePresetValues(values: number[]): number[] {
  const cleaned = values
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => speedValueFromKiB(speedValueToKiB(value, 'MB/s'), 'MB/s'));

  return Array.from(new Set(cleaned)).sort((a, b) => a - b);
}

export function presetBaseFromDisplayValue(value: number, unit: SpeedUnit): number {
  return speedValueFromKiB(speedValueToKiB(value, unit), 'MB/s');
}

export function displayValueFromPresetBase(value: number, unit: SpeedUnit): number {
  return speedValueFromKiB(speedValueToKiB(value, 'MB/s'), unit);
}

export function formatPresetValue(value: number): string {
  return String(value);
}

export default function SpeedLimiterView() {
  const { t } = useTranslation();
  const globalSpeedLimit = useSettingsStore(state => state.globalSpeedLimit);
  const lastCustomSpeedLimitKiB = useSettingsStore(state => state.lastCustomSpeedLimitKiB);
  const lastCustomSpeedLimitUnit = useSettingsStore(state => state.lastCustomSpeedLimitUnit);
  const speedLimitPresetValues = useSettingsStore(state => state.speedLimitPresetValues);
  const setGlobalSpeedLimit = useSettingsStore(state => state.setGlobalSpeedLimit);
  const setLastCustomSpeedLimitKiB = useSettingsStore(state => state.setLastCustomSpeedLimitKiB);
  const setLastCustomSpeedLimitUnit = useSettingsStore(state => state.setLastCustomSpeedLimitUnit);
  const setSpeedLimitPresetValues = useSettingsStore(state => state.setSpeedLimitPresetValues);
  const fallbackUnit: SpeedUnit = lastCustomSpeedLimitUnit === 'KB/s' ? 'KB/s' : 'MB/s';
  const initial = parseLimit(globalSpeedLimit, lastCustomSpeedLimitKiB, fallbackUnit);
  const [enabled, setEnabled] = useState(Boolean(globalSpeedLimit));
  const [value, setValue] = useState(String(initial.value));
  const [unit, setUnit] = useState<SpeedUnit>(initial.unit);
  const [customPresetValue, setCustomPresetValue] = useState(String(initial.value));
  const { addToast } = useToast();
  const savingRef = useRef(false);
  const presetValues = useMemo(
    () => sanitizePresetValues(speedLimitPresetValues),
    [speedLimitPresetValues]
  );

  useEffect(() => {
    const parsed = parseLimit(globalSpeedLimit, lastCustomSpeedLimitKiB, fallbackUnit);
    setEnabled(Boolean(globalSpeedLimit));
    setValue(String(parsed.value));
    setUnit(parsed.unit);
    setCustomPresetValue(String(parsed.value));
  }, [globalSpeedLimit, lastCustomSpeedLimitKiB, fallbackUnit]);


  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    const numericValue = clampSpeedDisplayValue(Number(value), unit);
    const valueKiB = speedValueToKiB(numericValue, unit);
    setIsSaving(true);
    try {
      await setGlobalSpeedLimit(enabled ? formatSpeedLimitForStorage(numericValue, unit) : '');
      setLastCustomSpeedLimitKiB(valueKiB);
      setLastCustomSpeedLimitUnit(unit);
      addToast({
        message: enabled
          ? t($ => $.speedLimiter.globalLimitSaved, { value: numericValue, unit })
          : t($ => $.speedLimiter.globalLimitDisabled),
        variant: 'success'
      });
    } catch (error) {
      addToast({
        message: t($ => $.speedLimiter.saveFailed, { detail: String(error) }),
        variant: 'error',
        isActionable: true
      });
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const preset = (presetValue: number) => {
    setEnabled(true);
    setValue(String(displayValueFromPresetBase(presetValue, unit)));
  };

  const applyCustomPreset = () => {
    const numericValue = clampSpeedDisplayValue(Number(customPresetValue), unit);
    const presetBaseValue = Math.min(MAX_LIMIT_MB, presetBaseFromDisplayValue(numericValue, unit));
    const nextPresets = sanitizePresetValues([...presetValues, presetBaseValue]);
    const alreadyExists = nextPresets.length === presetValues.length;
    const storedPresetDisplayValue = displayValueFromPresetBase(presetBaseValue, unit);
    setSpeedLimitPresetValues(nextPresets);
    setEnabled(true);
    setValue(String(storedPresetDisplayValue));
    addToast({
      message: alreadyExists
        ? t($ => $.speedLimiter.presetAlreadyExists, { value: formatPresetValue(storedPresetDisplayValue), unit })
        : t($ => $.speedLimiter.presetAdded, { value: formatPresetValue(storedPresetDisplayValue), unit }),
      variant: alreadyExists ? 'info' : 'success'
    });
  };

  const removePreset = (presetValue: number) => {
    const displayValue = displayValueFromPresetBase(presetValue, unit);
    const nextPresets = presetValues.filter(value => value !== presetValue);
    setSpeedLimitPresetValues(nextPresets);
    addToast({
      message: t($ => $.speedLimiter.presetRemoved, { value: formatPresetValue(displayValue), unit }),
      variant: 'info'
    });
  };

  const changeUnit = (nextUnit: SpeedUnit) => {
    if (nextUnit === unit) return;
    setValue(String(convertSpeedValue(Number(value), unit, nextUnit)));
    setCustomPresetValue(String(convertSpeedValue(Number(customPresetValue), unit, nextUnit)));
    setUnit(nextUnit);
  };

  const currentDisplayValue = Number.isFinite(Number(value)) && Number(value) > 0
    ? value
    : String(speedValueFromKiB(1, unit));

  return (
    <div className="flex-1 flex h-full flex-col overflow-hidden bg-main-bg">
      <WindowDragRegion />

      <div className="flex items-center gap-3 border-b border-border-color px-6 pb-4">
        <div className="flex items-center gap-3 text-[17px] font-semibold tracking-tight text-text-primary select-none">
          <button
            onClick={() => setEnabled(!enabled)}
            disabled={isSaving}
            className={`relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none disabled:cursor-not-allowed ${enabled ? 'bg-accent' : 'bg-item-hover'}`}
            aria-checked={enabled}
            role="switch"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ease-in-out ${enabled ? 'translate-x-4' : 'translate-x-1'}`}
            />
          </button>
          {t($ => $.speedLimiter.title)}
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          enabled ? 'bg-accent/15 text-accent' : 'bg-item-hover text-text-muted'
        }`}>
          {enabled ? `${currentDisplayValue} ${unit}` : t($ => $.speedLimiter.unlimited)}
        </span>
        <button onClick={() => void save()} disabled={isSaving} className="app-button app-button-primary ms-auto px-3 text-[11px] disabled:opacity-50">
          <Save size={14} /> {t($ => $.speedLimiter.saveLimit)}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <section className={`app-card max-w-[760px] p-5 ${enabled ? '' : 'opacity-55'}`}>
          <div className="mb-2 flex items-center gap-2 font-semibold text-text-primary">
            <Gauge size={18} className="text-accent" /> {t($ => $.speedLimiter.globalSpeedLimit)}
          </div>
          <p className="max-w-2xl text-[12px] leading-relaxed text-text-muted">
            {t($ => $.speedLimiter.description)}
          </p>

          <div className="mt-6 flex items-center gap-3">
            <input
              type="number"
              min={speedValueFromKiB(1, unit)}
              step="any"
              value={value}
              disabled={!enabled || isSaving}
              onChange={event => setValue(event.target.value)}
              className="app-control w-28 px-3 py-2 text-right font-mono"
            />
            <div className="flex rounded-md border border-border-modal bg-bg-input p-1">
              {(['KB/s', 'MB/s'] as SpeedUnit[]).map(option => (
                <button
                  key={option}
                  type="button"
                  disabled={!enabled || isSaving}
                  onClick={() => changeUnit(option)}
                  className={`rounded px-3 py-1.5 text-[12px] font-medium ${
                    unit === option ? 'bg-accent text-accent-foreground' : 'text-text-secondary hover:bg-item-hover'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div className="my-6 border-t border-border-color" />
          <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-text-secondary">
            <Zap size={14} /> {t($ => $.speedLimiter.quickPresets)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {presetValues.map(presetValue => {
              const displayValue = displayValueFromPresetBase(presetValue, unit);
              return (
                <div
                  key={presetValue}
                  className="group flex h-8 min-w-[92px] items-center overflow-hidden rounded-md border border-border-modal bg-bg-input text-[12px] text-text-primary transition-colors hover:bg-item-hover"
                >
                  <button
                    type="button"
                    disabled={!enabled || isSaving}
                    onClick={() => preset(presetValue)}
                    className="h-full flex-1 px-3 text-start disabled:opacity-50"
                  >
                    {formatPresetValue(displayValue)} {unit}
                  </button>
                  <button
                    type="button"
                    disabled={!enabled || isSaving}
                    onClick={() => removePreset(presetValue)}
                    className="flex h-full w-7 items-center justify-center border-s border-border-modal text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:bg-red-500/10 focus-visible:text-red-400 disabled:opacity-50"
                    title={t($ => $.speedLimiter.removePreset, { value: formatPresetValue(displayValue), unit })}
                    aria-label={t($ => $.speedLimiter.removePreset, { value: formatPresetValue(displayValue), unit })}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
            <div className="ms-1 flex h-8 items-center gap-1.5 rounded-md border border-border-modal bg-bg-input px-2">
              <input
                type="number"
                min={speedValueFromKiB(1, unit)}
                step="any"
                value={customPresetValue}
                disabled={!enabled || isSaving}
                onChange={event => setCustomPresetValue(event.target.value)}
                className="w-12 bg-transparent text-right font-mono text-[12px] text-text-primary outline-none disabled:opacity-50"
                aria-label={t($ => $.speedLimiter.customPresetIn, { unit })}
              />
              <span className="text-[11px] text-text-muted">{unit}</span>
              <button
                type="button"
                disabled={!enabled || isSaving}
                onClick={applyCustomPreset}
                className="app-icon-button h-6 w-6 disabled:opacity-50"
                title={t($ => $.speedLimiter.addQuickPreset)}
                aria-label={t($ => $.speedLimiter.addQuickPreset)}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        </section>
      </div>

    </div>
  );
}
