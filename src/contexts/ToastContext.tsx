import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect, useRef, useLayoutEffect } from 'react';
import { CheckCircle2, AlertCircle, Info, XCircle, X } from 'lucide-react';

export type ToastVariant = 'success' | 'info' | 'warning' | 'error';

const MAX_VISIBLE_TOASTS = 4;
const DEFAULT_TOAST_DURATION_MS = 7000;
const ERROR_TOAST_DURATION_MS = 10000;
const TOAST_EXIT_DURATION_MS = 220;

export interface ToastMessage {
  id: string;
  message: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
  isActionable?: boolean;
  onDismiss?: () => void;
}

interface ToastState extends ToastMessage {
  exiting?: boolean;
}

interface ToastContextType {
  addToast: (toast: Omit<ToastMessage, 'id'>) => string;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const nextToastId = useRef(0);

  const addToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    nextToastId.current += 1;
    const id = `toast-${nextToastId.current}`;
    setToasts(prev => {
      const next = [...prev, { ...toast, id }];
      return next.slice(-MAX_VISIBLE_TOASTS);
    });
    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => {
      // Prevent multiple exit calls and re-renders for the same ID
      if (prev.find(t => t.id === id)?.exiting) return prev;
      return prev.map(t => t.id === id ? { ...t, exiting: true } : t);
    });
  }, []);

  const removeToastCompletely = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} removeToastCompletely={removeToastCompletely} />
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
};

const ToastItem: React.FC<{ toast: ToastState; removeToast: (id: string) => void; removeToastCompletely: (id: string) => void }> = ({ toast, removeToast, removeToastCompletely }) => {
  const [isMounted, setIsMounted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const timerStartedAt = useRef<number | null>(null);
  const remainingDuration = useRef<number | null>(null);
  const onDismissCalled = useRef(false);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => setIsMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (remainingDuration.current === null) {
      remainingDuration.current = getToastDuration(toast);
    }

    if (toast.exiting || isHovered || remainingDuration.current === null) {
      return;
    }

    timerStartedAt.current = Date.now();
    const timer = setTimeout(() => {
      removeToast(toast.id);
    }, remainingDuration.current);

    return () => {
      clearTimeout(timer);
      if (timerStartedAt.current !== null && remainingDuration.current !== null) {
        remainingDuration.current = Math.max(0, remainingDuration.current - (Date.now() - timerStartedAt.current));
        timerStartedAt.current = null;
      }
    };
  }, [toast, isHovered, removeToast]);

  useEffect(() => {
    const dismiss = () => {
      if (onDismissCalled.current) return;
      onDismissCalled.current = true;
      toast.onDismiss?.();
    };
    if (toast.exiting) dismiss();
    return dismiss;
  }, [toast.exiting, toast.onDismiss]);

  useEffect(() => {
    if (toast.exiting) {
      const fallbackTimer = setTimeout(() => {
        removeToastCompletely(toast.id);
      }, TOAST_EXIT_DURATION_MS + 100);
      return () => clearTimeout(fallbackTimer);
    }
  }, [toast.exiting, toast.id, removeToastCompletely]);

  const variant = toast.variant || 'info';
  const role = variant === 'info' ? 'status' : 'alert';
  const ariaLive = variant === 'info' ? 'polite' : 'assertive';

  const variantStyles = {
    success: {
      accent: 'bg-emerald-500',
      icon: 'text-emerald-500',
    },
    info: {
      accent: 'bg-blue-500',
      icon: 'text-blue-500',
    },
    warning: {
      accent: 'bg-amber-500',
      icon: 'text-amber-500',
    },
    error: {
      accent: 'bg-red-500',
      icon: 'text-red-500',
    },
  };

  const icons = {
    success: <CheckCircle2 className="w-5 h-5 shrink-0" strokeWidth={2.5} />,
    error: <XCircle className="w-5 h-5 shrink-0" strokeWidth={2.5} />,
    warning: <AlertCircle className="w-5 h-5 shrink-0" strokeWidth={2.5} />,
    info: <Info className="w-5 h-5 shrink-0" strokeWidth={2.5} />,
  };

  const style = variantStyles[variant];
  const Icon = icons[variant];

  const isVisible = isMounted && !toast.exiting;
  const transitionTiming = isVisible
    ? '220ms cubic-bezier(0.16, 1, 0.3, 1)'
    : `${TOAST_EXIT_DURATION_MS}ms cubic-bezier(0.4, 0, 1, 1)`;

  return (
    <div
      className="grid w-full overflow-hidden"
      style={{
        gridTemplateRows: isVisible ? '1fr' : '0fr',
        marginBottom: isVisible ? 12 : 0,
        transition: `grid-template-rows ${transitionTiming}, margin-bottom ${transitionTiming}`,
      }}
      onTransitionEnd={(e) => {
        if (toast.exiting && e.target === e.currentTarget && e.propertyName === 'grid-template-rows') {
          removeToastCompletely(toast.id);
        }
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role={role}
          aria-live={ariaLive}
          className={`app-toast-item relative ${isVisible ? 'pointer-events-auto' : 'pointer-events-none'} flex w-full min-w-0 items-start gap-3 overflow-hidden rounded-lg border border-border-color bg-surface-overlay px-4 py-3 text-[14px] leading-relaxed text-text-primary shadow-[0_18px_50px_rgba(0,0,0,0.22)] backdrop-blur-xl`}
          style={{
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translateY(0) scale(1)' : 'translateY(8px) scale(0.985)',
            transformOrigin: 'bottom right',
            transition: `opacity ${transitionTiming}, transform ${transitionTiming}, box-shadow ${transitionTiming}`,
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onFocus={() => setIsHovered(true)}
          onBlur={() => setIsHovered(false)}
        >
          <div className={`absolute inset-y-0 left-0 w-1 ${style.accent}`} />
          <div className={`mt-0.5 shrink-0 ${style.icon}`}>{Icon}</div>
          <div className="min-w-0 flex-1 break-words font-medium tracking-normal text-text-primary">{toast.message}</div>
          <button
            onClick={() => removeToast(toast.id)}
            className="ml-2 mt-0.5 shrink-0 rounded-md p-1 text-text-secondary opacity-70 transition-all hover:bg-item-hover hover:text-text-primary hover:opacity-100 active:scale-95"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
};

const getToastDuration = (toast: ToastState): number | null => {
  if (toast.duration === 0 || toast.isActionable) return null;
  if (typeof toast.duration === 'number') return Math.max(0, toast.duration);
  return toast.variant === 'error' ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS;
};

const ToastContainer: React.FC<{ toasts: ToastState[]; removeToast: (id: string) => void; removeToastCompletely: (id: string) => void }> = ({ toasts, removeToast, removeToastCompletely }) => {
  return (
    <div className="fixed bottom-8 left-4 right-4 z-[100] flex flex-col items-end pointer-events-none sm:left-auto sm:right-6 sm:w-full sm:max-w-[420px]">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} removeToast={removeToast} removeToastCompletely={removeToastCompletely} />
      ))}
    </div>
  );
};
