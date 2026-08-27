import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-hebrew/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/outfit/wght.css";
import "@fontsource-variable/roboto/wght.css";
import "@fontsource-variable/vazirmatn/wght.css";
import "./index.css";
import App from "./App";
import { i18nReady } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./contexts/ToastContext";
import { error as logError, warn as logWarn, initLogger } from "./utils/logger";
void initLogger();

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
  void logError(redactConsoleMessage(serializeConsoleArguments(values))).catch(() => undefined);
};
console.warn = (...values: unknown[]) => {
  originalConsoleWarn(...values);
  void logWarn(redactConsoleMessage(serializeConsoleArguments(values))).catch(() => undefined);
};

const rootElement = document.getElementById("root");
const renderApp = () => {
  if (!rootElement) return;

  createRoot(rootElement).render(
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <App />
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
};

void i18nReady.then(renderApp).catch(error => {
  console.error('Failed to initialize localization:', error);
  renderApp();
});

// Prevent the webview's default context menu ("Reload", etc.) on right-click.
// Individual components that provide custom context menus call preventDefault()
// in their own onContextMenu handlers, which fires before this document-level
// listener and is unaffected.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});
