import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-hebrew/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/outfit/wght.css";
import "@fontsource-variable/roboto/wght.css";
import "@fontsource-variable/vazirmatn/wght.css";
import "./index.css";
import { i18nReady } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./contexts/ToastContext";
import { error as logError, warn as logWarn, initLogger } from "./utils/logger";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invokeCommand as invoke } from './ipc';
import { useWindowFocusState } from './utils/windowFocus';
import './utils/platform';

const isPropertiesWindow = getCurrentWindow().label.startsWith('properties-');

// WebView2 can overflow its native call stack when the renderer sends IPC
// during document bootstrapping. Keep all renderer-to-native startup work
// behind the document load boundary, not just the first logger query. This is
// also needed for Zustand persistence, whose module initialization reads the
// native database before React mounts.
const documentLoaded = new Promise<void>((resolve) => {
  const releaseAfterNativeLoad = () => {
    // The load event is dispatched from WebView2's navigation callback. Move
    // renderer startup to the next task so its first IPC cannot re-enter that
    // native callback stack.
    window.setTimeout(resolve, 0);
  };

  if (document.readyState === 'complete') {
    releaseAfterNativeLoad();
    return;
  }
  window.addEventListener('load', releaseAfterNativeLoad, { once: true });
});

void documentLoaded.then(() => {
  void initLogger();
});

const serializeConsoleArguments = (values: unknown[]) => values.map(value => {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}).join(' ');

const redactConsoleMessage = (message: string) => message
  .replace(/(authorization|cookie|password|token|secret)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
  .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[redacted]');

const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.error = (...values: unknown[]) => {
  originalConsoleError(...values);
  const message = redactConsoleMessage(serializeConsoleArguments(values));
  void documentLoaded.then(() => logError(message)).catch(() => undefined);
};
console.warn = (...values: unknown[]) => {
  originalConsoleWarn(...values);
  const message = redactConsoleMessage(serializeConsoleArguments(values));
  void documentLoaded.then(() => logWarn(message)).catch(() => undefined);
};

const rootElement = document.getElementById("root");
const renderRoot = (RootComponent: ComponentType) => {
  if (!rootElement) return;

  createRoot(rootElement).render(
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <RootComponent />
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
};

const PropertiesStartupFailure = () => {
  const isWindowActive = useWindowFocusState();
  return (
    <main data-window-active={isWindowActive ? 'true' : 'false'} className="properties-window-shell flex h-screen min-h-0 flex-col items-center justify-center gap-4 bg-main-bg p-6 text-text-primary">
      <p role="alert">Download Properties could not be loaded.</p>
      <button
        type="button"
        className="app-button app-button-primary px-3 text-xs"
        onClick={() => {
          void getCurrentWindow().close().catch(error => {
            console.error('[PropertiesStartupFailure] close failed', error);
          });
        }}
      >
        Close
      </button>
    </main>
  );
};

const MainStartupFailure = () => {
  const isWindowActive = useWindowFocusState();
  return (
    <main data-window-active={isWindowActive ? 'true' : 'false'} className="app-shell flex h-screen min-h-0 flex-col items-center justify-center gap-4 bg-main-bg p-6 text-text-primary">
      <p role="alert">Firelink could not be loaded.</p>
      <button
        type="button"
        className="app-button app-button-primary px-3 text-xs"
        onClick={() => {
          void getCurrentWindow().close().catch(error => {
            console.error('[MainStartupFailure] close failed', error);
          });
        }}
      >
        Close
      </button>
    </main>
  );
};

const renderMainApp = async () => {
  if (!rootElement) return;

  await documentLoaded;

  try {
    // Keep the child entrypoint isolated from the main application module. App
    // imports the persistent Zustand stores, whose module initialization issues
    // main-window-only IPC commands. Loading it in a Properties child creates a
    // second persistence owner and can race the bridge handshake.
    const RootComponent = (await import('./App')).default;
    renderRoot(RootComponent);
  } catch (error) {
    console.error('Failed to initialize Firelink:', error);
    renderRoot(MainStartupFailure);
  }
};

const renderPropertiesApp = async () => {
  if (!rootElement) return;

  await documentLoaded;

  try {
    // Properties starts with the synchronous English catalog and changes locale
    // after its first paint. Waiting for a lazy locale chunk here delays the
    // loading shell and makes native window startup visible to the user.
    const RootComponent = (await import('./components/PropertiesWindowApp')).PropertiesWindowApp;
    renderRoot(RootComponent);
  } catch (error) {
    // A failed lazy chunk must not leave the native window hidden forever. Show
    // a styled, closable failure state and use the same caller-validated native
    // reveal command as the normal child path.
    console.error('Failed to initialize the Properties window:', error);
    renderRoot(PropertiesStartupFailure);
    const fallbackSessionId = crypto.randomUUID();
    void invoke('properties_window_send_ready', { sessionId: fallbackSessionId })
      .then(() => invoke('properties_window_reveal', { sessionId: fallbackSessionId }))
      .catch(revealError => {
        console.error('Failed to reveal the Properties startup error:', revealError);
      });
  }
};

if (isPropertiesWindow) {
  void renderPropertiesApp();
} else {
  void i18nReady.then(renderMainApp).catch(error => {
    console.error('Failed to initialize localization:', error);
    void renderMainApp();
  });
}

// Prevent the webview's default context menu ("Reload", etc.) on right-click.
// Individual components that provide custom context menus call preventDefault()
// in their own onContextMenu handlers, which fires before this document-level
// listener and is unaffected.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});
